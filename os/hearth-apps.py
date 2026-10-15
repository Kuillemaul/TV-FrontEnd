#!/usr/bin/env python3
"""Install, start and remove the apps Hearth offers to set up on this machine.

Runs as root from hearth-apps.service, started by hearth-apps.path whenever Hearth (running as the
tv user) drops a request file in <state>/apps-requests/. Only apps listed in os/apps/catalog.json
can be installed. Progress goes to <state>/apps.json, which Hearth reads.

  Docker apps: /opt/hearth-apps/<app>/compose.yml (from os/apps/compose/<app>.yml) + its data.
  Flatpaks:    installed system-wide from Flathub.

  sudo systemctl start hearth-apps     # process waiting requests by hand
  journalctl -u hearth-apps            # what happened
"""

import grp
import json
import os
import pwd
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

REPO = os.environ.get("HEARTH_REPO", "/opt/hearth")
APPS_DIR = os.environ.get("HEARTH_APPS_DIR", "/opt/hearth-apps")
TV_USER = os.environ.get("HEARTH_USER", "tv")
TV = pwd.getpwnam(TV_USER)
STATE_DIR = os.environ.get("HEARTH_STATE_DIR", os.path.join(TV.pw_dir, ".local/state/hearth"))
REQUESTS = os.path.join(STATE_DIR, "apps-requests")
STATUS = os.path.join(STATE_DIR, "apps.json")
CATALOG = json.load(open(os.path.join(REPO, "os/apps/catalog.json")))
# Media folders may only live in the usual places for data (not system folders).
MEDIA_RE = re.compile(r"^/(srv|mnt|media|home|data|storage)(/[\w .@+-]+)*/?$")
MEDIA_SUBDIRS = ["movies", "tv", "music", "downloads", "recordings", "photos"]


def log(msg):
    print(f"[hearth-apps] {msg}", flush=True)


def load_status():
    try:
        return json.load(open(STATUS))
    except Exception:
        return {"jobs": {}, "apps": {}}


def save_status(data):
    os.makedirs(STATE_DIR, exist_ok=True)
    # Keep the 30 newest jobs.
    jobs = sorted(data["jobs"].items(), key=lambda kv: kv[1].get("at", 0), reverse=True)[:30]
    data["jobs"] = dict(jobs)
    tmp = STATUS + ".new"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.chown(tmp, TV.pw_uid, TV.pw_gid)
    os.replace(tmp, STATUS)


def progress(job_id, req, state, message, **extra):
    data = load_status()
    data["jobs"][job_id] = {"app": req.get("app"), "action": req.get("action"), "state": state, "message": message, "at": int(time.time() * 1000), **extra}
    save_status(data)
    log(f"{req.get('app')} {req.get('action')}: {state}: {message}")


def run(cmd, **kw):
    log("$ " + " ".join(cmd))
    return subprocess.run(cmd, check=True, text=True, capture_output=True, **kw)


def tail(err):
    out = (getattr(err, "stderr", "") or getattr(err, "stdout", "") or str(err)).strip().splitlines()
    return out[-1] if out else str(err)


# ---------------------------------------------------------------- docker


def ensure_docker(job_id, req):
    if shutil.which("docker") and compose_cmd():
        return
    progress(job_id, req, "running", "Installing Docker (first time only)…")
    run(["apt-get", "update"])
    for pkgs in (["docker.io", "docker-compose"], ["docker.io", "docker-compose-v2"], ["docker.io"]):
        try:
            run(["apt-get", "install", "-y", "--no-install-recommends", *pkgs], env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"})
            if compose_cmd():
                break
        except subprocess.CalledProcessError:
            continue
    run(["systemctl", "enable", "--now", "docker"])
    if not compose_cmd():
        raise RuntimeError("Docker Compose couldn't be installed (apt install docker-compose)")


def compose_cmd():
    for cmd in (["docker", "compose"], ["docker-compose"]):
        try:
            subprocess.run([*cmd, "version"], check=True, capture_output=True)
            return cmd
        except Exception:
            continue
    return None


def timezone():
    try:
        return open("/etc/timezone").read().strip()
    except Exception:
        link = os.path.realpath("/etc/localtime")
        return link.split("zoneinfo/", 1)[1] if "zoneinfo/" in link else "UTC"


def gid(name, default):
    try:
        return grp.getgrnam(name).gr_gid
    except KeyError:
        return default


def prepare_media(path):
    os.makedirs(path, exist_ok=True)
    for sub in MEDIA_SUBDIRS:
        d = os.path.join(path, sub)
        if not os.path.exists(d):
            os.makedirs(d)
            os.chown(d, TV.pw_uid, TV.pw_gid)
    st = os.stat(path)
    if st.st_uid == 0 and path.rstrip("/") not in ("/mnt", "/media", "/srv", "/home"):
        os.chown(path, TV.pw_uid, TV.pw_gid)


def app_secret(data):
    """A random password for an app's own database, made once and kept (so reinstalling still works)."""
    path = os.path.join(data, ".secret")
    if not os.path.exists(path):
        os.makedirs(data, exist_ok=True)
        with open(path, "w") as f:
            f.write(secrets.token_hex(16))
        os.chmod(path, 0o600)
    return open(path).read().strip()


def render(app, req):
    template = open(os.path.join(REPO, "os/apps/compose", f"{app}.yml")).read()
    data = os.path.join(APPS_DIR, app)
    media = req.get("media") or "/srv/media"
    values = {
        "data": data,
        "media": media.rstrip("/") or "/",
        "tz": timezone(),
        "puid": str(TV.pw_uid),
        "pgid": str(TV.pw_gid),
        "render": str(gid("render", gid("video", 44))),
        "claim": req.get("claim") or "",
        "secret": app_secret(data),
        # Immich: where phone backups go, and an existing photo folder it reads (never changes).
        "photos": (req.get("photos") or f"{media.rstrip('/')}/photos").rstrip("/"),
        "external": (req.get("external") or os.path.join(data, "no-external")).rstrip("/"),
    }
    return re.sub(r"\{(\w+)\}", lambda m: values.get(m.group(1), m.group(0)), template), data, values["media"]


def wait_for_port(port, seconds=180):
    end = time.time() + seconds
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2):
                return True
        except OSError:
            time.sleep(2)
    return False


