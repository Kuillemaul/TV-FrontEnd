#!/usr/bin/env bash
# Runs inside cage. Starts the Hearth server (as a systemd user service so it restarts
# on failure) with this Wayland session's environment, then keeps the UI on screen.
set -uo pipefail

systemctl --user import-environment WAYLAND_DISPLAY XDG_RUNTIME_DIR XDG_SESSION_TYPE DISPLAY
systemctl --user restart hearth.service

for _ in $(seq 1 60); do
  curl -fs http://127.0.0.1:8787/api/info >/dev/null && break
  sleep 0.5
done

PROFILE="$HOME/.local/state/hearth/shell-browser"
mkdir -p "$PROFILE"
# If the UI browser ever crashes, bring it straight back.
while true; do
  google-chrome-stable \
    --kiosk --app=http://127.0.0.1:8787 \
    --user-data-dir="$PROFILE" \
    --ozone-platform-hint=auto \
    --noerrdialogs --disable-session-crashed-bubble --disable-infobars \
    --check-for-update-interval=31536000 \
    --autoplay-policy=no-user-gesture-required \
    --use-fake-ui-for-media-stream \
    --enable-features=VaapiVideoDecoder,AcceleratedVideoDecodeLinuxGL \
    --disable-features=Translate,MediaRouter
  sleep 1
done
