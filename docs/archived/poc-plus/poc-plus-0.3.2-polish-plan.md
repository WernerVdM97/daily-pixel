---
title: "POC+ 0.3.2 — combat-correctness & prod-bug release (build plan)"
status: archived
domain: engine
phase: poc
tags:
  - build-plan
  - combat
  - ansi
  - discord
  - bugfix
related:
  - "[[poc-plus-roadmap]]"
  - "[[poc-plus-0.3.1-polish-plan]]"
  - "[[prompt-v12-combat]]"
  - "[[ansi-art-classification-framework]]"
  - "[[threat-encounter-system]]"
---
_Shipped 2026-07-11 as v0.3.2 (squash-merged `poc-plus/0.3.2-polish` → `dev`, commit `01e3556`). All 14 deliverables landed: C1–C6 combat correctness, P1–P2 presentation polish, N1–N5 non-combat bugs. 1451 tests green, typecheck clean. Two C3/C6 residuals deferred to v13 (LLM-authored NPC health, classify accuracy). The live-check batch (combat-card rendering on the dev bot) ran post-release; this plan is archived for provenance._

---

# POC+ 0.3.2 — build plan

## Why this release exists

`0.3.1` shipped the combat maths reveal and the combat-frame redesign to make fights legible. The live review immediately after (prod snapshot `warden-20260711-185823`, tester BendiusOver; local dev DB, tester trombosis) shows it made combat _less_ trustworthy, not more, because the numbers on the card do not reconcile. Players rolled a 22 against a shown "DC 15" and were told they lost; rolled a 12 against "DC 15" and were told they won; saw `+ WIN`, `TRADE`, and an HP loss stacked in one frame; and fought a 24-HP stag that rendered as "Minion 6/14" whose bar grew each round. Broadcasting crits publicly (Stage 2) on top of a card that mislabels wins would amplify the damage, so the combat readout has to become correct and coherent before that work starts. This release is combat-correctness first, then the fresh non-combat bug batch from the same review.

The root cause is understood and grounded in code (see each task), so this is mostly a rendering-and-plumbing job, not a combat-maths redesign: `resolveCombatRound`'s band table and margin definition stay untouched.

## How to run