def read_keys(app):
    """API keys the app wrote into its own settings, so Hearth can link to it without asking."""
    cfg = os.path.join(APPS_DIR, app, "config")
    try:
        if app in ("radarr", "sonarr", "prowlarr"):
            return {"apiKey": ET.parse(os.path.join(cfg, "config.xml")).getroot().findtext("ApiKey")}
        if app == "seerr":
            return {"apiKey": json.load(open(os.path.join(cfg, "settings.json")))["main"]["apiKey"]}
        if app == "plex":
            prefs = os.path.join(cfg, "Library/Application Support/Plex Media Server/Preferences.xml")
            token = ET.parse(prefs).getroot().get("PlexOnlineToken")
            return {"token": token} if token else {}
        if app == "qbittorrent":
            # Newer versions print a one-off admin password in the log on first start.
            res = subprocess.run(["docker", "logs", "qbittorrent"], capture_output=True, text=True)
            out = res.stdout + res.stderr
            m = re.findall(r"temporary password is provided for this session: (\S+)", out)
            return {"username": "admin", "password": m[-1]} if m else {}
    except Exception:
        return {}
    return {}


def docker_install(job_id, req):
    app = req["app"]
    meta = CATALOG["docker"][app]
    ensure_docker(job_id, req)
    if load_status().get("shares"):
        ensure_docker_waits_for_shares()
    text, data, media = render(app, req)
    os.makedirs(data, exist_ok=True)
    if meta.get("media"):
        prepare_media(media)
    if app == "immich":
        for key in ("photos", "external"):
            folder = re.search(rf"^\s*- \"([^\"]+):/{'data' if key == 'photos' else 'external'}", text, re.M)
            if folder:
                os.makedirs(folder.group(1), exist_ok=True)
    for sub in ("config", "cache", "transcode", "model-cache"):
        d = os.path.join(data, sub)
        if not os.path.exists(d):
            os.makedirs(d)
            os.chown(d, TV.pw_uid, TV.pw_gid)
    with open(os.path.join(data, "compose.yml"), "w") as f:
        f.write(text)
    compose = compose_cmd()
    progress(job_id, req, "running", f"Downloading {meta['name']}… (a few minutes the first time)")
    run([*compose, "-f", os.path.join(data, "compose.yml"), "pull"], timeout=3600)
    progress(job_id, req, "running", f"Starting {meta['name']}…")
    run([*compose, "-f", os.path.join(data, "compose.yml"), "up", "-d"], timeout=600)
    if not wait_for_port(meta["port"]):
        raise RuntimeError(f"{meta['name']} didn't start answering on port {meta['port']} (docker logs {app})")
    # Settings files (and their API keys) appear a little after the web page does.
    keys = {}
    for _ in range(15):
        keys = read_keys(app)
        if keys or app in ("jellyfin", "homeassistant", "tvheadend", "immich"):
            break
        time.sleep(2)
    status = load_status()
    status["apps"][app] = {"kind": "docker", "installed": True, "port": meta["port"], "media": media if meta.get("media") else None, **keys}
    save_status(status)
    progress(job_id, req, "done", f"{meta['name']} is running", port=meta["port"], **keys)


