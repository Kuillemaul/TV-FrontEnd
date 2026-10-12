# Setting up Hearth

You can do these in any order. Each part falls back to demo data until it's configured.

1. [The OptiPlex (OS + Hearth)](#1-the-optiplex)
2. [Live TV with a USB tuner](#2-live-tv-with-a-usb-tuner)
3. [Home Assistant dashboard and voice](#3-home-assistant-dashboard-and-voice)
4. [Gaming PC and emulator PC](#4-gaming-pc-and-emulator-pc)
5. [Remotes, controllers and HDMI-CEC](#5-remotes-controllers-and-hdmi-cec)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. The OptiPlex

**Hardware notes (OptiPlex 5080 Micro):** the Intel UHD 630 decodes H.264/HEVC/VP9 in hardware, so 4K60 streams and
Moonlight work well. HDMI isn't standard on every 5080 Micro. Most have DisplayPort, plus an optional HDMI/DP/USB-C
port. Use a **DP→HDMI 2.0 active** adapter or cable for 4K60 HDR. 8 GB of RAM is enough.

**BIOS (F2 at boot):**
- *Power Management → AC Recovery*: **Power On** (it comes back after a power cut)
- *Power Management → USB Wake Support*: **Enabled** (the remote/keyboard wakes it from sleep)
- *Secure Boot*: either setting works; disable it if you plan to use out-of-tree tuner drivers

**OS:** install **Debian 13** (or Ubuntu Server 24.04) *without* a desktop environment. In Debian's installer, untick
"Debian desktop environment" and "GNOME". Keep "SSH server". Create any admin user you like; the installer creates
a separate `tv` user that the TV runs as.

```bash
sudo apt install git
git clone https://github.com/Kuillemaul/TV-FrontEnd.git ~/hearth
cd ~/hearth
sudo ./os/install.sh
```

The installer:

- installs `cage` (kiosk compositor), Chrome (with Widevine DRM for Netflix and similar), mpv, PipeWire, Intel VAAPI, Node 22, and Moonlight and Plex HTPC from Flathub
- copies Hearth to `/opt/hearth` and builds it
- auto-logs `tv` in on tty1 and starts `cage → Chrome kiosk → Hearth`
- runs the server as a systemd **user** service (`systemctl --user status hearth` as `tv`)
- adds `tv` to the `input` group so the global **Home** key and the keyboard/mouse detection work
- lets Settings → Sleep/Restart/Shut down work without a password (polkit rule)

Edit `/opt/hearth/config/config.yaml`, then reboot. Logs: `journalctl --user -u hearth -f` (as `tv`).

**Updating:** `cd /opt/hearth && git pull && npm ci && npm run build && systemctl --user restart hearth`.

### Adding apps

Every tile is one entry under `apps:` in the config. Web apps open in their own kiosk Chrome profile, so you sign in
once per service and it remembers you. Any Linux program works too:

```yaml
- { id: moonlight, name: Moonlight, color: "#444", launch: { type: command, command: [flatpak, run, com.moonlight_stream.Moonlight] } }
- { id: steam, name: Steam, color: "#1b2838", launch: { type: command, command: [steam, -gamepadui] } }
```

### Streaming quality

Paid streaming services decide your maximum quality from how secure the device's DRM is. A Linux PC only gets
software DRM (Widevine L3), so in Chrome on Linux:

| Service | Typical max on Linux | Notes |
| --- | --- | --- |
| Plex (Plex HTPC app) | Full quality, 4K/HDR from your own server | Real TV app, made for remotes |
| YouTube (`/tv` interface) | 4K | TV interface, works well with a remote |
| Netflix, Disney+, Max, Prime Video, Hulu, Paramount+ | ~720p, stereo | Website interfaces; easiest with an air-mouse remote |

No 4K, HDR, Dolby Vision or Atmos from paid services is possible on Linux. If that matters, connect a
Google TV Streamer, Shield or Apple TV to another HDMI input for those services.

### Profiles, apps and themes

Everything here is done from the TV with the remote. No config file needed.

- **Add your son's profile:** Settings → Profiles → **Add profile** → choose **★ Kid**. Kid profiles start empty.
  In the editor that opens:
  - **Apps:** add the tiles he should see and order them with ▲/▼.
  - **Games:** tick the games he's allowed. The list covers every PC; search helps with big libraries.
  - **Live TV:** on or off.
  - **Theme:** a playful look (Candy background + Fredoka font is the kid default).
- **What a kid profile can't do:** open Smart Home, Lab or Settings, start anything that isn't on his list (also
  enforced by the server, so voice commands like "play Elden Ring" are refused), use Home Assistant voice
  commands, or sleep/restart the TV. He can still change his own theme and switch profiles.
- **Parent PIN:** Settings → Profiles → your profile → **PIN**. With a PIN set, switching from his profile back to
  yours asks for it. The picker shows a 🔒 next to protected profiles.
- **Switching:** the avatar in the top-right → **Switch profile**. "Who's watching?" also appears at start-up when
  there's more than one profile.
- **Arrange apps:** Apps → **Edit apps** (or Settings → Arrange apps) to reorder, hide, bring back, or **add a web
  app** (any website, opened full screen like the others). This affects only the current profile.
- **Theme:** avatar → **Change theme**, or Settings → Theme. Move across backgrounds, colour palettes and fonts and
  the whole TV previews each one. Select to keep it, then **Save**. Back cancels.

Profiles live in `~/.local/state/hearth/profiles.json` on the OptiPlex. Back it up if you like.

## 2. Live TV with a USB tuner

Hearth uses **Tvheadend** for the tuner, channel scan, guide (EPG) and recordings. It works with nearly every
Linux-supported USB tuner. For US ATSC 1.0 the **Hauppauge WinTV-dualHD** is a safe choice (two tuners, so you can
record and watch at once). ATSC 3.0 channels are mostly DRM-encrypted and won't work with any Linux tuner.

```bash
sudo apt install docker.io docker-compose-v2
sudo mkdir -p /srv/tvheadend/config /srv/recordings && sudo chown -R tv:tv /srv/tvheadend /srv/recordings
# set PUID/PGID (id tv) and TZ in the file first
sudo docker compose -f /opt/hearth/os/tvheadend/docker-compose.yml up -d
```

Open `http://<tv-ip>:9981` and run the wizard: choose your tuner's network (ATSC-T for US over-the-air), pick the
predefined mux list for your area, scan, and map all services to channels. Then:

- *Configuration → Users → Access Entries*: add an entry for network `127.0.0.1/32` with streaming + DVR rights and
  no username. Hearth then needs no password.
- *Configuration → Recording*: set the recording path to `/recordings`.
- Guide data: over-the-air EIT works out of the box. For a longer guide, add an XMLTV grabber.

In `config.yaml`:

```yaml
livetv:
  tvheadend: { url: http://127.0.0.1:9981, profile: pass }
```

Watching opens **mpv** full screen with every channel in a playlist. **CH+/CH−, PgUp/PgDn or up/down zap**,
Back returns to the guide (`os/mpv/input.conf`). From the guide, select a show and choose **Record**.

## 3. Home Assistant dashboard and voice

1. In Home Assistant: your profile → **Security** → **Long-lived access tokens** → create one for "Hearth".
2. In `config.yaml`, set `homeassistant.url` and `token`, then list the entities you want under `dashboard`,
   `favorites` (quick toggles on the Home screen) and `weather`.
3. Optional: `lovelacePath: /dashboard-tv/0` adds a "Full dashboard" button that opens Lovelace in kiosk mode.
   Sign in once in that window.

### Voice

Hearth sends the microphone to **Home Assistant Assist** for speech-to-text, so set up a voice pipeline first.
Under *Settings → Voice assistants*, add a pipeline with **Whisper** (STT) and **Piper** (TTS), either local add-ons or
Home Assistant Cloud.

Then in `config.yaml`:

```yaml
homeassistant:
  voice: { language: en, ttsEngine: tts.piper }   # remove ttsEngine to show replies without speaking them
```

- **Microphone:** any USB mic, or a remote with a built-in mic. The common "G20S Pro"-style air-mouse remotes have a
  2.4 GHz dongle that appears as a USB microphone, which is ideal.
- **Press-to-talk:** the mic button in the top bar, `M`/F2, or **Y** on a controller. Home Assistant detects when
  you stop talking.
- **TV commands are handled locally:** "open Netflix", "launch Plex", "play Super Metroid", "watch channel 7",
  "put on NBC", "show me the home lab", "go home", "stop". Anything else goes to Home Assistant's conversation
  agent, including your own sentences and LLM agents if you've set them up.
- You can also type a command in the voice panel. That's handy with a keyboard, or before a mic is set up.

## 4. Gaming PC and emulator PC

Each PC runs **Sunshine** (streams the screen) and the **Hearth agent** (lists games and starts the one you picked).
The TV runs **Moonlight** to show the stream.

### On each PC

1. **Install Sunshine** (https://app.lizardbyte.dev/Sunshine). In its web UI (`https://localhost:47990`), keep the
   default **Desktop** app. Hearth starts the game itself and then streams the desktop, so any game works without
   adding each one to Sunshine.
2. **Install Python 3.9+** (Windows: from python.org, tick "Add to PATH").
3. **Install the agent:** copy the `pc-agent/` folder to the PC, then:
   - Windows: `powershell -ExecutionPolicy Bypass -File install-windows.ps1`. This creates `agent.json` with a random
     token, starts the agent at logon, and opens port 47800 on private networks.
   - Linux: copy `agent.example.json` to `agent.json`, set a token, and run
     `python3 hearth_agent.py` from a systemd user service or your autostart.
4. **Edit `agent.json`** to choose where games come from. You can combine sources:
   - **Playnite** (recommended for the gaming PC): `"playnite": {"enabled": true}`. See [Playnite](#playnite) below.
     It covers Steam, Epic, GOG, Xbox / Game Pass, EA, Ubisoft, Battle.net and games you added by hand.
   - **LaunchBox** (recommended for the emulator PC): `"launchbox": {"path": "C:/Users/You/LaunchBox"}`.
     See [LaunchBox](#launchbox) below.
   - **Steam scan:** `"steam": {"enabled": true}` lists every installed Steam game. Leave it off if you use
     Playnite. If both are on, the Playnite entry wins for any game they share.
   - **Custom games:** anything else goes under `games` with a `uri` or `command`. A Game Pass game can be added
     directly with `explorer.exe shell:AppsFolder\<AppID>` (find the ID with PowerShell `Get-StartApps`).
     Set `processDir` so "quit on exit" can close it.
   - **Plain ROM folders** (no frontend): `emulators` entries with a ROM folder, extensions and a command
     (`{rom}` is replaced). Add `"only": ["Super Metroid", ...]` to list just those titles.
   - **Keyboard & mouse:** Steam games without controller support in the Steam store are flagged automatically.
     Force any title on or off under `"kbm": {"Factorio": true}`.
   - Check it: `python hearth_agent.py --list` prints what the TV will see.
5. **Make it reachable and wakeable:**
   - Turn on Wake-on-LAN in the BIOS and in the network adapter's Windows properties (*Wake on Magic Packet*).
   - Windows must auto-login (`netplwiz`, or Sysinternals Autologon) so the agent and Sunshine run after a wake.
   - Give the PC a DHCP reservation so its IP never changes.

### Big libraries: favourites only

Hearth is built for huge collections. With LaunchBox and Playnite it lists **only your favourites** by default.
Star a game there and it appears on the TV within about 15 seconds. Scanning happens in the background:
LaunchBox's XML is streamed and only re-read when it changes (a 20,000-game library takes under a second),
so opening the Games page never waits on the PC. If you do send thousands of games, the TV draws 120 at a time
with a "Show more" tile. Search, the platform chips and voice ("play Chrono Trigger") still cover everything.

### LaunchBox

```json
"launchbox": {
  "path": "C:/Users/You/LaunchBox",
  "favoritesOnly": true,
  "platforms": [],
  "includeHidden": false
}
```

- Hearth launches each game the way LaunchBox would: with the game's assigned emulator, that emulator's
  platform-specific command line (e.g. the RetroArch core), and the ROM path. PC/Windows entries open their
  application path, which can be an .exe, a shortcut or a `steam://` link.
- Box art comes from LaunchBox's `Images/<Platform>/Box - Front` folders.
- `platforms` limits the list to certain systems, e.g. `["Nintendo 64", "Sega Genesis"]`.
- Not supported: LaunchBox startup/pause screens, AutoHotkey scripts and additional apps. Hearth runs the
  emulator directly, without opening LaunchBox or BigBox.

### Playnite

1. Copy `pc-agent/playnite/HearthExporter` into Playnite's `Extensions` folder
   (`%APPDATA%\Playnite\Extensions\`, or `Extensions\` next to `Playnite.DesktopApp.exe` for the portable version),
   then restart Playnite.
2. Star the games you want on the TV (*Favorite*). The extension writes them to
   `%APPDATA%\Playnite\ExtensionsData\hearth-favorites.json` when Playnite starts or closes, after a library update,
   after you play something, and when you choose *Extensions → Hearth → Export favourites now*.
3. Set `"playnite": {"enabled": true}` in `agent.json`. For portable Playnite, also set `exportPath`
   (Playnite's `ExtensionsData` folder + `hearth-favorites.json`).

Games launch **through Playnite** (`playnite://playnite/start/<id>`), so Epic, Game Pass and every other store
and emulator works exactly as it does in Playnite. Keep Playnite running (it can start minimised).
Cover art comes from Playnite. Controller support comes from Playnite's *Features* ("Full Controller Support").
Tag a game **`Hearth: KBM`** to get the keyboard & mouse prompt, or **`Hearth: Controller`** to suppress it.

### On the TV

1. Add each PC to `config.yaml` under `gaming.hosts` with the agent URL, the **same token**, its IP and its MAC
   address (Wake-on-LAN).
2. Pair Moonlight with each PC once. Add a temporary Moonlight app tile (see [Adding apps](#adding-apps)), open it,
   select the PC, and enter the PIN in Sunshine's web UI on that PC.
3. In Moonlight's settings, set the resolution and FPS to match your TV (e.g. 4K60, or 1080p120) and enable
   "Optimize game settings" and "Quit app on host after quitting stream" if you like.

**What happens when you pick a game:** if the PC is asleep it's woken (up to 2 minutes). Then the agent starts the
game, Moonlight opens full screen, and when you quit the stream (Back+Start+LB+RB in Moonlight, or the Home key) the
agent closes the game (`quitOnExit`).

If a game needs a **keyboard and mouse**, Hearth first shows **"Get your keyboard & mouse ready"**, with live
✓ marks once they're connected to the TV, before it launches. Moonlight forwards them to the PC.

## 5. Remotes, controllers and HDMI-CEC

- **Air-mouse / Bluetooth / 2.4 GHz remotes** (e.g. G20S Pro) show up as a keyboard. Arrows, OK, Back and Home work as is, and
  many include a mic.
- **Any IR remote**, including your TV's remote: a **FLIRC USB** receiver turns IR buttons into keyboard keys. Map
  OK→Enter, Back→Escape, Home→`Homepage` (KEY_HOMEPAGE), Mic→F2, CH±→PgUp/PgDn.
- **Game controllers** (Xbox, PlayStation, 8BitDo) work over USB or Bluetooth: D-pad/stick to move, A to select,
  B for back, Y for voice. Hold the Xbox/PS button for one second to return to Hearth from any app.
- **HDMI-CEC (the TV's own remote over HDMI):** the OptiPlex's Intel graphics can't do CEC. Add a
  **Pulse-Eight USB-CEC adapter**, then:
  ```bash
  sudo inputattach --daemon --pulse8-cec /dev/ttyACM0
  sudo cec-ctl -d /dev/cec0 --playback --osd-name Hearth --active-source phys-addr=1.0.0.0
  ```
  The kernel exposes CEC remote buttons as an input device, so arrows, select and back work like a keyboard.

**Home key from anywhere:** Hearth reads `KEY_HOMEPAGE` and the controller guide button straight from `/dev/input`, so
they close Netflix, Plex, mpv or Moonlight and bring you back. Change these keys under `homeKeys` in the config.

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Black screen after boot | Switch to tty2 (Ctrl+Alt+F2), log in, and as `tv` check `journalctl --user -u hearth -b`. Check that `cage` runs: `journalctl -b | grep cage`. |
| Home key does nothing inside apps | `tv` must be in the `input` group (`id tv`). Log out and back in after changing it. |
| Netflix says the browser isn't supported | Use `google-chrome-stable` (Widevine). Chromium from Debian/Ubuntu often lacks it. Expect 720p from Netflix and most paid services in a Linux browser (see [Streaming quality](#streaming-quality)). |
| Choppy live TV | `vainfo` should list H.264/MPEG-2 profiles. Make sure `intel-media-va-driver` is installed and `hwdec=vaapi` is in `~/.config/mpv/mpv.conf`. |
| "Gaming PC is offline and has no MAC address" | Add `mac:` for the host. Wake-on-LAN must be enabled in BIOS + NIC. |
| Game starts on the PC but the stream is black | Sunshine's Desktop app must capture the screen the game is on; run the agent in the logged-in user session (the Windows installer does this). |
| Voice says Home Assistant isn't connected | Check `url`/`token`; the Smart Home page shows a reconnect banner while it retries. |
| Keyboard/mouse prompt never shows ✓ | It reads `/proc/bus/input/devices` on the TV. Plug the keyboard and mouse into the **OptiPlex**, not the gaming PC. |
