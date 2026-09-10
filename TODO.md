# TODO

**Actionable work has moved to the [Dark Factory board](https://github.com/users/WernerVdM97/projects/6)** (GitHub Project #6 on this repo). Seeded 2026-08-03 — 71 items, each an issue labelled by area, with milestone and priority. New work goes there, not in this file. See [[dark-factory]] for how the board and its agent loops work.

This file now keeps only the **narrative layer** — the handover context that is documentation, not cards.

## ⏭️ RESUME HERE (newest) — Dark Factory: bulletin live, headless launcher proven, loops fired (2026-09-10)

**Why the previous session stopped:** two OOM kills, `journalctl` → `tmux-spawn-*.scope: Failed with result 'oom-kill'` at 23:09:06 and 23:15:03, on a box with 1973 MB RAM, ~240 MB available, an interactive `pi` at 715 MB and the pi-lens TypeScript stack at ~690 MB. The 23:09 kill took triage run `d80169f9` (29 turns / 53 tool calls, then "process exited or disappeared before writing a result", nothing written); the 23:15 kill took the session that fired it. RAM is now 6 GB, and every loop below ran headless, outside any session, one at a time. Full record in `.pi/factory/memory/incidents/`.

**Done and verified.** Five commits on `dev`, none pushed: `2bf4a08` bulletin, `d4c6d5c` headless launcher, `7a6d02c` priority policy into the tracked triage definition, `014605a` cadence table, and a handover update of this file. Whole suite green (106 files / 2196 tests) and typecheck clean on `src` and the test project.

- **The bulletin works and is live.** `scripts/factory-bulletin.ts` is verified (19 of the new file's 21 cases landed with the fix) and posted as pinned issue **#103**. Pointing it at the live board found a real defect the unit tests could not: triage writes `**Triage 2026-09-10.** <the ask>` with the substance on the header's own line, and `toExcerpt` only matched `**Triage:`, so the header leaked into the owner-facing question column. Both forms now parse, and a `**Question:**` line beats the preamble above it. Sweeper job 5 runs the script instead of hand-rolling a digest.
- **The headless launcher is installed and proven.** `factory-run-due.timer` is enabled and active. Two fixes were needed to make a tick succeed: systemd's default `PATH` omits `~/.local/bin` where `pi` lives (the first tick exited 1), and `schedule.run-due` only fires schedules that are both unpaused and already overdue, so `FACTORY_FIRE=<id>` was added to fire one named schedule by hand through the same memory preflight and `flock`. The owner lowered the floor from 1500 MB to 1000 MB. Fire a loop with `sudo systemd-run --unit=factory-fire-<id> --collect --property=User=werner --property=WorkingDirectory=$PWD --property="Environment=HOME=/home/werner FACTORY_FIRE=<id>" /usr/local/bin/factory-run-due`.
- **Triage ran headless and produced real work** (47 turns / 68 tool calls, ~5 min, no OOM): triaged 27, 31, 33, 39, 40, 50, 93; newly Blocked with a written question 37, 38; overlaps flagged on 37→#51, 33→#48, 39→#76/#59, 40→#43/#61/#98, none merged by the agent.
- **Scrumo ran headless and sent its digest** (`message-id 1547725509180268544`, 23 lines, three decisions). Its findings: 7 open dependabot PRs, #21 CI red, the rest green. The digest is now armed with `--record`, so reactions on it will be tallied.
- **Priority policy is out of gitignored memory.** The milestone rule (`MVP`/`MVP+` = `P3 - low`, `v0.3.x polish` = `P2 - normal`) now lives in the tracked `.pi/agents/factory-triage.md`, together with the explicit statement that triage does not write `Priority`.
- **Cadences retuned** to triage 12h, executor 1d, sweeper 2d, scrumo 3d, anchors preserved. Applied by editing each record in `.pi/subagents/schedules/` directly; no tool action retunes a cadence. **All six schedules remain paused**, so nothing fires on its own until they are resumed.
- **The machine-local override now names the right account.** It said agent work must use `vault97eth`, which is not logged in anywhere; it now says `agent97eth`, matching `gh api user --jq .login`. Edited at source in `~/dotVault/agent/OVERRIDE.local.md`, with `SYSTEM.md` regenerated exactly as `bin/dev` builds it (baseline + `OVERRIDE.md` + `OVERRIDE.local.md`), so `~/.pi/agent/APPEND_SYSTEM.md` and `~/.claude/CLAUDE.md`, both symlinks to it, follow. Both dotVault files are gitignored, so nothing there needs committing.

**Still open.**

1. **The executor has never been fired headless.** It is the only loop that writes code and opens PRs, and it is the one to try next. One item is `Approved` (#34).
2. **Four `Blocked` items still have no question written**: #65, #82, #96, #97 (`needs-human-decision`, zero comments). Nothing can unblock them until triage states the ask. #95 was answered by the owner, so the count is 4, not the 5 the previous handover recorded.
3. **Four owner answers are still unread by triage**: #92, #95, #28, #32. Triage's own note says #28 and #32 need a human close rather than more triage.
4. **A launcher anomaly worth understanding.** After scrumo completed, the launcher's own headless `pi` spawned a stray second child (`2228b2fe`), stopped it after one turn, and its final report narrated a self-invented test failure instead of reporting scrumo's digest. Nothing was written to the repo and scrumo's own run was unaffected (`96705f1e`, complete). The launcher prompt now asks for a bare report, but a report-shape guard would be the real fix.
5. **Scrumo does not arm its own digest**; `factory-inbox.ts --record <id>` has to be run afterwards. Un-armed digests cannot be answered by reaction. Worth folding into scrumo.
6. **Rotate the `agent97eth` `gh` token.** A `grep` over `~/.config/gh/hosts.yml` printed the OAuth token into a session transcript, and nothing put it anywhere else. A server-side revoke (GitHub → Settings → Applications → Authorized OAuth Apps → GitHub CLI) is the only fix that kills the value; `gh auth refresh` re-issues but may leave the old one live. Revoking also drops `WernerVdM97`'s token, so both accounts need `gh auth login` afterwards.
7. **`docs/engine/dark-factory-requirements.md` still says scrumo is a "daily digest"** (the 2026-09-10 decision record). The live spec `docs/engine/dark-factory.md` carries the retuned table. Per `docs/CONVENTIONS.md` a `decided` doc is not silently rewritten, so formalising the retune needs a `decisions/` record.

**Disk, for the swap work.** `vgs` shows `2c0e-dev-vg` with **VFree 0**, and `/` holds 1.3 GB free of 8.5 GB (85% used), so the requested 6 GB swap cannot be created on the current disk. Grow the virtual disk in Proxmox first, then `sudo apt install -y cloud-guest-utils` (growpart is absent), `sudo growpart /dev/sda 5`, `sudo pvresize /dev/sda5`, `sudo lvcreate -L 6G -n swap_2 2c0e-dev-vg`, `mkswap` and `swapon` `/dev/mapper/2c0e--dev--vg-swap_2`, and add `/dev/mapper/2c0e--dev--vg-swap_2 none swap sw 0 0` to `/etc/fstab`.

## ⏭️ RESUME HERE - Release A cut as 0.3.3, owner to tag + merge (last touched 2026-08-02)

**Read first:** [`docs/archived/poc-plus/poc-plus-release-a-plan.md`](./docs/archived/poc-plus/poc-plus-release-a-plan.md), the executor-grade build plan, archived post-cut. § Execution state and § Task log carry the per-task handover and the owner locks (SL-1…SL-7, all settled); § Stage 4 measurement and § P1 carry the v12-vs-v13 numbers and, more importantly, what the agent-player harness can and cannot measure. Parent tracking is [[poc-plus-roadmap]] § Re-sequencing.

**State.** Release A is fully built, P1 (the daunting-band restatement) included, and the release is cut: `VERSION`/`package.json` at `0.3.3`, `CHANGELOG.md` `[0.3.3]` promoted and dated 2026-08-02, `assets/release-notes/v0.3.3.yml` written. P3 (the RESOLVE difficulty signal, [[resolve-difficulty-signal]]) was folded into the cut afterwards, because editing v13 in place is only available until 0.3.3 deploys and starts stamping rows. Baseline **89 files / 1675 tests**, typecheck clean. **v13 is live in every path**, `PROMPT_SET_VERSION = 'v13'` and `ProdPipelineGateway` defaults to `loadPromptSet()`, so production loads the new prose and the balance change is real.

**Two things left, both the owner's, per the `releasing` skill:**

1. **Merge the work through to `main`**: `poc-plus/release-a-polish` → `dev`, then `dev` → `main` (`--no-ff`). No agent commits, pushes, or checks out `dev`/`main` directly; this is the owner's step end to end.
2. **Tag `v0.3.3`** and push it.

**Two standing cautions for whoever picks this up next.**

- **Do not use the agent-player to validate balance.** It cannot measure RA-2 at all: the brain overwhelmingly picks the day-job menu over free actions, and `stripWorkInspiration` (stage 3, F#12) strips inspiration from work actions by design, so both v12 and v13 returned a **structural** 0% grant rate. A future 0% is equally meaningless. RA-2's ~10% target and 3.2-3.7 band stay **unverified** pending human play or a harness switch that forces free actions. The harness remains a good QA/crash instrument. Same caveat retroactively limits the plan's § RA-4 A/B results.
- **If a dial has to be relaxed, relax RA-2's frequency rather than RA-1's ladder** — stakes are the release's stated purpose, cadence is a comfort setting. RA-1 and RA-2 push the same direction at once, so the combined feel may read "stingy" rather than "tense"; the RA-4 playtest critic already called failure costs harsh on the *pre-change* tuning. Before touching numbers, check the model is honouring the anti-crush *rule* (every option set keeps one routine-band option) — it measured 21/21, so it is not the problem today.

**Discipline (unchanged, and not release-specific):** one orchestrated-delegation loop per task: lead scouts and finalises the handoff, executor builds, lead verifies (typecheck + suite + the task's acceptance boxes), commit, fresh-context reviewer critiques, lead triages, fixer lands accepted findings, verify, commit. Atomic commit per task; changelog current per task. **A green suite is not evidence that a prompt rule is reachable.** Stage 4's review caught an inspiration grant gated on a natural 20 in a category that never rolls; P1's review caught a reward instruction keyed to a DC that RESOLVE is never sent. Prose that keys off an engine signal (`D20:`, `PHASE:`, `needs_roll`, a category flag, any numeric the prompt names) must be checked against the message the engine actually builds, not merely read for sense. Live runs need `set -a; . ./.env; set +a` first (there is no `dotenv`). Prod host `192.168.0.242` was unreachable as of 2026-07-29, so re-pulling a snapshot may not be possible. Scope fences hold: no lethality, no shared-world plumbing, no classify-accuracy work, no item-economy depth.

## Release A closeout — decisions left open

These are tracked on the board as `type:decision` / `needs-human-decision` issues, but the *reasoning* stays here. Full write-ups in the plan's § Follow-up logged.

- **`opts.compact` has had no production caller since RA-6** — still plumbed through `buildOutcomeView`/`viewState.ts`/`commands/action.ts` with a unit test. Delete it, or keep it as a deliberate capability.
- **RA-1 residual** — the daunting band is fixed in prose and the arithmetic checks out, but no re-probe was run; it stays unverified behaviourally, needing isolated DECIDE probes (the kind stage 4 used), not an agent-player run.
- **RA-2 residual** — the ~10% target and 3.2-3.7 band remain unverified (the agent-player structurally cannot check them). Needs human play, or a harness switch that forces free actions, before anyone concludes it worked.
- **P3 residuals** (both balance decisions, see [[resolve-difficulty-signal]]) — `dangerTier`'s thresholds predate v13's ladder, so an ordinary 16-17 fight reads `hard` (re-tuning moves the combat card, so it needs measurement); and the card/narration match is per round, not per fight, because each CONTINUE round re-authors `baseDc`.

---

*History: the full pre-migration TODO.md (all done `[x]`, moved `[>]`, and the actionable items now on the board) is in git history and summarised across the linked docs. The board is the source of truth for open work from 2026-08-03.*

---

## Carry-over from the dev line — not yet on the board

Actionable findings from the dev-line TODO that postdate the 2026-08-03 board seeding and were never migrated. Kept here until triage takes them to the board; the dev TODO's other sections all map to live board issues.

### Prod-data review follow-ups (window 2026-07-19 → 08-02, snapshot `warden-20260802-212213`)

Day 27; 37 actions over 8 active days, 3 active players, 2 of 5 characters churned after week one. The 08-02 wolf fight is the pain centre (F#14 "This sucked", B#17-19): 13 rounds, ~20 min wall-clock, ending in a bail, with visible state desync. The latency and RA-1/RA-2 watch follow-ups from the same review are on the board (#63, #94, #95).

- [ ] **Combat length**: 13 rounds reads as "repeat spamming press the attack" (F#14/B#19). A round cap or an explicit mid-fight "press the advantage / break off" affordance; the bail path exists but costs nothing and reads as defeat.
- [ ] **Combat state desync**: minion↔wolf mixup, HP-bar bounce, hard→medium drift (B#17-19) point at the persisted in-combat edge disagreeing with what the card renders. Trace the 08-02 calls end-to-end. Related to the open C4 in_combat-edge-duplication item (#64).
- [ ] **Retention**: 2/5 characters churned after week one; the active tester's worst session was the most recent. Worth revisiting the stage-2 solo-first plan (nat 1/20 beats) as a hook before wider invites.

### M8.5 live agent-player smoke-run findings (2026-08-06)

First live runs on the M8.5 harness (realism arm on). The seam held end to end: all three wizard walks recorded through the protocol, zero invariant breaches, every DeepSeek timeout absorbed by the designed fail-open. Findings:

- [ ] **[harness] No watchdog for a wedged in-flight LLM request** *(smoke-c died mid-day-1)* - after a successful move the process sat alive-but-silent 4-6 min with no abort logged; the 30s/60s abort either never fired or didn't interrupt the fetch (a wedged socket can outlive an AbortController). One wedged request stalls a live run indefinitely - needs a top-level guard (heartbeat + hard kill, or a per-call timeout that actually aborts the socket).
- [ ] **[harness] Single-end `writeFileSync` in `finally` defeats the repro guarantee on signal death** *(smoke-c)* - a kill skips `finally`: zero transcript, zero protocol log, zero scoreboard (the run's death itself was the only artifact). A live-run harness that can outlive its controlling shell should append the transcript incrementally so a killed run still leaves evidence.
- [ ] **[engine/prompt] Failure branch keeps the success reward - wealth +3 on a failed `search`** *(smoke-b; also smoke-a: +3 on every resolved action incl. failures)* - a failed search applied `-item:Fresh Hare, stamina-1, wealth+3`: the failure template looks like the success template with only the item sign flipped, leaving `modify_wealth` on a failure. The `CATEGORY_MUTATION_MAP` telemetry flagged `modify_wealth`/`remove_item` as unexpected on `search`, and smoke-b's critic independently called the "- Fresh Hare alongside +💰 3" screen contradictory. Either the resolve-mutate prompt template for `search` leaks the reward into failure, or the model mirrors the success recipe with the item flipped - route via the `prompt-versioning` skill. *(The telemetry-flag↔findings disconnect is the existing [M4 enhancement] item above - telemetry flags never surface as transcript findings.)*
- [ ] **[infra] Decide-stage DeepSeek timeouts spike under concurrent live runs** *(a: 3, b: 2, c: 2 decide timeouts in a ~15-min window)* - three parallel live runs on one key plausibly contributed to provider flakiness (new datapoint on the known 07-31/08-02 latency degradation). The fail-open paths all held. Future fleets: ≤2 concurrent, or stagger.
- [ ] **[game-design] Favoured-option risk mismatch** *(smoke-a critic)* - a favoured option rolling 8 vs DC 8 read as FAILURE (strict-beat ties fail) with harsh fallout (-1 HP, -2 stamina, -kit) while a cautious option succeeded comfortably - the arrow/favoured hints don't match actual risk. Cross-refs the v13 ladder "combined feel may read stingy" caution.
- [ ] **[QA] The multi-day live path remains unverified** - smoke-c died mid-day-1 (no day boundary, no roll refill/regen/income observation). Needs a re-run (quieter window, ≤2 concurrent) once the watchdog + incremental-write items land.
- [>] **[harness] The realism arm didn't fix move variety** - the a/b brains picked `menu-pick 0` / `choice 0` (or the favoured option) almost exclusively; the brain still funnels into the day-job menu. Re-confirms the standing caution (no balance validation via the agent-player; `AGENT_FORCE_FREE_ACTIONS` remains the next arc's first task, #93).
