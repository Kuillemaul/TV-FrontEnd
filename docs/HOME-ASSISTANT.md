# Hearth and Home Assistant

**Home Assistant is the brain, Hearth is the screen.** Home Assistant owns everything about the house (calendars,
weather, presence, lights, doorbell events, "when this happens, do that"). Hearth shows it on the TV and does the
TV-only things (apps, Live TV, games, remotes).

Hearth connects to Home Assistant with the `homeassistant:` section in `config.yaml` (URL + long-lived token). Once
connected, it works both ways:

## 1. What Hearth tells Home Assistant

Three entities appear in Home Assistant (Developer tools → States, search `hearth`). `living_room` comes from the
TV's name (`ui.name`); set `homeassistant.tvId` to choose it yourself.

| Entity | State | Attributes |
|---|---|---|
| `sensor.hearth_living_room_activity` | `home`, `plex`, `live_tv`, `recording`, `game`, `app` | `title`, `app`, `channel` (Live TV), `game`, `started` |
| `sensor.hearth_living_room_profile` | the profile on screen ("Me", "Leo"…) | `kind` (`admin` / `kid`) |
| `sensor.hearth_living_room_sleep_timer` | when the sleep timer ends (timestamp), or unknown | |

They update the moment something changes. (They're set over Home Assistant's API, so they aren't editable in the UI;
Hearth re-sends them after Home Assistant restarts.)

## 2. What Home Assistant can tell Hearth

Any automation or script fires a **`hearth_command`** event:

```yaml
action:
  - event: hearth_command
    event_data:
      command: notify
      title: The washer is done
```

| `command` | Extra fields | What it does |
|---|---|---|
| `notify` | `title`, `message`, `camera`, `image`, `seconds` | Pop-up on the TV (over apps too). `camera: camera.x` shows it live. |
| `camera` | `entity`, `name` | Camera in the corner (full screen over apps). |
| `hide_camera` | | Hides it. |
| `open_app` | `app` (id like `plex`, or a name) | Opens an app. |
| `channel` | `channel` (number like `20`, or a name like `ABC News`) | Live TV on that channel. |
| `home` | | Closes whatever's playing, back to Home. |
| `stop` | | Closes whatever's playing. |
| `sleep_timer` | `minutes` (0 cancels) | Sets the sleep timer. |
| `tv_on` / `tv_off` | | TV power over HDMI-CEC. |
| `page` | `page`: `home`, `tv`, `apps`, `games`, `requests`, `smarthome`, `search`, `morning`… | Shows a page. |
| `search` | `query` | Search page with results. |
| `morning` | | The morning screen. |

With more than one Hearth TV, add `tv: living_room` (or `tv: all`) to target one.

## 3. Ready-made automations

Paste into *Settings → Automations → Create → ⋮ → Edit in YAML*. Change the entity ids to yours.

### Doorbell: show the camera on the TV (and pause nothing else)

```yaml
alias: Doorbell on the TV
triggers:
  - trigger: state
    entity_id: binary_sensor.doorbell_ringing   # your Eufy doorbell's ring sensor
    to: "on"
conditions:
  - condition: not
    conditions:
      - condition: state
        entity_id: sensor.hearth_living_room_activity
        state: unavailable
actions:
  - event: hearth_command
    event_data:
      command: notify
      title: Someone's at the door
      camera: camera.doorbell
      seconds: 30
```

(Hearth's own `alerts.doorbell` in config.yaml does this too; use one or the other.)

### Movie-time lights

```yaml
alias: Dim the lights for Plex and Live TV
triggers:
  - trigger: state
    entity_id: sensor.hearth_living_room_activity
    to: [plex, live_tv]
conditions:
  - condition: sun
    after: sunset
actions:
  - action: light.turn_on
    target: { entity_id: light.living_room }
    data: { brightness_pct: 10, transition: 3 }
mode: restart
```

```yaml
alias: Lights back up after watching
triggers:
  - trigger: state
    entity_id: sensor.hearth_living_room_activity
    to: home
    for: { seconds: 10 }
conditions:
  - condition: sun
    after: sunset
actions:
  - action: light.turn_on
    target: { entity_id: light.living_room }
    data: { brightness_pct: 70, transition: 3 }
```

(Turn Hearth's own *Movie-time lights* off in Settings if you use these.)

### Kids' school-night bedtime

```yaml
alias: School-night TV bedtime
triggers:
  - trigger: time
    at: "20:50:00"
conditions:
  - condition: time
    weekday: [sun, mon, tue, wed, thu]
  - condition: state
    entity_id: sensor.hearth_living_room_profile
    attribute: kind
    state: kid
actions:
  - event: hearth_command
    event_data: { command: notify, title: "10 minutes left", message: "Time to finish up", seconds: 20 }
  - delay: { minutes: 10 }
  - event: hearth_command
    event_data: { command: tv_off }
```

### Washer / dryer finished

```yaml
alias: Washer done on the TV
triggers:
  - trigger: state
    entity_id: sensor.washer_status
    from: running
    to: idle
actions:
  - event: hearth_command
    event_data: { command: notify, title: The washer is done, message: Time to hang it out }
```

### Morning news when someone's home and the TV turns on

```yaml
alias: Morning screen at 7 on weekdays
triggers:
  - trigger: time
    at: "07:00:00"
conditions:
  - condition: time
    weekday: [mon, tue, wed, thu, fri]
  - condition: state
    entity_id: person.you
    state: home
actions:
  - event: hearth_command
    event_data: { command: tv_on }
  - event: hearth_command
    event_data: { command: morning }
```

## 4. The morning screen

The first time the TV wakes up in the morning (05:00–10:00, after being idle a couple of hours) Hearth shows **Good
morning**: today's and tomorrow's events from your **Home Assistant calendars**, the weather and forecast from
`homeassistant.weather`, open items on your **to-do lists**, and a button for the news channel. Say "good morning" or
"what's on today" any time.

**Google Calendar:** add it to Home Assistant (*Settings → Devices & services → Add integration → Google Calendar*, or
*Remote Calendar* with the calendar's secret iCal address). Every `calendar.*` entity shows up automatically.

Optional settings in `config.yaml`:

```yaml
morning:
  start: "05:00"
  end: "10:00"
  calendars: [calendar.family, calendar.work]   # default: all calendars
  todo: [todo.shopping_list]                    # default: any list with something left to do
  news: { channel: 24 }                         # or { app: youtube }; default: a channel with "News" in its name
# morning: false   # turn it off
```
