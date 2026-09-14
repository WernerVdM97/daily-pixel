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
#
# One switch turns the whole factory off: see § The one switch below. Off means no schedules,
# no drain, no housekeeping; a FACTORY_FIRE by name still runs.
#
# A tick has two steps: the due schedules, then the job drain. The schedules step no longer
# `exec`s, because the shell has to survive to the drain: a job's stage runs one per process
# (see docs/engine/dark-factory-job-ledger.md), so its progress comes from the drain running
# every tick, not from a long-lived agent. Schedules fire first, so a job started at 06:00
# can have its build running by 06:01.
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
# The budget preflight reads the key's own ceiling with this. Overridable so a test can answer
# for it, exactly as PI_BIN is below.
CURL_BIN="${CURL_BIN:-curl}"
# The model this launcher's own fire runs on, mirroring WRAPPER_MODEL in scripts/factory-jobs.ts.
# The pin is load-bearing, not a preference: with no --model, pi resolves the model from
# settings and installs --api-key against THAT provider, so the OpenRouter key would land on
# the settings-default provider and every fire would 401. It also pins the parent whose
# preferredProvider the children's own model resolution (z-ai/glm-5.3, delegate-judge) follows.
FACTORY_FIRE_MODEL="openrouter/deepseek/deepseek-v4.1-flash"

log() { echo "$LOG_TAG $*"; }

# ── The one switch ─────────────────────────────────────────────────────────
# Off means this tick does nothing at all: no schedules, no drain, no housekeeping. Three
# sources can say so, and any of them is enough, because none should have to be the only one:
# the process environment (a systemd drop-in), the repo .env (where the factory's other knobs
# live), and a pause file whose mere presence stops the factory, with an optional reason on its
# first line. A named FACTORY_FIRE still runs — that is a human asking for one schedule by
# hand — but it does not drag the drain and the pruner along behind it.
PAUSE_FILE="${FACTORY_PAUSE_FILE:-$PROJECT_DIR/.pi/factory/PAUSED}"

# bash 3.2 (macOS) has no ${var,,}, so lowercase through tr.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# The factory's own OpenRouter credential, so a factory run's spend is separable from the shared
# one every interactive `pi` session uses (`~/.pi/agent/auth.json`). Resolved the same way as
# FACTORY_ENABLED: the process environment first (where a systemd drop-in would put it), then the
# repo `.env` by name. Line-oriented config, never sourced.
#
# Empty is a valid answer and means "fall back to the shared credential". The caller must then
# OMIT `--api-key` rather than pass it empty: `--api-key ""` is not "no key", it is a broken
# key, and it would turn a missing variable into a factory that cannot reach a model at all.
#
# `--api-key` and not an exported variable, because pi resolves `--api-key`, then `auth.json`,
# THEN the environment. An exported FACTORY_OPENROUTER_API_KEY would be silently ignored in
# favour of the shared auth.json key while looking correctly configured.
factory_key() {
  local raw
  if [ -n "${FACTORY_OPENROUTER_API_KEY:-}" ]; then
    printf '%s' "$FACTORY_OPENROUTER_API_KEY"
    return 0
  fi
  [ -r "$PROJECT_DIR/.env" ] || return 0
  raw="$(sed -n 's/^[[:space:]]*FACTORY_OPENROUTER_API_KEY[[:space:]]*=[[:space:]]*//p' "$PROJECT_DIR/.env" | tail -1)"
  case "$raw" in
    \"*) raw="${raw#\"}" && raw="${raw%%\"*}" ;;
    \'*) raw="${raw#\'}" && raw="${raw%%\'*}" ;;
    *) raw="${raw%%#*}" ;;
  esac
  printf '%s' "$raw" | tr -d '[:space:]'
}

