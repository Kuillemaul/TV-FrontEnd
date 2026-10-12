# Hearth

A custom TV operating system for a small PC behind the TV (built for a Dell OptiPlex 5080 Micro).
It replaces the smart-TV interface with a single interface you drive with a remote, a game
controller, or a keyboard and mouse.

- **Live TV & DVR**: channel guide, watch live and record from a USB tuner (via Tvheadend). CH+/CH− zap inside the player.
- **Streaming apps**: Plex, Netflix, YouTube (TV interface), Disney+, Prime Video, anything with a web app or Linux app.
- **Smart home**: Home Assistant dashboard with lights, climate, locks, covers, cameras and scenes, updating live.
- **Home lab**: up/down and latency for your services, plus Home Assistant sensors (CPU, NAS, UPS, internet).
- **Voice**: press the mic button and talk. TV commands ("open Netflix", "play Elden Ring", "watch channel 4") run locally; everything else ("turn off the kitchen lights") goes to Home Assistant Assist.
- **Family**: daily screen-time limits and bedtime for kid profiles, with a "That's all for today" screen and PIN-protected bonus time. "Who's watching?" again after a long idle.
- **Around the house**: doorbell pop-up with live camera (even over a game), alerts like "washer done" or "server down", movie-time lights that follow what's playing, TV power and inputs over HDMI-CEC.
- **Extras**: Plex continue watching, record a whole series, wake word, a phone remote (QR pairing, typing), a photo screensaver, 24-hour charts and PIN-protected one-button actions in the Lab.
- **Profiles**: a "Who's watching?" screen. Kid profiles get a hand-picked set of apps and games, no Smart Home/Lab/Settings, and voice only for TV commands. Parent profiles can have a PIN.
- **Make it yours**: reorder, hide or add app tiles (any website), and pick a theme (background, colour palette and font) from a side panel that previews live as you move. Each profile keeps its own theme.
- **Games**: details before you play (screenshot, rating, play time), **Browse** for unfavourited/uninstalled PC games or one emulated platform at a time, and a PCs panel to wake/sleep/shut down. Plus your favourites from **Playnite** (Steam, Epic, Game Pass, GOG…) and **LaunchBox** (emulators), plus Steam and custom entries, in one library. It handles libraries of 20,000+ ROMs. Pick one and the PC wakes, starts it, and it streams to the TV with Moonlight. Games that need a keyboard and mouse tell you to get them ready first, and the prompt shows whether a keyboard and mouse are plugged in.

```
 ┌──────────────── OptiPlex 5080 (Debian/Ubuntu) ─────────────────┐        ┌──── Gaming PC ────┐
 │ cage (Wayland kiosk)                                            │        │ Sunshine          │
 │  ├─ Chrome kiosk ── Hearth UI (React, spatial navigation)       │  HTTP  │ hearth_agent.py   │
 │  └─ foreground app: mpv · Plex · Chrome app · Moonlight ────────┼───────►│  Steam library,   │
 │                                                                 │ stream │  launch / stop    │
 │ Hearth server (Node) ── REST + WebSocket for the UI             │◄───────┤                   │
 │  ├─ launcher (one foreground app, returns to UI on exit)        │        └───────────────────┘
 │  ├─ /dev/input hotkeys (Home works even inside other apps)      │        ┌─── Emulator PC ───┐
 │  ├─ Tvheadend client ──► Tvheadend + USB tuner                  │        │ Sunshine          │
 │  ├─ Home Assistant WS client (states, Assist voice, intents)    │◄──────►│ hearth_agent.py   │
 │  └─ game service (Wake-on-LAN, agents, Moonlight)               │        │  ROM folders      │
 └─────────────────────────────────────────────────────────────────┘        └───────────────────┘
```

## Try it now (demo mode)

Everything runs with built-in demo data until you configure it, so you can explore the interface on any machine:

```bash
npm run go            # install, build and start → http://localhost:8787
```

(Same as `npm install`, `npm run build`, then `npm start`. Works in Windows PowerShell too.)

For UI development with hot reload, run `npm run dev:server` and `npm run dev:web` (then open http://localhost:5173).

### Controls

| Action | Remote / keyboard | Controller |
| --- | --- | --- |
| Move | Arrows | D-pad / left stick |
| Select | Enter / OK | A |
| Back | Back / Esc / Backspace | B |
| Voice | Mic key / `M` / F2 | Y |
| Home | Home | Start |
| Close any app, back to Hearth | Remote **Home** key | Hold **Xbox/PS** button 1s |

The mouse works everywhere too. Hovering focuses, clicking selects, and the cursor hides when idle.

## Setting it up for real

Follow **[docs/SETUP.md](docs/SETUP.md)**: OS install, the tuner, Home Assistant and voice, the gaming PCs, and remotes.

## Repository layout

| Path | What it is |
| --- | --- |
| `server/` | Hearth server (TypeScript, Fastify). Launcher, Tvheadend/Home Assistant/game clients, voice intents, input hotkeys. |
| `web/` | The TV interface (React + Vite). `src/nav/spatial.ts` handles remote/controller/mouse navigation. |
| `pc-agent/` | `hearth_agent.py`: dependency-free agent for the gaming and emulator PCs (Playnite, LaunchBox, Steam, ROM folders, launch/stop). `playnite/` holds the Playnite exporter extension. |
| `config/config.example.yaml` | Every setting, documented. Copy to `config/config.yaml`. |
| `os/` | OptiPlex setup: `install.sh`, the cage kiosk session, the systemd user service, mpv remote bindings, Tvheadend compose file. |

## Tests

```bash
npm test -w server      # voice intents + input device detection
cd pc-agent && python -m unittest test_hearth_agent.py   # LaunchBox/Playnite sources
npm run typecheck
```
