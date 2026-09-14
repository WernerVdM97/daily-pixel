---
name: factory-control
description: Stop, pause, resume or restart the Dark Factory — the switch sources (.pi/factory/PAUSED, .env, the systemd unit), per-loop schedule pause/resume, firing one loop or one tick by hand, and the tick test that proves a stop took. Use when asked to pause, stop, halt, resume, restart or check the factory.
allowed-tools: Read, Edit, Write, Bash
---

# Factory control

The factory writes to GitHub and spends tokens, so it is **off unless something switches it on**: nothing fires until a source says `FACTORY_ENABLED=1`, and an explicit off beats an explicit on whichever source it comes from. The code is the authority, this page is the runbook: `scripts/factory-run-due.sh` (§ The one switch) and `docs/engine/dark-factory.md` § Turning it off.

**Off is a claim about the tick, not about a file.** A stop is not done until a tick says so out loud, so run one (see Verifying) rather than reporting that the lever is in place.

**The pause file gates the tick, not the schedule runner inside a session.** The switch lives in `scripts/factory-run-due.sh`, so it only stops what that script would have started. A `pi` session opened in this repo runs the project schedules itself and fires any occurrence it finds overdue, pause file and all: on 2026-09-14 a session started at 18:03Z found `factory-triage` overdue (its 17:30Z occurrence, never fired because every tick of the day had logged the off line) and fired it six seconds later, so a triage pass wrote the board as the very account the pause was protecting (`.pi/factory/memory/incidents/`). A stop is therefore **two** levers, the file for the tick and `schedule.pause` per loop for the session path, and neither is sufficient alone.

## What a tick is

`factory-run-due.timer` (system unit, `/etc/systemd/system/`) fires `factory-run-due.service` every 5 min plus up to 30s jitter. The service runs `/usr/local/bin/factory-run-due`, a copy of `scripts/factory-run-due.sh`, which does three things in order: fire due schedules (one `pi` child each), drain one job stage, then housekeeping (fetch, fast-forward `dev`, prune merged branches). A tick with nothing due still drains and housekeeps — the drain is what advances a job, so "nothing due" is not "nothing happened".

Ticks are skippable for three reasons besides the switch, and the journal line names which: below `FACTORY_MIN_AVAIL_MB` (default 1000), another launcher holding `/tmp/factory-run-due.lock`, or nothing due. Check the log line before blaming the switch.

## Levers

| Lever | Where | Scope | To resume |
| --- | --- | --- | --- |
| Pause file | `.pi/factory/PAUSED`, first line = the reason the journal prints | every tick: no fires, no drain, no housekeeping | `rm` it, **and** confirm an explicit on |
| Env switch | `FACTORY_ENABLED` in the repo `.env`, the unit, or a drop-in | same as the pause file | flip back to `1` |
| Per-loop | `"paused": true` in `.pi/subagents/schedules/<id>/schedule.json` | that one schedule; the drain and pruner keep running | `schedule.resume` |
| Timer | `sudo systemctl disable --now factory-run-due.timer` | the tick itself, machine-wide | `sudo systemctl enable --now …` |

The pause file is the **stop now, with a note** lever; `.env` is the one that reads as intent ("off until further notice"). Stacking both buys nothing except a second place to undo later, since either alone stops the whole tick.

Both of those gates, and the timer below them, only govern the tick. The session door is the per-loop row, and it is the one that is silently open: a schedule left unpaused is fired by any `pi` session in this repo the moment it notices the occurrence is overdue. A stop that means it uses the file **and** all eight loops.

## Stopping

Whole factory, on both levers, because each one guards a different door. First the tick, with a reason for the next reader:

```bash
cd /home/werner/projects/daily-pixel
printf '%s\n' "owner paused $(date -u +%F): <why>, until <what>" > .pi/factory/PAUSED
```

Then the schedules, since the file cannot stop a session firing one. One loop, or all eight in turn:

```
subagent({ action: "schedule.pause", id: "factory-triage" })
subagent({ action: "schedule.list" })   # ids and the paused flags
```

