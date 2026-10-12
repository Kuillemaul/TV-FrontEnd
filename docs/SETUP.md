# Setting up Hearth

You can do these in any order. Each part falls back to demo data until it's configured.

1. [The OptiPlex (OS + Hearth)](#1-the-optiplex)
2. [Live TV with a USB tuner](#2-live-tv-with-a-usb-tuner)
3. [Home Assistant dashboard and voice](#3-home-assistant-dashboard-and-voice)
4. [Gaming PC and emulator PC](#4-gaming-pc-and-emulator-pc)
5. [Family, automations and extras](#5-family-automations-and-extras)
6. [Remotes, controllers and HDMI-CEC](#6-remotes-controllers-and-hdmi-cec)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. The OptiPlex

**Hardware notes (OptiPlex 5080 Micro):** the Intel UHD 630 decodes H.264/HEVC/VP9 in hardware, so 4K60 streams and
Moonlight work well. HDMI isn't standard on every 5080 Micro. Most have DisplayPort, plus an optional HDMI/DP/USB-C
port. Use a **DP→HDMI 2.0 active** adapter or cable for 4K60 HDR. 8 GB of RAM is enough.

**BIOS (F2 at boot):**
- *System Configuration → SATA Operation* (or *Storage → SATA/NVMe Operation*): **AHCI**. Dell ships it set to
  "RAID On", which hides the NVMe SSD from Linux: the Debian installer won't see the disk.
- *Power Management → AC Recovery*: **Power On** (it comes back after a power cut)
- *Power Management → USB Wake Support*: **Enabled** (the remote/keyboard wakes it from sleep)
- *Secure Boot*: either setting works; disable it if you plan to use out-of-tree tuner drivers
- Faster boot: *POST Behavior → Fastboot*: **Minimal**; *Extend BIOS POST Time*: **0 seconds**; and in
  *Boot Sequence* put the SSD's "debian" entry first and untick network (PXE) boot

**OS:** install **Debian 13** (or Ubuntu Server 24.04) *without* a desktop environment. In Debian's installer, untick
"Debian desktop environment" and "GNOME". Keep "SSH server". Create any admin user you like; the installer creates
a separate `tv` user that the TV runs as.

If you set a root password in the installer, Debian leaves `sudo` out. Add it once (use the **root** password, and
the dash in `su -`), then log out and back in:

```bash
su -
apt update && apt install -y sudo git
usermod -aG sudo YOURUSERNAME
exit
```

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
- adds the Hearth boot splash (Plymouth), hides the boot menu and kernel text, and starts Chrome and the server
  side by side so the TV is ready sooner. Hold **Shift** or tap **Esc** while it boots to get the boot menu back.

**Display:** Settings → Display picks the resolution (4K, 1080p…) and refresh rate (60/59.94/50/24 Hz). A new
setting goes back by itself after 15 seconds unless you press *Keep*, so a mode the TV can't show never leaves you
with a black screen. HDR isn't available on this setup yet: cage (the kiosk compositor in Debian 13) can't output
HDR, so 4K HDR films and videos play tone-mapped to SDR.

**Pin to Home:** press **X** on a controller (or **P**, the remote's Menu key, or right-click) on any app, game,
channel or smart-home control to pin it to the top of Home. Do the same on Home to move or unpin it.

**Plex "Continue watching"** on Home opens Plex HTPC and tells it to play from where you stopped (like casting from
the Plex phone app). In Plex HTPC's settings, keep **Advertise as player** on. If it isn't found, Plex HTPC still
opens and the show is first in its own Continue Watching row.

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

1. **Install Apollo** (https://github.com/ClassicOldSong/Apollo), or Sunshine. In its web UI
   (`https://localhost:47990`), keep the default **Desktop** app. Hearth starts the game itself and streams the
   desktop, so any game works without adding each one to Apollo. See [Apollo](#apollo-virtual-display) below.
2. **Install the agent** (Windows), in PowerShell:
   ```powershell
   git clone -b claude/eager-ptolemy-skr759 https://github.com/Kuillemaul/TV-FrontEnd.git $env:TEMP\hearth-setup
   & $env:TEMP\hearth-setup\pc-agent\setup-windows.ps1
   ```
   It asks for administrator rights, installs Git and Python if needed, puts Hearth in `C:\Hearth` (a folder from a
   ZIP download is converted where it is), creates `agent.json` with a random token (or keeps and repairs yours),
   installs the Playnite extension, starts the agent at logon, opens port 47800 on private networks, and installs
   updates by itself every night at 4am (`%LOCALAPPDATA%\Hearth\update.log`). At the end it prints the block to paste
   into the TV's `config.yaml`. Run `C:\Hearth\pc-agent\setup-windows.ps1` again any time to update or repair.
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
   - **Keyboard & mouse** is worked out automatically for every PC game. The agent checks the game's Steam store
     page: by its Steam id, or by name for Epic, Game Pass, GOG and LaunchBox PC games (almost every PC game is
     listed on Steam). Games without controller support there get the "get your keyboard & mouse ready" prompt.
     If the game can't be found, there's no prompt. To correct any game, tag it `Hearth: KBM` or
     `Hearth: Controller` in Playnite, or add it to `"kbm": {"Factorio": true}` in `agent.json`.
     Check what it decides for a title with `python hearth_agent.py --check "Age of Empires IV"`.
   - Check it: `python hearth_agent.py --list` prints what the TV will see.
5. **Make it reachable and wakeable:**
   - Turn on Wake-on-LAN in the BIOS and in the network adapter's Windows properties (*Wake on Magic Packet*).
   - Windows must auto-login (`netplwiz`, or Sysinternals Autologon) so the agent and Sunshine run after a wake.
   - Give the PC a DHCP reservation so its IP never changes.

### Closing a game

Any of these closes the game on the PC and brings the TV back to Hearth:

- **Quit from inside the game**: RetroArch's *Quit*, Dolphin's *Stop*, a PC game's *Exit to desktop*. The agent
  notices the game has gone (within a few seconds) and the TV ends the stream (`endStreamOnGameExit`, on by default).
- **Leave the stream**: the remote's **Home** key, holding the **Xbox/PS button** for a second, or Moonlight's
  Start+Select+LB+RB. The agent then closes the game: the emulator it started, or everything running from the
  game's install folder for Steam/Playnite games (`quitOnExit`).

Tips: map an emulator "quit" hotkey to a controller combo (e.g. RetroArch *Hotkey enable* = Select,
*Quit* = Start), so Select+Start ends an emulated game. A game started through a launcher that exits straight
away (e.g. `explorer.exe shell:AppsFolder\…` for Game Pass) is tracked by its install folder instead. Set
`processDir` for such custom games, or the TV can't tell when they've ended (you'd leave with Home instead).

### Multiplayer controllers (emulators)

**How controllers reach the PC:** Moonlight sends every controller connected to the TV, and Apollo turns each into
a virtual Xbox controller on the PC, **in the order they were connected to the OptiPlex**. Turn controllers on in
player order (player 1 first) and that order is kept. In Apollo set the controller type to **Xbox 360** so every pad
looks the same to the emulators. Leave no controllers plugged into the PC itself, or they'd take player 1.

**Eden (and yuzu, Citron, Sudachi):** there's no command-line option for controllers (`eden.exe -f -g "game"` just
starts a game full screen), so Hearth sets up Eden's settings file for you:

1. Once: start a stream from the TV with one controller, open Eden on the PC through the stream, and in
   *Emulation → Configure → Controls* map **Player 1** to that controller (Pro Controller). Map it while streaming,
   so it's Apollo's virtual controller and not a pad plugged into the PC.
2. That's it. Selecting a Switch game on the TV shows **Players 1–4**, preset to the number of controllers
   connected. Before Eden starts, the agent marks that many players **connected** (the rest off) and gives
   players 2–4 Player 1's mapping on controllers 2–4. Eden's original file is kept as `qt-config.ini.hearth-backup`.

The agent finds the settings in Eden's `user` folder (portable) or `%APPDATA%\eden\config`. If yours is elsewhere,
set `"controllers": {"eden": {"config": "D:/Emulators/Eden/user/config/qt-config.ini"}}` in `agent.json`. To turn
this off, set `"controllers": {"enabled": false}`.

**Other emulators** just need mapping once, by controller number, and then follow the same order:

| Emulator | One-time setup |
| --- | --- |
| RetroArch | Nothing: controllers go to players 1–4 in order automatically. |
| Dolphin (GameCube/Wii) | *Controllers*: Port 1–4 = Standard Controller, devices `XInput/0` … `XInput/3`. |
| PCSX2 / DuckStation | *Controllers*: Port 1 = `XInput-0` / `SDL-0`, Port 2 = `XInput-1` / `SDL-1`. |
| Ryujinx | Players 1–4 = Xbox controller (0) … (3). Not automated; ask if you use it. |

### Apollo (virtual display)

Apollo creates a virtual monitor when the TV connects, matching the TV's resolution and refresh rate, and can turn
your real monitors off for the session. Hearth works with that:

1. Set `virtualDisplay: true` for the PC in the TV's `config.yaml`.
2. When you pick a game, the TV **connects first**: Apollo creates the virtual monitor and switches your monitors
   off. The agent **waits until Windows reports the virtual monitor**, then starts the game, so it opens on the
   virtual display at the TV's resolution. When you quit, the game closes first (`quitOnExit`) and Apollo brings
   your monitors back as usual. If you quit while it's still connecting, the game isn't started at all.
3. Keep your Apollo settings as they are (virtual display, monitors off). Set the stream resolution, FPS and HDR in
   **Moonlight on the TV**. Apollo builds the virtual monitor to match.
4. In Apollo's web UI → *Clients*, make sure the TV (OptiPlex) is allowed to view, control and launch apps.
5. Check it once: start a stream from the TV, then on the PC run `python hearth_agent.py --displays`. You should see
   a line like *SudoMaker Virtual Display Adapter*. If your virtual display has a different name, set
   `"virtualDisplay": {"match": "part of that name"}` in `agent.json`.

The TV still uses Moonlight to receive the stream; Apollo is only on the PCs.

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
  emulator directly, without opening LaunchBox or BigBox. Closing works without them, see
  [Closing a game](#closing-a-game).

### Playnite

1. Copy `pc-agent/playnite/HearthExporter` into Playnite's `Extensions` folder
   (`%APPDATA%\Playnite\Extensions\`, or `Extensions\` next to `Playnite.DesktopApp.exe` for the portable version),
   then restart Playnite.
2. Star the games you want in **My games** on the TV (*Favorite*). The extension writes your whole library (with
   favourite and installed flags) to `%APPDATA%\Playnite\ExtensionsData\hearth-library.json` when Playnite starts
   or closes, after a library update, after you play something, and when you choose
   *Extensions → Hearth → Send library to Hearth*. Unfavourited and uninstalled games appear under **Browse PC**.
3. Set `"playnite": {"enabled": true}` in `agent.json`. For portable Playnite, also set `exportPath`
   (Playnite's `ExtensionsData` folder + `hearth-library.json`).

Games launch **through Playnite** (`playnite://playnite/start/<id>`), so Epic, Game Pass and every other store
and emulator works exactly as it does in Playnite. Keep Playnite running (it can start minimised).
Cover art comes from Playnite. Controller support comes from Playnite's *Features* ("Full Controller Support") when
it has them, otherwise from the Steam store (see above). Tags are only needed to correct a game:
**`Hearth: KBM`** forces the keyboard & mouse prompt, **`Hearth: Controller`** turns it off.

### Browsing everything else

**Games → Browse PC** lists every game in your Playnite library: unfavourited ones, and **uninstalled** ones marked
*Not installed*. Picking an uninstalled game asks Playnite to install it. **Games → Browse emulated** shows your
LaunchBox platforms with game counts. Pick one platform and you get its full list (paged, with search). Only that
platform is loaded at a time, so a 20,000-ROM collection stays quick. Browse is parents-only; kid profiles only ever
see their hand-picked games.

Selecting any game opens its **details** first: a screenshot, description, rating, genres and how long you've played
(Playnite/LaunchBox's count, plus time streamed on the TV). Steam details come from the Steam store; LaunchBox
uses its Notes and *Screenshot - Gameplay* images; Playnite uses its description and background.

**Games → PCs** shows which PCs are on, for how long, what they're running, and how long they usually take to wake.
From there you can wake, sleep, restart or shut them down (`"allowPower": false` in `agent.json` turns power
control off).

### On the TV

1. Add each PC to `config.yaml` under `gaming.hosts` with the agent URL, the **same token**, its IP and its MAC
   address (Wake-on-LAN).
2. Pair Moonlight with each PC once: **Settings → Gaming PCs → Pair <PC>**. Hearth wakes the PC, starts Moonlight's
   pairing and shows a 4-digit PIN with a QR code for the PC's Apollo/Sunshine PIN page (`https://<pc>:47990/pin`);
   type the PIN there. To skip that step, put the Apollo web login in the PC's `agent.json`
   (`"apollo": {"username": "...", "password": "..."}`) and the agent enters the PIN itself.
   *Open Moonlight* in the same place opens Moonlight's own settings (resolution, bitrate, 5.1 audio).
3. In Moonlight's settings, set the resolution and FPS to match your TV (e.g. 4K60, or 1080p120) and enable
   "Optimize game settings" and "Quit app on host after quitting stream" if you like.

**What happens when you pick a game:** if the PC is asleep it's woken (up to 2 minutes). Then the agent starts the
game, Moonlight opens full screen, and when you quit the stream (Back+Start+LB+RB in Moonlight, or the Home key) the
agent closes the game (`quitOnExit`).

If a game needs a **keyboard and mouse**, Hearth first shows **"Get your keyboard & mouse ready"**, with live
✓ marks once they're connected to the TV, before it launches. Moonlight forwards them to the PC.

## 5. Family, automations and extras

### Screen time
Settings → Profiles → your son's profile → **Screen time**: a daily allowance (30 min to 3 h) and a **bedtime**
(e.g. 20:00 until 07:00). Time counts only while something is playing (apps, Live TV, games). The top bar shows
how much is left, there's a pop-up at 5 minutes, and when time runs out whatever is playing closes and a
"That's all for today" screen appears. A parent can add **+15/+30 minutes** right there with their PIN, or from
Settings → Screen time. Bonus time also works during bedtime, for that one late movie night. Adding time from the
kid's screen needs a parent PIN, so set one.

### Movie-time lights
List scenes under `scenes:` in config.yaml (see the example): e.g. dim the lights when Plex or Live TV starts and
bring them back when it stops, or set the TV backlight for games. Toggle it in Settings → *Movie-time lights*.

### Alerts and the doorbell
Under `alerts:` set your doorbell entity and camera, and any rules ("washer finished", "garage opened"). Servers
listed in the Lab raise an alert when they go down. Alerts appear as cards with a chime and a **live camera**. If Plex,
a game or Live TV is on screen, Hearth briefly opens the alert on top and then returns you to what you were
watching. Under the kiosk compositor that window is full screen; the game keeps streaming behind it. Test it from
Settings → *Test doorbell*.

### Plex: continue watching
Add your server under `plex:` (URL + token) to get a **Continue watching** row on Home. Selecting an item opens it
in Plex Web, full screen, ready to resume.

### Recording a whole series
In the guide, select a show → **Record series** (Tvheadend's "autorec" records every episode).

### TV power and other inputs
With a Pulse-Eight USB-CEC adapter (see below), Settings has **Turn TV off/on** and **Switch TV to Hearth**, and
"turn off the TV" works by voice. Add other HDMI devices under `tv.inputs` and they appear as app tiles; "switch to
the Xbox" works by voice too.

### Wake word
Install the **openWakeWord** add-on in Home Assistant and pick a wake word in your Assist pipeline. Then turn on
Settings → *Wake word*. Say it, wait for the panel to appear, then speak your command.

### Home lab charts and actions
Every Lab sensor shows a 24-hour chart from Home Assistant history. Add `lab.actions` for one-button jobs like
restarting a container: a Home Assistant service (e.g. a Portainer/Proxmox `button`) or a webhook URL. Actions are
parents-only and ask for your PIN.

### Phone remote
Set `server.host: 0.0.0.0`, restart, and open Settings → **Phone remote**. Scan the QR code with your phone, enter
the 4-digit code, and you get a D-pad, OK/back/home, voice, volume and **typing** (it types into the selected box on
the TV, or runs as a command like "play Mario Kart"). Inside Plex, browser apps or Moonlight, the presses are sent as
real key presses through `ydotool` (installed by `install.sh`). Unpaired devices can't use Hearth at all. The code
changes every 10 minutes and after 5 wrong tries.

### Screensaver and "Who's watching?"
After `screensaver.idleMinutes` with nothing playing, a photo slideshow (from `screensaver.photosDir`) with the clock
and weather fades in. Any button wakes it. If it's been idle longer than `pickerAfterMinutes`, waking asks
"Who's watching?" so the right profile (and its limits) applies.

## 6. Remotes, controllers and HDMI-CEC

- **Air-mouse / Bluetooth / 2.4 GHz remotes** (e.g. G20S Pro) show up as a keyboard. Arrows, OK, Back and Home work as is, and
  many include a mic.
- **Any IR remote**, including your TV's remote: a **FLIRC USB** receiver turns IR buttons into keyboard keys. Map
  OK→Enter, Back→Escape, Home→`Homepage` (KEY_HOMEPAGE), Mic→F2, CH±→PgUp/PgDn.
- **Game controllers** (Xbox, PlayStation, 8BitDo) work over USB or Bluetooth: D-pad/stick to move, A to select,
  B for back, Y for voice. Hold the Xbox/PS button for one second to return to Hearth from any app.
  In Plex, YouTube, Netflix and the other apps, Hearth turns the controller into a keyboard: D-pad/left stick → arrows,
  A → Enter, B or View → Back (Esc), X/Y → play/pause (Space). Moonlight is left alone (it uses the controller
  directly). Turn it off for an app that handles controllers itself with `controllerKeys: false` on its tile.
- **HDMI-CEC (the TV's own remote over HDMI):** the OptiPlex's Intel graphics can't do CEC. Add a
  **Pulse-Eight USB-CEC adapter**, then:
  ```bash
  sudo inputattach --daemon --pulse8-cec /dev/ttyACM0
  sudo cec-ctl -d /dev/cec0 --playback --osd-name Hearth --active-source phys-addr=1.0.0.0
  ```
  The kernel exposes CEC remote buttons as an input device, so arrows, select and back work like a keyboard.

**Home key from anywhere:** Hearth reads `KEY_HOMEPAGE` and the controller guide button straight from `/dev/input`, so
they close Netflix, Plex, mpv or Moonlight and bring you back. Change these keys under `homeKeys` in the config.

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| No sound / wrong speakers | Settings → Sound: pick the HDMI port with the green dot, then Stereo / 5.1 / 7.1, and use **Test speakers**. |
| A controller doesn't respond | Settings → Controllers → **Test controllers** shows every pad's buttons and sticks live (hold B to exit). |
| Black screen after boot | Switch to tty2 (Ctrl+Alt+F2), log in, and as `tv` check `journalctl --user -u hearth -b`. Check that `cage` runs: `journalctl -b | grep cage`. |
| Home key does nothing inside apps | `tv` must be in the `input` group (`id tv`). Log out and back in after changing it. |
| Netflix says the browser isn't supported | Use `google-chrome-stable` (Widevine). Chromium from Debian/Ubuntu often lacks it. Expect 720p from Netflix and most paid services in a Linux browser (see [Streaming quality](#streaming-quality)). |
| Choppy live TV | `vainfo` should list H.264/MPEG-2 profiles. Make sure `intel-media-va-driver` is installed and `hwdec=vaapi` is in `~/.config/mpv/mpv.conf`. |
| "Gaming PC is offline and has no MAC address" | Add `mac:` for the host. Wake-on-LAN must be enabled in BIOS + NIC. |
| Game starts on the PC but the stream is black | Sunshine's Desktop app must capture the screen the game is on; run the agent in the logged-in user session (the Windows installer does this). |
| Voice says Home Assistant isn't connected | Check `url`/`token`; the Smart Home page shows a reconnect banner while it retries. |
| Keyboard/mouse prompt never shows ✓ | It reads `/proc/bus/input/devices` on the TV. Plug the keyboard and mouse into the **OptiPlex**, not the gaming PC. |