def docker_remove(job_id, req):
    app = req["app"]
    data = os.path.join(APPS_DIR, app)
    compose = compose_cmd()
    if compose and os.path.exists(os.path.join(data, "compose.yml")):
        progress(job_id, req, "running", "Stopping…")
        run([*compose, "-f", os.path.join(data, "compose.yml"), "down"], timeout=300)
    # Its settings stay in /opt/hearth-apps/<app> so installing it again picks up where it left off.
    status = load_status()
    status["apps"].pop(app, None)
    save_status(status)
    progress(job_id, req, "done", f"{CATALOG['docker'][app]['name']} removed (its settings are kept)")


def docker_keys(job_id, req):
    keys = read_keys(req["app"])
    status = load_status()
    if req["app"] in status["apps"]:
        status["apps"][req["app"]].update(keys)
        save_status(status)
    progress(job_id, req, "done", "Read settings", **keys)


# ---------------------------------------------------------------- flatpak


def flatpak(job_id, req):
    meta = CATALOG["flatpak"][req["app"]]
    if not shutil.which("flatpak"):
        run(["apt-get", "install", "-y", "--no-install-recommends", "flatpak"])
    run(["flatpak", "remote-add", "--if-not-exists", "flathub", "https://dl.flathub.org/repo/flathub.flatpakrepo"])
    status = load_status()
    if req["action"] == "install":
        progress(job_id, req, "running", f"Installing {meta['name']}… (a few minutes the first time)")
        run(["flatpak", "install", "-y", "--noninteractive", "flathub", meta["id"]], timeout=3600)
        status["apps"][req["app"]] = {"kind": "flatpak", "installed": True, "id": meta["id"]}
        save_status(status)
        progress(job_id, req, "done", f"{meta['name']} is installed", id=meta["id"])
    else:
        run(["flatpak", "uninstall", "-y", "--noninteractive", meta["id"]], timeout=600)
        status["apps"].pop(req["app"], None)
        save_status(status)
        progress(job_id, req, "done", f"{meta['name']} removed")


# ---------------------------------------------------------------- network shares

FSTAB = "/etc/fstab"
SHARE_DIR = "/etc/hearth/shares"
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,29}$")
CIFS_RE = re.compile(r"^//[\w.-]+/[\w .$&()'-]+(/[\w .$&()'-]+)*$")
NFS_RE = re.compile(r"^[\w.-]+:/[\w ./-]*$")


def fstab_lines():
    return open(FSTAB).read().splitlines() if os.path.exists(FSTAB) else []


def write_fstab(lines):
    tmp = FSTAB + ".hearth"
    with open(tmp, "w") as f:
        f.write("\n".join(lines).rstrip("\n") + "\n")
    os.replace(tmp, FSTAB)


