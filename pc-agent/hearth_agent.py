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


class Library:
    def __init__(self, cfg: dict[str, Any], cache_dir: Path) -> None:
        self.cfg = cfg
        steam_cfg = cfg.get("steam", {})
        self.steam_enabled = steam_cfg.get("enabled", True)
        self.steam_path = steam_cfg.get("path")
        self.controllers = ControllerCache(cache_dir / "controller-support.json", steam_cfg.get("controllerLookup", True))
        self.entries: dict[str, dict[str, Any]] = {}
        self.scanned_at = 0.0

    def scan(self, force: bool = False) -> dict[str, dict[str, Any]]:
        if not force and time.time() - self.scanned_at < 60:
            return self.entries
        entries: dict[str, dict[str, Any]] = {}
        overrides: dict[str, bool] = self.cfg.get("kbm", {})

        if self.steam_enabled and (root := steam_root(self.steam_path)):
            for g in steam_games(root):
                gid = f"steam-{g['appid']}"
                controller = self.controllers.get(g["appid"])
                entries[gid] = {
                    "id": gid,
                    "title": g["title"],
                    "platform": "PC",
                    "source": "steam",
                    "art": STEAM_ART.format(appid=g["appid"]),
                    "controller": controller,
                    "requiresKbm": overrides.get(g["title"], controller == "none"),
                    "_launch": {"uri": f"steam://rungameid/{g['appid']}"},
                    "_processDir": g["installDir"],
                }

        for g in self.cfg.get("games", []):
            gid = f"custom-{g.get('id') or stable_id(g['title'])}"
            art = g.get("art")
            entries[gid] = {
                "id": gid,
                "title": g["title"],
                "platform": g.get("platform", "PC"),
                "source": "custom",
                "art": art if art and art.startswith("http") else bool(art),
                "controller": g.get("controller", "unknown"),
                "requiresKbm": overrides.get(g["title"], g.get("requiresKbm", False)),
                "_launch": {"uri": g.get("uri"), "command": g.get("command"), "cwd": g.get("cwd")},
                "_processDir": g.get("processDir"),
                "_artPath": None if not art or art.startswith("http") else art,
            }

        for emu in self.cfg.get("emulators", []):
            rom_dir = Path(emu["romDir"])
            exts = {e.lower() for e in emu.get("extensions", [])}
            art_dir = Path(emu["artDir"]) if emu.get("artDir") else None
            if not rom_dir.is_dir():
                log(f"ROM folder not found: {rom_dir}")
                continue
            for rom in sorted(rom_dir.rglob("*")):
                if not rom.is_file() or (exts and rom.suffix.lower() not in exts):
                    continue
                gid = f"rom-{emu['system']}-{stable_id(emu['system'], str(rom.relative_to(rom_dir)))}"
                art_path = None
                if art_dir:
                    art_path = next((art_dir / f"{rom.stem}{ext}" for ext in (".png", ".jpg", ".jpeg", ".webp") if (art_dir / f"{rom.stem}{ext}").exists()), None)
                entries[gid] = {
                    "id": gid,
                    "title": clean_rom_title(rom.stem),
                    "platform": emu.get("name", emu["system"]),
                    "source": "rom",
                    "art": bool(art_path),
                    "controller": "full",
                    "requiresKbm": emu.get("requiresKbm", False),
                    "_launch": {"command": [part.replace("{rom}", str(rom)) for part in emu["command"]], "cwd": emu.get("cwd")},
                    "_artPath": str(art_path) if art_path else None,
                }

        self.entries = entries
        self.scanned_at = time.time()
        return entries

    def public(self) -> list[dict[str, Any]]:
        games = []
        for e in self.scan().values():
            item = {k: v for k, v in e.items() if not k.startswith("_")}
            if e["source"] == "steam":  # controller support may have been looked up since the scan
                item["controller"] = self.controllers.get(int(e["id"].split("-")[1]))
                item["requiresKbm"] = self.cfg.get("kbm", {}).get(e["title"], item["controller"] == "none")
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
        if spec.get("command"):
            kwargs: dict[str, Any] = {"cwd": spec.get("cwd") or None}
            if IS_WINDOWS:
                kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
            else:
                kwargs["start_new_session"] = True
            self.proc = subprocess.Popen(spec["command"], **kwargs)
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
                gid = urllib.request.unquote(self.path[5:])
                path = library.scan().get(gid, {}).get("_artPath")
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
                    entry = library.scan().get(gid) or library.scan(force=True).get(gid)
                    if not entry:
                        return self._json(404, {"error": f"unknown game {gid}"})
                    launcher.launch(entry)
                    return self._json(200, {"ok": True})
                if self.path == "/stop":
                    launcher.stop()
                    return self._json(200, {"ok": True})
                if self.path == "/rescan":
                    library.scan(force=True)
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
    if args.list:
        for g in library.public():
            print(f"{g['platform']:<12} {g['controller']:<8} {'KBM ' if g['requiresKbm'] else '    '}{g['title']}")
        return

    library.scan(force=True)
    log(f"{len(library.entries)} games found")
    port = int(cfg.get("port", 47800))
    server = ThreadingHTTPServer((cfg.get("bind", "0.0.0.0"), port), make_handler(cfg, library, Launcher()))
    log(f"Hearth agent listening on :{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