One loop per task, per the `orchestrated-delegation` skill: lead scouts and finalises the executor handoff, executor builds, lead verifies (baseline below plus the task's acceptance), commit, reviewer critiques adversarially, lead triages, fixer lands accepted findings, verify, commit. Branch `poc-plus/0.3.2-polish` off `dev`; atomic commit per task; defer the merge to `dev` but keep the changelog current per task; merge at the end; changelog per the `changelog` skill; release cut per the `releasing` skill.

**Verification baseline (every task):** `npm run typecheck` clean, `npm test` green. Combat and player-facing tasks additionally get one live check on the dev bot.

**Live-check batching:** the combat-card tasks need a human operator driving a real fight on Discord. Build everything code-doable, then hand the operator one consolidated live-check script covering all pending visual verifications in a single session. The two admin-DM preview scripts from `0.3.1` still apply: `scripts/send-ansi.ts` (batch-DM every `.ansi` in `docs/assets/ansi/test/colour/`) and `scripts/send-dm.ts` (`npm run send-dm`, plus `sendToAdmin(payload)` for posting a real `src/` builder's output). Reach for `send-dm` to eyeball a rendered continue/terminal card without a full fight.

**Data provenance:** the review that scoped this release is in-terminal only (it contains real Discord-linked player text; per `db-backups/README.md` it is never committed or shared). The lead can re-pull a fresh snapshot to re-read the raw reports while scouting.

## Ordering & dependencies

Part 1 is the reason for the release and goes first; C1 and C3 settle the facts the rest of Part 1 leans on. Part 2 is presentation polish on the same cards, so it follows Part 1. Part 3 (non-combat bugs) depends on nothing here and can run in parallel with a second executor.

- **C1 (contested-roll display) → C2 (verdict reconciliation).** C1 changes what the card shows; C2 makes the words agree with it. Do C1 first.
- **C3 (real enemy identity + HP) → C4 (opening frame name + re-entry band).** C3 makes the real name and maxHp available; C4 surfaces them on the opening frame.
- C5, C6, and all of Part 2 and Part 3 are independent.
- Release cut is last, gated on everything.

## Confirmed decisions (scope lock, 2026-07-11)

Locked with the release owner before any executor was spawned. These bind the tasks below; where a task's original prose differs, this section wins.

- **C1 — DC becomes a danger tier.** The continue card shows the contested roll (player total vs enemy total) exactly like the terminal card, and the `[DC N]` value is _demoted_ to a worded encounter-danger tier (easy / medium / hard / risky / fatal — the five-tier `TODO.md` ladder), never a per-beat threshold. This deliberately pulls the `TODO.md` "map DC to easy/medium/hard/fatal" item into `0.3.2`.
- **C2 — asymmetric trade + band-led verdict.** Two coupled changes: (1) the `trade` band's HP deltas become margin-signed — edge-win (`margin > 0`): you `-1`, foe `-2`; dead tie (`margin == 0`): you `-2`, foe `-2` (unchanged, keeps `combatCapScenario` green); edge-loss (`margin < 0`): you `-2`, foe `-1`. `clean`/`glanced`/`heavy` and all crit overrides are untouched (crits never route to `trade`). (2) Per-round beats are **band-led with both HP deltas and no WIN/LOSS word**; an unqualified WON/LOST appears only on the fight-ending beat. **This is a deliberate exception to the "no combat re-tune" fence** (see the amended fence below) — a bounded, trade-band-only delta change the owner signed off, because it fixes the "I rolled higher yet we both lost 2 HP" grievance at the mechanic, not just the label.
- **C6 — lead surfaces, owner decides.** The investigate-first gate is not the lead's to close alone: the lead reproduces, records the root cause, and brings the branch recommendation (bounded routing fix here vs guard + defer classify-template to v13) to the release owner, who picks the path that ships.
- **Execution — Part 3 runs concurrently in a worktree.** N1–N5 (non-combat) run in an isolated git worktree lane in parallel with Parts 1–2 on the main branch; the lead lands the worktree's commits with care for merge order. Parts 1 and 2 stay sequential (shared cards).

---

## Part 1 — combat correctness

Source: the 2026-07-11 review. Every task here is a confirmed defect, not a taste call.

### C1 — the continue card must show the contested roll, not a misleading `[DC N]`

**Symptom.** "I rolled a 22 against a 15 but the margin is −1"; "I rolled a 12 against a 15 and it says I won"; "rolled 12, DC 13, why −10 heavy loss". Players read `d20 22 vs [DC 15]` as a win, but the fight is a contested roll against the enemy's hidden d20, so the displayed DC is not the threshold that decides the round.

**Root cause (verified 2026-07-11).** The margin is `(playerD20 + playerBonus) − (enemyD20 + enemyBonus)` (`src/engine/action/combat-dc.ts:142-144`), i.e. vs the enemy's total, not vs the DC. The terminal card was already corrected for exactly this (`src/render/CombatCardRenderer.ts:214-233`, comment cites "B#20": it shows the player d20 left and the enemy's contestant roll right, not `[DC N]`). The continue card was not: `renderCombatContinueCard` still prints `[DC ${dc}]` on the readout (`CombatCardRenderer.ts:157-177`), fed `dc: lastRound.dc` from `action.ts:560`. So the two cards disagree, and the one shown mid-fight is the misleading one.

**Deliverable.** Bring the continue card's readout into line with the terminal card: show the contested roll (player total vs the enemy's total) so the sign of the margin is self-evident, and drop or demote the solo `[DC N]`. The round already carries `enemyD20` and `enemyBonus` on `CombatBeatLog` (added in `0.3.1` ANSI-D), so no engine change is needed; this is a `CombatCardRenderer` + `action.ts` render change. If the DC value is kept anywhere, it must read as encounter danger (see the `TODO.md` "map DC to easy/medium/hard/fatal" item), never as a beat threshold.

**Acceptance:**

- [ ] The continue card shows the player's total and the enemy's contested total (or the signed margin against it) such that a positive margin never coincides with a "you rolled higher than the number shown, but lost" reading.
- [ ] Continue and terminal cards use the same roll-vs-roll vocabulary; a fixture test asserts both.
- [ ] Width (≤28 interior) and char-budget tests still green.

### C2 — the WIN/LOSS verdict, the band word, and the HP outcome must tell one story

