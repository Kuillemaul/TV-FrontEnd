#!/usr/bin/env python3
"""
Hearth PC agent: runs on your gaming PC and/or emulator PC (Windows or Linux).

It tells the TV which games are installed and starts the one you pick, so that
Moonlight on the TV can stream it through Sunshine. Standard library only.

    python hearth_agent.py --config agent.json

Endpoints (all but /health need "Authorization: Bearer <token>"):
    GET  /health          -> {"ok": true, "host": "...", "presence": {idleSeconds, locked, foreground}, ...}
    GET  /games           -> [{id, title, platform, source, art, controller, requiresKbm}]
    GET  /art/<id>        -> local cover image for ROMs / custom games
    POST /launch {"id"}   -> start a game (closes the previous one)
    POST /stop            -> close the game Hearth started
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import shlex
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

IS_WINDOWS = sys.platform == "win32"
STEAM_STORE = "https://store.steampowered.com/api/appdetails?appids={appid}&l=english"
STEAM_SEARCH = "https://store.steampowered.com/api/storesearch/?term={term}&l=english&cc=US"
STEAM_ART = "https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_600x900.jpg"
# Steam store category ids
CAT_FULL_CONTROLLER = 28
CAT_PARTIAL_CONTROLLER = 18
# Not games: redistributables, Proton, runtimes, Steam tools.
STEAM_SKIP_IDS = {228980, 1070560, 1391110, 1628350, 1493710, 2180100, 250820}
STEAM_SKIP_NAMES = re.compile(r"^(Proton|Steam Linux Runtime|Steamworks|SteamVR|Steam Controller)", re.I)
ROM_TAGS = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]")


LOG_FILE = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local" / "state") / "Hearth" / "agent.log"


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    try:
        print(line, flush=True)
    except (OSError, AttributeError):  # pythonw has no console
        pass
    # Also kept in a file, since the agent normally runs in the background with no window.
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 2_000_000:
            LOG_FILE.replace(LOG_FILE.with_suffix(".old.log"))
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


# --------------------------------------------------------------------------------------
# Steam
# --------------------------------------------------------------------------------------


def parse_vdf(text: str) -> dict[str, Any]:
    """Minimal parser for Valve's KeyValues text format (.vdf / .acf)."""
    tokens = re.findall(r'"((?:[^"\\]|\\.)*)"|([{}])', text)
    root: dict[str, Any] = {}
    stack = [root]
    key: str | None = None
    for quoted, brace in tokens:
        if brace == "{":
            child: dict[str, Any] = {}
            stack[-1][key or ""] = child
            stack.append(child)
            key = None
        elif brace == "}":
            stack.pop()
            key = None
        elif key is None:
            key = quoted.replace("\\\\", "\\")
        else:
            stack[-1][key] = quoted.replace("\\\\", "\\")
            key = None
    return root


def steam_root(configured: str | None) -> Path | None:
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured))
    if IS_WINDOWS:
        try:
            import winreg

            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as k:
                candidates.append(Path(winreg.QueryValueEx(k, "SteamPath")[0]))
        except OSError:
            pass
        candidates.append(Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Steam")
    else:
        home = Path.home()
        candidates += [home / ".steam/steam", home / ".local/share/Steam", home / ".var/app/com.valvesoftware.Steam/data/Steam"]
    return next((c for c in candidates if (c / "steamapps").is_dir()), None)


def steam_games(root: Path) -> list[dict[str, Any]]:
    libraries = {root}
    vdf = root / "steamapps" / "libraryfolders.vdf"
    if vdf.exists():
        folders = parse_vdf(vdf.read_text(encoding="utf-8", errors="replace")).get("libraryfolders", {})
        for entry in folders.values():
            if isinstance(entry, dict) and entry.get("path"):
                libraries.add(Path(entry["path"]))

    games: dict[int, dict[str, Any]] = {}
    for lib in libraries:
        for acf in (lib / "steamapps").glob("appmanifest_*.acf"):
            try:
                state = parse_vdf(acf.read_text(encoding="utf-8", errors="replace")).get("AppState", {})
                appid = int(state["appid"])
            except (KeyError, ValueError, OSError):
                continue
            name = state.get("name", "")
            fully_installed = int(state.get("StateFlags", "4")) & 4
            if appid in STEAM_SKIP_IDS or STEAM_SKIP_NAMES.match(name) or not fully_installed:
                continue
            games[appid] = {
                "appid": appid,
                "title": name,
                "installDir": str(lib / "steamapps" / "common" / state.get("installdir", "")),
            }
    return list(games.values())


class SteamStoreCache:
    """
    Looks up games on the Steam store once, in the background, and caches the answers on disk:
    controller support, age rating, description, screenshots, genres and release year.

    Works for games you don't own on Steam too (Epic, Game Pass, GOG, LaunchBox PC games):
    they're matched to their Steam page by name, because almost every PC game is listed there.
    """

    def __init__(self, path: Path, enabled: bool) -> None:
        self.path = path
        self.enabled = enabled
        self.data: dict[str, dict[str, Any]] = {}
        self.searches: dict[str, int] = {}  # normalised title -> appid (0 = no match)
        self.pending: list[tuple[str, Any]] = []
        self.lock = threading.Lock()
        try:
            raw = json.loads(path.read_text())
            self.searches = raw.pop("__search__", {})
            # Older caches stored just the controller string.
            self.data = {k: (v if isinstance(v, dict) else {"controller": v}) for k, v in raw.items()}
        except (OSError, ValueError):
            pass
        if enabled:
            threading.Thread(target=self._worker, daemon=True).start()

    def _queue(self, task: tuple[str, Any]) -> None:
        with self.lock:
            if task not in self.pending:
                self.pending.append(task)

    def info(self, appid: int) -> dict[str, Any]:
        value = self.data.get(str(appid))
        if (value is None or "description" not in value) and self.enabled:
            self._queue(("app", appid))
        return value or {}

    def get(self, appid: int) -> str:
        return self.info(appid).get("controller", "unknown")

    def find(self, title: str) -> int | None:
        """Steam appid for a game title, or None (unknown yet / no match). Looks it up in the background."""
        key = norm_title(title)
        if not key:
            return None
        if key in self.searches:
            return self.searches[key] or None
        if self.enabled:
            self._queue(("search", title))
        return None

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({**self.data, "__search__": self.searches}, indent=1))

    def _worker(self) -> None:
        while True:
            with self.lock:
                task = self.pending.pop(0) if self.pending else None
            if task is None:
                time.sleep(2)
                continue
            kind, arg = task
            try:
                if kind == "app":
                    with urllib.request.urlopen(STEAM_STORE.format(appid=arg), timeout=10) as res:
                        body = json.load(res).get(str(arg), {})
                    self.data[str(arg)] = parse_steam_store(body)
                else:
                    url = STEAM_SEARCH.format(term=urllib.parse.quote(arg))
                    with urllib.request.urlopen(url, timeout=10) as res:
                        items = json.load(res).get("items", [])
                    self.searches[norm_title(arg)] = match_search(arg, items) or 0
                self._save()
            except Exception as err:  # network hiccup or rate limit: retry later
                log(f"store lookup {arg} failed: {err}")
                time.sleep(30)
                self._queue(task)
            time.sleep(1.6)  # stay well under the store API rate limit


EDITION_WORDS = re.compile(
    r"\b(goty|game of the year|definitive|deluxe|complete|ultimate|gold|premium|standard|enhanced|remastered|anniversary|digital)( edition)?\b|\bedition\b|[™®©]",
    re.I,
)


def match_search(title: str, items: list[dict[str, Any]]) -> int | None:
    """Pick the Steam search result that is really this game (ignoring "GOTY Edition", ™ and the like)."""
    want = norm_title(EDITION_WORDS.sub("", title))
    for item in items[:5]:
        if norm_title(EDITION_WORDS.sub("", item.get("name", ""))) == want:
            return int(item["id"])
    return None


def parse_steam_store(body: dict[str, Any]) -> dict[str, Any]:
    if not body.get("success"):
        return {"controller": "unknown", "description": ""}
    d = body.get("data", {})
    cats = {c.get("id") for c in d.get("categories", [])}
    controller = "full" if CAT_FULL_CONTROLLER in cats else "partial" if CAT_PARTIAL_CONTROLLER in cats else "none"
    esrb = (d.get("ratings") or {}).get("esrb", {}).get("rating") or ""
    age = int(d.get("required_age") or 0)
    rating = norm_rating(esrb) or ("M" if age >= 17 else "T" if age >= 13 else None)
    year = re.search(r"(19|20)\d\d", (d.get("release_date") or {}).get("date", ""))
    return {
        "controller": controller,
        "rating": rating,
        "description": re.sub(r"<[^>]+>", "", d.get("short_description", "")).strip(),
        "screenshots": [x["path_full"] for x in d.get("screenshots", [])[:4] if x.get("path_full")],
        "genres": [g["description"] for g in d.get("genres", [])][:3],
        "year": int(year.group(0)) if year else None,
    }


# --------------------------------------------------------------------------------------
# Library
# --------------------------------------------------------------------------------------


def stable_id(*parts: str) -> str:
    return hashlib.sha1("\0".join(parts).encode()).hexdigest()[:12]


def clean_rom_title(stem: str) -> str:
    return ROM_TAGS.sub("", stem).replace("_", " ").strip() or stem


def norm_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", title.lower())


# Checked in order: "E10+ - Everyone 10+" must hit E10 before the plain "Everyone" rule.
RATING_PATTERNS = [
    ("E10", re.compile(r"E10|everyone 10", re.I)),
    ("M", re.compile(r"\b(AO|M|M17|mature|adults only|PEGI ?16|PEGI ?18)\b", re.I)),
    ("T", re.compile(r"\b(T|teen|PEGI ?12)\b", re.I)),
    ("E", re.compile(r"\b(E|EC|everyone|early childhood|K-A|PEGI ?3|PEGI ?7)\b", re.I)),
]


