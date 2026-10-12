#!/usr/bin/env bash
# Started on tty1 after autologin (see install.sh). Runs the whole TV inside cage,
# a Wayland kiosk compositor: one full-screen app at a time, newest on top.
set -euo pipefail
export XDG_SESSION_TYPE=wayland
exec cage -d -s -- /opt/hearth/os/shell.sh
