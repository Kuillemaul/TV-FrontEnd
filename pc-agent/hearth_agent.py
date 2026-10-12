#!/usr/bin/env python3
"""
Hearth PC agent: runs on your gaming PC and/or emulator PC (Windows or Linux).

It tells the TV which games are installed and starts the one you pick, so that
Moonlight on the TV can stream it through Sunshine. Standard library only.

    python hearth_agent.py --config agent.json

Endpoints (all but /health need "Authorization: Bearer <token>"):
    GET  /health          -> {"ok": true, "host": "..."}
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
STEAM_ART = "https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_600x900.jpg"
# Steam store category ids
CAT_FULL_CONTROLLER = 28
CAT_PARTIAL_CONTROLLER = 18
# Not games: redistributables, Proton, runtimes, Steam tools.
STEAM_SKIP_IDS = {228980, 1070560, 1391110, 1628350, 1493710, 2180100, 250820}
STEAM_SKIP_NAMES = re.compile(r"^(Proton|Steam Linux Runtime|Steamworks|SteamVR|Steam Controller)", re.I)
ROM_TAGS = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]")


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


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
    Looks up each Steam game's store page once, in the background, and caches it on disk:
    controller support, age rating, description, screenshots, genres and release year.
    """

    def __init__(self, path: Path, enabled: bool) -> None:
        self.path = path
        self.enabled = enabled
        self.data: dict[str, dict[str, Any]] = {}
        self.pending: list[int] = []
        self.lock = threading.Lock()
        try:
            raw = json.loads(path.read_text())
            # Older caches stored just the controller string.
            self.data = {k: (v if isinstance(v, dict) else {"controller": v}) for k, v in raw.items()}
        except (OSError, ValueError):
            pass
        if enabled:
            threading.Thread(target=self._worker, daemon=True).start()

    def info(self, appid: int) -> dict[str, Any]:
        value = self.data.get(str(appid))
        if (value is None or "description" not in value) and self.enabled:
            with self.lock:
                if appid not in self.pending:
                    self.pending.append(appid)
        return value or {}

    def get(self, appid: int) -> str:
        return self.info(appid).get("controller", "unknown")

    def _worker(self) -> None:
        while True:
            with self.lock:
                appid = self.pending.pop(0) if self.pending else None
            if appid is None:
                time.sleep(2)
                continue
            try:
                with urllib.request.urlopen(STEAM_STORE.format(appid=appid), timeout=10) as res:
                    body = json.load(res).get(str(appid), {})
                self.data[str(appid)] = parse_steam_store(body)
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self.path.write_text(json.dumps(self.data, indent=1))
            except Exception as err:  # network hiccup or rate limit: retry later
                log(f"store lookup {appid} failed: {err}")
                time.sleep(30)
                with self.lock:
                    self.pending.append(appid)
            time.sleep(1.6)  # stay well under the store API rate limit


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
        if key not in self.art_index:
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
        features = {f.lower() for f in g.get("features") or []}
        tags = {t.lower() for t in g.get("tags") or []}
        controller = "full" if "full controller support" in features else "partial" if "partial controller support" in features else "unknown"
        cover = g.get("cover")
        platforms = g.get("platforms") or []
        ratings = g.get("ageRatings") or []
        return {
            "id": f"pn-{g['id']}",
            "title": g.get("name") or "Unknown",
            "platform": platforms[0] if platforms else "PC",
            "source": "playnite",
            "store": g.get("source") or "",
            "art": bool(cover),
            "controller": controller,
            "requiresKbm": bool(tags & self.kbm_tags) and not (tags & self.pad_tags),
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
                "genres": (g.get("genres") or [])[:3],
                "playtimeMinutes": int((g.get("playtime") or 0) / 60),
            },
        }

    def entries(self) -> dict[str, dict[str, Any]]:
        return {e["id"]: e for e in self._load() if e["favorite"]}

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
        self.controllers = SteamStoreCache(cache_dir / "steam-store.json", steam_cfg.get("controllerLookup", True) and self.steam_enabled)
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
        if e.get("_appid"):
            store = self.controllers.info(e["_appid"])
            info = {**info, **{k: store.get(k) for k in ("description", "year", "genres") if store.get(k)}}
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

    def _public(self, e: dict[str, Any]) -> dict[str, Any]:
        item = {k: v for k, v in e.items() if not k.startswith("_")}
        item.setdefault("favorite", True)
        item.setdefault("installed", True)
        if e.get("_appid"):  # Steam controller support and rating are looked up in the background
            store = self.controllers.info(e["_appid"])
            item["controller"] = store.get("controller", "unknown")
            item["requiresKbm"] = item["controller"] == "none"
            item["rating"] = store.get("rating")
        overrides: dict[str, bool] = self.cfg.get("kbm", {})
        if e["title"] in overrides:
            item["requiresKbm"] = overrides[e["title"]]
        return item

    def public(self) -> list[dict[str, Any]]:
        return sorted((self._public(e) for e in list(self.entries.values())), key=lambda g: g["title"].lower())


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