def norm_rating(text: str | None) -> str | None:
    """ESRB/PEGI text ("E - Everyone", "Teen", "PEGI 12", "e10") -> E | E10 | T | M, or None."""
    if not text:
        return None
    return next((rating for rating, pattern in RATING_PATTERNS if pattern.search(text)), None)


def page(items: list[dict[str, Any]], q: str, offset: int, limit: int) -> dict[str, Any]:
    if q:
        ql = q.lower()
        items = [g for g in items if ql in g["title"].lower()]
    return {"total": len(items), "games": items[offset : offset + limit]}


def is_true(value: str | None) -> bool:
    return (value or "").strip().lower() == "true"


def mtimes(paths: list[Path]) -> tuple[float, ...]:
    out = []
    for p in paths:
        try:
            out.append(p.stat().st_mtime)
        except OSError:
            out.append(0.0)
    return tuple(out)


# ---- LaunchBox ------------------------------------------------------------------------

LB_ILLEGAL = re.compile(r"[<>:\"/\\|?*']")


class LaunchBoxSource:
    """
    Reads LaunchBox's Data/Platforms/*.xml and Data/Emulators.xml and returns only the
    games you've marked as favourites (configurable). Platform files are streamed with
    iterparse, so a 20,000-game library parses in a couple of seconds, and they are only
    re-read when LaunchBox actually changes them.
    """

    def __init__(self, cfg: dict[str, Any]) -> None:
        self.root = Path(cfg["path"])
        self.favorites_only = cfg.get("favoritesOnly", True)
        self.platforms = set(cfg.get("platforms", []))  # empty = all
        self.include_hidden = cfg.get("includeHidden", False)
        self.pc_platforms = set(cfg.get("pcPlatforms", ["Windows", "MS-DOS", "Windows 3.X", "ScummVM"]))
        self.cache_key: tuple[float, ...] | None = None
        self.cache: dict[str, dict[str, Any]] = {}
        self.art_index: dict[tuple[str, str], dict[str, list[Path]]] = {}
        self.art_index_at: dict[tuple[str, str], float] = {}
        self.counts: dict[str, int] = {}
        self.id_platform: dict[str, Path] = {}
        self.browse_cache: tuple[Any, list[dict[str, Any]]] | None = None

    def _files(self) -> list[Path]:
        data = self.root / "Data"
        return [data / "Emulators.xml", *sorted((data / "Platforms").glob("*.xml"))]

    def _emulators(self) -> tuple[dict[str, dict[str, Any]], dict[tuple[str, str], str]]:
        import xml.etree.ElementTree as ET

        emulators: dict[str, dict[str, Any]] = {}
        platform_args: dict[tuple[str, str], str] = {}
        path = self.root / "Data" / "Emulators.xml"
        if not path.exists():
            return emulators, platform_args
        for el in ET.parse(path).getroot():
            if el.tag == "Emulator":
                emulators[el.findtext("ID", "")] = {
                    "path": el.findtext("ApplicationPath", ""),
                    "args": el.findtext("CommandLine", ""),
                    "noQuotes": is_true(el.findtext("NoQuotes")),
                    "noSpace": is_true(el.findtext("NoSpace")),
                    "title": el.findtext("Title", ""),
                }
            elif el.tag == "EmulatorPlatform":
                key = (el.findtext("Emulator", ""), el.findtext("Platform", ""))
                if el.findtext("CommandLine") is not None:
                    platform_args[key] = el.findtext("CommandLine", "")
        return emulators, platform_args

    def _abs(self, path: str) -> str:
        """LaunchBox stores paths relative to its own folder (e.g. ..\\ROMs\\x.zip); URLs pass through."""
        if re.match(r"^[a-z][a-z0-9+.-]+://", path, re.I):
            return path
        p = Path(path) if IS_WINDOWS else Path(path.replace("\\", "/"))
        return str(p if p.is_absolute() else (self.root / p).resolve())

    def entries(self) -> dict[str, dict[str, Any]]:
        """Favourites (by default) across all platforms. Also counts every platform for Browse."""
        files = self._files()
        key = mtimes(files)
        if key == self.cache_key:
            return self.cache

        import xml.etree.ElementTree as ET

        emulators, platform_args = self._emulators()
        out: dict[str, dict[str, Any]] = {}
        counts: dict[str, int] = {}
        for xml_file in files[1:]:
            for _, el in ET.iterparse(xml_file, events=("end",)):
                if el.tag != "Game":
                    continue
                platform = el.findtext("Platform", "")
                visible = (self.include_hidden or not is_true(el.findtext("Hide"))) and not is_true(el.findtext("Broken"))
                if visible:
                    counts[platform] = counts.get(platform, 0) + 1
                    self.id_platform[el.findtext("ID", "")] = xml_file
                keep = visible and (not self.favorites_only or is_true(el.findtext("Favorite"))) and (not self.platforms or platform in self.platforms)
                if keep:
                    entry = self._entry(el, platform, emulators, platform_args)
                    if entry:
                        out[entry["id"]] = entry
                el.clear()  # keep memory flat on huge platform files

        self.cache, self.cache_key, self.counts = out, key, counts
        log(f"LaunchBox: {len(out)} games ({'favourites' if self.favorites_only else 'all'}), {sum(counts.values())} in library")
        return out

    def platform_counts(self) -> list[dict[str, Any]]:
        self.entries()
        return [{"name": k, "count": v} for k, v in sorted(self.counts.items()) if v]

    def _load_platform(self, xml_file: Path) -> list[dict[str, Any]]:
        """Every game of one platform. Only one platform is kept in memory at a time."""
        mt = mtimes([xml_file])
        if self.browse_cache and self.browse_cache[0] == (xml_file, mt):
            return self.browse_cache[1]
        import xml.etree.ElementTree as ET

        emulators, platform_args = self._emulators()
        games = []
        for _, el in ET.iterparse(xml_file, events=("end",)):
            if el.tag == "Game":
                if (self.include_hidden or not is_true(el.findtext("Hide"))) and not is_true(el.findtext("Broken")):
                    entry = self._entry(el, el.findtext("Platform", ""), emulators, platform_args)
                    if entry:
                        games.append(entry)
                el.clear()
        games.sort(key=lambda g: g["title"].lower())
        self.browse_cache = ((xml_file, mt), games)
        return games

    def browse(self, platform: str, q: str = "", offset: int = 0, limit: int = 120) -> dict[str, Any]:
        xml_file = self.root / "Data" / "Platforms" / f"{platform}.xml"
        if not xml_file.exists():  # file names normally match the platform name; fall back to the index
            xml_file = next((f for f in set(self.id_platform.values()) if f.stem.lower() == platform.lower()), xml_file)
        if not xml_file.exists():
            return {"total": 0, "games": []}
        return page(self._load_platform(xml_file), q, offset, limit)

    def find(self, gid: str) -> dict[str, Any] | None:
        """Look up any LaunchBox game (not just favourites) by id, e.g. one launched from Browse."""
        if gid in self.cache:
            return self.cache[gid]
        xml_file = self.id_platform.get(gid.removeprefix("lb-"))
        if not xml_file:
            return None
        return next((g for g in self._load_platform(xml_file) if g["id"] == gid), None)

    def _entry(self, el: Any, platform: str, emulators: dict[str, dict[str, Any]], platform_args: dict[tuple[str, str], str]) -> dict[str, Any] | None:
        lb_id = el.findtext("ID", "")
        title = el.findtext("Title", "") or "Unknown"
        app = el.findtext("ApplicationPath", "")
        if not lb_id or not app:
            return None
        game_args = el.findtext("CommandLine", "") or ""
        emu = emulators.get(el.findtext("Emulator", "") or "")
        is_pc = platform in self.pc_platforms

        if emu and not is_pc:
            exe = self._abs(emu["path"])
            args = platform_args.get((el.findtext("Emulator", ""), platform), emu["args"]) or ""
            rom = self._abs(app)
            rom_arg = rom if emu["noQuotes"] else f'"{rom}"'
            parts = [f'"{exe}"', args.strip(), game_args.strip()]
            line = " ".join(p for p in parts if p)
            line = f"{line}{rom_arg}" if emu["noSpace"] else f"{line} {rom_arg}"
            launch = {"commandLine": line, "cwd": str(Path(exe).parent)}
            process_dir = None
        else:
            target = self._abs(app)
            launch = {"file": target, "args": game_args}
            process_dir = str(Path(target).parent) if Path(target).suffix.lower() == ".exe" else None

        year = re.match(r"(\d{4})", el.findtext("ReleaseDate", "") or "")
        return {
            "id": f"lb-{lb_id}",
            "title": title,
            "platform": platform or "PC",
            "source": "launchbox",
            "art": True,
            "controller": "unknown" if is_pc else "full",
            "requiresKbm": False,
            "rating": norm_rating(el.findtext("Rating")),
            "favorite": is_true(el.findtext("Favorite")),
            "_lookup": is_pc,
            "_steamAppid": int(m.group(1)) if is_pc and (m := re.search(r"steam://(?:rungameid|run)/(\d+)", app)) else None,
            "installed": True,
            "_launch": launch,
            "_processDir": process_dir,
            "_artLookup": (platform, title),
            "_details": {
                "description": (el.findtext("Notes", "") or "").strip()[:1500],
                "year": int(year.group(1)) if year else None,
                "genres": [g.strip() for g in (el.findtext("Genre", "") or "").split(";") if g.strip()][:3],
                "playtimeMinutes": int(int(el.findtext("PlayTime", "0") or 0) / 60),
            },
        }

    def _image_index(self, platform: str, folder: str) -> dict[str, list[Path]]:
        key = (platform, folder)
        # Rebuilt every 10 minutes so new or changed images in LaunchBox show up without a restart.
        if key not in self.art_index or time.time() - self.art_index_at.get(key, 0) > 600:
            self.art_index_at[key] = time.time()
            index: dict[str, list[Path]] = {}
            root = self.root / "Images" / platform / folder
            if root.is_dir():
                for f in sorted(root.rglob("*")):
                    m = re.match(r"^(.*)-\d\d$", f.stem)
                    if m and f.suffix.lower() in (".png", ".jpg", ".jpeg"):
                        index.setdefault(m.group(1).lower(), []).append(f)
            self.art_index[key] = index
        return self.art_index[key]

    def art(self, platform: str, title: str) -> Path | None:
        """Box-front image, matching LaunchBox's "<Title>-01.png" naming (region subfolders included)."""
        found = self._image_index(platform, "Box - Front").get(LB_ILLEGAL.sub("_", title).lower())
        return found[0] if found else None

    def screenshots(self, platform: str, title: str) -> list[Path]:
        key = LB_ILLEGAL.sub("_", title).lower()
        shots = self._image_index(platform, "Screenshot - Gameplay").get(key, []) + self._image_index(platform, "Fanart - Background").get(key, [])
        return shots[:4]


