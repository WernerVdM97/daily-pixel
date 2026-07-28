---
title: "POC+ Release A — worth-returning-to (build plan)"
status: decided
domain: engine
phase: poc
tags:
  - build-plan
  - balance
  - coherence
  - combat
  - llm-cost
  - prompt-versioning
related:
  - "[[poc-plus-roadmap]]"
  - "[[prompt-v13-roadmap]]"
  - "[[layer-boundaries-and-json-seam]]"
  - "[[action-engine-framework]]"
  - "[[the-poc]]"
---
_Executor-grade build plan for **Release A** of the POC+ arc, inserted 2026-07-23 after the full-period prod-data review and re-sequencing recorded in [[poc-plus-roadmap]] (§ Re-sequencing). Release A front-loads the solo fun fundamentals the telemetry exposed, so the game is worth returning to before any more shared-world code lands. Parent tracking lives in [[poc-plus-roadmap]]; this plan is the per-stage contract, authored by the orchestrated-delegation lead at stage start. Status `decided` while active; archive → `archived/poc-plus/` on ship._

---

# POC+ Release A — build plan

## Why this release exists

A read-only snapshot of the whole POC+ period (`warden-20260723-201953`; 07-07 → 07-23, game day 17, builds `0.3.0`–`0.3.2`: 98 actions, 796 LLM calls, 4 characters, 1 external tester) validated the arc's foundation but showed the live Oak never reached a size where the shared-world stages (cross-player buffs, the Saturday boss) can be fun-validated. The re-sequencing decision (recorded in the roadmap) is to front-load the fundamentals that make the game worth returning to solo, and to run the remaining playtesting through the agent-player harness ([[layer-boundaries-and-json-seam]] M4) until a later human user-testing round.

Release A is that front-load: five items the telemetry exposed as the difference between a coherent daily ritual and a leaky one.

