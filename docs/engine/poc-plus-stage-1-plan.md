---
title: "POC+ Stage 1 — v12 tail, welcome tag & combat maths reveal (build plan)"
status: decided
domain: engine
phase: poc
tags:
  - build-plan
  - combat
  - ansi
  - discord
  - social
related:
  - "[[poc-plus-roadmap]]"
  - "[[prompt-v13-roadmap]]"
  - "[[stage-5-live-cutover-plan]]"
  - "[[mvp+ansi-art]]"
  - "[[prompt-v12-combat]]"
---
_Build plan for the first stage of [[poc-plus-roadmap]]: close the v12 tail (T0), ship the welcome tag (T1), and ship the combat maths reveal on a new `AnsiRenderer` (T2). Written as the executor-grade contract for an orchestrated-delegation lead. Line anchors were verified 2026-07-09 and will drift; the lead re-verifies each anchor while scouting, before delegating._

---

# POC+ Stage 1 — build plan

## How to run

One loop per task, per the `orchestrated-delegation` skill: lead scouts and finalises the executor handoff → executor builds → lead verifies (baseline below plus the task's acceptance) → commit → reviewer critiques adversarially → lead triages → fixer lands accepted findings → verify → commit. Branching and release cuts per the `releasing` skill; changelog per merge per the `changelog` skill.

**Verification baseline (every task):** `npm run typecheck` clean; `npm test` green. Player-facing tasks additionally get one live check on the dev bot.

**Release cuts:** next `0.3.x` after T0 + T1 land (F#21 and the tag are the player-facing notes; the sweep is internal); the next `0.3.x` after T2.

## T0 — v12 closeout tail

Two sub-tasks, spec by reference, each its own commit.

### T0a — dead-code sweep ([[stage-5-live-cutover-plan]] T7)

**Description.** `0.3.0` shipped with the legacy v11 path in-tree; T7's wipe and release halves happened, the code sweep did not. Delete: the legacy `ActionStateMachine` (`src/engine/action/machine.ts`); the critic dual-injection in `WorldEngineImpl` (~`:363`); `PROMPT_VERSION` (`src/llm/prompt-builder.ts:6`) and its stamp sites (`WorldEngineImpl.ts:568-569,1747`, `DeepseekLlmGateway.ts:161-162`); the `decision-<PROMPT_VERSION>.md` load path; the `current_source.md` byte-identical test (`tests/llm/prompt-builder.test.ts:211-218`). Keep `decision-v11.md` on disk, off the load path.

**Acceptance:**
- [x] Grep for `PROMPT_VERSION` is clean, and `ActionStateMachine` matches nothing but `PipelineActionStateMachine` (the substring is expected), outside git history and the kept v11 asset; full suite green without the deleted path. (`72fb32d`; re-verified 2026-07-09, 1122 tests green.)
- [x] Doc loop: tick T7 (and note the Checkpoint — the 2026-07-08 prod QA session stood in as the smoke gate) in [[stage-5-live-cutover-plan]], flip that doc to `shipped`, archive it per conventions, update the map of content. (Doc loop reconciled 2026-07-09, one session after the code landed.)

**Scope fence:** no other v13 threads, no template edits, no DB work (the wipe already happened).

### T0b — F#21 divine-intervention rework ([[prompt-v13-roadmap]] §4)

**Description.** The typed divine-intervention fallback (`PipelineActionStateMachine.resolveDivineIntervention()`) is a system failure presented as an in-world outcome. Rework the player-facing behaviour: refund the roll (system-fault grace, the same seam as the `0.3.0` timeout refund), author no lasting mutations, and render the outcome visually distinct from in-world outcomes so it reads as a system hiccup, not narrative. Likely files: `src/engine/action/PipelineActionStateMachine.ts`, `src/engine/OutcomeRenderer.ts`, `src/discord/commands/action.ts` (presentation); the lead scouts the exact seams before handoff.

**Acceptance:**
- [/] A forced classify-stage throw produces: a refunded roll, no mutations, and an outcome that names itself a system failure with distinct visual treatment. _Code landed (`4c51334`) but shipped without a test and no live check was recorded — verify (test or forced live throw) before ticking._
- [x] The `TODO.md` closeout item and [[prompt-v13-roadmap]] §4's checkbox are ticked. (Reconciled 2026-07-09.)

**Scope fence:** the fallback's *routing* (typed path, when it fires) is already correct and stays; only the player-facing cost/refund/presentation changes.

## T1 — Welcome tag (roadmap item 1)

**Files:** `src/discord/commands/join.ts` (public announcement, ~`:199-211`).

**Deliverables:**
- The "✨ A new hero joins the Oak" `followUp` gains the owner mention: `<@discordId>` alongside the character name in the embed description, with `allowedMentions: { users: [] }` on the `followUp` so no ping fires (matches the `0.2.8` owner-identity treatment; pattern at `src/discord/commands/action.ts:238`).
- The announcement gains a components row with the 🌅 `Hi` button (`custom_id: 'nav:hi'`, secondary style); the existing `nav:hi` handler already spawns a per-clicker ephemeral on public messages (pattern at `src/discord/format.ts:224-234`).

**Acceptance:**
- [/] Live `/join` on the dev bot: the announcement shows the owner mention, no ping fires, and the `Hi` button opens the clicker's own ephemeral `/hi`. _Code landed (`068e96b`) but no live check was recorded — run it before ticking._
- [x] The `TODO.md` item "add /hi to 'A new hero joins the Oak' message" is ticked. (Reconciled 2026-07-09.)

**Scope fence:** the `/join` wizard's inline-skills formatting polish (a separate `TODO.md` item) is out; no other commands touched.

## T2 — `AnsiRenderer` + combat maths reveal (roadmap item 2)

Two deliverables; land as two commits (renderer first, consumer second) so the review can bite each separately.

### T2a — `AnsiRenderer`

**New module** (suggested `src/render/AnsiRenderer.ts`; the directory does not exist yet). Contract per [[mvp+ansi-art]] §2/§3/§5:

- Sources stay colour-free; colour is applied by role at render time. Role vocabulary: `chrome` (30), `threat` (31), `life` (32), `warmth` (33), `player` (34/36), `emphasis` (37), `panel` (bg 40), `surface` (bg 41/42).
- API sketch (the executor may refine names, not the shape):

```ts
type Role = 'chrome' | 'threat' | 'life' | 'warmth' | 'player' | 'emphasis';
interface CombatantLine { name: string; level?: number; hp: number; maxHp: number; }
interface FrameSpec {
  header: CombatantLine;          // enemy
  sprite?: string[];              // colour-free fragment lines
  floater?: string;               // e.g. "-12" / "+10"
  message?: string[];             // 2×26 message box budget
  footer?: CombatantLine;         // player
}
renderFrame(spec: FrameSpec): string;                  // returns a ```ansi fenced block
hpBar(hp: number, maxHp: number, width: number): string; // display clamped to [0, maxHp]
```

- Constraints, each covered by a unit test: source lines ≤ 30 chars pre-colour; rendered block < 2 000 chars incl. fences; `hpBar` clamps 0 / negative / over-max inputs; colour is never the sole carrier of meaning (symbols/prose duplicate it), so the monochrome mobile degrade stays readable.

### T2b — combat outcome rework

**Files:** `src/engine/OutcomeRenderer.ts` (dice line at `:153-173`, crit flag at `:153`); data source `src/engine/action/combat-dc.ts` (`playerRolled`, signed margin, severity bands, `enemyHpBefore/After`) which is **read-only** for this task — this is a rendering job, not a maths job.

**Deliverables:**
- Combat outcomes drop the ASCII scene art and render an `AnsiRenderer` frame instead: the dice line (roll vs DC, margin, severity), one HP-bar line per combatant on separate lines, and signed damage floaters from the HP deltas.
- Displayed HP clamped to `[0, max]` (B#6: no mid-resolution `-5 HP`), combatants never crammed onto one line (B#5).

**Acceptance:**
- [ ] A live combat beat on the dev bot shows roll vs DC + margin, both HP bars on separate lines, and a damage floater; no scene art. Desktop shows colour; phone shows clean monochrome.
- [ ] B#5 and B#6 are irreproducible.
- [ ] Frame stays < 2 000 chars incl. fences (prior measurements: 820–1 250).
- [ ] `TODO.md` ticks: F#7 "show the maths", the combat half of "drop ascii from action outcomes", and the B#5/B#6 rows.

**Scope fences (whole of T2):** no splash or block-letter fonts ([[mvp+ansi-art]] §4 stays deferred); no prompt-template changes; no broadcast plumbing (that is stage 2); non-combat outcomes keep their scene art.

## Stage exit

- [ ] All task acceptance boxes green; typecheck + suite green.
- [ ] Releases cut and changelog current per merge.
- [ ] Doc loop: this plan's boxes ticked; [[poc-plus-roadmap]]'s tracking list updated (stage 1 done); `TODO.md` rows struck; [[stage-5-live-cutover-plan]] archived; map of content updated.
- [ ] Recommend `/clear`, then resume with:

> Resuming the POC+ arc — parent tracking doc [[poc-plus-roadmap]], active plan [[poc-plus-stage-1-plan]]. Branch `<branch>`, last commit `<sha>`, `<Tn>` just completed; next is `<Tn+1>`. Before building: reconcile the docs' claimed state against the repo (checkboxes vs `git log`, tests green) and fix any drift first.