# ---- Playnite -------------------------------------------------------------------------


# Playnite calls PC games "PC (Windows)", and Game Pass games "Microsoft Xbox Series" / "Xbox One", but they
# all run on this PC. Only emulated platforms set up in Playnite (e.g. "Nintendo Switch") keep their name.
PC_LIKE = re.compile(r"^(pc\b|.*windows|.*xbox|ms-dos|dos\b|linux|macintosh|mac\b)", re.I)


def playnite_platform(platforms: list[str]) -> str:
    if not platforms or any(PC_LIKE.match(p) for p in platforms):
        return "PC"
    return platforms[0]


class PlayniteSource:
    """
    Reads the library file that the Hearth Exporter Playnite extension writes (see
    pc-agent/playnite/). Favourites are the main list; the whole library (installed or not)
    is available to Browse. Playnite covers Epic, GOG, Xbox / Game Pass, EA, Ubisoft,
    Battle.net, itch, Steam and anything added by hand. Games launch through Playnite
    (playnite://playnite/start/<id>), which also offers to install uninstalled ones.
    """

    def __init__(self, cfg: dict[str, Any]) -> None:
        data = Path(os.environ.get("APPDATA", str(Path.home()))) / "Playnite" / "ExtensionsData"
        default = data / "hearth-library.json"
        if not default.exists() and (data / "hearth-favorites.json").exists():
            default = data / "hearth-favorites.json"  # older exporter: favourites only
        self.path = Path(cfg.get("exportPath") or default)
        # exportPath pointing at the ExtensionsData folder (portable Playnite) instead of the file: use the file in it.
        if self.path.is_dir():
            self.path = self.path / "hearth-library.json"
        self.kbm_tags = {t.lower() for t in cfg.get("kbmTags", ["Hearth: KBM", "Keyboard & Mouse"])}
        self.pad_tags = {t.lower() for t in cfg.get("controllerTags", ["Hearth: Controller"])}
        self.cache_key: tuple[float, ...] | None = None
        self.all: list[dict[str, Any]] = []

    def _load(self) -> list[dict[str, Any]]:
        key = mtimes([self.path])
        if key == self.cache_key:
            return self.all
        try:
            games = json.loads(self.path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as err:
            log(f"Playnite export not readable yet ({self.path}): {err}")
            games = []
        legacy = self.path.name == "hearth-favorites.json"
        self.all = sorted((self._entry(g, legacy) for g in games if g.get("id")), key=lambda e: e["title"].lower())
        self.cache_key = key
        log(f"Playnite: {len(self.all)} games, {sum(e['favorite'] for e in self.all)} favourites")
        return self.all

    def _entry(self, g: dict[str, Any], legacy: bool) -> dict[str, Any]:
        # Older exporters wrote [null] for a game with no features/tags/genres/platforms (a PowerShell quirk).
        names = lambda key: [str(x) for x in (g.get(key) or []) if x]  # noqa: E731
        features = {f.lower() for f in names("features")}
        tags = {t.lower() for t in names("tags")}
        controller = "full" if "full controller support" in features else "partial" if "partial controller support" in features else "unknown"
        cover = g.get("cover")
        platforms = names("platforms")
        ratings = names("ageRatings")
        return {
            "id": f"pn-{g['id']}",
            "title": g.get("name") or "Unknown",
            "platform": playnite_platform(platforms),
            "source": "playnite",
            "store": g.get("source") or "",
            "art": bool(cover),
            "controller": controller,
            "requiresKbm": bool(tags & self.kbm_tags) and not (tags & self.pad_tags),
            # Tags win; otherwise controller support is looked up on the Steam store.
            "_tagKbm": True if tags & self.kbm_tags and not tags & self.pad_tags else False if tags & self.pad_tags else None,
            "_steamAppid": int(g["gameId"]) if (g.get("source") or "").lower() == "steam" and str(g.get("gameId", "")).isdigit() else None,
            "_lookup": True,
            "rating": next((r for r in map(norm_rating, ratings) if r), None),
            "favorite": legacy or bool(g.get("favorite")),
            "installed": g.get("installed", True) is not False,
            "_launch": {"uri": f"playnite://playnite/start/{g['id']}"},
            "_processDir": g.get("installDirectory") or None,
            "_artPath": cover,
            "_shots": [x for x in [g.get("background")] if x],
            "_details": {
                "description": re.sub(r"<[^>]+>", " ", g.get("description") or "").strip()[:1500],
                "year": g.get("releaseYear"),
                "genres": names("genres")[:3],
                "playtimeMinutes": int((g.get("playtime") or 0) / 60),
            },
        }

    def entries(self) -> dict[str, dict[str, Any]]:
        games = self._load()
        favourites = [e for e in games if e["favorite"]]
        # Nothing starred in Playnite yet: show what's installed rather than nothing.
        chosen = favourites or [e for e in games if e["installed"]]
        return {e["id"]: e for e in chosen}

    def browse(self, q: str = "", offset: int = 0, limit: int = 120) -> dict[str, Any]:
        return page(self._load(), q, offset, limit)

    def find(self, gid: str) -> dict[str, Any] | None:
        return next((e for e in self._load() if e["id"] == gid), None)


# ---- ROM folders ----------------------------------------------------------------------


class RomFolderSource:
    """Plain ROM folders (no frontend). Walked in the background, never on a request."""

    def __init__(self, emulators: list[dict[str, Any]]) -> None:
        self.emulators = emulators

    def entries(self) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for emu in self.emulators:
            rom_dir = Path(emu["romDir"])
            exts = {e.lower() for e in emu.get("extensions", [])}
            art_dir = Path(emu["artDir"]) if emu.get("artDir") else None
            arts = {f.stem.lower(): f for f in art_dir.iterdir()} if art_dir and art_dir.is_dir() else {}
            only = {t.lower() for t in emu.get("only", [])}  # optional allow-list of titles
            if not rom_dir.is_dir():
                log(f"ROM folder not found: {rom_dir}")
                continue
            for dirpath, _, files in os.walk(rom_dir):
                for name in files:
                    rom = Path(dirpath) / name
                    if exts and rom.suffix.lower() not in exts:
                        continue
                    title = clean_rom_title(rom.stem)
                    if only and title.lower() not in only:
                        continue
                    gid = f"rom-{emu['system']}-{stable_id(emu['system'], str(rom.relative_to(rom_dir)))}"
                    art = arts.get(rom.stem.lower())
                    out[gid] = {
                        "id": gid,
                        "title": title,
                        "platform": emu.get("name", emu["system"]),
                        "source": "rom",
                        "art": bool(art),
                        "controller": "full",
                        "requiresKbm": emu.get("requiresKbm", False),
                        "_launch": {"command": [part.replace("{rom}", str(rom)) for part in emu["command"]], "cwd": emu.get("cwd")},
                        "_artPath": str(art) if art else None,
                    }
        return out


# ---- Library --------------------------------------------------------------------------


class Library:
    def __init__(self, cfg: dict[str, Any], cache_dir: Path) -> None:
        self.cfg = cfg
        steam_cfg = cfg.get("steam", {})
        self.steam_enabled = steam_cfg.get("enabled", True)
        self.steam_path = steam_cfg.get("path")
        self.controllers = SteamStoreCache(cache_dir / "steam-store.json", steam_cfg.get("controllerLookup", True))
        self.launchbox = LaunchBoxSource(cfg["launchbox"]) if cfg.get("launchbox", {}).get("path") else None
        self.playnite = PlayniteSource(cfg["playnite"]) if cfg.get("playnite", {}).get("enabled") else None
        self.roms = RomFolderSource(cfg.get("emulators", []))
        self.rescan_s = float(cfg.get("rescanMinutes", 10)) * 60
        self.entries: dict[str, dict[str, Any]] = {}
        self.scanned_at = 0.0
        self.lock = threading.Lock()

    def start_background(self) -> None:
        def loop() -> None:
            while True:
                time.sleep(15)
                if time.time() - self.scanned_at >= self.rescan_s or self._sources_changed():
                    self.scan()

        threading.Thread(target=loop, daemon=True).start()

    def _sources_changed(self) -> bool:
        """Cheap check (a few stat calls) so LaunchBox/Playnite favourites show up within ~15s."""
        if self.launchbox and mtimes(self.launchbox._files()) != self.launchbox.cache_key:
            return True
        return bool(self.playnite and mtimes([self.playnite.path]) != self.playnite.cache_key)

    def scan(self) -> dict[str, dict[str, Any]]:
        with self.lock:
            started = time.time()
            entries: dict[str, dict[str, Any]] = {}
            for name, source in (("steam", self._steam), ("custom", self._custom), ("roms", self.roms.entries),
                                 ("launchbox", self.launchbox and self.launchbox.entries),
                                 ("playnite", self.playnite and self.playnite.entries)):
                if not source:
                    continue
                try:
                    entries.update(source())
                except Exception as err:  # one broken source shouldn't empty the library
                    log(f"{name} scan failed: {err}")
            # A game starred in Playnite/LaunchBox and also found by the Steam scan: keep the frontend's entry.
            frontend_titles = {norm_title(e["title"]) for e in entries.values() if e["source"] in ("playnite", "launchbox")}
            entries = {k: e for k, e in entries.items() if not (e["source"] == "steam" and norm_title(e["title"]) in frontend_titles)}
            self.entries = entries
            self.scanned_at = time.time()
            log(f"library: {len(entries)} games ({time.time() - started:.1f}s)")
            return entries

    def get(self, gid: str) -> dict[str, Any] | None:
        """Any launchable game: favourites first, then the full LaunchBox/Playnite libraries (Browse)."""
        found = self.entries.get(gid)
        if not found and gid.startswith("lb-") and self.launchbox:
            found = self.launchbox.find(gid)
        if not found and gid.startswith("pn-") and self.playnite:
            found = self.playnite.find(gid)
        return found or self.scan().get(gid)

    # ---- Browse ------------------------------------------------------------------------

    def browse_sources(self) -> dict[str, Any]:
        pc = len(self.playnite._load()) if self.playnite else len(self._steam())
        return {"pc": pc, "platforms": self.launchbox.platform_counts() if self.launchbox else []}

    def browse(self, source: str, platform: str, q: str, offset: int, limit: int) -> dict[str, Any]:
        if source == "platform" and self.launchbox:
            result = self.launchbox.browse(platform, q, offset, limit)
        elif source == "pc":
            result = self.playnite.browse(q, offset, limit) if self.playnite else page(sorted(self._steam().values(), key=lambda g: g["title"].lower()), q, offset, limit)
        else:
            result = {"total": 0, "games": []}
        return {"total": result["total"], "games": [self._public(e) for e in result["games"]]}

    def details(self, gid: str) -> dict[str, Any] | None:
        e = self.get(gid)
        if not e:
            return None
        info = dict(e.get("_details") or {})
        shots: list[str] = []
        if e.get("_appid") or e.get("_lookup"):
            store = self._steam_info(e)
            # The library's own text wins; Steam fills the gaps.
            info = {**{k: store.get(k) for k in ("description", "year", "genres") if store.get(k)}, **{k: v for k, v in info.items() if v}}
            shots = list(store.get("screenshots", []))
        local = self._local_shots(e)
        shots += [f"/shot/{gid}/{i}" for i in range(len(local))]
        return {**self._public(e), "description": info.get("description", ""), "year": info.get("year"), "genres": info.get("genres", []),
                "playtimeMinutes": info.get("playtimeMinutes"), "screenshots": shots}

    def _local_shots(self, e: dict[str, Any]) -> list[str]:
        if e.get("_artLookup") and self.launchbox:
            return [str(p) for p in self.launchbox.screenshots(*e["_artLookup"])]
        return [p for p in e.get("_shots", []) if p and Path(p).is_file()]

    def shot_path(self, gid: str, n: int) -> str | None:
        e = self.get(gid)
        shots = self._local_shots(e) if e else []
        return shots[n] if 0 <= n < len(shots) else None

    def _steam(self) -> dict[str, dict[str, Any]]:
        root = steam_root(self.steam_path) if self.steam_enabled else None
        if not root:
            return {}
        return {
            f"steam-{g['appid']}": {
                "id": f"steam-{g['appid']}",
                "title": g["title"],
                "platform": "PC",
                "source": "steam",
                "art": STEAM_ART.format(appid=g["appid"]),
                "controller": "unknown",
                "requiresKbm": False,
                "_launch": {"uri": f"steam://rungameid/{g['appid']}"},
                "_processDir": g["installDir"],
                "_appid": g["appid"],
            }
            for g in steam_games(root)
        }

    def _custom(self) -> dict[str, dict[str, Any]]:
        out = {}
        for g in self.cfg.get("games", []):
            gid = f"custom-{g.get('id') or stable_id(g['title'])}"
            art = g.get("art")
            out[gid] = {
                "id": gid,
                "title": g["title"],
                "platform": g.get("platform", "PC"),
                "source": "custom",
                "art": art if art and art.startswith("http") else bool(art),
                "controller": g.get("controller", "unknown"),
                "requiresKbm": g.get("requiresKbm", False),
                "_tagKbm": g.get("requiresKbm"),
                "_lookup": "controller" not in g,
                "_launch": {"uri": g.get("uri"), "command": g.get("command"), "cwd": g.get("cwd")},
                "_processDir": g.get("processDir"),
                "_artPath": None if not art or art.startswith("http") else art,
            }
        return out

    def art_path(self, gid: str) -> str | None:
        e = self.get(gid)
        if not e:
            return None
        if e.get("_artLookup") and self.launchbox:
            found = self.launchbox.art(*e["_artLookup"])
            return str(found) if found else None
        return e.get("_artPath")

    def _steam_info(self, e: dict[str, Any]) -> dict[str, Any]:
        """Steam store data for any PC game: by its Steam id, or matched by name (Epic, Game Pass…)."""
        appid = e.get("_appid") or e.get("_steamAppid") or (self.controllers.find(e["title"]) if e.get("_lookup") else None)
        return self.controllers.info(appid) if appid else {}

    def _public(self, e: dict[str, Any]) -> dict[str, Any]:
        """
        Keyboard & mouse, decided in this order: agent.json "kbm" override, a Playnite tag
        (or "requiresKbm" on a custom game), the library's own controller info, the Steam
        store listing. If nothing is known, no prompt.
        """
        item = {k: v for k, v in e.items() if not k.startswith("_")}
        item.setdefault("favorite", True)
        item.setdefault("installed", True)
        if e.get("_appid") or e.get("_lookup"):
            store = self._steam_info(e)
            if item.get("controller", "unknown") == "unknown" and store.get("controller") not in (None, "unknown"):
                item["controller"] = store["controller"]
            if not item.get("rating") and store.get("rating"):
                item["rating"] = store["rating"]
            item["requiresKbm"] = item["controller"] == "none"
        if e.get("_tagKbm") is not None:
            item["requiresKbm"] = bool(e["_tagKbm"])
        overrides: dict[str, bool] = self.cfg.get("kbm", {})
        if e["title"] in overrides:
            item["requiresKbm"] = overrides[e["title"]]
        return item

    def public(self) -> list[dict[str, Any]]:
        return sorted((self._public(e) for e in list(self.entries.values())), key=lambda g: g["title"].lower())


# --------------------------------------------------------------------------------------
# Moonlight pairing: enter the TV's PIN into Apollo/Sunshine for you
# --------------------------------------------------------------------------------------


def apollo_pin(apollo: dict[str, Any], pin: str, name: str) -> dict[str, Any]:
    """POST the PIN to Apollo/Sunshine's web API (https://localhost:47990/api/pin).

    Needs the web UI login in agent.json ("apollo": {"username", "password"}). Without it the
    TV shows the PIN and a QR code for the PIN page instead.
    """
    if not re.fullmatch(r"\d{4}", pin):
        return {"ok": False, "error": "bad pin"}
    user, password = apollo.get("username"), apollo.get("password")
    if not user or not password:
        return {"ok": False, "error": "no Apollo login in agent.json"}
    import base64
    import ssl

    url = str(apollo.get("url") or "https://localhost:47990").rstrip("/") + "/api/pin"
    auth = base64.b64encode(f"{user}:{password}".encode()).decode()
    req = urllib.request.Request(
        url,
        data=json.dumps({"pin": pin, "name": name}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Basic {auth}"},
        method="POST",
    )
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # Apollo/Sunshine use a self-signed certificate on localhost
    try:
        with urllib.request.urlopen(req, timeout=8, context=ctx) as res:
            reply = json.loads(res.read() or b"{}")
            ok = str(reply.get("status", "true")).lower() == "true"
            return {"ok": ok, "error": None if ok else "Apollo rejected the PIN"}
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "error": str(err)}


# --------------------------------------------------------------------------------------
# Launching
# --------------------------------------------------------------------------------------


def open_uri(uri: str) -> None:
    if IS_WINDOWS:
        os.startfile(uri)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", uri])
    elif uri.startswith("steam://"):
        subprocess.Popen(["steam", uri], start_new_session=True)
    else:
        webbrowser.open(uri)


def process_paths() -> list[tuple[int, str]]:
    """(pid, executable path) for every process we can see. Fast: no PowerShell."""
    out: list[tuple[int, str]] = []
    if IS_WINDOWS:
        import ctypes
        from ctypes import wintypes

        psapi, k32 = ctypes.WinDLL("psapi"), ctypes.WinDLL("kernel32")  # type: ignore[attr-defined]
        pids = (wintypes.DWORD * 8192)()
        needed = wintypes.DWORD()
        if not psapi.EnumProcesses(ctypes.byref(pids), ctypes.sizeof(pids), ctypes.byref(needed)):
            return out
        for pid in pids[: needed.value // ctypes.sizeof(wintypes.DWORD)]:
            handle = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                continue
            try:
                buf = ctypes.create_unicode_buffer(1024)
                size = wintypes.DWORD(1024)
                if k32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                    out.append((int(pid), buf.value))
            finally:
                k32.CloseHandle(handle)
        return out
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                out.append((int(pid), os.readlink(f"/proc/{pid}/exe")))
            except OSError:
                pass
    return out


def processes_under(directory: str, paths=process_paths) -> list[int]:
    """PIDs whose executable lives under `directory` (a game's install folder)."""
    directory = os.path.normcase(os.path.abspath(directory))
    if len(directory) < 8:  # refuse something silly like C:\ or /
        return []
    return [pid for pid, exe in paths() if os.path.normcase(exe).startswith(directory + os.sep)]


def kill_processes_under(directory: str) -> int:
    """Close every process whose executable lives under `directory` (used for Steam/Playnite games).
    Uses the same process list as game detection (PowerShell's Get-Process often can't read a game's
    path, so it silently closed nothing). Checks again and retries once. Returns how many it closed."""
    closed = 0
    for attempt in range(2):
        pids = processes_under(directory)
        if not pids:
            break
        for pid in pids:
            if IS_WINDOWS:
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True)
            else:
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
        closed += len(pids)
        time.sleep(1.0)
    left = processes_under(directory)
    log(f"closed {closed} process(es) in {directory}" + (f"; {len(left)} still running" if left else ""))
    return closed


# --------------------------------------------------------------------------------------
# Loading cover: hides the desktop on the stream while a game starts
# --------------------------------------------------------------------------------------


def visible_window_pids(min_w: int = 640, min_h: int = 360) -> set[int]:
    """PIDs owning a visible, reasonably large top-level window (Windows only)."""
    if not IS_WINDOWS:
        return set()
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32  # type: ignore[attr-defined]
    pids: set[int] = set()

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def each(hwnd, _):  # noqa: ANN001
        if not user32.IsWindowVisible(hwnd) or user32.IsIconic(hwnd):
            return True
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        if rect.right - rect.left >= min_w and rect.bottom - rect.top >= min_h:
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            pids.add(int(pid.value))
        return True

    user32.EnumWindows(each, 0)
    return pids


def cover_art_file(art: str | None) -> str | None:
    """A local file for the cover's box art: as given, or a Steam/web picture downloaded once to a temp cache."""
    if not art:
        return None
    if not art.startswith(("http://", "https://")):
        return art if Path(art).is_file() else None
    import tempfile

    cache = Path(tempfile.gettempdir()) / "hearth-cover-art"
    target = cache / (hashlib.sha1(art.encode()).hexdigest()[:16] + Path(urllib.parse.urlsplit(art).path).suffix)
    if not target.is_file():
        try:
            cache.mkdir(parents=True, exist_ok=True)
            with urllib.request.urlopen(art, timeout=4) as res:
                target.write_bytes(res.read())
        except Exception:  # noqa: BLE001 - no art is fine
            return None
    return str(target)


def compose_cover(title: str, art: str | None, w: int, h: int):  # noqa: ANN201 - PIL.Image or None
    """
    The PC's loading screen drawn the same way as the TV's (web/src/components/LoadingCover.tsx, .cover-* in
    styles.css): blurred box art behind, the poster on the left, the title and "Starting…" beside it. When
    Moonlight's stream window briefly shows this before Hearth's cover is back on top, it looks the same.
    Needs Pillow; returns None without it.
    """
    try:
        from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont
    except ImportError:
        return None
    rem = w / 120  # the TV sizes everything in rem: 1/120 of the screen width
    bg_colour = (7, 9, 14)
    img = Image.new("RGB", (w, h), bg_colour)
    poster = None
    if art:
        try:
            poster = Image.open(art).convert("RGB")
        except Exception:  # noqa: BLE001
            poster = None
    if poster is not None:
        # Background: the art covering 110% of the screen, blurred, a little more saturated, at 55%.
        bw, bh = int(w * 1.1), int(h * 1.1)
        ratio = max(bw / poster.width, bh / poster.height)
        back = poster.resize((max(1, int(poster.width * ratio)), max(1, int(poster.height * ratio))))
        back = back.crop(((back.width - w) // 2, (back.height - h) // 2, (back.width - w) // 2 + w, (back.height - h) // 2 + h))
        back = ImageEnhance.Color(back.filter(ImageFilter.GaussianBlur(2.5 * rem))).enhance(1.2)
        img = Image.blend(img, back, 0.55)
    # Shade: darker towards the edges, centred left of middle (radial-gradient at 30% 50%).
    small = Image.new("L", (192, 108))
    px = small.load()
    for y in range(108):
        for x in range(192):
            d = min(1.0, ((((x / 191) - 0.3) / 0.7) ** 2 + (((y / 107) - 0.5) / 0.5) ** 2) ** 0.5 / 1.2)
            px[x, y] = int(255 * 0.6 * d)
    img = Image.composite(Image.new("RGB", (w, h), (0, 0, 0)), img, small.resize((w, h)))
    draw = ImageDraw.Draw(img)
    # Poster card: 22rem wide, 2:3, rounded, with a soft shadow, 8rem from the left, vertically centred.
    pw, ph = int(22 * rem), int(33 * rem)
    px0, py0 = int(8 * rem), (h - ph) // 2
    shadow = Image.new("L", (w, h), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((px0, py0 + int(2.5 * rem), px0 + pw, py0 + ph + int(2.5 * rem)), radius=int(1.2 * rem), fill=150)
    img = Image.composite(Image.new("RGB", (w, h), (0, 0, 0)), img, shadow.filter(ImageFilter.GaussianBlur(3 * rem)))
    draw = ImageDraw.Draw(img)
    card = Image.new("RGB", (pw, ph), (26, 29, 36))
    if poster is not None:
        ratio = max(pw / poster.width, ph / poster.height)
        fit = poster.resize((max(1, int(poster.width * ratio)), max(1, int(poster.height * ratio))))
        card = fit.crop(((fit.width - pw) // 2, (fit.height - ph) // 2, (fit.width - pw) // 2 + pw, (fit.height - ph) // 2 + ph))
    mask = Image.new("L", (pw, ph), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, pw - 1, ph - 1), radius=int(1.2 * rem), fill=255)
    img.paste(card, (px0, py0), mask)

    def font(names: list[str], size: float):  # noqa: ANN202
        for name in names:
            try:
                return ImageFont.truetype(name, int(size))
            except OSError:
                continue
        return ImageFont.load_default()

    big = font(["seguibl.ttf", "segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"], 4 * rem)
    small_font = font(["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"], 1.5 * rem)
    # Title: wrapped to the space right of the poster, 4rem from it.
    tx = px0 + pw + int(4 * rem)
    max_w = w - tx - int(8 * rem)
    lines: list[str] = []
    for word in title.split():
        if lines and draw.textlength(lines[-1] + " " + word, font=big) <= max_w:
            lines[-1] += " " + word
        else:
            lines.append(word)
    line_h = int(4 * rem * 1.05)
    block_h = line_h * len(lines) + int(1.4 * rem) + int(1.5 * rem * 1.3)
    ty = (h - block_h) // 2
    for i, line in enumerate(lines[:3]):
        draw.text((tx, ty + i * line_h), line, font=big, fill=(242, 244, 248))
    sy = ty + line_h * min(len(lines), 3) + int(1.4 * rem)
    # Three accent dots, then "Starting <title>…".
    dot, gap = 0.6 * rem, 0.4 * rem
    for i, alpha in enumerate((1.0, 0.6, 0.3)):
        cx = tx + i * (dot + gap)
        colour = tuple(int(bg + (fg - bg) * alpha) for bg, fg in zip(bg_colour, (123, 140, 255)))
        draw.ellipse((cx, sy + rem * 0.45, cx + dot, sy + rem * 0.45 + dot), fill=colour)
    draw.text((tx + 3 * dot + 2 * gap + rem, sy), f"Starting {title}…", font=small_font, fill=(160, 164, 172))
    return img


def show_cover(title: str, art: str | None = None) -> None:
    """
    Run as `hearth_agent.py --cover TITLE [ART]`: a full-screen "loading" window in Hearth's style.
    It stays on top but never takes focus or clicks, so the game starting underneath gets focus
    as usual. The agent closes it once the game's window is up.
    """
    import tkinter as tk

    root = tk.Tk()
    root.overrideredirect(True)
    root.configure(bg="#07090e", cursor="none")
    w, h = root.winfo_screenwidth(), root.winfo_screenheight()
    root.geometry(f"{w}x{h}+0+0")
    root.attributes("-topmost", True)
    root.attributes("-alpha", 0.995)  # layered window, needed for click-through below
    scale = h / 1080
    art = cover_art_file(art)
    composed = compose_cover(title, art, w, h)
    if composed is not None:
        # The same picture as the TV's loading screen, so a glimpse of it on the stream doesn't look like a flash.
        from PIL import ImageTk

        full = ImageTk.PhotoImage(composed)
        tk.Label(root, image=full, bg="#07090e", borderwidth=0).place(x=0, y=0, width=w, height=h)
        root._full = full  # type: ignore[attr-defined]  # keep a reference
        art = None  # drawn already
    frame = tk.Frame(root, bg="#07090e")
    if composed is None:
        frame.place(relx=0.5, rely=0.5, anchor="center")
    img = None
    if art and Path(art).is_file():
        try:
            # Pillow (installed by setup-windows.ps1) reads the JPEG covers Playnite and LaunchBox use.
            from PIL import Image, ImageTk

            pic = Image.open(art)
            pic.thumbnail((int(420 * scale * 0.75), int(420 * scale)))
            img = ImageTk.PhotoImage(pic)
        except Exception:  # noqa: BLE001 - no Pillow: Tk itself only reads PNG and GIF
            if art.lower().endswith((".png", ".gif")):
                try:
                    img = tk.PhotoImage(file=art)
                    img = img.subsample(max(1, round(img.height() / (420 * scale))))
                except tk.TclError:
                    img = None
    if img is not None:
        tk.Label(frame, image=img, bg="#07090e").pack(pady=(0, int(30 * scale)))
        root._art = img  # type: ignore[attr-defined]  # keep a reference
    if composed is None:
        tk.Label(frame, text=title, fg="#f2f4f8", bg="#07090e", font=("Segoe UI Semibold", int(54 * scale))).pack()
        status = tk.Label(frame, text="Starting", fg="#8c93a8", bg="#07090e", font=("Segoe UI", int(24 * scale)))
        status.pack(pady=(int(14 * scale), 0))
        dots = [0]

        def tick() -> None:
            dots[0] = (dots[0] + 1) % 4
            status.configure(text="Starting" + "." * dots[0])
            root.after(450, tick)

        tick()
    if IS_WINDOWS:
        import ctypes

        root.update_idletasks()
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        hwnd = user32.GetParent(root.winfo_id()) or root.winfo_id()
        GWL_EXSTYLE, WS_EX_TRANSPARENT, WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE, WS_EX_LAYERED = -20, 0x20, 0x80, 0x08000000, 0x80000
        style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED)
    root.after(int(float(os.environ.get("HEARTH_COVER_MAX", "120")) * 1000), root.destroy)  # never stay up forever
    root.mainloop()


class LoadingCover:
    """The --cover window for one launch, and the watcher that takes it down."""

    def __init__(self, cfg: dict[str, Any]) -> None:
        c = cfg.get("loadingCover", {})
        self.enabled = bool(c.get("enabled", True)) and IS_WINDOWS
        self.timeout = float(c.get("timeoutSeconds", 90))
        self.reveal = float(c.get("revealSeconds", 2))
        self.proc: subprocess.Popen[bytes] | None = None

    def show(self, entry: dict[str, Any], game_pids) -> None:  # noqa: ANN001 - callable returning set[int]
        self.close()
        if not self.enabled:
            return
        # A local cover file, or the web picture (Steam) for the cover window to fetch.
        web = entry.get("art") if isinstance(entry.get("art"), str) and str(entry.get("art")).startswith("http") else ""
        art = entry.get("_artPath") or web or ""
        exe = sys.executable.replace("python.exe", "pythonw.exe")
        try:
            self.proc = subprocess.Popen([exe, str(Path(__file__).resolve()), "--cover", entry["title"], art])
        except OSError as err:
            log(f"loading cover: {err}")
            return
        proc = self.proc

        def watch() -> None:
            deadline = time.time() + self.timeout
            while time.time() < deadline and self.proc is proc and proc.poll() is None:
                time.sleep(0.5)
                pids = game_pids()
                if pids and pids & visible_window_pids():
                    time.sleep(self.reveal)  # let the game draw its first frames
                    break
            if self.proc is proc:
                self.close()

        threading.Thread(target=watch, daemon=True).start()

    def close(self) -> None:
        proc, self.proc = self.proc, None
        if proc and proc.poll() is None:
            proc.terminate()

    @property
    def showing(self) -> bool:
        """The cover is still up: the game's window hasn't appeared yet."""
        return bool(self.proc and self.proc.poll() is None)


class Launcher:
    #: A started process that exits this quickly was a launcher stub (explorer.exe shell:…,
    #: a game's own launcher), not the game itself, so its exit doesn't mean "game over".
    STUB_SECONDS = 15.0

    def __init__(self) -> None:
        self.proc: subprocess.Popen[bytes] | None = None
        self.current: dict[str, Any] | None = None
        # Bumped by /stop, so a launch still waiting for Apollo's display is abandoned.
        self.generation = 0
        self.launched_at = 0.0
        self.seen_running = False
        self.misses = 0
        self.proc_exited_at: float | None = None

    def launch(self, entry: dict[str, Any]) -> None:
        self.stop()
        spec = entry["_launch"]
        log(f"launch {entry['title']}")
        kwargs: dict[str, Any] = {"cwd": spec.get("cwd") or None}
        if IS_WINDOWS:
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
        else:
            kwargs["start_new_session"] = True
        if spec.get("command"):
            self.proc = subprocess.Popen(spec["command"], **kwargs)
        elif spec.get("commandLine"):
            # LaunchBox emulator command lines are pre-quoted strings; Windows takes them verbatim.
            line = spec["commandLine"]
            self.proc = subprocess.Popen(line if IS_WINDOWS else shlex.split(line), **kwargs)
        elif spec.get("file"):
            target, args = spec["file"], spec.get("args") or ""
            if IS_WINDOWS:
                os.startfile(target, "open", args, str(Path(target).parent))  # type: ignore[attr-defined]  # .exe, .lnk, .url
            elif target.endswith((".sh", ".AppImage")) or os.access(target, os.X_OK):
                self.proc = subprocess.Popen([target, *shlex.split(args)], cwd=str(Path(target).parent), start_new_session=True)
            else:
                open_uri(target)
        elif spec.get("uri"):
            open_uri(spec["uri"])
        else:
            raise ValueError(f"{entry['title']} has no command or uri")
        self.current = entry
        self.launched_at = time.time()
        self.misses = 0
        self.proc_exited_at = None
        # We started this process ourselves, so we know the game started.
        self.seen_running = self.proc is not None
        if self.proc is not None:
            proc = self.proc

            def watch() -> None:
                proc.wait()
                if self.proc is proc:
                    self.proc_exited_at = time.time()

            threading.Thread(target=watch, daemon=True).start()

    def _alive(self) -> bool | None:
        """Is the game process there? None when we have no way to tell."""
        e = self.current
        if not e:
            return None
        proc_alive = self.proc is not None and self.proc.poll() is None
        stub = self.proc_exited_at is not None and self.proc_exited_at - self.launched_at < self.STUB_SECONDS
        if e.get("_processDir"):
            return proc_alive or bool(processes_under(e["_processDir"]))
        if self.proc is not None and not stub:
            return proc_alive
        return None

    def game_running(self) -> bool | None:
        """
        True while the game runs, False once it has exited (quit from inside the game), None
        if we can't tell. Only says False after the game was seen running and then missing
        twice in a row, so a slow-starting game (Steam, launchers) never ends the stream early.
        """
        alive = self._alive()
        if alive is None and self.proc_exited_at is not None and self.proc_exited_at - self.launched_at < self.STUB_SECONDS:
            self.seen_running = False  # that was a launcher; only trust what we can observe from now on
        if alive:
            self.seen_running = True
            self.misses = 0
            return True
        if alive is None or not self.seen_running:
            return None
        self.misses += 1
        return False if self.misses >= 2 else True

    def game_pids(self) -> set[int]:
        """Processes that belong to the running game: the one we started, and anything in its folder."""
        pids: set[int] = set()
        if self.proc is not None and self.proc.poll() is None:
            pids.add(self.proc.pid)
        if self.current and self.current.get("_processDir"):
            pids.update(processes_under(self.current["_processDir"]))
        return pids

    def stop(self) -> None:
        self.generation += 1
        if self.current:
            log(f"stopping {self.current['title']}")
        if self.proc and self.proc.poll() is None:
            log("stopping game process")
            if IS_WINDOWS:
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.proc.pid)], capture_output=True)
            else:
                try:
                    os.killpg(self.proc.pid, signal.SIGTERM)
                except OSError:
                    pass
        if self.current and self.current.get("_processDir"):
            kill_processes_under(self.current["_processDir"])
        self.proc = None
        self.current = None


# ---- Controllers for emulators ---------------------------------------------------------

# Switch emulators from the yuzu family share yuzu's settings format.
YUZU_FAMILY = ("eden", "yuzu", "suyu", "sudachi", "citron", "torzu")
MAX_PLAYERS = 8


def emulator_exe(spec: dict[str, Any]) -> str | None:
    """The emulator's .exe path from a launch spec (LaunchBox command line or an argv list)."""
    if spec.get("commandLine"):
        m = re.match(r'\s*"([^"]+)"|\s*(\S+)', spec["commandLine"])
        return (m.group(1) or m.group(2)) if m else None
    if spec.get("command"):
        return spec["command"][0]
    return None


def yuzu_config_path(exe: str, cfg: dict[str, Any]) -> Path | None:
    """Where an Eden/yuzu install keeps qt-config.ini: agent.json override, portable "user" folder, or AppData."""
    stem = Path(exe.replace("\\", "/")).stem.lower()
    family = next((f for f in YUZU_FAMILY if f in stem), None)
    if not family:
        return None
    override = cfg.get("controllers", {}).get(family, {}).get("config")
    candidates = [Path(override)] if override else []
    exe_dir = Path(exe).parent
    candidates += [exe_dir / "user" / "config" / "qt-config.ini"]
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates += [Path(appdata) / family / "config" / "qt-config.ini"]
    candidates += [Path.home() / ".config" / family / "qt-config.ini"]
    return next((c for c in candidates if c.is_file()), None)


def set_yuzu_players(text: str, players: int) -> str | None:
    """
    Rewrite the [Controls] section of a yuzu-family qt-config.ini so players 1..N are connected
    and the rest are not, and players 2..N use Player 1's mapping on controller ports 2..N
    (Apollo gives every TV controller its own virtual Xbox pad, in order). Returns None if the
    file doesn't look like a yuzu config, so nothing is touched.
    """
    lines = text.splitlines()
    start = next((i for i, l in enumerate(lines) if l.strip() == "[Controls]"), None)
    if start is None:
        return None
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("[")), len(lines))
    section = lines[start + 1 : end]
    values: dict[str, str] = {}
    order: list[str] = []
    for line in section:
        if "=" in line:
            k, v = line.split("=", 1)
            values[k] = v
            order.append(k)
    p1 = {k[len("player_0_") :]: v for k, v in values.items() if k.startswith("player_0_") and "\\" not in k}
    if not any("port:" in v for v in p1.values()):
        return None  # Player 1 isn't mapped to a controller; leave the file alone

    def put(key: str, value: str) -> None:
        if key not in values:
            order.append(key)
        values[key] = value

    players = max(1, min(MAX_PLAYERS, players))
    for n in range(MAX_PLAYERS):
        put(f"player_{n}_connected\\default", "false")
        put(f"player_{n}_connected", "true" if n < players else "false")
    for n in range(1, players):
        for name, value in p1.items():
            if name == "connected":
                continue
            if name == "type" or "port:" in value:
                put(f"player_{n}_{name}\\default", "false")
                put(f"player_{n}_{name}", re.sub(r"port:\d+", f"port:{n}", value))
    rebuilt = [f"{k}={values[k]}" for k in order]
    return "\n".join(lines[: start + 1] + rebuilt + lines[end:]) + ("\n" if text.endswith("\n") else "")


