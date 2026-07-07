---
title: "T3 follow-up — voluntary mid-combat bail (flee at a cost): spec handoff"
status: shipped
domain: engine
superseded_by: "implemented in code"
phase: poc
tags: [combat, engine, pipeline, thread-c, stage-3, bail, spec]
related: ["[[stage-3-combat-spine-plan]]", "[[prompt-v12-combat]]"]
---

# T3 follow-up — voluntary mid-combat bail (flee at a cost) · spec handoff

**Contract:** make an engaged combat fight offer the player a voluntary "flee at a cost" option on every continuation round, closing the gap between the as-built T3 machine (no voluntary combat bail) and the ratified design. **Read `docs/engine/stage-3-combat-spine-plan.md` first** — decision 4 (a bailed enemy is remembered at its anchor) and the termination-ladder item 3 ("player bail → existing bail path, `-BAIL_STAMINA_COST` stamina, enemy edge left persisted at current `enemyHp`"). Also see `docs/game/prompt-v12-combat.md` §C-a rule 4 ("`required: true` throughout — no clean Skip, only Bail (flee, at a cost)").

## The gap (verified against the code)

- `ensureBail(options, required)` (`src/engine/action/PipelineActionStateMachine.ts:767`) returns options unchanged when `required === true`. Combat is always `required: true`, so combat beats currently get NO bail option.
- The only bail in combat today is the once-per-day desperate-choice beat's `Bail bloodied` (`:396`).
- The generic bail path in `step()` (`:191`, `option.dcModifier === null`) fires BEFORE the combat sub-mode gate (`:236`) and already does the right thing: returns `resolved: true`, `outcome: 'bailed'`, `mutations: [modify_stamina -BAIL_STAMINA_COST]`. It does NOT clear the `in_combat` edge — so if the edge was persisted by the prior round, the enemy is remembered. **No change to the bail path is needed.**

## Design — settled (do not re-derive)

1. **Scope: combat CONTINUATION beats only (round 2+).** Append a voluntary flee option to the next-round decision built in `handleCombatStep`'s CONTINUE path (the `nextDecision = toActionDecision(...)` at `:472`). The enemy edge for the round is persisted via that path's returned `mutations[]` (the `set_relation` at `:488`), which `PipelineSimEngine` applies before presenting the beat — so a subsequent flee leaves the enemy remembered at the current `enemyHp`. This exactly matches ladder item 3.
2. **The FIRST combat beat (round 1) does NOT get a flee option.** Round 1 is the forced reaction to the threat; no `in_combat` edge is established until `handleCombatStep` runs, so there is no enemy to leave behind. This keeps the existing test `tests/engine/pipeline-machine.test.ts:249` ("never adds a bail option to a required action's first decision") green. Do NOT touch `start()`.
3. **Reuse the existing bail path unchanged.** When the player picks the flee option, `step():191` handles it. Do not add a combat-specific bail branch. (Combat-flavoured flee `outcomeText` is an accepted deferral — the generic "You step back… catching your breath" is acceptable.)
4. **The desperate-choice beat's `Bail bloodied` is unchanged.**

## Implementation

