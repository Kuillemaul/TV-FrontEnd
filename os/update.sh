#!/usr/bin/env bash
# Hearth updater: fetch the latest version, rebuild, restart, and roll back if it doesn't come up.
# Runs as root from hearth-update.service: nightly (hearth-update.timer) or "Update now" in the
# network editor. Progress and the changelog go to the state file the editor reads.
#
#   sudo systemctl start hearth-update      # update now
#   journalctl -u hearth-update             # what happened
set -uo pipefail

REPO=${HEARTH_REPO:-/opt/hearth}
TV_USER=${HEARTH_USER:-tv}
TV_HOME=$(getent passwd "$TV_USER" | cut -d: -f6)
STATE_DIR="${HEARTH_STATE_DIR:-$TV_HOME/.local/state/hearth}"
STATUS="$STATE_DIR/update.json"
NIGHTLY=0
[[ "${1:-}" == "--nightly" ]] && NIGHTLY=1

as_tv() { sudo -u "$TV_USER" -H "$@"; }
git_tv() { as_tv git -C "$REPO" "$@"; }

# status <state> <message> [old] [new]: write update.json (state: checking|updating|up-to-date|updated|failed|rolled-back)
status() {
  mkdir -p "$STATE_DIR"
  local changes="[]"
  if [[ -n "${3:-}" && -n "${4:-}" ]]; then
    changes=$(git_tv log --format='%h%x09%cI%x09%s' "$3..$4" 2>/dev/null | python3 -c '
import json, sys
print(json.dumps([dict(zip(("sha", "date", "subject"), l.rstrip("\n").split("\t", 2))) for l in sys.stdin if l.strip()]))')
  fi
  python3 - "$STATUS" "$1" "$2" "${3:-}" "${4:-}" "$changes" <<'PY'
import json, sys, time
path, state, message, old, new, changes = sys.argv[1:7]
try:
    data = json.load(open(path))
except Exception:
    data = {}
data.update({"state": state, "message": message, "checkedAt": int(time.time() * 1000)})
if new:
    data.update({"from": old, "to": new, "changes": json.loads(changes), "updatedAt": int(time.time() * 1000)})
json.dump(data, open(path, "w"), indent=2)
PY
  chown "$TV_USER:$TV_USER" "$STATUS" 2>/dev/null || true
  echo "[hearth-update] $1: $2"
}

auto_update_enabled() {
  python3 - "$STATE_DIR/state.json" <<'PY'
import json, sys
try:
    s = json.load(open(sys.argv[1])).get("settings", {})
except Exception:
    s = {}
sys.exit(0 if s.get("autoUpdate", True) else 1)
PY
}

server_port() {
  local port
  port=$(grep -A3 -E '^server:' "$REPO/config/config.yaml" 2>/dev/null | grep -oE 'port:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | head -1)
  echo "${port:-8787}"
}

restart_hearth() {
  if [[ -n "${HEARTH_RESTART_CMD:-}" ]]; then bash -c "$HEARTH_RESTART_CMD"; return; fi  # tests
  as_tv XDG_RUNTIME_DIR="/run/user/$(id -u "$TV_USER")" systemctl --user restart hearth.service
}

# Hearth answers /api/info with a new bootId within the time limit.
healthy() {
  local before="$1" port deadline boot
  port=$(server_port)
  deadline=$((SECONDS + ${HEARTH_HEALTH_SECONDS:-90}))
  while ((SECONDS < deadline)); do
    boot=$(curl -fs --max-time 3 "http://127.0.0.1:$port/api/info" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("bootId",""))' 2>/dev/null)
    if [[ -n "$boot" && "$boot" != "$before" ]]; then return 0; fi
    sleep 2
  done
  return 1
}

build() {
  if [[ -n "${HEARTH_BUILD_CMD:-}" ]]; then as_tv bash -c "cd '$REPO' && $HEARTH_BUILD_CMD"; return; fi  # tests
  as_tv bash -c "cd '$REPO' && npm ci --no-audit --no-fund && npm run build"
}

if ((NIGHTLY)) && ! auto_update_enabled; then
  echo "[hearth-update] automatic updates are off"
  exit 0
fi

status checking "Checking for updates…"
branch=$(git_tv rev-parse --abbrev-ref HEAD)
old=$(git_tv rev-parse HEAD)
if ! git_tv fetch --quiet origin "$branch"; then
  status failed "Couldn't reach GitHub. Check the internet connection (and that the GitHub token is still valid)."
  exit 1
fi
new=$(git_tv rev-parse "origin/$branch")
if [[ "$old" == "$new" ]]; then
  status up-to-date "Hearth is up to date."
  exit 0
fi
# A version that failed to start once isn't retried; the next fix will be.
if [[ -f "$STATE_DIR/update-skip" && "$(cat "$STATE_DIR/update-skip")" == "$new" ]]; then
  status up-to-date "The newest version didn't start on this TV earlier, so it was skipped. Waiting for the next one."
  exit 0
fi

status updating "Installing $(git_tv rev-list --count "$old..$new") update(s)…" "$old" "$new"
os_changed=$(git_tv diff --name-only "$old" "$new" -- os/ | grep -v -E '^os/(update\.sh|plymouth/)' || true)
port=$(server_port)
boot_before=$(curl -fs --max-time 3 "http://127.0.0.1:$port/api/info" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("bootId",""))' 2>/dev/null || true)

# Only Hearth's own files change: config.yaml, profiles and everything in ~/.local/state stay.
git_tv reset --quiet --hard "$new"
if build; then
  # System parts (packages, services, the boot session) changed too: re-run the installer for those.
  if [[ -n "$os_changed" ]]; then
    echo "[hearth-update] system files changed: $os_changed"
    HEARTH_FROM_UPDATER=1 bash "$REPO/os/install.sh" || echo "[hearth-update] install.sh reported a problem"
  fi
  restart_hearth
  if healthy "$boot_before"; then
    note=""
    [[ -n "$os_changed" ]] && note=" Restart the TV to finish (system files changed)."
    status updated "Updated to $(git_tv log -1 --format=%h "$new").$note" "$old" "$new"
    exit 0
  fi
  echo "[hearth-update] Hearth didn't come back after the update"
fi

# Something went wrong: put the previous version back.
git_tv reset --quiet --hard "$old"
build && restart_hearth
echo "$new" > "$STATE_DIR/update-skip"
status rolled-back "The update didn't start properly, so the previous version was put back." "$old" "$new"
exit 1