def configure_players(entry: dict[str, Any], players: int | None, cfg: dict[str, Any]) -> str | None:
    """Before launching an emulator, set it up for the number of controllers on the TV."""
    if not players or cfg.get("controllers", {}).get("enabled", True) is False:
        return None
    exe = emulator_exe(entry.get("_launch", {}))
    path = yuzu_config_path(exe, cfg) if exe else None
    if not path:
        return None
    text = path.read_text(encoding="utf-8")
    updated = set_yuzu_players(text, players)
    if updated is None:
        log(f"{path}: Player 1 isn't mapped to a controller in the emulator; not changing players")
        return None
    backup = path.with_name(path.name + ".hearth-backup")
    if not backup.exists():
        backup.write_text(text, encoding="utf-8")
    if updated != text:
        path.write_text(updated, encoding="utf-8")
    log(f"{Path(exe.replace(chr(92), '/')).stem}: {players} player(s) connected")
    return str(path)


# ---- Apollo / virtual display ---------------------------------------------------------


def active_displays() -> list[str]:
    """Names of the display adapters Windows currently has attached to the desktop."""
    if not IS_WINDOWS:
        return []
    import ctypes
    from ctypes import wintypes

    class DISPLAY_DEVICEW(ctypes.Structure):  # noqa: N801 - Win32 name
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("DeviceName", wintypes.WCHAR * 32),
            ("DeviceString", wintypes.WCHAR * 128),
            ("StateFlags", wintypes.DWORD),
            ("DeviceID", wintypes.WCHAR * 128),
            ("DeviceKey", wintypes.WCHAR * 128),
        ]

    ATTACHED_TO_DESKTOP = 0x1
    names, i = [], 0
    while True:
        dd = DISPLAY_DEVICEW()
        dd.cb = ctypes.sizeof(dd)
        if not ctypes.windll.user32.EnumDisplayDevicesW(None, i, ctypes.byref(dd), 0):  # type: ignore[attr-defined]
            break
        if dd.StateFlags & ATTACHED_TO_DESKTOP:
            names.append(dd.DeviceString)
        i += 1
    return names