def mount_share(job_id, req):
    """Attach a network share (SMB/NFS) at /mnt/<name>, mounted at every boot before Docker starts."""
    name = str(req.get("name", ""))
    if not NAME_RE.match(name):
        raise ValueError("Give the share a short name (letters, numbers, dashes)")
    target = f"/mnt/{name}"
    kind = req.get("type", "cifs")
    source = str(req.get("source", "")).strip()
    opts = "_netdev,nofail,x-systemd.mount-timeout=30"
    if kind == "cifs":
        if not CIFS_RE.match(source):
            raise ValueError("Share should look like //192.168.1.5/media")
        if not shutil.which("mount.cifs"):
            progress(job_id, req, "running", "Installing SMB support…")
            run(["apt-get", "install", "-y", "--no-install-recommends", "cifs-utils"], env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"})
        os.makedirs(SHARE_DIR, mode=0o700, exist_ok=True)
        cred = os.path.join(SHARE_DIR, f"{name}.cred")
        with open(os.open(cred, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
            f.write(f"username={req.get('username') or 'guest'}\npassword={req.get('password') or ''}\n")
        opts += f",credentials={cred},uid={TV.pw_uid},gid={TV.pw_gid},file_mode=0664,dir_mode=0775,iocharset=utf8"
        fs = "cifs"
    elif kind == "nfs":
        if not NFS_RE.match(source):
            raise ValueError("NFS export should look like 192.168.1.5:/volume1/media")
        if not shutil.which("mount.nfs"):
            progress(job_id, req, "running", "Installing NFS support…")
            run(["apt-get", "install", "-y", "--no-install-recommends", "nfs-common"], env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"})
        fs = "nfs"
    else:
        raise ValueError("Unknown share type")

    # An empty, unwritable folder underneath: if the share is ever missing, apps get an error
    # instead of quietly filling the TV's own drive.
    subprocess.run(["umount", target], capture_output=True)
    os.makedirs(target, exist_ok=True)
    subprocess.run(["chattr", "+i", target], capture_output=True)
    line = f"{source.replace(' ', chr(92) + '040')} {target} {fs} {opts} 0 0"
    lines = [l for l in fstab_lines() if not (l.split() + ["", ""])[1] == target]
    write_fstab(lines + [f"{line}  # added by Hearth"])
    run(["systemctl", "daemon-reload"])
    progress(job_id, req, "running", f"Mounting {source}…")
    try:
        run(["mount", target], timeout=60)
    except subprocess.CalledProcessError as err:
        msg = tail(err)
        if "13" in msg or "denied" in msg.lower():
            raise RuntimeError("The server said no: check the username and password")
        raise RuntimeError(f"Couldn't connect to {source}: {msg}")
    ensure_docker_waits_for_shares()
    status = load_status()
    status.setdefault("shares", {})[name] = {"source": source, "path": target, "type": fs}
    save_status(status)
    progress(job_id, req, "done", f"{source} is at {target}", path=target)


def unmount_share(job_id, req):
    name = str(req.get("name", ""))
    if not NAME_RE.match(name):
        raise ValueError("Unknown share")
    target = f"/mnt/{name}"
    subprocess.run(["umount", target], capture_output=True)
    write_fstab([l for l in fstab_lines() if not (l.split() + ["", ""])[1] == target])
    run(["systemctl", "daemon-reload"])
    cred = os.path.join(SHARE_DIR, f"{name}.cred")
    if os.path.exists(cred):
        os.remove(cred)
    status = load_status()
    status.get("shares", {}).pop(name, None)
    save_status(status)
    progress(job_id, req, "done", f"{target} disconnected")


def ensure_docker_waits_for_shares():
    """Start Docker's apps only after network shares are mounted (so Immich finds its photos)."""
    dropin = "/etc/systemd/system/docker.service.d/hearth-shares.conf"
    if os.path.exists(dropin) or not os.path.exists("/lib/systemd/system/docker.service"):
        return
    os.makedirs(os.path.dirname(dropin), exist_ok=True)
    with open(dropin, "w") as f:
        f.write("[Unit]\nAfter=remote-fs.target\nWants=remote-fs.target\n")
    run(["systemctl", "daemon-reload"])


# ---------------------------------------------------------------- requests


def handle(path):
    job_id = os.path.basename(path)[:-5]
    try:
        req = json.load(open(path))
    except Exception:
        req = {}
    os.remove(path)
    app, action, kind = req.get("app"), req.get("action"), req.get("kind")
    if not re.fullmatch(r"[\w-]{1,40}", job_id):
        return
    try:
        if kind == "share":
            req["app"] = f"share:{req.get('name', '')}"
            if any("\n" in str(req.get(k, "")) or "\r" in str(req.get(k, "")) for k in ("username", "password", "source")):
                raise ValueError("Usernames and passwords can't contain line breaks")
            progress(job_id, req, "running", "Connecting…")
            (mount_share if action == "mount" else unmount_share)(job_id, req)
            return
        if kind not in ("docker", "flatpak") or app not in CATALOG[kind]:
            raise ValueError(f"{app} isn't an app Hearth can install")
        for key in ("photos", "external"):
            if req.get(key) and (not MEDIA_RE.match(req[key]) or os.path.normpath(req[key]) != req[key].rstrip("/")):
                raise ValueError("Pick folders under /srv, /mnt, /media, /home, /data or /storage")
        if req.get("media") and (not MEDIA_RE.match(req["media"]) or os.path.normpath(req["media"]) != req["media"].rstrip("/")):
            raise ValueError("Pick a media folder under /srv, /mnt, /media, /home, /data or /storage")
        if req.get("claim") and not re.fullmatch(r"claim-[\w-]+", req["claim"]):
            raise ValueError("That Plex claim code doesn't look right")
        progress(job_id, req, "running", "Starting…")
        if kind == "flatpak":
            if action not in ("install", "remove"):
                raise ValueError("Unknown action")
            flatpak(job_id, req)
        elif action == "install":
            docker_install(job_id, req)
        elif action == "remove":
            docker_remove(job_id, req)
        elif action == "keys":
            docker_keys(job_id, req)
        else:
            raise ValueError("Unknown action")
    except Exception as err:  # report every failure to the TV
        progress(job_id, req, "failed", tail(err))


def main():
    if os.geteuid() != 0:
        sys.exit("Run as root (hearth-apps.service)")
    os.makedirs(REQUESTS, exist_ok=True)
    os.chown(REQUESTS, TV.pw_uid, TV.pw_gid)
    # Requests that arrive while one is running are picked up in the same run.
    while True:
        waiting = sorted((os.path.join(REQUESTS, f) for f in os.listdir(REQUESTS) if f.endswith(".json")), key=os.path.getmtime)
        if not waiting:
            break
        handle(waiting[0])


if __name__ == "__main__":
    main()