1. **Stakes** - 83% success, no `final_dc` above 17, 11 fair failures in 98 actions. Nothing is ever really at risk.
2. **Inspiration dial** - `modify_rolls_remaining:+1` fires on 29% of actions, inflating cadence to ~4.8 turns per active day (F#4, "fun but too broken").
3. **NPC mint-on-first-sight** - `add_npc` fired twice in the whole period; the world narrates people it never persists (F#1, the vanishing-caravan incoherence, the oldest open complaint).
4. **Critic cost A/B** - the coherence critic is ~35% of all LLM calls and ~15% of tokens for a QA step players never see.
5. **Combat terminal polish** - the enemy reads "critical" not "dead" on a win with no fatal-blow prompt (F#11); the combat frame names a generic "Minion" instead of the known foe (B#15).

## Scope reality: this release straddles the v13 prompt boundary

The scouting pass (2026-07-23, seams cited per task below) surfaced a fact the roadmap's "small-code" framing understated: **three of the five items are substantially prompt-authored, not engine code.**

- **Stakes (RA-1)** - `baseDc` is an LLM-authored decide field (`decide/BASE.md:76`); the difficulty guidance is prose in `decide/BASE.md:29,46`; the reward menus (which mutations a success/failure may grant) live in `resolve/**/*.md`. The engine only clamps and validates. Meaningfully raising stakes is a prompt-set change, not a code table edit.
- **Inspiration (RA-2)** - `modify_rolls_remaining` is emitted only by resolve prompts (`resolve/BASE.md:39,49`, `resolve/skill/success.md:5`, `resolve/rest/success.md:6`, `resolve/other/success.md:4`); there is no frequency cap anywhere in the engine. Dialing frequency is a prompt change; a hard cap needs new engine state.
- **NPC mint (RA-3)** - the bounded "persist a narrated combat foe instead of `'Minion'`" half is pure engine; full mint-on-first-narration needs `add_npc` to carry a `health` field, which is a decide-prompt vocab change already logged as a v13 item (0.3.2 C3 residual, see [[prompt-v13-roadmap]] and `CHANGELOG.md` "0.3.2 residuals → v13").

The roadmap already anticipates this in its "Sequencing against v13" section: template-touching work routes through the `prompt-versioning` skill and lands as, or alongside, the v13 prompt-set bump. So Release A is not a clean engine-only release. **Decision gate SL-1 (below) settles whether Release A carries a v13-aligned prompt-set bump, or ships only its engine-bounded slices and defers the prompt-tuning to ride v13.** Everything downstream (ordering, release cut, which items are in-scope) depends on that answer, so it is locked with the owner before any executor is spawned.

## How to run

One loop per task, per the `orchestrated-delegation` skill: the lead scouts and finalises the executor handoff, the executor builds, the lead verifies (baseline below plus the task's acceptance), commit, a fresh-context reviewer critiques adversarially, the lead triages, a fixer lands accepted findings, verify, commit. Branch `poc-plus/release-a` off `dev`; atomic commit per task; keep the changelog current per task (`changelog` skill); merge at the end; release cut per the `releasing` skill. Any prompt-touching task additionally runs through the `prompt-versioning` skill (own versioned file, `current_source` mirror, version-constant bump, rows stamped).

**Verification baseline (every task):** `npm run typecheck` clean, `npm test` green (reconcile the count on branch first; ~1550+ after M4). Balance tasks additionally get an agent-player run (`npm run agent:play`, per the `agent-smoke` skill) as the primary playtest signal, since live human testing is deferred; player-facing render tasks get a dev-bot live check via `scripts/send-dm.ts`.

**Playtest signal (RA-1, RA-2, RA-4).** Live human testing is deferred per the re-sequencing. The agent-player harness is the primary before/after signal: run N days pre-change and post-change, compare the transcript scoreboard (success rate, DC distribution, rolls-per-day cadence, LLM call/token counts). This is a genuine change from the 0.3.2 loop, which leaned on a human dev-bot operator.

**Data provenance.** The scoping review is in-terminal only (real Discord-linked player text; per `db-backups/README.md` never committed or shared). Re-pull `warden-20260723-201953` (or a fresh snapshot) with the `db-backups/` tooling to re-read the raw numbers while scouting; the deep-dive was presented as an artifact.

## Ordering & dependencies

Two lanes, split by the SL-1 answer. The engine-bounded lane can start immediately regardless of SL-1; the prompt-tuning lane is gated on it.

**Engine-bounded lane (start now):**

- **RA-4 (critic A/B)** first - cheapest, most measurable, zero prompt-set risk, and it trims the LLM-cost tail that every other agent-player run pays. It is a gating change plus a measurement, not a feature.
- **RA-5 (combat terminal polish)** - self-contained render + engine, no prompt-set dependency. RA-5b (the "Minion" fallback) shares the combat-establish seam with RA-3's bounded half, so do them adjacently.
- **RA-3 bounded half (persist the narrated foe)** - pure engine at the `npcsToAdd` apply loop / combat-establish path; independent of the prompt-set bump.

**Prompt-tuning lane (gated on SL-1):**

- **RA-1 (stakes)** and **RA-2 (inspiration)** move together - both retune the resolve prompt-set and both want the same agent-player before/after harness, so batch their prompt-versioning bump. RA-1 also folds in the MVP "make stamina/wealth/HP spendable/meaningful" item, so scope-fence it tightly (see RA-1).
- **RA-3 full half (mint-on-narration vocab)** - only if SL-1 opts into the v13 vocab change; otherwise it stays a v13 item and RA-3 ships its bounded half only.

Release cut is last, gated on whichever items SL-1 admits.

## Confirmed decisions (scope lock)

_To be locked with the release owner before any executor is spawned. These bind the tasks; where a task's prose differs, this section wins. Defaults are the lead's recommendation; the owner confirms or overrides._

- **SL-1 — does Release A carry a v13-aligned prompt-set bump?** *(LOCKED 2026-07-28: **Option A** — Release A carries the bump. RA-1, RA-2 and RA-3's full mint vocab are all in scope, batched as one resolve/decide prompt-set bump after the engine lane. Must not race an independent v13 set bump.)*
  - **Option A (recommended): Release A carries the bump.** Stakes and inspiration are the highest-player-value items the telemetry exposed; deferring them to v13 hollows out the release's stated purpose ("worth returning to"). Release A then bundles the resolve-prompt retune (RA-1, RA-2) with the engine-bounded lane, routed through `prompt-versioning`, and RA-3's full mint-vocab rides it too. Cost: Release A becomes a prompt-set release, so it must not race an independent v13 set bump - coordinate with [[prompt-v13-roadmap]].
  - **Option B: Release A is engine-only.** Ship RA-4, RA-5, and RA-3's bounded half now as a fast coherence/cost release; fold RA-1, RA-2, and RA-3's vocab into the next v13 prompt-set bump. Cost: the two biggest fun items slip to v13's cadence.
  - Everything below assumes Option A unless the owner picks B, in which case RA-1/RA-2 and RA-3's full half drop out of this plan and into [[prompt-v13-roadmap]].
- **SL-2 — no lethality.** The death track stays POC-deferred per [[the-poc]]. RA-1 raises DCs and adds meaningful cost (stamina/wealth/HP spend), never death. HP reaching 0 keeps its current non-lethal handling; RA-1 does not touch the combat floor.
- **SL-3 — RA-4 measure-before-gate.** The critic A/B is investigate-and-measure first. The lead runs the agent-player harness with the critic on vs gated, records the call/token delta and any coherence regression in this plan, and brings the keep/gate/drop recommendation to the owner before the gate lands as default-on-or-off. The critic fails open today (`DeepseekLlmGateway.ts:409-480`), so a gate cannot break a run, only change cost.
- **SL-4 — RA-3 mint scope.** *(LOCKED 2026-07-28: **named foes only**.)* The bounded engine half persists a combat foe only when it has a resolved name (from the `combatEnemy` hint or a known NPC); a genuinely ambient/unnamed encounter stays ephemeral and keeps its fallback, so the NPC table grows only with foes the world actually named — no auto-naming of random scuffles, and no unbounded growth of the per-location handle list the decide prompt must enumerate. The full mint-on-narration vocab (`add_npc` gains `health`) is admitted, since SL-1 = Option A.

- **SL-5 — the sixth TODO row is RA-6, not part of RA-5.** *(LOCKED 2026-07-28.)* "Private embed parity on auto-resolve paths" gets its own number and landed first: it touches the auto-resolve reply fan-out, not combat rendering, so folding it into RA-5 would have broken the atomic-commit-per-task rule for no gain.

---

## RA-1 — Stakes: meaningful cost and higher DCs on ambitious actions

**Telemetry.** 98 actions, 83% success, no `final_dc` above 17, 11 fair failures. The difficulty ceiling and the reward floor are both too soft, so no action feels consequential. Folds in the MVP "make stamina/wealth/HP spendable/meaningful" item.

**Code seam (scouted 2026-07-23).** DCs are prompt-authored, not a code table: `baseDc` is an LLM decide field (`assets/prompts/decision-prompts/current_source/decide/BASE.md:76`), guided by prose at `decide/BASE.md:29,46` ("10-12 routine, 14-16 hard, 17+ daunting"). The engine only clamps: `accumulateDc` → `[0,30]` (`src/engine/action/dc.ts:12`), `validateDcModifier` ±5 (`:17`), and `resolveRoll(d20,bonus,dc)` decides pass/fail (`dc.ts:66`); `finalDc` is assigned at `PipelineActionStateMachine.ts:1051` (non-combat) / `:926` (combat). Reward menus are prompt-authored per type: `resolve/BASE.md:34-50` plus `resolve/{skill,search,social}/{success,failure}.md`. The engine validates and applies the resulting mutations (`mutations.ts:286` health, `:299` stamina, `:317` wealth; applied `:452/:461/:464`) with per-axis down-caps (`collapseStackedDeltas:113-149`, `STAMINA_DELTA_CAP=-5`, `HEALTH_DELTA_CAP=-4`; wealth/rolls uncapped). Deltas surface in `OutcomeRenderer.ts:47-90`.

**Deliverable.** Retune the resolve/decide prompt-set (via `prompt-versioning`) so ambitious actions carry higher DCs and real cost: raise the DC-guidance ladder for daunting attempts, and rebalance the success/failure reward menus so a failure has a felt cost (stamina/wealth/HP spend) and success is proportional to the risk taken. The MVP "spendable resources" item lands here as making stamina/wealth/HP the currency of ambition. No engine-maths change beyond the existing clamps unless the retune exposes a genuine cap gap (flag as a decision, do not smear balance into code).

**Prompt-versioning?** Yes - resolve + decide prompt-set bump. Gated on SL-1 = Option A.

**Acceptance:**

- [ ] An agent-player before/after run shows the DC distribution widened (ambitious actions reach the hard/risky band) and success rate pulled down from ~83% toward a target band recorded in this plan.
- [ ] Failures cost something a player feels (a stamina/wealth/HP delta on the failure branch), verified in the transcript and in a resolve fixture test.
- [ ] No lethality introduced (SL-2); the combat floor is untouched.
- [ ] Prompt-versioning rows stamped; `current_source` mirror updated; version constant bumped.

## RA-2 — Inspiration dial: `modify_rolls_remaining` reads as a gift, not a leak

**Telemetry.** `modify_rolls_remaining:+1` fires on 29% of actions, inflating cadence to ~4.8 turns per active day (F#4, "fun but too broken"). Related to the WAD bonus-rolls item and F#12 (work should not offer inspiration).

**Code seam (scouted 2026-07-23).** Emitted only by resolve prompts: `resolve/BASE.md:39` (menu entry), `:49` (nat-20 grants +2), `resolve/skill/success.md:5` (offered as an OR), `resolve/rest/success.md:6`, `resolve/other/success.md:4`. Applied in `mutations.ts:326-334` (validate: cannot drop below 0) and `:467-469` (`state.rollsRemaining = max(0, …)`), summed uncapped in `collapseStackedDeltas:125`. **No frequency cap exists anywhere.** The display already surfaces a grant as "✨ inspired" (`OutcomeRenderer.ts:310-312`). Nearest daily-state hook is the allowance in `src/controller/dayJob.ts:167`.

**Deliverable.** Two coupled levers, pick per owner taste at handoff: (1) dial the prompt frequency down so `modify_rolls_remaining` is a rarer, earned grant, and (2) surface it as a named reward ("Inspired: +1 action today") so it reads as a gift. Remove the F#12 leak (day-job work should not offer inspiration). If the owner wants a hard ceiling, add a per-day inspiration cap in engine state near the `dayJob.ts:167` allowance - flag it as new state, do not leave it prompt-only.

**Prompt-versioning?** Yes - resolve prompt-set bump (batched with RA-1). Gated on SL-1 = Option A. The engine cap, if chosen, is a separate non-prompt commit.

**Acceptance:**

- [ ] An agent-player before/after run shows rolls-per-active-day pulled down from ~4.8 toward a target recorded in this plan.
- [ ] Day-job work no longer offers inspiration (F#12); a fixture asserts the work path grants no `modify_rolls_remaining`.
- [ ] The grant reads as a named reward in the outcome view; a snapshot covers it.
- [ ] If a hard cap is chosen, engine state enforces it with a test; otherwise the frequency dial is the mechanism and that is recorded here.

## RA-3 — NPC mint-on-first-sight: stop narrating people the world never persists

**Telemetry.** `add_npc` fired twice in the whole period; the world narrates NPCs it never persists (F#1, the vanishing-caravan incoherence). The oldest open complaint and the highest-value coherence fix. Overlaps the combat "Minion" fallback (RA-5b).

**Code seam (scouted 2026-07-23).** `add_npc`/`spawn_npc` (legacy alias) validated at `mutations.ts:359-365`, applied to `npcsToAdd` at `:485-494`, written to DB in `WorldEngineImpl.ts:644-663` (create-only collision check via `npcRepo.findByLocation`, stamps `createdByActionId`). Repo: `src/db/repositories/npc.ts` (`create:12-47`); row shape `NpcRow` at `types.ts:101-115` (includes `health`, added by `202607112100_npc_combat_health.ts`). Seed: 8 fixed NPCs via `seedNpcs` (`migrate.ts:281+`). The decide prompt lists present NPCs as `[N1]…[Nk]` handles (`prompt-builder.ts:246-256`); `decide/combat.md:19-25` tells the model to name a `combatEnemy` from a present NPC. **No mint-on-narration hook exists** - NPCs enter only via seed or an explicit `add_npc`. The combat-establish path falls back to an un-minted `'Minion'` when no foe is resolved (`PipelineActionStateMachine.ts:511-521`); NPC-resolution-fail drops to the location anchor at `:487-489`.

**Deliverable — two halves (SL-4).**

- **Bounded (engine-only, unconditional):** when a combat resolves against a narrated/known foe, persist it as a real NPC (its resolved name and derived health) instead of the throwaway `'Minion'`, so the foe you fought exists afterwards and re-engages coherently. Seam: the combat-establish path (`:476-521`) and the `npcsToAdd` apply loop (`WorldEngineImpl.ts:644`). This directly feeds RA-5b.
- **Full (prompt-vocab, SL-1 = Option A only):** give `add_npc` a `health` field so the resolve LLM can mint a narrated NPC on first sight with combat-ready stats, closing the F#1 coherence gap for non-combat NPCs too. This is the 0.3.2 C3 residual promoted; route through `prompt-versioning` and coordinate with [[prompt-v13-roadmap]].

**Prompt-versioning?** Bounded half no. Full half yes (decide/resolve mutation-vocab bump).

**Acceptance:**

- [ ] A combat against a narrated foe leaves a persisted NPC with that name and sane health; a test drives establish → resolve → `findByLocation` and asserts the row exists (create-only, no duplicate on re-engage).
- [ ] The `'Minion'` fallback no longer fires for a foe that has a name (ties into RA-5b).
- [ ] (Full half only) `add_npc` accepts and stores `health`; the decide vocab and validator cover it; a fixture mints an NPC with health from a narration.

## RA-4 — Critic cost A/B: measure, then gate the coherence critic

**Telemetry.** The coherence critic is ~35% of all LLM calls and ~15% of tokens for a QA step players never see; also behind some of the reasoning-tail timeouts.

**Code seam (scouted 2026-07-23).** **Note a framing correction:** the critic is *not* in the classify stage (the older TODO "remove critic from classify" is imprecise). Classify is heuristic-first with an LLM fallback (`PipelineActionStateMachine.ts:165,174`) and the critic never touches it. The real cost is that the pipeline critic fires **on every decide beat and every narrate beat**: `critiqueDecide` (`:1083-1124`, called at `:185` and `:350`) and `critiqueNarration` (`:1175-1205`, at `:883`/`:1029`). Gateway: `DeepseekLlmGateway.critique()` (`:409-480`, `call_kind='critic'`, fails open to `ok`), prompt `assets/prompts/critic/critic-v1.md`. Injected at the machine constructor (`:144`), prod-enabled via `ENABLE_COHERENCE_CRITIC` (`index.ts:1146-1148`, passed `:1209`). The critic is **ungated today** - the old `required` gate was deliberately removed (comment at `:1091-1096`, which names re-gate candidates: `decision.length < 2`, `baseDc` out of range). The legacy `CritiquedLlmGateway.ts:33-36` still shows the anomaly-gate pattern. Combat decide is already exempt (`:681-682`, `:1144`).

**Deliverable (SL-3, measure-first).** Instrument an A/B via the agent-player harness: run with the critic on (current) vs anomaly-gated, and record the call/token delta plus any coherence regression in this plan. Then land the recommended gate in `critiqueDecide`/`critiqueNarration` - re-introduce an anomaly trigger (empty/short `decision[]`, `baseDc` out of range, parse-warning present) so the critic runs only when a beat looks risky, mirroring the legacy pattern. Keep the `ENABLE_COHERENCE_CRITIC` flag as the global off-switch. Fails-open behaviour is preserved.

**Prompt-versioning?** No - this is engine wiring and measurement, no prompt-template edit.

**Acceptance:**

- [ ] The A/B numbers (critic share of calls/tokens before vs after) are recorded in this plan from an agent-player run.
- [ ] The critic runs only on anomaly-flagged beats by default; a test asserts a clean decide/narrate beat skips the critic and a flagged one invokes it.
- [ ] No coherence regression attributable to the gate in the agent-player run (the critic still fires where it mattered); fails-open preserved.

## RA-5 — Combat terminal polish: "dead" not "critical", a fatal-blow beat, and the real foe

**Telemetry.** On a WIN the enemy reads "critical" not "dead" and there is no fatal-blow prompt (F#11); the combat frame names a generic "Minion" instead of the known foe (B#15). Post-`0.3.2` residue.

**Code seam (scouted 2026-07-23).**

- **(a) "critical" on a win.** `enemyConditionBand` (`PipelineActionStateMachine.ts:1289-1297`) bands `Healthy/Bloodied/Battered/Critical` with **no "Dead" tier**, so a foe at fraction 0 still bands to `'Critical'`. Reused for the outcome combat scene (`actionViewState.ts:349-354`) and the status frame (`composeCombatStatus:1305-1323`). The terminal card verdict is separate: `OutcomeRenderer.buildCombatTerminalCard:185-212` (`:196` `WON/LOST`, `:205` marker) rendered by `CombatCardRenderer.buildTerminalLines:308-339`.
- **(a) no fatal-blow prompt.** The win branch short-circuits straight to resolve at `:546-552` (`if (newEnemyHp<=0) return this.resolveCombat(... 'success' ...)`), with no interstitial beat. Contrast the player-near-death path which *does* build a desperate-choice prompt at `:559-616`. A symmetric enemy fatal-blow beat would be added at the `:546` win branch.
- **(b) "Minion" / "Unknown foe".** Machine fallback `'Minion'` at `:511-521` when `combatEnemy` is absent; NPC-resolution-fail drops to location anchor at `:487-489`. Name priority ladder `:498-510`. Opening-frame fallback `'Unknown foe'` at `OpeningFrameRenderer.ts:157` (nameplate `:196`), fed via `actionViewState.ts:184,284,354`. Enemy name source: `combatEnemy` hint (`pipeline/types.ts:65`, parsed `ProdPipelineGateway.ts:174-180`, authored `decide/combat.md:19-25`), set on the terminal outcome `combatFrame.enemyName` at `:936`. The pre-decision "Unknown foe" is legitimate (foe not established until the first choice); the bug is the `'Minion'` establish fallback.

**Deliverable.**

- Add a terminal "Slain"/"Dead" condition tier so a defeated foe never reads "Critical" on the win frame (extend `enemyConditionBand` for fraction 0, propagate to the outcome scene).
- Add a symmetric enemy fatal-blow beat at the `:546` win branch: a short "killing blow" interstitial mirroring the player desperate-choice shape, so the kill lands as a beat, not a silent short-circuit. Keep it single-beat, non-lethal-to-player, no Stage-2 broadcast plumbing (fenced).
- Kill the `'Minion'` fallback for a named foe: when the foe has a resolved name (or RA-3's persisted NPC), the establish path and both frames use it; `'Minion'`/`'Unknown foe'` remain only for a genuinely ambient encounter. Shares the establish seam with RA-3's bounded half - do them adjacently.

**Prompt-versioning?** No - engine + render only.

**Acceptance:**

- [ ] A won fight shows a "slain/dead" enemy condition on the outcome frame, never "Critical"; a fixture covers fraction-0.
- [ ] The killing blow renders as its own beat (fatal-blow interstitial), not a silent jump to the outcome; a combat test asserts the beat fires on `newEnemyHp<=0`.
- [ ] A combat against a named/known foe never renders "Minion"; the ambient fallback still works.
- [ ] No Stage-2 broadcast plumbing added (fence).

---

## Scope fences (what stays deferred)

- [>] **No lethality / death track** (SL-2) - POC-deferred per [[the-poc]]; RA-1 adds cost and DC, never death.
- [>] **No shared-world plumbing** - the nat 1/20 broadcast (Release B), cross-player buffs (Stage 3), and the Saturday boss (Stage 4) stay in [[poc-plus-roadmap]]. RA-5's fatal-blow beat is private-outcome only.
- [>] **Prompt-set races** - if SL-1 = Option A, Release A owns the resolve/decide bump; it must not land alongside an independent v13 set bump. Coordinate in [[prompt-v13-roadmap]].
- [>] **Classify accuracy** (0.3.2 C6 residual) - the combat-mis-classification prompt work stays v13; RA-4 does not touch classify.
- [>] **Full item economy** - RA-1 makes existing resources spendable; item depth stays in [[improved-item-features]].
- [>] **The four M4 live-smoke backlog observations** (search-category wealth telemetry, wealth-on-failure, out-of-graph `scene_location`, bail-refund UX signal, per `TODO.md`) - triage during scouting; fold any that fall naturally into RA-1 (wealth-on-failure overlaps stakes) or RA-3, else leave logged.

## Release cut

Versions are unpinned per the roadmap; Release A takes the next `0.3.x` (expected `0.3.3`) at cut time. Once the admitted bundle is accepted and the changelog is current:

- [ ] Bump `VERSION` → `0.3.3`; sync `package.json` `"version"`.
- [ ] Promote `[Unreleased]` → `[0.3.3]` with the date (the M4 agent-player entry already sitting in `[Unreleased]` ships in this cut unless separated).
- [ ] Add `assets/release-notes/v0.3.3.yml` (player-facing: fights feel riskier and more rewarding, foes are named and stay dead, the world remembers who you met; non-technical).
- [ ] Tag `v0.3.3`, push the tag.
- [ ] Prompt the user to complete the merge (`dev` → `main` per the `releasing` skill; the lead never merges `dev`/`main`).

## Doc loop (release exit)

- [ ] All admitted-task acceptance boxes green; typecheck + suite green; agent-player before/after runs recorded.
- [ ] `TODO.md`: the five Release A rows struck; any deferred half (RA-3 full, RA-1/RA-2 if SL-1 = B) re-homed to [[prompt-v13-roadmap]].
- [ ] [[poc-plus-roadmap]] tracking updated (Release A recorded before Release B); map of content current.
- [ ] Archive this plan → `archived/poc-plus/` once shipped.
- [ ] Recommend `/clear`, then resume with the Release B (Stage 2 solo-first) handover.

---

## Execution state

_The lead updates this section per task with commit hashes, review outcomes, and the owner locks, mirroring the 0.3.2 plan's running handover._

- **Branch:** `poc-plus/release-a`, cut off `dev` at `b32642a` on 2026-07-28. *(Reconciliation note: a stale local `feature/release-a` pointer existed at `62bd4b3`, 62 commits behind `dev` with zero unique commits — a pre-M0 branch, not resumable work. Nothing was lost; the branch was cut fresh off `dev`.)*
- **Baseline (verified 2026-07-28):** `npm run typecheck` clean, `npm test` green at **86 files / 1576 tests**. Matches the M4 handover baseline.
- **Owner locks:** SL-1 = **Option A** (carry the prompt-set bump), SL-2 = no lethality (pre-settled), SL-3 = measure-before-gate (default returns to the owner *with* the A/B numbers), SL-4 = **named foes only**, SL-5 = the sixth row is **RA-6**.
- **Admitted bundle:** RA-1, RA-2, RA-3 (both halves), RA-4, RA-5, RA-6.

### Task log

- **RA-6 — private embed parity on auto-resolve paths.** Dropped `{ compact: true }` from the `renderStartResult` fan-out (`SessionController.ts`), so the day-job-work and nav-button custom-action private replies carry the full gamebook trail like the public copy. The two calls became identical, so the view is now built once and shared by both arms (safe: `OutcomeViewState` is a plain DTO and `outcomeViewToDiscord` only reads it). The `compact` option itself remains plumbed through `buildOutcomeView`/`actionViewState.ts` but now has **no production caller** — flagged as a follow-up cleanup decision, deliberately not done here to keep the commit atomic. Blast radius confirmed by the M1 dispatch oracle: exactly two golden snapshots moved, each a single added story-thread line on the two auto-resolve leaves (`action:dayjob:<n>`, `action:custom:modal`), nothing removed. Stale compact-era parity comments reconciled in `SessionController.ts` and `agent/harness.ts`; the agent-harness test's `viewPrivate !== viewPublic` discriminator (impossible post-change) was replaced with the property RA-6 actually buys — the private arm carries a `storyThread`. Typecheck clean, 86/1576 green. **Commit `8c2bdde`. Review: clean, no fixer pass.** The fresh-context reviewer confirmed the aliasing is safe (each `outcomeViewToDiscord` call builds its own `EmbedBuilder` and independent `.toJSON()`, so aliased inputs cannot cross-contaminate two replies; no identity-based branching anywhere), traced all four action paths (no fifth exists — `buildOutcomeView` has exactly three call sites, none now passing `compact`), and dismissed the embed-cap regression risk on the strongest possible grounds: since the two arms are byte-identical they degrade identically through the same `MAX_EMBED_DESC = 4096` ladder the public copy already exercised, so RA-6 introduces no new truncation mode. Residual nits accepted without change: the text-parity assertion is guaranteed-pass while the views stay aliased (kept as the guard against a future un-aliasing, which the still-plumbed `compact` option invites), and this commit deliberately carries the SL-lock bookkeeping alongside the fix because those locks gate every later task.

### Scouting corrections to RA-3 / RA-5 (2026-07-28, lead)

Reading the combat-establish path end-to-end turned up three things the 2026-07-23 scouting pass did not, all of which change what these two tasks should build. Verified against code, not inferred.

- **`combatEnemy.maxHp` is unreachable dead code.** `src/llm/pipeline/types.ts:65` declares it and `PipelineActionStateMachine.ts:500-501` consumes it as the middle tier of the documented enemy-max-HP ladder ("resolved NPC's real health > LLM-authored `maxHp` hint > `deriveEnemyMaxHp(baseDc)`"), but the prod parser copies only `{ name, anchor }` (`ProdPipelineGateway.ts:180`) and **no prompt anywhere asks for `maxHp`** (grepped all of `assets/prompts/`). So in production that ladder has two rungs, not three, and the comment describing it is misleading. Decide: either delete the tier, or wire it properly — noting that RA-3's full half is already adding a `health` vocab slot, so wiring `maxHp` overlaps that work and probably belongs there rather than in RA-5.
- **`combatEnemy.name` is missing the emptiness guard its sibling field has.** `ProdPipelineGateway.ts:176-180` accepts any `string` name, while `sceneLocation` three lines above it (`:170`) requires `.trim() !== ''`. A payload of `{ name: "", anchor: "location" }` therefore passes validation and establishes a fight whose `enemyName` is the empty string — which does *not* fall back to `'Minion'`, because the fallback only fires when `combatEnemy` is absent entirely. The result is a blank foe nameplate. Cheap engine fix, belongs in RA-5.
- **The `'Minion'` fallback is already correctly scoped, so RA-5b is much smaller than specced.** `'Minion'` fires *only* in the no-`combatEnemy`-signal branch (`PipelineActionStateMachine.ts:511-521`), which `decide/combat.md` § 4 explicitly designates as the intended behaviour ("if omitted or unresolvable, the engine defaults to a location-anchored minion"). A foe that *has* a name already renders under it, courtesy of 0.3.2 C3. So the remaining B#15 sightings are not an engine fallback bug — they are DECIDE omitting `combatEnemy` on a fight against a known NPC, which is classify/decide prompt accuracy and belongs to the v13 lane, not RA-5. RA-5's engine-side foe work reduces to the empty-name guard above.

**Consequent refinement to SL-4 ("named foes only").** The discriminator must be the `anchor` signal, **not** the mere presence of a name. `decide/combat.md` § 4 reserves `anchor: 'npc'` for "a named NPC or boss" and `anchor: 'location'` for "unnamed minions or wildlife (a wolf, a boar)" — but the model still supplies a *name string* for wildlife, so gating the mint on "has a name" would persist "a wolf" as a permanent location resident, exactly the table growth the owner rejected. The correct mapping is:

| Establish case | Persist? |
| --- | --- |
| `anchor: 'npc'`, NPC resolved | No — already a real NPC row |
| `anchor: 'npc'`, resolution **failed** | **Yes — this is the RA-3-bounded mint target** (the model named a specific NPC the DB does not have; the F#1 vanishing-caravan case) |
| `anchor: 'location'` (wildlife/minion, may carry a name) | No — ambient, stays ephemeral per SL-4 |
| no `combatEnemy` signal at all | No — `'Minion'`, ambient by design |

That single failed-resolution branch (`PipelineActionStateMachine.ts:487-489`, currently silently dropping to the location anchor) is the whole of RA-3's bounded half.

### Follow-up logged (not in Release A scope)

- **The `compact` option has no production caller.** `opts.compact` is still plumbed through `buildOutcomeView` (`actionViewState.ts:317,372`), `OutcomeViewState.storyThread` (`viewState.ts:52`) and the legacy `commands/action.ts:271` signature, with a direct unit test at `tests/discord/view-state.test.ts:107`. Post-RA-6 nothing passes it. Either delete the option and its test, or keep it as a deliberate capability — an owner call, deliberately excluded from RA-6 to keep that commit atomic.