def wait_for_virtual_display(cfg: dict[str, Any], displays=active_displays, sleep=time.sleep) -> bool:
    """
    With Apollo, the virtual monitor only exists once the TV's stream has connected, and the
    real monitors are switched off at that moment. Wait for it before starting the game, so the
    game opens on the virtual display at the TV's resolution instead of on a monitor that's
    about to disappear. Returns False on timeout (the game is started anyway).
    """
    vd = cfg.get("virtualDisplay", {})
    match = vd.get("match", "Virtual Display").lower()  # Apollo's SudoVDA: "SudoMaker Virtual Display Adapter"
    timeout = float(vd.get("timeoutSeconds", 45))
    settle = float(vd.get("settleSeconds", 2))
    if not IS_WINDOWS and displays is active_displays:
        sleep(float(vd.get("fallbackSeconds", 5)))  # can't see displays here: just give the stream a head start
        return True
    deadline = time.time() + timeout
    while time.time() < deadline:
        if any(match in name.lower() for name in displays()):
            sleep(settle)  # let Windows finish moving to the new display layout
            return True
        sleep(0.5)
    log(f"virtual display matching '{match}' didn't appear within {timeout:.0f}s; starting the game anyway")
    return False


def stream_display_active(cfg: dict[str, Any], displays=active_displays) -> bool | None:
    """True while Apollo's virtual display exists (a stream is connected); None where we can't tell."""
    if not IS_WINDOWS and displays is active_displays:
        return None
    match = cfg.get("virtualDisplay", {}).get("match", "Virtual Display").lower()
    return any(match in name.lower() for name in displays())


