#!/usr/bin/env bash
# Runs inside cage. Starts the Hearth server (as a systemd user service so it restarts
# on failure) with this Wayland session's environment, then keeps the UI on screen.
set -uo pipefail

systemctl --user import-environment WAYLAND_DISPLAY XDG_RUNTIME_DIR XDG_SESSION_TYPE DISPLAY
# Don't wait for it: Chrome starts at the same time and shows the boot logo (splash.html)
# until the server answers, then switches to Hearth.
systemctl --user restart --no-block hearth.service

PROFILE="$HOME/.local/state/hearth/shell-browser"
mkdir -p "$PROFILE"
# If the UI browser ever crashes, bring it straight back.
while true; do
  google-chrome-stable \
    --kiosk --app=file:///opt/hearth/os/splash.html \
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
