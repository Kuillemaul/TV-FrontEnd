#!/usr/bin/env bash
# Hearth installer for a fresh Debian 13 (trixie) or Ubuntu 24.04 minimal install
# on the OptiPlex 5080 Micro. Run as root from the repository checkout:
#
#   sudo ./os/install.sh
#
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)"; exit 1; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TV_USER=tv

echo "==> Packages"
apt-get update
apt-get install -y --no-install-recommends \
  cage xwayland mpv curl ca-certificates gnupg flatpak \
  pipewire pipewire-pulse wireplumber \
  intel-media-va-driver vainfo \
  fonts-inter fonts-noto-color-emoji \
  v4l-utils dvb-tools ir-keytable inputattach ydotool \
  python3

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v google-chrome-stable >/dev/null; then
  echo "==> Google Chrome (includes Widevine for Netflix, Disney+, Prime Video)"
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update && apt-get install -y google-chrome-stable
fi

echo "==> Flatpak apps (Moonlight, Plex HTPC)"
flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install -y --noninteractive flathub com.moonlight_stream.Moonlight tv.plex.PlexHTPC

echo "==> TV user"
id "$TV_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$TV_USER"
# input: global Home key + keyboard/mouse detection; video/render: VAAPI; audio: sound
usermod -aG video,render,audio,input "$TV_USER"
loginctl enable-linger "$TV_USER"

echo "==> Hearth to /opt/hearth"
mkdir -p /opt/hearth
cp -a "$REPO/." /opt/hearth/
[[ -f /opt/hearth/config/config.yaml ]] || cp /opt/hearth/config/config.example.yaml /opt/hearth/config/config.yaml
chown -R "$TV_USER:$TV_USER" /opt/hearth
sudo -u "$TV_USER" bash -c 'cd /opt/hearth && npm ci && npm run build'
chmod +x /opt/hearth/os/*.sh

echo "==> Session"
mkdir -p /etc/systemd/system/getty@tty1.service.d
cp /opt/hearth/os/systemd/getty-autologin.conf /etc/systemd/system/getty@tty1.service.d/autologin.conf
TV_HOME=$(getent passwd "$TV_USER" | cut -d: -f6)
sudo -u "$TV_USER" mkdir -p "$TV_HOME/.config/systemd/user" "$TV_HOME/.config/mpv"
cp /opt/hearth/os/systemd/hearth.service "$TV_HOME/.config/systemd/user/hearth.service"
cp /opt/hearth/os/mpv/input.conf /opt/hearth/os/mpv/mpv.conf "$TV_HOME/.config/mpv/"
grep -q hearth/os/session.sh "$TV_HOME/.bash_profile" 2>/dev/null || cat >> "$TV_HOME/.bash_profile" <<'PROFILE'

# Start the Hearth TV session on the physical console.
if [[ -z "${WAYLAND_DISPLAY:-}" && "$(tty)" == /dev/tty1 ]]; then
  exec /opt/hearth/os/session.sh
fi
PROFILE
chown -R "$TV_USER:$TV_USER" "$TV_HOME"

# Let the tv user sleep/reboot/power off from the Settings page without a password.
cat > /etc/polkit-1/rules.d/50-hearth-power.rules <<'RULES'
polkit.addRule(function (action, subject) {
  if (subject.user == "tv" && /^org\.freedesktop\.login1\.(suspend|reboot|power-off)/.test(action.id)) {
    return polkit.Result.YES;
  }
});
RULES

# Phone remote → key presses into Plex/browser/Moonlight (ydotool needs its daemon).
cat > /etc/systemd/system/ydotoold.service <<'UNIT'
[Unit]
Description=ydotool daemon (Hearth phone remote)
[Service]
ExecStart=/usr/bin/ydotoold --socket-path=/run/ydotoold.socket --socket-perm=0666
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl enable ydotoold.service

systemctl daemon-reload
echo
echo "Done. Next:"
echo "  1. Edit /opt/hearth/config/config.yaml (Home Assistant token, Tvheadend, gaming PCs)"
echo "  2. Pair Moonlight with each PC once: add Moonlight as an app tile (see docs/SETUP.md), open it"
echo "     on the TV, pick the PC and type the PIN into Sunshine's web UI on that PC."
echo "  3. Reboot. The TV boots straight into Hearth."