def apollo_close(apollo: dict[str, Any]) -> bool:
    """Ask Apollo/Sunshine to end the running app (and so the stream session). Needs the web login."""
    user, password = apollo.get("username"), apollo.get("password")
    if not user or not password:
        return False
    import base64
    import ssl

    import http.cookiejar
    import urllib.error

    base = str(apollo.get("url") or "https://localhost:47990").rstrip("/")
    auth = base64.b64encode(f"{user}:{password}".encode()).decode()
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    json_headers = {"Content-Type": "application/json"}
    try:
        # Sunshine and older Apollo: HTTP basic auth on every API call.
        req = urllib.request.Request(base + "/api/apps/close", data=b"{}", headers={**json_headers, "Authorization": f"Basic {auth}"}, method="POST")
        with urllib.request.urlopen(req, timeout=6, context=ctx):
            log("Apollo: ended the session")
            return True
    except urllib.error.HTTPError as err:
        if err.code not in (401, 403):
            log(f"Apollo close: HTTP {err.code} {err.reason}")
            return False
        log(f"Apollo close: basic login refused (HTTP {err.code}); trying Apollo's login page")
    except Exception as err:  # noqa: BLE001
        log(f"Apollo close: {err}")
        return False
    try:
        # Newer Apollo: log in once for a session cookie, then call the API with it.
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx), urllib.request.HTTPCookieProcessor(jar))
        body = json.dumps({"username": user, "password": password}).encode()
        opener.open(urllib.request.Request(base + "/api/login", data=body, headers=json_headers, method="POST"), timeout=6).read()
        opener.open(urllib.request.Request(base + "/api/apps/close", data=b"{}", headers=json_headers, method="POST"), timeout=6).read()
        log("Apollo: ended the session (login page)")
        return True
    except urllib.error.HTTPError as err:
        log(f"Apollo close (login page): HTTP {err.code} {err.reason}. Check the Apollo username and password in agent.json")
    except Exception as err:  # noqa: BLE001
        log(f"Apollo close (login page): {err}")
    return False


