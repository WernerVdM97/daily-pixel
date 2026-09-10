#!/usr/bin/env bash
# Headless launcher for the Dark Factory's due schedules.
#
# Why this exists rather than "fire it from a pi session": an in-session run stacks a
# second pi process on a parent that already holds ~700 MB, and on this box that ended
# twice in an oom-kill (see .pi/factory/memory/incidents/). The first kill took a triage
# run mid-pass, which lost its work and changed nothing; the second took the interactive
# session that fired it. So the trigger lives outside any session, refuses to start
# without memory headroom, and refuses to overlap itself.
#
# Install (system units, matching scripts/daily-pixel-deploy.*):
#   sudo cp scripts/factory-run-due.sh /usr/local/bin/factory-run-due
#   sudo cp scripts/factory-run-due.service scripts/factory-run-due.timer /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now factory-run-due.timer
#
# Run one tick by hand:  scripts/factory-run-due.sh
# Fire one named schedule now, even though it is paused and not yet due:
#   FACTORY_FIRE=factory-triage scripts/factory-run-due.sh
set -euo pipefail

PROJECT_DIR="${FACTORY_PROJECT_DIR:-/home/werner/projects/daily-pixel}"
# Floor chosen to survive a tick alongside an interactive session on a 3.3GB box; the
# earlier oom-kills happened when a second pi stacked onto a parent already holding ~700MB.
MIN_AVAIL_MB="${FACTORY_MIN_AVAIL_MB:-1000}"
# Names one schedule to fire by hand. `run-due` only ever fires schedules that are unpaused
# and already overdue, which is no use for "run triage now" while the loops are still paused.
# A manual fire goes through the same lock and the same memory preflight as a timed tick.
FIRE_ID="${FACTORY_FIRE:-}"
LOCK_FILE="${FACTORY_LOCK_FILE:-/tmp/factory-run-due.lock}"
LOG_TAG="[factory-run-due]"

log() { echo "$LOG_TAG $*"; }

# MemAvailable is the kernel's estimate of what a new process can actually claim.
# MemFree would refuse ticks that would have fitted, because it ignores reclaimable cache.
read_avail_mb() {
  if [ -r /proc/meminfo ]; then
    awk '/^MemAvailable:/ {printf "%d", $2 / 1024}' /proc/meminfo
    return
  fi
  if command -v vm_stat >/dev/null 2>&1; then
    # macOS has no MemAvailable; free + inactive pages is the closest equivalent.
    vm_stat | awk -v page="$(getconf PAGESIZE)" '
      /Pages free/     { gsub(/\./, "", $3); free = $3 }
      /Pages inactive/ { gsub(/\./, "", $3); inactive = $3 }
      END { printf "%d", (free + inactive) * page / 1048576 }'
    return
  fi
  echo ""
}

# systemd and cron both hand us a bare PATH that excludes ~/.local/bin, so fall back to
# the conventional install location rather than failing the tick.
PI_BIN="${PI_BIN:-}"
if [ -z "$PI_BIN" ]; then
  PI_BIN="$(command -v pi || true)"
fi
if [ -z "$PI_BIN" ] && [ -x "$HOME/.local/bin/pi" ]; then
  PI_BIN="$HOME/.local/bin/pi"
fi
if [ -z "$PI_BIN" ]; then
  log "pi not on PATH and no binary at \$HOME/.local/bin/pi; set PI_BIN"
  exit 1
fi

avail_mb="$(read_avail_mb)"
if [ -z "$avail_mb" ]; then
  log "cannot read available memory; refusing to fire rather than risk an oom-kill"
  exit 1
fi
if [ "$avail_mb" -lt "$MIN_AVAIL_MB" ]; then
  log "only ${avail_mb}MB available, need ${MIN_AVAIL_MB}MB; skipping this tick"
  exit 0
fi

# Non-blocking lock: a tick that lands while a run is in flight is a skip, not a queue
# entry. The schedules also skip overlap, but that guard lives inside the process we are
# trying not to start a second time.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another launcher holds $LOCK_FILE; skipping this tick"
  exit 0
fi

if [ -n "$FIRE_ID" ]; then
  log "${avail_mb}MB available; firing schedule ${FIRE_ID}"
  ACTION="Call subagent({action:'schedule.run', id:'${FIRE_ID}'}) exactly once. Report what it returned, in under 10 lines."
else
  log "${avail_mb}MB available; firing due schedules"
  ACTION="Call subagent({action:'schedule.run-due'}) exactly once. Report which schedules were due and what each returned, in under 10 lines."
fi
cd "$PROJECT_DIR"
exec "$PI_BIN" -p --approve --tools subagent "$ACTION"