**`src/engine/action/PipelineActionStateMachine.ts` — CONTINUE path only (~`:472`).** After building `nextDecision`, append a flee option unless one already exists (mirror `ensureBail`'s `.some(o => o.dcModifier === null)` dedupe guard, defensive):

```ts
const nextDecision = toActionDecision(decideResult, state.required);
// Engaged combat offers a voluntary flee (dcModifier: null) each round — caught by step()'s
// bail path, which leaves the in_combat edge persisted (enemy remembered, plan decision 4).
// ensureBail can't add it (returns early for required), so append here.
if (!nextDecision.options.some(o => o.dcModifier === null)) {
  nextDecision.options = [...nextDecision.options, { label: 'Flee the fight', dcModifier: null }];
}
```

Match the surrounding style; keep the comment to the genuine rationale (why here, not in `ensureBail`). Do not mutate a shared object in a way that leaks — `toActionDecision` returns a fresh object each call, so reassigning `.options` is safe; confirm that.

**`assets/prompts/decision-prompts/v12/decide/combat.md` — Rule 3, one-line accuracy note.** The engine now appends the flee option on engaged rounds, so make the prompt truthful: add a brief clause that the engine offers a flee option each engaged round (the model still must never author a bail/retreat option itself, per BASE Rule 3). Do not otherwise rewrite Rule 3. Keep the existing lint anchors intact (`## COMBAT-SPECIFIC RULES`, the `not.toMatch(/every 3rd or 4th/i)` guard, `/danger follows location/i`).

## Tests — `tests/sim/pipeline-sim.test.ts`, in the `describe('T3 iteration 1 — combat round-loop core')` or a new sibling `describe`

Mirror the harness used by the existing combat tests: `buildSimEngine(rollSource, …, { machine: 'pipeline', script, seed })`, `engine.startAction`, `engine.stepAction`, `engine.getPersistedRelationCount()`, `engine.getCharacter('sim:pipeline')?.health|stamina`. Use a high-HP seed so no floor fires (see `BASE_CHARACTER` / the multi-round test at `:546`), and a `rollSource` sequence that produces a non-terminal round (enemy survives, player survives — e.g. a `trade`/`glanced` band) so a round-2 continuation beat is presented.

1. **A combat continuation beat offers a `Flee the fight` option.** Drive `startAction` → `stepAction(round-1 real option)`; assert the returned round-2 decision's options contain one with `dcModifier === null` labelled `Flee the fight`, alongside the scripted real option(s).
2. **Picking `Flee the fight` mid-combat bails, costs stamina, and leaves the enemy remembered.** From the round-2 beat, `stepAction(1, 'Flee the fight')` → `resolved: true`, `outcome.outcome === 'bailed'`; assert stamina dropped by `BAIL_STAMINA_COST` (1); assert `getPersistedRelationCount() >= 1` AND the persisted `in_combat` edge's `enemyHp` equals the round-1-depleted value (enemy remembered at current HP, not reset/cleared). Mirror the edge-persistence assertion style at `:786-809`.
3. **The first combat beat has NO flee option (round 1 is the forced reaction).** Assert the decision returned by `startAction` for a combat action has no option with `dcModifier === null`. Locks the scope decision.

## Scope fence — do NOT

- Do NOT touch `start()`, `ensureBail`, or the generic bail path (`:191`). Round 1 stays flee-less; the bail path is reused as-is.
- Do NOT add a combat-specific `outcomeText` or bail branch.
- Do NOT change the desperate-choice beat, the band math, `resolveCombat`, or any combat termination logic.
- Do NOT touch non-combat decide/resolve templates, `prompt-builder.ts`, or `PROMPT_SET_VERSION`.
- Do NOT alter existing combat tests' expectations (they use `choicePolicy: 'first-real'`, which skips the null-dcModifier flee option, so they must stay green untouched).

## Prod-wiring caveats (for whoever promotes the pipeline off the sim)

The "enemy remembered" guarantee depends on ordering that only `PipelineSimEngine` currently enforces, and the flee is the first synchronous-resolving option in combat. Two things the eventual Discord-wired caller must preserve (flagged in the T3-followup review; not fixable in this sim-only slice):

- **Persist round *N*'s `in_combat` `set_relation` mutation before presenting (or accepting a flee on) round *N+1*.** `PipelineSimEngine.stepAction` applies non-terminal `PipelineStepResult.mutations` synchronously before returning; a caller that persists asynchronously/fire-and-forget could accept a flee before the edge lands and forget the enemy (breaks plan decision 4). No machine-contract type obliges this yet.
- **Serialise `step()` per action.** The flee resolves synchronously via the generic bail path (no `await`), unlike a normal combat round (which awaits `decide()`). A concurrent double-submit on the same pending action could let a slow in-flight round resurrect an already-bailed action. Single-flight per action is assumed.

## Verification (run before returning; report exact numbers)

```bash
npx vitest run tests/sim/pipeline-sim.test.ts        # existing combat tests + your 3 new ones green
npm run typecheck                                     # clean
npm test -- --run                                     # full suite green — baseline 1135 passing (grows by your new tests)
```

Report: the machine diff (the appended flee option), the one-line combat.md note, the new tests, and exact pass counts. Confirm no existing combat test needed changing.
