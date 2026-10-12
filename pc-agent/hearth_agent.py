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
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

IS_WINDOWS = sys.platform == "win32"
STEAM_STORE = "https://store.steampowered.com/api/appdetails?appids={appid}&filters=categories"
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


class ControllerCache:
    """Looks up Steam controller support in the background and caches it on disk."""

    def __init__(self, path: Path, enabled: bool) -> None:
        self.path = path
        self.enabled = enabled
        self.data: dict[str, str] = {}
        self.pending: list[int] = []
        self.lock = threading.Lock()
        try:
            self.data = json.loads(path.read_text())
        except (OSError, ValueError):
            pass
        if enabled:
            threading.Thread(target=self._worker, daemon=True).start()

    def get(self, appid: int) -> str:
        value = self.data.get(str(appid))
        if value is None and self.enabled:
            with self.lock:
                if appid not in self.pending:
                    self.pending.append(appid)
        return value or "unknown"

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
                cats = {c.get("id") for c in body.get("data", {}).get("categories", [])} if body.get("success") else set()
                support = "full" if CAT_FULL_CONTROLLER in cats else "partial" if CAT_PARTIAL_CONTROLLER in cats else "none"
                if not body.get("success"):
                    support = "unknown"
                self.data[str(appid)] = support
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self.path.write_text(json.dumps(self.data, indent=1))
            except Exception as err:  # network hiccup or rate limit: retry later
                log(f"controller lookup {appid} failed: {err}")
                time.sleep(30)
                with self.lock:
                    self.pending.append(appid)
            time.sleep(1.6)  # stay well under the store API rate limit


# --------------------------------------------------------------------------------------
# Library
# --------------------------------------------------------------------------------------


def stable_id(*parts: str) -> str:
    return hashlib.sha1("\0".join(parts).encode()).hexdigest()[:12]


def clean_rom_title(stem: str) -> str:
    return ROM_TAGS.sub("", stem).replace("_", " ").strip() or stem


def norm_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", title.lower())


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
        self.art_index: dict[str, dict[str, Path]] = {}

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
        files = self._files()
        key = mtimes(files)
        if key == self.cache_key:
            return self.cache

        import xml.etree.ElementTree as ET

        emulators, platform_args = self._emulators()
        out: dict[str, dict[str, Any]] = {}
        for xml_file in files[1:]:
            for _, el in ET.iterparse(xml_file, events=("end",)):
                if el.tag != "Game":
                    continue
                platform = el.findtext("Platform", "")
                keep = (
                    (not self.favorites_only or is_true(el.findtext("Favorite")))
                    and (not self.platforms or platform in self.platforms)
                    and (self.include_hidden or not is_true(el.findtext("Hide")))
                    and not is_true(el.findtext("Broken"))
                )
                if keep:
                    entry = self._entry(el, platform, emulators, platform_args)
                    if entry:
                        out[entry["id"]] = entry
                el.clear()  # keep memory flat on huge platform files

        self.cache, self.cache_key = out, key
        log(f"LaunchBox: {len(out)} games ({'favourites' if self.favorites_only else 'all'})")
        return out

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

        return {
            "id": f"lb-{lb_id}",
            "title": title,
            "platform": platform or "PC",
            "source": "launchbox",
            "art": True,
            "controller": "unknown" if is_pc else "full",
            "requiresKbm": False,
            "_launch": launch,
            "_processDir": process_dir,
            "_artLookup": (platform, title),
        }

    def art(self, platform: str, title: str) -> Path | None:
        """Box-front image, matching LaunchBox's "<Title>-01.png" naming (region subfolders included)."""
        if platform not in self.art_index:
            index: dict[str, Path] = {}
            folder = self.root / "Images" / platform / "Box - Front"
            if folder.is_dir():
                for f in sorted(folder.rglob("*")):
                    m = re.match(r"^(.*)-\d\d$", f.stem)
                    if m and f.suffix.lower() in (".png", ".jpg", ".jpeg"):
                        index.setdefault(m.group(1).lower(), f)
            self.art_index[platform] = index
        return self.art_index[platform].get(LB_ILLEGAL.sub("_", title).lower())