def presence() -> dict[str, Any]:
    """Is someone sitting at this PC? Seconds since the last keyboard/mouse/controller input, whether
    the desktop is locked, and the window in front (and whether it fills its screen, like a game).
    Hearth uses it to grey out this PC's games so a stream doesn't take over the screen by accident.
    Windows only; elsewhere every value is None ("can't tell")."""
    out: dict[str, Any] = {"idleSeconds": None, "locked": None, "foreground": None}
    if not IS_WINDOWS:
        return out
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]

        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]

        info = LASTINPUTINFO(ctypes.sizeof(LASTINPUTINFO), 0)
        if user32.GetLastInputInfo(ctypes.byref(info)):
            # Both are 32-bit millisecond tick counts; the mask handles the 49-day wrap.
            out["idleSeconds"] = int(((kernel32.GetTickCount() - info.dwTime) & 0xFFFFFFFF) / 1000)

        # The lock screen (and UAC prompts) live on a secure desktop we're not allowed to open.
        DESKTOP_SWITCHDESKTOP = 0x0100
        desk = user32.OpenInputDesktop(0, False, DESKTOP_SWITCHDESKTOP)
        out["locked"] = not desk
        if desk:
            user32.CloseDesktop(desk)

        hwnd = user32.GetForegroundWindow()
        if hwnd and not out["locked"]:
            title = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, title, 256)
            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))

            class MONITORINFO(ctypes.Structure):
                _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

            mon = MONITORINFO(ctypes.sizeof(MONITORINFO))
            fullscreen = False
            if user32.GetMonitorInfoW(user32.MonitorFromWindow(hwnd, 2), ctypes.byref(mon)):  # 2 = nearest
                m = mon.rcMonitor
                fullscreen = rect.left <= m.left and rect.top <= m.top and rect.right >= m.right and rect.bottom >= m.bottom
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            exe = ""
            handle = kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
            if handle:
                buf = ctypes.create_unicode_buffer(1024)
                size = wintypes.DWORD(1024)
                if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                    exe = Path(buf.value).name
                kernel32.CloseHandle(handle)
            # The desktop itself (explorer's wallpaper window) "fills the screen" but isn't an app.
            desktop = exe.lower() == "explorer.exe" and not title.value
            out["foreground"] = {"title": title.value, "exe": exe, "fullscreen": bool(fullscreen and not desktop)}
    except Exception as err:  # noqa: BLE001 - presence is best-effort
        log(f"presence: {err}")
    return out


def uptime_seconds() -> int:
    try:
        if IS_WINDOWS:
            import ctypes

            return int(ctypes.windll.kernel32.GetTickCount64() / 1000)  # type: ignore[attr-defined]
        return int(float(Path("/proc/uptime").read_text().split()[0]))
    except Exception:
        return 0


POWER_COMMANDS = {
    "shutdown": (["shutdown", "/s", "/t", "5"], ["systemctl", "poweroff"]),
    "restart": (["shutdown", "/r", "/t", "5"], ["systemctl", "reboot"]),
    "sleep": (["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"], ["systemctl", "suspend"]),
}


