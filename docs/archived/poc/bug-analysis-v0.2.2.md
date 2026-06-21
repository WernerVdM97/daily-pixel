---
title: Bug Analysis — v0.2.2 Release
status: shipped
domain: archived
phase: poc
tags: [bugs, review, release, scheduler, sleep, migrations]
superseded_by: "implemented in code"
related:
  - "[[handover-code-review-post-pr14.md]]"
  - "[[goodnight-and-rest-features.md]]"
  - "[[daily-work-teleport]]"
---

In-depth bug review of the **v0.2.2** release (git range `2fc951e..aed7038`, ~2,405 insertions across 52 files, mostly PR #16). Three independent reviewers swept the diff in slices — **engine + DB/migrations**, **Discord commands**, and **scheduler (`index.ts`) + LLM** — each reading full file context, not just the diff, and running the test suite (93 tests green) + `tsc --noEmit` clean.

**Headline:** no crashers, but two release-worthy bugs — a guaranteed nightly HP drain on Hunter/Herbalist, and scheduler/idempotency gaps in the newly-decoupled tick/announcement. Several of the findings are *feature collisions*: two correct-in-isolation systems (daily-work teleport, unsafe-sleep penalty, absence penalty) interact badly.

---

## 🔄 Fix review — 2026-06-18

A round of fixes landed in the working tree (`hi.ts`, `sleep.ts`, `WorldEngineImpl.ts`, `index.ts`). Each finding below was **re-verified against the actual current code**, not the original reviewer reports. Suite green: **497/497**.

- [x] **H1 — fixed.** `sleep.ts:88-101` adds an `atWorkplace` carve-out: sleeping at your own resolved `workplace_location` no longer counts as unsafe, so Hunter/Herbalist take no penalty for doing their job. Correct, and uses the same `getWorkplaceLocation` seed as the teleport so the two agree.
- [x] **H2 — fixed.** The good-night message now builds its row via `getNavButtons(char, "sleep")` (`index.ts` ~875) instead of a hardcoded `nav:action`. Since `/sleep` requires `rollsRemaining === 0`, the mutual-exclusion logic hides Action and shows Sleep — the dead button is gone.
- [x] **H3 — fixed.** `index.ts:323-326` gates the announcement on `lastCron === today`; a failed/incomplete tick now skips the announcement instead of posting stale stats.
  - [!] **Follow-on:** a genuinely failed tick now yields **no announcement at all** for that day (day silently frozen until an admin `/sleep` tick). That's the safe choice over wrong data, but it's a silent-stall path — worth an admin alert beyond the existing tick-failure DM, or an auto catch-up tick.
- [x] **M1 — fixed.** `index.ts:414-424` runs a boot-time catch-up: if we're past today's 07:30 UTC, the tick completed (`lastCron === today`), and we haven't announced (`lastAnnouncement !== today`), it announces immediately. Closes the restart-in-window gap.
- [x] **M2 — fixed (well-covered).** `updateLastPlayed` is now stamped on the nav-button handler (`:1287`, covers `nav:hi/journal/sleep/look` **and** the morning-announcement Hi button), day-job buttons (`:1144`), and chat commands (`:767`); `startAction`/`resumeAction` stamp internally. Only feedback/bug **modal** submits don't stamp — acceptable, those aren't gameplay.
- [x] **M3 — resolved (reworked, 2nd round).** The HP penalty is **gone** — `WorldEngineImpl.tick()` no longer docks health for absence. Replaced with a soft retention nudge: a player who crosses **exactly 5 calendar days** of absence gets a one-shot in-character **DM** (`⚠️ The Oak stirs without you…`). The tick collects their Discord ids into the new `TickResult.absentWarnings`, and the 03:30 scheduler DMs them (best-effort via `dmUser`). Fires once on the 5-day mark — no nightly spam, no HP loss.
  - [I] **Tradeoff noted:** firing on `diffDays === 5` (not `>= 5`) means if the tick fully fails on a player's exact 5-day night, that player never gets the nudge. Acceptable for a soft warning; the alternative needs a `last_absence_warned_at` column.
- [x] **M4 — fixed (by removal).** The misleading per-`/sleep` "souls did not make it home" tally is gone; `sleep.ts`/`index.ts` now show the tick-derived "X soul(s) stirred, N NPC(s) on the move" instead.
  - [x] **Cleanup done:** dead `countSoulsInUnsafe()` removed from `WorldEngine`, `WorldEngineImpl`, and `MockWorldEngine` (no callers remained).
- [x] **M5 — fixed.** `hi.ts` resolves the display workplace via `getWorkplaceLocation(...)` with `characterId`/`dayNumber`, so the Wanderer's seeded destination now shows in `/hi` and matches the teleport.
- [x] **L4 — fixed (see round 3).** `current_source.md` had drifted from `decision-v7.md`; re-synced in commit `c0c6dc1`.

**Still open after this round:** L1–L3, L5, L6 (all low/suspect) were not touched and remain as written. Suite: **496 green**, `tsc` clean.

---

## 🔄 Fix review — 2026-06-18 (round 3, hotfix)

Follow-up items addressed. Suite: **502 green**, `tsc` clean.

- [x] **H3 follow-on — admin alert added.** `runMorningAnnouncement` now calls `notifyAdmin("World stalled — announcement skipped", …)` when it skips because `last_cron_date !== today`, so a failed/missed tick (no day advance, no announcement) surfaces immediately instead of sitting in a console log. Recovery is still admin `/sleep`. (Auto catch-up tick deliberately not added — a stalled tick usually means a real fault worth a human look.)
- [x] **M4 follow-on — public goodnight added (the count is now meaningfully wired).** The unsafe-soul count was the *missing second message*, not dead code. There are now two distinct goodnight surfaces:
  - **Per-user** `/sleep` response — unchanged (rests you at the Oak, private reply).
  - **Public goodnight** `🌙 Night falls over the Oak` — posted to the tick channel, naming the count of souls still at unsafe locations (*"will they make it back?"*) or noting all are home. `countSoulsInUnsafe()` was **restored** and is read **live** at post-time, so it reflects who's actually out as night falls.
  - [I] **Timing (updated):** its own scheduler at **18:30 UTC** (idempotent per day + boot-time catch-up), the evening bookend to the morning message. Day cycle (UTC): `03:30` tick · `05:30` morning (moved from 07:30) · `18:30` goodnight.
- [x] **Nav buttons restored (regression from the 0.2.2 "nav cleanup").** `Look`, `Stats`, `Backpack` are back in `format.ts` with page-scoped visibility: the four info pages (backpack/stats/journal/look) cross-link to each other, and `Look` also shows on `/hi`. They stay off action-outcome/sleep views, and every page stays within Discord's 5-button row cap. All view commands were still registered, so this was display-only — no handler work needed.
- [x] **L4 — fixed.** `current_source.md` had genuinely drifted from `decision-v7.md` (the original flag was real); it was re-synced in commit `c0c6dc1`. Verified byte-identical. (An earlier note here called it a false positive — that was wrong; the branch HEAD already carried the fix, which is why a re-`cp` showed no diff.)

**Remaining:** L1 (machine `done`-inference behavioral change), L3 (`countSoulsInUnsafe` treats unknown locations as unsafe — now live-relevant since the goodnight uses it), L6 (`notifyAdmin` REST fallback). L2 + L5 were fixed in `1977a29`, L4 in `c0c6dc1`.

---

## How to read this

Severity is **impact on a live player or the live bot**, not code aesthetics. Each item has a concrete failure scenario and a suggested fix. Items marked `[?]` need a design call, not just a code change.

---

## 🔴 High — fix before relying on the release

- [!] **H1 · Hunter/Herbalist lose 1 HP every night just for doing their job.** `src/discord/commands/sleep.ts:82-92` + `src/index.ts:871-893` + `assets/char-creation/day-jobs.yml:74,136` + `src/db/migrate.ts:83`. The day-job teleport sends Hunter & Herbalist to **The Forest Edge**, seeded `is_safe: 0`. Their work action runs there and (unless the LLM emits a `set_location` back) leaves them there, so `/sleep` computes `wasUnsafe = true` and docks the `-1 HP` unsafe-night penalty. A player who *only ever does their intended job* takes a guaranteed nightly health loss with zero risky behaviour — the teleport feature and the sleep penalty collide.
  - [I] Fix options (pick one): treat "sleeping at your own `workplace_location`" as safe for penalty purposes; **or** auto-return the player to the Oak when a daily-work action completes; **or** seed The Forest Edge (and any workplace) `is_safe: 1`.
  - [?] Which is intended — is daily work *meant* to be a risk/reward (sleep elsewhere to avoid the penalty), or is the penalty only for off-job wandering?

- [!] **H2 · The good-night `/sleep` message shows a dead Action button.** `src/index.ts:588-598` hardcodes a `nav:action` button, bypassing `getNavButtons` (`src/discord/format.ts:74-92`). But `/sleep` is only reachable when `rollsRemaining === 0` and no pending action (`sleep.ts:72`), so clicking Action always hits the "🛌 Out of actions for today" guard (`index.ts:951-957`). This re-introduces the exact dead button the *"out of rolls offers Sleep, not a dead Action button"* fix (a headline 0.2.2 item) was built to eliminate.
  - [I] Drop the hardcoded `nav:action` from the good-night row (leave Feedback), or route it through `getNavButtons(char)` so the Action↔Sleep mutual-exclusion applies.

- [!] **H3 · Morning announcement posts stale stats / a duplicate day when the tick failed.** read `src/index.ts:274-275` vs write `src/engine/WorldEngineImpl.ts:900-901`. The 07:30 announcement reads `last_tick_players_affected` / `last_tick_npc_movement_count` with **no check that this day's 03:30 tick actually succeeded**. The whole tick is one transaction — if it throws (caught, logged, admin-notified at `index.ts:235-238`), `day_number`/meta never advance, yet the announcement still fires 4h later and posts `Day <stale day_number> begins` with *last cycle's* counts to the public channel.
  - [I] Gate the announcement on the tick's success marker: `if (engine.getMeta('last_cron_date') !== today) { skip or run a catch-up tick }`.

---

## 🟠 Medium — real but bounded / needs a design call

- [!] **M1 · A restart between 03:30 and 07:30 UTC silently drops today's announcement.** `src/index.ts:249-256`. On boot, `scheduleMorningAnnouncement` only schedules the *next* 07:30; it never checks whether today's 07:30 already passed unannounced. Tick succeeds at 03:30 → bot restarts at 08:00 → scheduler sees "07:30 passed → schedule tomorrow", and since nothing checks `last_announcement_date` at boot, **today's Day-N message is lost**. (The tick has a boot idempotency guard; the announcement has no boot-time catch-up.)
  - [I] At schedule/boot time: if `now` is past today's 07:30 UTC **and** `last_announcement_date !== today` **and** `last_cron_date === today`, run the announcement immediately, then arm the next.

- [!] **M2 · The 3-day absence penalty is undermined by button-only play.** `src/index.ts:571-575`. `updateLastPlayed` is stamped only in the slash-command branch (and that branch early-returns for `/action`, `/hi`, `/join` which manage their own flow). It is **never stamped for nav buttons, day-job buttons, or modal submits** — i.e. the entire Hi-button / day-job-button flow this release pushes. A player who interacts purely via buttons looks "absent" and the tick docks them 3 HP (`WorldEngineImpl.ts:789-801`) despite active play. Partially masked because `startAction`/`resumeAction` stamp internally (`:438`,`:516`), but pure menu/nav navigation does not.
  - [I] Stamp `updateLastPlayed` once in the shared interaction entry point for *all* interaction types, or drop the partial index.ts version and stamp engine-side only (avoid the false sense of coverage).

- [?] **M3 · Absence penalty nets to ~zero for the common case (idle at a safe spot).** `src/engine/WorldEngineImpl.ts:780-801`. The tick first regenerates `health = min(health+3, max)`, *then* subtracts up to 3 for absence — so an absent player parked at a safe location (most idle players, at the Oak) loses **nothing**; the penalty only bites players idle in *unsafe* spots. Likely defeats the stated "absent player loses 3 health" intent.
  - [?] Is net-zero-at-safe intended? If absence should always cost, apply the penalty before/instead of safe regen, or skip safe regen when `diffDays >= 3`. Either way the migration comment is misleading.

- [!] **M4 · "X soul(s) did not make it home tonight" fires on a normal mid-day `/sleep`.** `src/discord/commands/sleep.ts:109-113` + `WorldEngineImpl.ts:728-736`. `countSoulsInUnsafe()` counts *every* character currently in any unsafe location, evaluated the instant one player sleeps — including players who simply haven't finished their day, and Hunters/Herbalists sitting at their unsafe workplace. The wording implies death/loss but the count fires during ordinary play, so an early sleeper routinely sees a scary, inaccurate tally.
  - [I] Only surface this on the **world tick** (where "home for the night" is meaningful), not per-player rest — or reword to "still out in the wilds".

- [!] **M5 · `/hi` hides the Wanderer's workplace, but the teleport still moves & charges them.** `src/discord/commands/hi.ts:179-184` vs `src/index.ts:871-893` (via `getWorkplaceLocation`, `hi.ts:123-138`). The `/hi` suffix reads `job?.workplace_location`, which is `null` for Wanderer → nothing shown. But pressing a day-job action teleports the Wanderer to a seeded `WANDERER_SPOTS` location and spends 1 stamina. The preview and the action disagree.
  - [I] In `hi.ts`, resolve the Wanderer destination via `getWorkplaceLocation(...)` (same seed) for display so the preview matches the teleport.

---

## 🟡 Low / suspect — verify or note

- [I] **L1 · Behavioural change: `done:false` + no options now commits mutations.** `src/engine/action/machine.ts:84-117`. The auto-finish branch dropped the `decision.done` requirement, so a contradictory LLM response (`done:false`, no rollable options, not required) now has `decision.mutations` applied (line 113) without roll gating. Still bounded by `validateMutations`, and this is plausibly the *intended* fix ("no real options → nothing to roll → resolve neutrally"). Verify against the auto-finish design intent; if unintended, gate on `decision.done === true` like the `preResolvedMutations` path (`:124-128`).
- [I] **L2 · DST can shift the absence penalty by one day.** `src/engine/WorldEngineImpl.ts:791-792`. `new Date('YYYY-MM-DDT00:00:00')` parses as *local* time; a DST transition between the two dates makes `Math.floor(diffMs/86400000)` round 2.96 days → 2. Harmless on UTC-deployed hosts. Fix: parse as UTC (`...T00:00:00Z`).
- [I] **L3 · `countSoulsInUnsafe` treats unknown locations as unsafe + does N+1 lookups.** `WorldEngineImpl.ts:728-736`. A character whose `location` isn't in the `locations` table is counted as a lost soul. Fine with current seeding (all real locations exist); verify no path sets `location` to a non-`locations` value, then consider a single aggregate query.
- [c] **L4 · Convention drift: `current_source.md` ≠ `decision-v7.md`.** line 182 differs ("services to" vs "offers services to"). Only `decision-v7.md` loads at runtime (`prompt-builder.ts:19-22`), so no runtime defect, but it breaks the AGENTS.md "keep `current_source.md` byte-identical" invariant. Fix: copy `decision-v7.md` over `current_source.md`.
- [I] **L5 · Dead `?? null` on a `.slice()`.** `WorldEngineImpl.ts:399`: `outcome.outcomeText.slice(0,500) ?? null` — `slice` never returns nullish, and `outcomeText` is typed `string`. Cosmetic; signals the author expected nullability. If `outcomeText` ever becomes optional, `.slice` throws *before* the coalesce. Use `(outcome.outcomeText ?? '').slice(0,500)` if defensiveness is wanted.
- [?] **L6 · `notifyAdmin` REST fallback on send-failure.** `index.ts:157-181`: if the gateway `admin.send` throws (DMs closed), it retries the same op over REST (also fails, just warns). Not a correctness bug; confirm no path lets *both* paths succeed (duplicate admin DM).

---

## ✅ Explicitly checked — correct (not bugs)

- [p] **Migration framework is solid.** Baseline correctly no-ops on existing prod DBs (schema.sql is all `IF NOT EXISTS` / `INSERT OR IGNORE`; v2–v7 ALTERs are try/catch- or existence-guarded; a duplicate-column `SQLITE_ERROR` doesn't abort the surrounding transaction). New columns (`last_played_at`, `applied_mutations`, `narrative`) are absent from schema.sql and added by later dated migrations, so fresh-DB ordering is right. Ledger applies in chronological order.
- [p] **Scheduler time-math & re-arming are correct.** `setUTCHours` + "if passed today, +1 UTC day" is right; UTC means no DST concern; both `scheduleTick` and `scheduleMorningAnnouncement` re-call themselves inside the `setTimeout` callback (including on skip/error paths). The H1/M1 gaps above are about *cross-restart* and *tick-failure* coordination, not the steady-state arithmetic.
- [p] **`MessageFlags.Ephemeral` migration is clean** — no leftover `{ ephemeral: true }`, and `buildComponentPayload` folds the bit into the V2 `flags` bitfield (no illegal `flags`+`ephemeral` combo).
- [p] **`classEmoji()` is now a single source of truth** (`format.ts`), imported by `join.ts` instead of redefined.
- [p] **Custom / non-Oak actions never teleport** — the teleport block is gated on `char.location === "The Warden's Oak"` and lives only in the `action:dayjob:` button handler; the custom-modal path has none.
- [p] **`/action` 4096-char degradation works** — the `clip()` chain guarantees description ≤ 4096 (counts blockquote/markdown via `.length`); buttons live in `components`, so a hard clip never disables choices.
- [p] **`nav:hi` button reuse** from the public announcement takes the `reply()` branch (message lacks the Ephemeral flag) → spawns a fresh ephemeral `/hi` instead of corrupting the public post.
- [p] **Feedback/Bug modal handlers** are type-guarded, reply before the engine call, and wrap `submitFeedback`/`submitBug` in try/catch → `notifyAdmin`.
- [p] **`LLM_MODEL` override & `PROMPT_VERSION = 'v7'`** wiring is correct (`?.trim() || undefined`, spread only when truthy; gateway defaults to `'deepseek-v4-flash'`).

---

## Suggested triage order

1. [x] **H1** — Hunter/Herbalist nightly HP drain (workplace carve-out in `sleep.ts`).
2. [x] **H2** — dead Action button on the sleep message (routed through `getNavButtons`).
3. [x] **H3 / M1** — announcement vs tick coordination (gated on `last_cron_date`; boot-time catch-up).
4. [x] **M2** — stamp `last_played_at` on nav/day-job buttons (covers the button-only flow).
5. [x] **M3** — HP penalty removed; replaced with a one-shot 5-day absence-warning DM.
6. [x] **M4** — misleading "souls" tally removed; dead `countSoulsInUnsafe` deleted.
7. [x] **M5** — Wanderer workplace now shown in `/hi`.
8. [x] **L4** — `current_source.md` re-synced with `decision-v7.md` (commit `c0c6dc1`).
9. [x] **H3 follow-on** — admin alert when a missed tick stalls the world.
10. [x] **Goodnight** — public night announcement added (unsafe-soul count wired into the tick).
11. [x] **Nav buttons** — Look/Stats/Backpack restored with page-scoped visibility.
12. [ ] **L1–L3, L5, L6** — low/suspect, verify/polish.

> Range reviewed: `2fc951e..aed7038`. Reviewers read full file context and ran the suite; findings above are what survived that pass. The `[?]` items are intent questions for the designer, not defects to silently patch.