The eight schedule ids: `factory-triage`, `factory-executor`, `factory-sweeper`, `factory-scrumo`, `factory-scrumo-thu`, `factory-scrumo-sun`, `meta-oil-fri`, `meta-oil-sat`.

## Starting

1. Remove the pause file: `rm .pi/factory/PAUSED`.
2. Check for an explicit on, because `rm` alone starts nothing: `grep -nE '^[[:space:]]*FACTORY_ENABLED' .env` must show a truthy value (`1`/`true`/`yes`/`on`), or the unit must carry one.
3. Resume paused loops: `subagent({ action: "schedule.resume", id: "<id>" })`, one call per loop, for every loop the stop paused rather than only the one you came for. A schedule left paused never fires, and the tick's off line keeps saying the factory is stopped, so the two levers read as one state and can disagree.
4. Confirm the machinery: `systemctl is-active factory-run-due.timer`.
5. Run one tick and watch it do the full three steps (Verifying).

## By hand

A tick, now: `bash scripts/factory-run-due.sh` (uses the repo copy and the same lock, memory preflight and switch). One loop by name, ignoring its due time: `FACTORY_FIRE=factory-triage bash scripts/factory-run-due.sh` — a deliberate fire still runs while the factory is off, but skips the drain and housekeeping so a frozen job stays frozen. The ledger commands (`factory-jobs.ts start|drain|retry|list|show|stale`) are the owner's tools and always work.

## Verifying

```bash
cd /home/werner/projects/daily-pixel
bash scripts/factory-run-due.sh          # expect: factory is off (...PAUSED: <reason>); skipping this tick
journalctl -u factory-run-due.service --since "-15min" --no-pager | tail -5
npx --no-install tsx scripts/factory-jobs.ts list      # expect: no jobs in the ledger, or a named one
systemctl list-timers factory-run-due.timer            # the tick is still scheduled; the switch gates it
cmp /usr/local/bin/factory-run-due scripts/factory-run-due.sh
```

And the door that has no journal: `subagent({ action: "schedule.list" })` must show eight `paused` rows while the factory is stopped. A stopped factory with eight `scheduled` rows is stopped only until someone opens a session here.

A stopped factory reads as: the off line and nothing else. No `draining job stages`, no `housekeeping`, no `{"action":…}` from the ledger. Anything past that line means a stage was already in flight when the switch landed, which is normal and by design.

## Traps

- **An in-flight stage finishes.** A tick already inside a 50-minute `build` cannot be interrupted safely, and killing it mid-write is what loses work; the next tick sees the switch. Check the ledger before declaring a clean stop.
- **The file does not stop a session fire.** `.pi/factory/PAUSED` is read by `scripts/factory-run-due.sh`, so it stops that script's schedules, drain and housekeeping and nothing else. pi's own schedule runner fires an overdue project schedule from inside any session in this repo, so a stop that leaves the loops unpaused still writes to GitHub the next time someone opens `pi` here. Pause the schedules too, and read `scheduleOrigin` in the run's `status.json` to tell a scheduled fire from a deliberate `FACTORY_FIRE`.
- **`FACTORY_FIRE` and `factory-jobs.ts` bypass the switch on purpose.** They are the human path. If the work must stop, do not leave a hand-fired run going and call it paused.
- **`rm` does not start anything.** Presence of the pause file stops the factory even when enabled; absence still means off. Only an explicit on enables it.
- **State is local.** `.env`, `.pi/factory/*` and `.pi/subagents/` are gitignored (`project.json` and the memory skeleton excepted), so a clone inherits neither the schedules nor any of this state.
- **The installed copy drifts.** Edit `scripts/factory-run-due.sh`, then reinstall with the `sudo cp` lines at the head of that file, and `cmp` the two.
- **Record the pause where the factory remembers things.** A pause with a cause and a date belongs in `.pi/factory/memory/incidents/memory.md` as well, because `PAUSED` is untracked and dies with the checkout.