# The factory key's own ceiling, read live rather than trusted to a note. The same
# GET /api/v1/key that reports the split reports `limit_remaining`, so nothing is mirrored into
# `.env`: raise the cap on the dashboard and the next tick sees it, lower it mid-window and what
# is left is recomputed, remove it and the field comes back null.
#
# Prints the remaining amount, or nothing when there is no factory key, the request failed, or
# the answer cannot be read. FAIL OPEN is the point: only a definite answer stops the tick -
# a zero budget, or an HTTP 401/403, which says the key itself is wrong and every call today
# would be refused (with --api-key passed there is no fallback to misroute onto). Anything the
# preflight cannot read - a timeout, a 5xx, an unparsable body - still lets the tick run,
# because a guard that cannot see the budget must not become a new way to stop the factory.
# Returns non-zero only for the definite-rejection skip; the reason is already logged.
factory_key_remaining() {
  local key body code
  key="$(factory_key)"
  [ -n "$key" ] || return 0
  # -w appends \n<http_code>, so a rejected key is distinguishable from an unreadable answer.
  body="$("$CURL_BIN" -s --max-time 5 -w '\n%{http_code}' -H "Authorization: Bearer $key" \
    https://openrouter.ai/api/v1/key 2>/dev/null)" || return 0
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  case "$code" in
    200) ;;
    401 | 403)
      log "factory key was rejected by OpenRouter (HTTP ${code}); check FACTORY_OPENROUTER_API_KEY in .env or the unit; skipping this tick" >&2
      return 1 ;;
    *) return 0 ;;
  esac
  printf '%s' "$body" | sed -n 's/.*"limit_remaining"[: ]*\([0-9][0-9.]*\).*/\1/p' | tail -1
}

is_off() {
  case "$(lower "$1")" in 0 | false | no | off) return 0 ;; *) return 1 ;; esac
}

factory_off_reason() {
  local from_env reason enabled=0
  if [ -n "${FACTORY_ENABLED:-}" ]; then
    if is_off "$FACTORY_ENABLED"; then
      echo "FACTORY_ENABLED=$FACTORY_ENABLED"
      return 0
    fi
    enabled=1
  fi
  if [ -r "$PROJECT_DIR/.env" ]; then
    # Line-oriented config, not a shell script: read the one key rather than sourcing it.
    from_env="$(sed -n 's/^[[:space:]]*FACTORY_ENABLED[[:space:]]*=[[:space:]]*//p' "$PROJECT_DIR/.env" | tail -1)"
    # A trailing comment is not part of a boolean, and the quoting is optional.
    case "$from_env" in
      \"*) from_env="${from_env#\"}" && from_env="${from_env%%\"*}" ;;
      \'*) from_env="${from_env#\'}" && from_env="${from_env%%\'*}" ;;
      *) from_env="${from_env%%#*}" ;;
    esac
    from_env="$(printf '%s' "$from_env" | tr -d '[:space:]')"
    if [ -n "$from_env" ]; then
      if is_off "$from_env"; then
        echo "FACTORY_ENABLED=$from_env in .env"
        return 0
      fi
      enabled=1
    fi
  fi
  if [ -e "$PAUSE_FILE" ]; then
    reason="$(sed -n '1p' "$PAUSE_FILE" 2>/dev/null || true)"
    if [ -n "$reason" ]; then
      echo "$PAUSE_FILE: $reason"
    else
      echo "$PAUSE_FILE exists"
    fi
    return 0
  fi
  # Nothing switched it on, so it is off: absence means off, which is the point of a switch
  # that spends tokens and writes to GitHub. Enabling is a deliberate act (FACTORY_ENABLED=1
  # in the environment, in `.env`, or in the unit), and FACTORY_FIRE still runs by name.
  if [ "$enabled" = "1" ]; then
    return 1
  fi
  echo "not enabled (no FACTORY_ENABLED=1 in the environment, .env or the unit)"
  return 0
}

FACTORY_PAUSED=""
if reason="$(factory_off_reason)"; then
  if [ -n "$FIRE_ID" ]; then
    FACTORY_PAUSED=1
    log "factory is off ($reason); firing ${FIRE_ID} anyway, because it was asked for by name"
  else
    log "factory is off ($reason); skipping this tick"
    exit 0
  fi
fi

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

