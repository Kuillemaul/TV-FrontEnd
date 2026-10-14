# Tonight's checks

Run these on the TV PC (SSH or a keyboard on the OptiPlex), as your own user. Paste the output back into the chat.

## 0. Update first

Network editor (`http://<tv-ip>:8780`) → Overview → **Check for updates now**. Wait for Hearth to come back.

## 1. Plex recording check (read-only, records nothing)

Paste this whole block in one go:

```bash
URL=$(sudo grep -A4 '^plex:' /opt/hearth/config/config.yaml | grep -oP 'url:\s*"?\K[^"\s]+')
TOKEN=$(sudo grep -A4 '^plex:' /opt/hearth/config/config.yaml | grep -oP 'token:\s*"?\K[^"\s]+')
NOW=$(date +%s)
GUID=$(curl -s -g -H 'Accept: application/json' "$URL/tv.plex.providers.epg.cloud:2/grid?type=1%2C4&endsAt>=$((NOW+7200))&beginsAt<=$((NOW+7200))&X-Plex-Token=$TOKEN" | python3 -c 'import json,sys; m=json.load(sys.stdin)["MediaContainer"]["Metadata"]; e=next(x for x in m if x.get("type")=="episode"); print(e["guid"])')
echo "$GUID"
curl -s -H 'Accept: application/json' "$URL/media/subscriptions/template?guid=$GUID&X-Plex-Token=$TOKEN" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for t in d["MediaContainer"]["SubscriptionTemplate"]:
    for s in t["MediaSubscription"]:
        print(s.get("type"), s.get("title"), "| library", s.get("targetLibrarySectionID"), "| settings", len(s.get("Setting",[])), "| params", str(s.get("parameters"))[:80])'
```

Expected: lines starting `4 This Episode` and `2 All Episodes`.

## 2. Try a real recording

In Hearth: Live TV → pick something later tonight → **Record**. Then Live TV → **Recordings** should list it, and the
Plex app should show it under Live TV & DVR → Recording Schedule. Cancel it afterwards if you don't want it.

## 3. Live TV: stuck when watching a channel

Start a channel. If keys don't get you out, use the phone remote's Home button, then:

```bash
sudo tail -40 /home/tv/.local/state/hearth/mpv-livetv.log
sudo journalctl _SYSTEMD_USER_UNIT=hearth.service --since "-10 min" --no-pager | grep -iE "launch|exited|plex live|home" | tail -20
```

Also note: did it actually play (moving picture/sound)? Which Home did you press (remote or keyboard)?

## 4. Eufy doorbell live view

Settings → **Test doorbell** (or say "who's at the door?"). The picture should go live after 3–5 seconds. If it stays a
still image:

```bash
sudo journalctl _SYSTEMD_USER_UNIT=hearth.service --since "-10 min" --no-pager | grep -i camera | tail -10
```

## 5. Quick looks

- Search (magnifier, top right): try "abc", "news", a film you own.
- Controller: LB / RB switch pages; the top menu no longer flashes the previous item.
- Live TV → **Choose channels** → *Hide SD copies*, *Hide radio*.

## 6. Home Assistant link (new)

1. In Home Assistant: Developer tools → States, search `hearth`. You should see
   `sensor.hearth_living_room_activity` (try opening Plex on the TV and watch it change), `_profile` and `_sleep_timer`.
2. **Developer tools → Events**, event type `hearth_command`, event data:
   ```yaml
   command: notify
   title: Hello from Home Assistant
   ```
   → **Fire event**. A pop-up should appear on the TV. Try `command: morning` too.
3. Add Google Calendar to Home Assistant (Settings → Devices & services → Add integration → **Google Calendar**, or
   **Remote Calendar** with the calendar's secret iCal address from Google Calendar settings).
4. On the TV say "good morning" (or fire `command: morning`): calendar, weather and to-do lists should show.

Automations to copy: [HOME-ASSISTANT.md](HOME-ASSISTANT.md).

## 7. "In use" PCs (new)

1. Update the agent on both PCs: run `C:\Hearth\pc-agent\setup-windows.ps1` again (or wait for the 4am update).
2. Sit at the gaming PC and move the mouse. Within 15 seconds, Games on the TV should show **Gaming PC · In use**,
   the games greyed out, and picking one should ask *Stream anyway?*.
3. Lock the PC (Win+L): it should clear within 15 seconds.
4. If it never shows, run this on the TV (use the gaming PC's IP) and paste the output:
   ```bash
   curl -s http://<gaming-pc-ip>:47800/health
   ```
   It should include `"presence": {"idleSeconds": …}`.