def power(action: str) -> None:
    win, nix = POWER_COMMANDS[action]
    log(f"power: {action}")
    # Give the HTTP reply a moment to go out before the PC goes away.
    threading.Timer(1.0, lambda: subprocess.Popen(win if IS_WINDOWS else nix)).start()


# --------------------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------------------


def make_handler(cfg: dict[str, Any], library: Library, launcher: Launcher):
    cover = LoadingCover(cfg)
    token = cfg["token"]

    class Handler(BaseHTTPRequestHandler):
        server_version = "HearthAgent/1"

        def log_message(self, fmt: str, *args: Any) -> None:  # quieter logs
            if os.environ.get("HEARTH_AGENT_DEBUG"):
                super().log_message(fmt, *args)

        def _json(self, code: int, body: Any, etag: bool = False) -> None:
            data = json.dumps(body).encode()
            tag = f'"{hashlib.sha1(data).hexdigest()[:20]}"' if etag else None
            if tag and self.headers.get("If-None-Match") == tag:
                # The TV already has this exact library: say so instead of sending it again.
                self.send_response(304)
                self.send_header("ETag", tag)
                self.end_headers()
                return
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            if tag:
                self.send_header("ETag", tag)
            self.end_headers()
            self.wfile.write(data)

        def _authed(self) -> bool:
            if self.headers.get("Authorization") == f"Bearer {token}":
                return True
            self._json(401, {"error": "unauthorized"})
            return False

        def _file(self, path: str | None) -> None:
            if not path or not Path(path).is_file():
                return self._json(404, {"error": "no image"})
            data = Path(path).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(path)[0] or "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "max-age=3600")
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length) or b"{}") if length else {}

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                current = launcher.current["title"] if launcher.current else None
                running = launcher.game_running() if launcher.current else None
                return self._json(200, {"ok": True, "host": socket.gethostname(), "uptime": uptime_seconds(), "playing": current,
                                        "gameRunning": running, "streamDisplay": stream_display_active(cfg),
                                        "presence": presence(), "covering": cover.showing})
            if not self._authed():
                return
            url = urllib.parse.urlsplit(self.path)
            qs = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            if url.path == "/games":
                return self._json(200, library.public(), etag=True)
            if url.path == "/browse/sources":
                return self._json(200, library.browse_sources())
            if url.path == "/browse":
                return self._json(200, library.browse(qs.get("source", "pc"), qs.get("platform", ""), qs.get("q", ""),
                                                      int(qs.get("offset", 0)), min(int(qs.get("limit", 120)), 500)))
            if url.path.startswith("/details/"):
                found = library.details(urllib.parse.unquote(url.path[9:]))
                return self._json(200, found) if found else self._json(404, {"error": "unknown game"})
            if url.path.startswith("/shot/"):
                gid, _, n = urllib.parse.unquote(url.path[6:]).rpartition("/")
                return self._file(library.shot_path(gid, int(n or 0)))
            if self.path.startswith("/art/"):
                return self._file(library.art_path(urllib.parse.unquote(url.path[5:])))
            self._json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if not self._authed():
                return
            try:
                if self.path == "/pair":
                    body = self._body()
                    return self._json(200, apollo_pin(cfg.get("apollo") or {}, str(body.get("pin", "")), str(body.get("name", "Hearth TV"))))
                if self.path == "/launch":
                    body = self._body()
                    gid = body.get("id", "")
                    entry = library.get(gid)
                    if not entry:
                        return self._json(404, {"error": f"unknown game {gid}"})
                    # Close any running game first: Eden & co. save their settings on exit and
                    # would overwrite the controller setup below.
                    launcher.stop()
                    try:
                        configure_players(entry, body.get("players"), cfg)
                    except Exception as err:  # never block a launch over controller setup
                        log(f"controller setup skipped: {err}")
                    if body.get("waitForDisplay"):
                        log(f"waiting for Apollo's virtual display before starting {entry['title']}")
                        generation = launcher.generation
                        wait_for_virtual_display(cfg)
                        if launcher.generation != generation:
                            log("stream ended while waiting; not starting the game")
                            return self._json(409, {"error": "The stream ended before the game started"})
                    if body.get("cover"):
                        cover.show(entry, launcher.game_pids)
                    launcher.launch(entry)
                    return self._json(200, {"ok": True})
                if self.path == "/power":
                    action = self._body().get("action", "")
                    if not cfg.get("allowPower", True) or action not in POWER_COMMANDS:
                        return self._json(403, {"error": "power control is off"})
                    power(action)
                    return self._json(200, {"ok": True})
                if self.path == "/stop":
                    cover.close()
                    launcher.stop()
                    # Ending the app in Apollo removes its virtual display, so the real monitors come back.
                    closed = apollo_close(cfg.get("apollo") or {}) if self._body().get("endSession") else False
                    return self._json(200, {"ok": True, "sessionEnded": closed})
                if self.path == "/rescan":
                    library.scan()
                    return self._json(200, {"ok": True})
            except Exception as err:
                log(f"error: {err}")
                return self._json(500, {"error": str(err)})
            self._json(404, {"error": "not found"})

    return Handler


def check_title(title: str) -> None:
    """Synchronous Steam lookup, for checking the keyboard/mouse decision from a terminal."""
    url = STEAM_SEARCH.format(term=urllib.parse.quote(title))
    with urllib.request.urlopen(url, timeout=10) as res:
        items = json.load(res).get("items", [])
    print("Steam search:", ", ".join(f"{i.get('name')} ({i.get('id')})" for i in items[:5]) or "no results")
    appid = match_search(title, items)
    if not appid:
        print("No exact match -> controller unknown -> no keyboard/mouse prompt (tag it in Playnite if needed)")
        return
    with urllib.request.urlopen(STEAM_STORE.format(appid=appid), timeout=10) as res:
        info = parse_steam_store(json.load(res).get(str(appid), {}))
    kbm = info["controller"] == "none"
    print(f"Matched appid {appid}: controller={info['controller']} rating={info.get('rating')} -> {'KEYBOARD & MOUSE prompt' if kbm else 'no prompt'}")


def upgrade_config(cfg_path: Path, example_path: Path) -> tuple[bool, list[str]]:
    """Create or repair agent.json for the installer: make it from the example with a fresh token,
    fix Windows paths written with single backslashes, and add settings new versions introduced.
    Your own values are never changed. Returns (ok, messages)."""
    import secrets

    notes: list[str] = []
    example = json.loads(example_path.read_text(encoding="utf-8"))
    if not cfg_path.exists():
        cfg: dict[str, Any] = dict(example)
        cfg["token"] = secrets.token_hex(16)
        notes.append("Created agent.json")
    else:
        text = cfg_path.read_text(encoding="utf-8-sig")
        try:
            cfg = json.loads(text)
        except json.JSONDecodeError as err:
            # The usual mistake: "C:\Games\x" typed as "C:\Games\x" with single backslashes.
            fixed = re.sub(r'\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\', lambda m: m.group(0) if m.group(1) else "/", text)
            try:
                cfg = json.loads(fixed)
            except json.JSONDecodeError:
                return False, [f"agent.json has a mistake on line {err.lineno}, column {err.colno}: {err.msg}"]
            cfg_path.with_name("agent.json.bak").write_text(text, encoding="utf-8")
            notes.append("Fixed single backslashes in paths (old file saved as agent.json.bak)")
        if not cfg.get("token") or cfg["token"] == "change-me":
            cfg["token"] = secrets.token_hex(16)
            notes.append("Made a new token")
        for key, value in example.items():
            if key not in cfg:
                cfg[key] = value
                notes.append(f'Added new setting "{key}"')
    if notes:
        cfg_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    notes.append(f"TOKEN={cfg['token']}")
    return True, notes


def main() -> None:
    parser = argparse.ArgumentParser(description="Hearth PC agent")
    parser.add_argument("--config", default=str(Path(__file__).with_name("agent.json")))
    parser.add_argument("--list", action="store_true", help="print the detected library and exit")
    parser.add_argument("--check", metavar="TITLE", help="look a game up on the Steam store now and show the keyboard/mouse decision")
    parser.add_argument("--displays", action="store_true", help="list active displays (run while streaming to see Apollo's virtual display)")
    parser.add_argument("--upgrade-config", action="store_true", help="create/repair agent.json and add new settings (used by the installer)")
    parser.add_argument("--cover", nargs="+", metavar=("TITLE", "ART"), help=argparse.SUPPRESS)  # the loading window
    args = parser.parse_args()
    if args.cover:
        show_cover(args.cover[0], args.cover[1] if len(args.cover) > 1 else None)
        return
    if args.upgrade_config:
        ok, notes = upgrade_config(Path(args.config), Path(__file__).with_name("agent.example.json"))
        print("\n".join(notes))
        sys.exit(0 if ok else 1)
    if args.displays:
        print("\n".join(active_displays()) or "No displays found (this only works on Windows)")
        return
    if args.check:
        check_title(args.check)
        return

    cfg_path = Path(args.config)
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    if not cfg.get("token") or cfg["token"] == "change-me":
        sys.exit("Set a random 'token' in agent.json (the same one goes in the TV's config.yaml).")

    library = Library(cfg, cfg_path.parent / "cache")
    library.scan()
    if args.list:
        for g in library.public():
            print(f"{g['platform']:<12} {g['controller']:<8} {'KBM ' if g['requiresKbm'] else '    '}{g['title']}")
        return

    library.start_background()
    port = int(cfg.get("port", 47800))
    server = ThreadingHTTPServer((cfg.get("bind", "0.0.0.0"), port), make_handler(cfg, library, Launcher()))
    log(f"Hearth agent listening on :{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