# The ticks are 5 min against 12h/24h/48h/7d cadences, so nearly every tick has nothing to do.
# Without this gate each one would spawn a pi (~700MB peak, one model call) just to be told
# "nothing due". Read the stored nextRunAt instead: same-width UTC ISO stamps compare fine as
# strings. A record this cannot make sense of counts as due, so a schedule-format change costs
# extra ticks rather than parking the factory silently, which is the one failure that would
# not be noticed. Streams rather than grep -P or sed with alternation, because this runs on
# BSD and GNU userlands alike.
any_schedule_due() {
  local file paused next now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for file in "$PROJECT_DIR"/.pi/subagents/schedules/*/schedule.json; do
    [ -e "$file" ] || continue
    paused="$(sed -n 's/.*"paused": *\([a-z]*\).*/\1/p' "$file")"
    case "$paused" in
      true) continue ;;
      false) ;;
      *) return 0 ;;
    esac
    next="$(sed -n 's/.*"nextRunAt": *"\([^"]*\)".*/\1/p' "$file")"
    [ -n "$next" ] || return 0
    next="${next%%.*}Z"
    if [[ "$next" > "$now" ]]; then continue; fi
    return 0
  done
  return 1
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

# The cap is not a soft limit: past it OpenRouter refuses every call, and the key is passed as
# --api-key so there is no fallback to the shared credential. Reading it here turns a spent cap
# into one skipped tick with a reason, instead of a failed call per agent for the rest of the
# day. Before the lock, because there is nothing to serialise when nothing will run, and on every
# tick, because one GET on a free endpoint is nothing beside the ~700MB pi it guards.
if ! remaining="$(factory_key_remaining)"; then
  # The definite rejection is already logged by the preflight.
  exit 0
fi
if [ -n "$remaining" ] && awk -v r="$remaining" 'BEGIN { exit !(r <= 0) }'; then
  log "factory key is out of budget (limit_remaining=${remaining}); skipping this tick; raise the cap on the dashboard to resume"
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
elif any_schedule_due; then
  log "${avail_mb}MB available; firing due schedules"
  ACTION="Call subagent({action:'schedule.run-due'}) exactly once. Report which schedules were due and what each returned, in under 10 lines."
else
  # Nothing due is the ordinary tick now, not a reason to exit: a ready job stage does not
  # care whether a schedule fired, and the drain below is the only thing that advances it.
  log "${avail_mb}MB available; nothing due at $(date -u +%H:%MZ)"
  ACTION=""
fi

cd "$PROJECT_DIR"
status=0
PI_KEY="$(factory_key)"
if [ -z "$PI_KEY" ]; then
  # Loud on purpose, and hoisted above both spend paths so the common tick (nothing due, but a
  # stage ready for the drain) cannot fall back to the shared credential silently. Falling back
  # is a deliberate degradation, not an ordinary condition: it is the only way a factory run's
  # spend stops being separable.
  log "no FACTORY_OPENROUTER_API_KEY (env or .env); this tick spends on the shared ~/.pi/agent/auth.json credential"
fi
if [ -n "$ACTION" ]; then
  if [ -n "$PI_KEY" ]; then
    "$PI_BIN" -p --approve --tools subagent --model "$FACTORY_FIRE_MODEL" --api-key "$PI_KEY" "$ACTION" || status=$?
  else
    "$PI_BIN" -p --approve --tools subagent --model "$FACTORY_FIRE_MODEL" "$ACTION" || status=$?
  fi
fi

# One action per tick: reap an orphan, block a spent or twice-failed job, or run one ready
# stage. It holds its own drain lock for the whole run, stage included, so a stage in flight
# is never started twice; a failure here is logged and retried on the next tick, and the exit
# code still reaches systemd so `systemctl --failed` sees a broken factory.
if [ "${FACTORY_PAUSED:-}" = "1" ]; then
  log "factory is off; the drain and housekeeping steps are skipped too"
  exit "$status"
fi

if [ -f "$PROJECT_DIR/scripts/factory-jobs.ts" ]; then
  log "draining job stages"
  npx --no-install tsx scripts/factory-jobs.ts drain || status=$?
  # Repo hygiene, after the drain so a merge that `reconcile` just completed is included:
  # fetch (nothing should fork from a stale base), fast-forward local dev when that is safe,
  # and delete local branches whose PR is merged. It never touches origin's branches.
  log "housekeeping"
  npx --no-install tsx scripts/factory-jobs.ts housekeeping || status=$?
else
  log "no scripts/factory-jobs.ts in this checkout; skipping the drain step"
fi

exit "$status"