**Symptom.** "it shows i traded and I loosed and had +1 margin (3 contradictions) in one message"; "the margin says +1, does that not mean i win? ... supposed to be dead yet it didn't deduct HP"; "+1 margin as if i beat the enemy yet it subtracts 2 HP from me".

**Root cause (verified 2026-07-11).** The band table (`combat-dc.ts:97-100`) makes `trade` cover `margin ∈ [−2, 1]` and deal damage to _both_ combatants, while the terminal card prints a binary `+ WIN / x LOSS`. So a `+1 margin` is simultaneously a positive contest (reads as WIN), a `TRADE` band, and a self-HP loss. All three are true, but presented as a contradiction.

**Deliverable.** Reconcile the wording so the three facts cohere. The band is the source of truth for what happened to HP, so the verdict line should defer to it rather than assert a contradicting binary: lead with the band outcome (clean / glanced / trade / heavy) and show each combatant's HP delta beside it, and reserve an unqualified "WON/LOST" for the fight-ending beat only (enemy dead, or player down). Do not change the band table or the margin maths; this is wording and layout on the two cards. Confirm with the lead whether "WIN/LOSS" stays as a per-round label at all, or becomes a fight-terminal-only label.

**Acceptance:**

- [ ] No single card can show a positive-margin "WIN" alongside a self-HP loss without the band word explaining why (a `trade`-band fixture proves it reads coherently).
- [ ] The fight-terminal verdict (enemy dead / player down) is unambiguous and distinct from a per-round band outcome.
- [ ] Fixture tests cover clean / glanced / trade / heavy on both cards.

### C3 — real enemy identity and HP, stable across rounds

**Symptom.** "shows minion HP 6/14 when I am fighting a stag npc with hp 24"; "the enemy also now somehow seems more healthy than previously, their healthbar is larger"; "on my 4th last stand decision the enemy is now full health".

**Root cause (verified 2026-07-11).** `deriveEnemyMaxHp(baseDc)` (`combat-dc.ts:192`) sizes the foe from the encounter DC, not from the NPC being fought, so a 24-HP stag renders at a DC-derived 14, and the name falls back to a generic "Minion". The `in_combat` edge already carries `enemyName` / `enemyHp` / `enemyMaxHp` (`combat-state.ts:14-16`) with sanity clamps (`isSaneCombatProps`, `:45`), so the plumbing exists; the bug is what gets written into it at combat start, plus a between-rounds instability where the bar grows or resets (last-stand path).

**Deliverable.** When a combat targets a known NPC, seed `enemyName` and `enemyMaxHp` from that NPC at combat start rather than the DC-derived defaults, and hold `enemyMaxHp` fixed for the fight so the bar only ever shrinks (persisted damage), never grows. Keep `deriveEnemyMaxHp` as the fallback for a nameless/ambient foe. The lead scouts the exact seam where the `in_combat` edge is first written (`PipelineActionStateMachine` combat start / `combat-state.ts`) and where the last-stand branch re-reads it.

**Acceptance:**

- [ ] A combat against a known NPC shows that NPC's name and its real max HP; the ambient-foe fallback still works.
- [ ] `enemyMaxHp` is constant across every round of a fight, including the last-stand path; a multi-round test asserts the bar is monotonically non-increasing.
- [ ] The `isSaneCombatProps` clamps still hold (no regression on the tolerant-read of old in-flight states).

### C4 — opening frame names the known foe, and re-entry shows banded persisted HP

**Symptom.** "still says unknown foe when I am explicitly fighting the stag" (opening frame); "when combat is re-entered, the art page should not show hp ?/?, it should indicate the damage still persisted on the enemy ... show the size of the remaining HP, not the numbers, and a label like hurt, wounded".

