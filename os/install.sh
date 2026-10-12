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
  sudo cage xwayland mpv curl ca-certificates gnupg flatpak polkitd \
  pipewire pipewire-pulse pipewire-alsa wireplumber pulseaudio-utils alsa-utils \
  intel-media-va-driver vainfo \
  fonts-inter fonts-noto-color-emoji \
  v4l-utils dvb-tools ir-keytable inputattach \
  python3

# ydotool (phone remote key presses) isn't packaged in Debian 13, so build 1.x from source.
if [[ ! -x /usr/local/bin/ydotoold ]]; then
  echo "==> ydotool (from source)"
  apt-get install -y --no-install-recommends git cmake build-essential
  tmp=$(mktemp -d)
  git clone --depth 1 --branch v1.0.4 https://github.com/ReimuNotMoe/ydotool.git "$tmp/ydotool"
  cmake -S "$tmp/ydotool" -B "$tmp/build"
  cmake --build "$tmp/build" -j"$(nproc)" --target ydotool ydotoold
  install -m 755 "$tmp/build/ydotool" "$tmp/build/ydotoold" /usr/local/bin/
  rm -rf "$tmp"
fi

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

echo "==> Boot splash & quick boot"
apt-get install -y --no-install-recommends plymouth plymouth-themes
mkdir -p /usr/share/plymouth/themes/hearth
cp /opt/hearth/os/plymouth/hearth/* /usr/share/plymouth/themes/hearth/
# Load the Intel graphics driver early so the splash appears straight after the BIOS logo.
grep -qx i915 /etc/initramfs-tools/modules 2>/dev/null || echo i915 >> /etc/initramfs-tools/modules
# Leave the last splash frame on screen until the TV shell takes over (no text console flash).
mkdir -p /etc/systemd/system/plymouth-quit.service.d
cat > /etc/systemd/system/plymouth-quit.service.d/hearth.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=-/usr/bin/plymouth quit --retain-splash
UNIT
touch "$TV_HOME/.hushlogin"
if [[ -f /etc/default/grub ]]; then
  # No boot menu (hold Shift or tap Esc during boot to get it back), quiet kernel, splash on.
  sed -i -E \
    -e 's/^#?GRUB_TIMEOUT=.*/GRUB_TIMEOUT=1/' \
    -e 's/^#?GRUB_TIMEOUT_STYLE=.*/GRUB_TIMEOUT_STYLE=hidden/' \
    -e 's/^#?GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="quiet splash loglevel=3 rd.udev.log_level=3 systemd.show_status=false vt.global_cursor_default=0"/' \
    /etc/default/grub
  grep -q '^GRUB_TIMEOUT_STYLE=' /etc/default/grub || echo 'GRUB_TIMEOUT_STYLE=hidden' >> /etc/default/grub
  update-grub
fi
plymouth-set-default-theme -R hearth
# Waiting for the network to be "fully online" isn't needed to show the TV (Hearth retries).
for unit in systemd-networkd-wait-online.service NetworkManager-wait-online.service; do
  systemctl disable --now "$unit" 2>/dev/null || true
done

# Let the tv user sleep/reboot/power off from the Settings page without a password.
mkdir -p /etc/polkit-1/rules.d
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
ExecStart=/usr/local/bin/ydotoold --socket-path=/run/ydotoold.socket --socket-perm=0666
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ydotoold.service
echo
echo "Done. Next:"
echo "  1. Edit /opt/hearth/config/config.yaml (Home Assistant token, Tvheadend, gaming PCs)"
echo "  2. Pair Moonlight with each PC once: add Moonlight as an app tile (see docs/SETUP.md), open it"
echo "     on the TV, pick the PC and type the PIN into Sunshine's web UI on that PC."
echo "  3. Reboot. The TV boots straight into Hearth."