# ---- Playnite -------------------------------------------------------------------------


class PlayniteSource:
    """
    Reads the favourites list that the Hearth Exporter Playnite extension writes
    (see pc-agent/playnite/). Playnite covers Epic, GOG, Xbox / Game Pass, EA, Ubisoft,
    Battle.net, itch, Steam and anything you've added by hand, so one source gives you all of it.
    Games launch through Playnite itself (playnite://playnite/start/<id>).
    """

    def __init__(self, cfg: dict[str, Any]) -> None:
        default = Path(os.environ.get("APPDATA", str(Path.home()))) / "Playnite" / "ExtensionsData" / "hearth-favorites.json"
        self.path = Path(cfg.get("exportPath") or default)
        self.kbm_tags = {t.lower() for t in cfg.get("kbmTags", ["Hearth: KBM", "Keyboard & Mouse"])}
        self.pad_tags = {t.lower() for t in cfg.get("controllerTags", ["Hearth: Controller"])}
        self.cache_key: tuple[float, ...] | None = None
        self.cache: dict[str, dict[str, Any]] = {}

    def entries(self) -> dict[str, dict[str, Any]]:
        key = mtimes([self.path])
        if key == self.cache_key:
            return self.cache
        out: dict[str, dict[str, Any]] = {}
        try:
            games = json.loads(self.path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as err:
            log(f"Playnite export not readable yet ({self.path}): {err}")
            games = []
        for g in games:
            features = {f.lower() for f in g.get("features") or []}
            tags = {t.lower() for t in g.get("tags") or []}
            controller = "full" if "full controller support" in features else "partial" if "partial controller support" in features else "unknown"
            requires_kbm = bool(tags & self.kbm_tags) and not (tags & self.pad_tags)
            cover = g.get("cover")
            platforms = g.get("platforms") or []
            out[f"pn-{g['id']}"] = {
                "id": f"pn-{g['id']}",
                "title": g.get("name") or "Unknown",
                "platform": platforms[0] if platforms else "PC",
                "source": "playnite",
                "store": g.get("source") or "",
                "art": bool(cover),
                "controller": controller,
                "requiresKbm": requires_kbm,
                "_launch": {"uri": f"playnite://playnite/start/{g['id']}"},
                "_processDir": g.get("installDirectory") or None,
                "_artPath": cover,
            }
        self.cache, self.cache_key = out, key
        log(f"Playnite: {len(out)} games")
        return out


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
        self.controllers = ControllerCache(cache_dir / "controller-support.json", steam_cfg.get("controllerLookup", True) and self.steam_enabled)
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
        return self.entries.get(gid) or self.scan().get(gid)

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
        e = self.entries.get(gid)
        if not e:
            return None
        if e.get("_artLookup") and self.launchbox:
            found = self.launchbox.art(*e["_artLookup"])
            return str(found) if found else None
        return e.get("_artPath")

    def public(self) -> list[dict[str, Any]]:
        overrides: dict[str, bool] = self.cfg.get("kbm", {})
        games = []
        for e in list(self.entries.values()):
            item = {k: v for k, v in e.items() if not k.startswith("_")}
            if e.get("_appid"):  # Steam controller support is looked up in the background
                item["controller"] = self.controllers.get(e["_appid"])
                item["requiresKbm"] = item["controller"] == "none"
            if e["title"] in overrides:
                item["requiresKbm"] = overrides[e["title"]]
            games.append(item)
        return sorted(games, key=lambda g: g["title"].lower())


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

        def _body(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length) or b"{}") if length else {}

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                return self._json(200, {"ok": True, "host": socket.gethostname()})
            if not self._authed():
                return
            if self.path.split("?")[0] == "/games":
                return self._json(200, library.public())
            if self.path.startswith("/art/"):
                path = library.art_path(urllib.request.unquote(self.path[5:]))
                if not path or not Path(path).is_file():
                    return self._json(404, {"error": "no art"})
                data = Path(path).read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", mimetypes.guess_type(path)[0] or "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "max-age=604800")
                self.end_headers()
                self.wfile.write(data)
                return
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