def kill_processes_under(directory: str) -> None:
    """Close every process whose executable lives under `directory` (used for Steam games)."""
    directory = os.path.normcase(os.path.abspath(directory))
    if len(directory) < 8:  # refuse something silly like C:\ or /
        return
    if IS_WINDOWS:
        ps = (
            "Get-Process | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith($args[0]) } "
            "| Stop-Process -Force"
        )
        subprocess.run(["powershell", "-NoProfile", "-Command", ps, directory.lower()], capture_output=True)
        return
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            exe = os.path.normcase(os.readlink(f"/proc/{pid}/exe"))
        except OSError:
            continue
        if exe.startswith(directory + os.sep):
            try:
                os.kill(int(pid), signal.SIGTERM)
            except OSError:
                pass


class Launcher:
    def __init__(self) -> None:
        self.proc: subprocess.Popen[bytes] | None = None
        self.current: dict[str, Any] | None = None

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

    def stop(self) -> None:
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
    token = cfg["token"]

    class Handler(BaseHTTPRequestHandler):
        server_version = "HearthAgent/1"

        def log_message(self, fmt: str, *args: Any) -> None:  # quieter logs
            if os.environ.get("HEARTH_AGENT_DEBUG"):
                super().log_message(fmt, *args)

        def _json(self, code: int, body: Any) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
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
            self.send_header("Cache-Control", "max-age=604800")
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length) or b"{}") if length else {}

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                current = launcher.current["title"] if launcher.current else None
                return self._json(200, {"ok": True, "host": socket.gethostname(), "uptime": uptime_seconds(), "playing": current})
            if not self._authed():
                return
            url = urllib.parse.urlsplit(self.path)
            qs = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            if url.path == "/games":
                return self._json(200, library.public())
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
                if self.path == "/launch":
                    gid = self._body().get("id", "")
                    entry = library.get(gid)
                    if not entry:
                        return self._json(404, {"error": f"unknown game {gid}"})
                    launcher.launch(entry)
                    return self._json(200, {"ok": True})
                if self.path == "/power":
                    action = self._body().get("action", "")
                    if not cfg.get("allowPower", True) or action not in POWER_COMMANDS:
                        return self._json(403, {"error": "power control is off"})
                    power(action)
                    return self._json(200, {"ok": True})
                if self.path == "/stop":
                    launcher.stop()
                    return self._json(200, {"ok": True})
                if self.path == "/rescan":
                    library.scan()
                    return self._json(200, {"ok": True})
            except Exception as err:
                log(f"error: {err}")
                return self._json(500, {"error": str(err)})
            self._json(404, {"error": "not found"})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Hearth PC agent")
    parser.add_argument("--config", default=str(Path(__file__).with_name("agent.json")))
    parser.add_argument("--list", action="store_true", help="print the detected library and exit")
    args = parser.parse_args()

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