**Root cause (verified 2026-07-11).** `combatEnemyName` is already plumbed from the pipeline into `buildDecisionMessage` and on to the opening frame (`action.ts:329/600/729`), and `OpeningFrameRenderer.ts:152` honestly renders "Unknown foe" when it is undefined. Today nothing populates it, because the `combatEnemy` hint "surfaced from DECIDE" (per the field's own doc comment, `OpeningFrameRenderer.ts:60-65`) was never wired. On re-entry the frame has no enemy-HP band because the opening frame deliberately shows no real HP pre-first-decision.

**Deliverable.** Surface the real foe name from classify/decide into `combatEnemyName` so a known enemy is named on the opening frame. For combat re-entry (an `in_combat` edge already exists for this PC and foe), pass the persisted enemy condition as a band (hurt / wounded / bloodied), never exact numbers, so the opener reflects prior damage. Depends on C3 (the real name and HP must exist first).

**Acceptance:**

- [ ] The combat opening frame names a known foe; "Unknown foe" appears only for a genuinely ambient/unnamed encounter.
- [ ] Re-entering a fight in progress shows a banded enemy-condition indicator (word, not numbers) reflecting persisted damage.

**Depends on:** C3.

### C5 — rolls and art on the last-stand and bail decision screens

**Symptom.** "on decision 2, it DOES NOT SHOW THE ROLLS OR ART AGAINNNNNN, all i see is last stand or bail, I want to see what led to this".

**Description.** The `0.3.1` maths reveal renders on the ordinary continue screen, but the last-stand / bail branch presents only the buttons with no round readout, so the player cannot see the roll that dropped them there. Extend the continue-card readout (post-C1/C2 form) to the last-stand and bail decision screens. The lead confirms the exact branch in `action.ts` that builds those screens (`renderCombatStatus` / `buildDecisionMessage`, `:551-621`).

**Acceptance:**

- [ ] The last-stand and bail decision screens show the round's roll readout and enemy condition, matching the ordinary continue screen.
- [ ] A test drives a floor-save/last-stand beat and asserts the readout is present.

### C6 — combat must not resolve as a skill action or silently auto-resolve

**Symptom.** "if this was a combat scene, why does it read like a normal skill action? the title says combat but it doesn't seem like this followed the usual combat mechanics"; "it started by showing the rest classification art, but i wanted to do combat ... it switched to combat but never showed any combat screens or contested dice rolls, just seemed to autoresolve, WHICH SUCKS for a boss fight in the stag den".

**Description.** Some actions the player intends as combat are classified as `skill`/`rest`, or a combat action auto-resolves at start without ever running the contested-roll spine, producing a one-shot outcome with no fight. This is the most damaging report (a boss fight resolved to nothing), but it touches classify and the auto-resolve path, so it is higher-risk than the rendering tasks.

**This task is investigate-first, with a decision gate.** The lead reproduces from the cited actions, finds the root cause (mis-classification vs a combat action hitting the empty-`decision[]` auto-resolve branch), and decides:

- If the fix is a bounded engine/routing change with no prompt-template edit, land it here.
- If it needs a classify-prompt change, it goes through the `prompt-versioning` skill and is fenced to the v13 prompt-set work ([[prompt-v13-roadmap]]) instead, and this release ships only a guard: a combat-classified action must never auto-resolve without at least one contested round (fail closed to a real fight, not a shrug).

**Acceptance:**

- [ ] Root cause recorded (a short note in this plan or a `decisions/` doc if it touches the mutation/classify contract).
- [ ] Either the routing is fixed, or a guard prevents a combat action from auto-resolving with no round; a test covers the chosen path.
- [ ] If deferred, the residual is logged in `TODO.md` and [[prompt-v13-roadmap]].

---

## Part 2 — combat presentation polish

Same cards as Part 1; do after Part 1 lands so the layout is stable.

### P1 — terminal card prose fit and right-edge padding

**Symptom.** "the prose will never fit in the feedback block bottom text line, something else that actually would fit should be there" (the live frame showed "With a final desperate blo", truncated mid-word); and a separate report asking to shift content one column left so the max-HP number does not touch the right border.

**Deliverable.** The terminal card's bottom slot must not truncate a word mid-glyph: either fit a short fixed caption keyed to the band/verdict, or clip on a word boundary with an ellipsis, never mid-word. Fix the right-edge padding so a 2-digit `N/MM` HP figure keeps one space inside the border. Both are `CombatCardRenderer` layout fixes with width tests.

**Acceptance:**

- [ ] No card slot truncates mid-word; a long-prose fixture proves the fallback.
- [ ] Every interior line keeps the border padding with 4-digit-worst-case HP; the width test asserts it.

### P2 — the killing blow gets a margin and a real frame

**Symptom.** "okay nice here margin is showed, but why not on death blow, and surely death blow should also trigger an art frame up top and not just the inline one"; and (bail on a lethal blow) "I would have wanted to see the play-by-play combat decisions here, also can the action outcome screen show the original opening art instead of the location".

**Deliverable.** The fight-ending beat shows the round margin like every other beat, and renders the combat frame treatment (not a bare location scene) on the outcome. This overlaps the `0.3.1` opening-frame-on-auto-resolve gap in `TODO.md`; the lead decides whether the death-blow frame reuses the opening-frame-on-outcome work or is a combat-terminal-specific render. Fence the public broadcast of the kill to Stage 2.

**Acceptance:**

- [ ] The killing/last blow shows the margin and the combat frame on the outcome, not the plain location scene.
- [ ] No Stage-2 broadcast plumbing is added here.

---

## Part 3 — prod bug batch (non-combat)

Independent of Parts 1 and 2; a good parallel-executor lane. Each its own commit.

### N1 — Saturday threat NPC is missing at the announced location

"The weekend brings danger ... trouble at The Forest Edge ... but yet no-one is at The Forest Edge when i get there and press /look, where did the enemy go?" The Saturday threat announces a location and spawns a hostile NPC there, but the NPC is absent on arrival. Investigate the spawn/persistence path (`spawn_npc`, the afternoon-beat threat spawn, `last_threat_date` guard) and confirm the NPC is minted at, and stays at, the announced location. Relates to F#1 (mint-on-first-sight) but is the scripted-threat path specifically.

- [ ] The Saturday threat NPC is present at the announced location on `/look`; a test covers spawn + placement.

### N2 — a newly crossed location stays a placeholder

"why is the new location just dots"; "i have found the stags den, but the details like the description and photo still haven't updated from the template". A crossed frontier mints a provisional location (unsafe, placeholder scene) and an async cartographer is meant to enrich it; here the enrichment never lands, so the place stays "just dots". Investigate whether the cartographer call fails, never fires, or is not persisted, and make enrichment reliably resolve (or visibly retry).

- [ ] A crossed frontier resolves to a real description + scene tags within a bounded time; a failed enrichment is retried or logged, not silently stuck.

### N3 — the `/action` "last action" hint ignores the Saturday bonus roll

"one action remaining hint shows prematurely on saturday with bonus action on the /action screen". `buildActionHints` (`action.ts:62`, called `:202`) fires the last-action hint off the raw roll count, so on Saturday (allowance 4, not 3) it warns a roll early. Make the hint key off the day's real allowance, not a hardcoded threshold.

- [ ] The last-action hint fires only on the genuine last roll of the day, Saturday included; a test covers the Saturday case.

### N4 — verify inspiration accounting (bug report on 0.3.1)

"why am I getting inspiration multiple times a day?" reported against `0.3.1`, after the B#3 auto-resolve clobber fix. Verify end to end whether this is a residual leak or the intended bonus-roll mechanic (`modify_rolls_remaining` reward) surfacing without explanation. If a leak, fix it; if working as designed, this is the `TODO.md` "surface bonus rolls as a reward" item and closes as a documentation/UX note, not a code fix.

- [ ] Inspiration spend/grant proven correct by a test or a written trace; the report closes as fixed or as working-as-designed with a UX follow-up logged.

### N5 — remove the impossible free-text hint from the unfinished-action screen

"remove the 'or type action \<what you do\> to continue' from the unfinished action screen, it is not actually possible to do that." A copy fix: drop the instruction that suggests an interaction the screen does not support.

- [ ] The unfinished-action screen no longer offers the impossible free-text continue; no other copy regresses.

---

## Scope fences

- [>] No Stage-2 broadcast plumbing (nat 1/20 global broadcast stays the next release; the killing-blow frame in P2 is private-outcome only).
- [>] No change to `resolveCombatRound`, the band table, or the margin maths — **with one signed-off exception (C2 above): the `trade` band's HP deltas become margin-signed.** Nothing else in the resolution logic, no other band, and no crit path moves. The readout truthfulness remains the release's spine; this is the single bounded re-tune the owner accepted.
- [>] No classify-prompt-template change unless C6 explicitly routes there via the `prompt-versioning` skill and the v13 set.
- [>] Feature asks from the same review are deferred to their homes, not built here: nat-20 extra rewards (adjacent to Stage 2), the "why do non-final decisions have a stat / do DC modifiers stack" design question ([[per-option-stat-and-ability-checks]] follow-up), the menu/nav-button rework (F#5, [[discord-interaction-layer]]), fast travel ([[per-player-map-exploration]]), and the new-hero welcome-screen emoji.
- [>] The `fragments` catalogue stays mvp+; combat/opening frames keep placeholder scenes.

## Release cut (0.3.2)

Once the bundle is user-accepted and the changelog is current:

- [ ] Bump `VERSION` `0.3.1` → `0.3.2`; sync `package.json` `"version"`.
- [ ] Promote `[Unreleased]` → `[0.3.2]` with the date.
- [ ] Add `assets/release-notes/v0.3.2.yml` (player-facing: combat now reads correctly, the foe is named with real HP, the bug fixes; non-technical).
- [ ] Tag `v0.3.2`, push the tag.
- [ ] Prompt the user to complete the merge.

## Doc loop (release exit)

- [ ] All task acceptance boxes green; typecheck + suite green; live-check batch run.
- [ ] `TODO.md`: the combat-correctness items and the N1-N5 rows struck; any C6 residual logged.
- [ ] [[poc-plus-roadmap]] tracking updated (`0.3.2` recorded before Stage 2); map of content current.
- [ ] Archive this plan → `archived/poc-plus/` once shipped (per the `0.3.1` precedent).
- [ ] Recommend `/clear`, then resume with the Stage 2 handover.

---

## Execution state (updated 2026-07-11, mid-build — handover)

Branch `poc-plus/0.3.2-polish` off `dev`. Working tree clean at commit `06d78b9`. Baseline: `npm run typecheck` clean, `npm test` green (**1434 tests**). Each combat task ran the full orchestrated-delegation loop (executor → lead verify → commit → adversarial reviewer → lead triage → fixer → verify → commit).

**Done and committed (Part 1 C1–C5 + Part 2 not yet started):**

- **C1** — continue card shows the contested roll + demotes `[DC N]` to a danger-tier tag. Build `420493b`; review-fix `d9366b0`.
- **C2** — asymmetric `trade` band + band-led HP-delta readout on both cards. Build `183498d`; review-fix `d693934`.
- **C3** — seed real enemy name + HP from the NPC at combat start, `enemyMaxHp` held fixed. Build `2831fc5`; review-fix `cc28965`; residual doc `eb0ef2b`. **The C3 review caught a blocker:** the real-health branch was dead code because `npcs.health` was NULL for every NPC (`seedNpcs` never set it; `add_npc` has no health vocab). Fixed by a backfill migration (`202607112100_npc_combat_health.ts`, Shadow Stag=24 etc., idempotent) + `seedNpcs` now writes health + stripped the new `health` from the LLM context. Residual logged in `TODO.md`: **LLM-authored/`spawn_npc` NPCs (incl. the Saturday threat) still have NULL health → derive from DC; giving `add_npc` a `health` field is a decision-prompt change → v13.**
- **C4** — opening frame shows the re-entry banded enemy condition (wound word + pips, never numbers) read from the persisted `in_combat` edge a bail leaves behind; foe-naming plumbing (`combatEnemyName`) confirmed already wired (Part 1 verify-only). Build `9d43daf`; review hardening `8e82a12`. Engine emits band DATA (`ActionStartResult.combatEnemyCondition`); render boundary preserved.
- **C5** — verify-and-gate: the last-stand/bail (desperate-choice) screen **already** shows the full post-C1/C2 contested-roll readout + banded condition — the shared `renderCombatStatusFrame` plus the desperate decision's `combatStatus`+`combatRounds` (B#19, shipped 0.3.1) cover it once C1/C2 landed. **No production change needed;** locked with an acceptance test (`06d78b9`) whose decision shape mirrors the engine floor branch. (Button cosmetics — "Last stand" renders as a lettered `A` — are a separate `TODO.md` item, out of scope.)

**C6 — INVESTIGATED, root cause recorded, OWNER DECISION LOCKED (2026-07-11). Not yet coded.**

- **Root cause (verified 2026-07-11):** the first-beat auto-resolve branch `if (decideResult.decision.length === 0)` (`PipelineActionStateMachine.ts:191`) fires for **any** action type, including combat — it calls the generic `this.resolve(...)` (skill-style) with NO contested-roll spine. So when DECIDE returns an empty `decision[]` for a combat-classified action, the fight auto-resolves to a one-shot outcome with no combat screens/dice (symptom B: "switched to combat but never showed any combat screens… just autoresolved"). Combat's real spine only runs via `step()` → `handleCombatStep`, gated on `state.actionType === 'combat' && state.required` (`:299`), which needs a first decision with a pickable option.
- **DECISION (owner-locked): guard here + defer classify to v13.** **(1) Land the guard here** — in the `:191` branch, when `actionType === 'combat'`, do NOT auto-resolve; synthesise a combat first decision (a single required "Engage"/"Press the attack" option, not bail-only) so at least one contested round runs. Fails closed to a real fight, not a shrug. Bounded engine/routing change, no prompt edit; add a test asserting a combat action with an empty DECIDE `decision[]` yields an unresolved start whose first `step()` runs `handleCombatStep` (a contested round), never a one-shot resolve. **(2) Defer to v13** — the mis-classification accuracy (combat read as skill/rest, symptom A) is a classify-prompt-template concern → route via the `prompt-versioning` skill + [[prompt-v13-roadmap]]; log the residual in `TODO.md` + the v13 roadmap. **No owner re-ask needed — code the guard directly.**

**Part 3 — N1–N5 BUILT in an isolated worktree, awaiting land (NOT yet on `poc-plus/0.3.2-polish`).**

- Worktree branch `worktree-agent-a64f7a101513aa1f8` (path `.claude/worktrees/agent-a64f7a101513aa1f8`). Baseline there was 1383 (branched pre-combat-tests) → 1389 green after 6 added tests. Commits to land, **oldest→newest**: `bd57611`(N5 copy) → `4f63bc5`(N4 WAD doc) → `20c4c28`(N2 cartographer) → `697f057`(N1 threat anchor) → `d6df2e0`(N3 Saturday-hint regression lock).
- Outcomes: **N1** fixed (threat NPC now anchors at its `home_location`, tick wander skips anchored NPCs; `spawnNpc` idempotent). **N2** fixed (engine now diffs `enrichment_pending` before/after the machine call to recover truly-minted rows and fires the cartographer on both step + auto-resolve paths; residual: failed enrichment is logged, not retried — logged in `TODO.md`). **N3** verified already-correct (hint keys off `rolls_remaining===1`, not a hardcoded threshold), regression-locked with Saturday tests. **N4** working-as-designed (roll drained once, grant nets correctly; trace recorded, UX follow-up kept open). **N5** fixed (removed the impossible free-text hint from the unfinished-action panel, `hi.ts:246`).
- **Landing care:** N1/N2/N3 add `[Unreleased]` CHANGELOG entries and N1/N2/N4 append to `TODO.md`, so expect trivial merge adjacency there. N3 touches `action.ts` `buildActionHints` only (combat lane touched other parts of `action.ts` — check for adjacency). **The lead must adversarially verify each N-commit's diff before landing** (the worktree agent self-reported; not yet lead-reviewed). Recommended: cherry-pick in the stated order onto `poc-plus/0.3.2-polish`, run typecheck+suite after each, reconcile CHANGELOG/TODO.

**Remaining work:** C6 (owner-confirm the split, then code the guard + test + its review loop) · Part 2 P1 (terminal card prose fit + right-edge padding) · P2 (killing blow gets margin + real frame) · land Part 3 (verify + cherry-pick the 5 commits) · live-check batch on the dev bot (combat cards; **add "watch danger-tier flicker across rounds"** and "watch enemy-HP stability across a last-stand re-entry") · release cut 0.3.2 (VERSION bump, changelog promote, `assets/release-notes/v0.3.2.yml`, tag, prompt owner to merge).

**Changelog `[Unreleased]`** carries C1, C2, C3, C4 entries (C5 needed none — no new behaviour). Part 3's entries live on the worktree branch until landed. Keep adding per task.

**Open decisions locked with the owner (scope-lock section):** C1 danger-tier, C2 asymmetric-trade exception + band-led, C6 = **guard here + defer classify to v13 (owner-locked 2026-07-11, code directly)**, Part 3 concurrent worktree lane.
