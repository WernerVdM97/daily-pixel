---
title: "T3 iteration 2 — floor + loss ladder: spec handoff"
status: shipped
domain: engine
superseded_by: "implemented in code"
phase: poc
tags: [combat, engine, pipeline, thread-c, stage-3, floor, spec]
related: ["[[stage-3-combat-spine-plan]]", "[[prompt-v12-combat]]"]
---

# T3 iteration 2 — floor + loss ladder (spec handoff)

**Contract:** implement the once-per-day survive-at-1 floor, forced desperate-choice beat,
loss termination, and `hpZero` marker per the Stage 3 plan's T3 iteration 2. **Read
`docs/engine/stage-3-combat-spine-plan.md` first** (the ratified decisions block + T3 design
settled block). Then read the files listed below for grounding.

## Grounding reads

1. `src/engine/action/PipelineActionStateMachine.ts` — the machine, especially `handleCombatStep`
   (the combat sub-mode handler) and `resolveCombat` (terminal combat beat).
2. `src/engine/action/combat-state.ts` — `readCombatSave`, `combatSaveUpdate`, `readCombatState`.
3. `src/engine/action/pipeline-context.ts` — `getCurrentDay` (already on `PipelineContextResolver`).
4. `src/sim/PipelineSimEngine.ts` — `currentDay` field, `getCurrentDay` resolver wiring.
5. `src/engine/WorldEngine.ts` — `ActionOutcome` (already has `hpZero?: boolean`).
6. `tests/sim/pipeline-sim.test.ts` — the existing T3 iteration 1 tests (the `describe('T3 iteration 1 — combat round-loop core')` block). **Do not modify these tests.**
7. `src/engine/action/combat-dc.ts` — constants (handy for test assertions: `ENEMY_HP_MIN`, etc).

## What needs to change

### 1. `PipelineActionStateMachine.ts` — `handleCombatStep`

The `hpZeroReached` branch (currently resolves to `failure` immediately) must be replaced with
the floor + save ladder. The whole `if (hpZeroReached)` block becomes:

```
if (hpZeroReached) {
  const currentDay = this.resolver.getCurrentDay?.() ?? 0;
  const savedDay = readCombatSave(context.sceneState ?? []);
  if (savedDay === null || savedDay !== currentDay) {
    // ── Desperate-choice beat (first lethal blow today) ──
    // Clamp player to 1 HP. Author the combat_save edge.
    // Present forced options: bail bloodied / last stand.
    // Do NOT advance the round number.
    // ... (see below for full structure)
  } else {
    // ── Second lethal blow today → HP-zero, resolve failure ──
    // Player HP floor at 0. No save edge written (already spent).
    return this.resolveComfight(...verdict 'failure', hpZero: true);
  }
}
```

**Desperate-choice beat structure:**

The desperate-choice is an **engine-authored decision** — no LLM decide() call. Return
`resolved: false` with forced options and the floor mutations already applied in the
non-terminal mutations slot.

```
// Mutations to persist before the desperate-choice is presented:
// 1. modify_health with amount that floors player at 1 (not the full deadly delta)
// 2. combat_save edge (set_relation)
// 3. set_relation for combat state (same enemyHp, same round — no advancement)
const floorPlayerHpDelta = 1 - char.health; // brings player to exactly 1
const saveRelation = combatSaveUpdate(currentDay);
const combatEdgeSameRound = combatRoundUpdate(cs, 0, cs.round);
// The round's band delta was already applied to newEnemyHp above — the enemy still took
// its hits this round, so the combat edge reflects that band-depleted enemyHp, not the
// player's lethal delta (which is floored separately).
```

**On the lethal blow:**
- `enemyHp` still gets its band delta (the round happened)
- Player HP goes to 1 (instead of the lethal delta)
- The `combat_save` edge is written
- Return forced options `bail bloodied` / `last stand`
- Include mutations: the `combat_save` `set_relation`, the combat `set_relation` (with
  enemyHp set to the band-depleted value, round at current)
- Player HP floor (1) is applied via the same `modify_health` injection in the mutations

So the scene-state edge for combat stays at the band-depleted enemyHp. Round does NOT
advance (player hasn't survived the round yet in a way that advances the fight).

**Tracking the desperate-choice state.** Add `desperateChoice?: boolean` to
`PipelineInternalActionState`. Set it on the returned `nextState` when entering the
desperate-choice sub-mode. Clear it when the player makes their choice.

**On the next `step()` call** (state has `desperateChoice === true`):
- `bail bloodied`: route to bail path (same as existing bail, but with combat edge left
  persisted — do NOT clear the in_combat edge). Player HP already at 1 (from the floor
  mutations already persisted in the previous step's non-terminal mutations). Resolve with
  outcome `'bailed'`.
- `last stand`: clear `desperateChoice`, and **fall through to the normal combat continue
  flow** (contested roll, band, etc). The player starts this round at 1 HP.

The check for `desperateChoice` goes at the **top** of `handleCombatStep`, before the
establish-or-read combat state block.

### 2. `PipelineActionStateMachine.ts` — `handleCombatStep` loss ladder

After the desperate-choice section, the existing `if (hpZeroReached)` block is replaced by
the two cases above. The existing `hpZeroReached` detection line stays the same but now
points to the new ladder instead of the old single `resolveCombat(…, 'failure')`.

### 3. `PipelineActionStateMachine.ts` — `resolveCombat`

When resolving with `hpZero === true` (second lethal blow), the method already sets
`hpZero` on the outcome via the existing `hpZero` field in `resolveCombat`. Verify this
path sets `hpZero: true` correctly when the ladder sends it. No change needed beyond
the existing code — just make sure the call site passes the right verdict.

### 4. `PipelineActionStateMachine.ts` — `PipelineInternalActionState`

Add `desperateChoice?: boolean`.

### 5. Tests (`tests/sim/pipeline-sim.test.ts`)

Add a new `describe('T3 iteration 2 — floor + loss ladder')` block with these tests:

**a) First lethal blow triggers desperate-choice beat (not immediate failure)**

Script a combat where player HP is low (e.g. 2 HP). The blow would drop them to ≤0.
Assert the turn is NOT resolved — `stepAction` returns `resolved: false` with forced
options `bail bloodied` and `last stand`.

**b) `bail bloodied` resolves combat as bail with enemy edge persisted**

Start from the desperate-choice state. Pick `bail bloodied`. Assert outcome is `'bailed'`.
Assert the in_combat edge is still persisted (relationsPersisted > 0).

**c) `last stand` continues combat with player at 1 HP**

Start from the desperate-choice state. Pick `last stand`. Assert combat continues
(resolved: false). Assert player HP is 1 after the step.

**d) Second lethal blow the same day resolves failure with hpZero**

Simulate a combat where the save fires (desperate-choice), then `last stand`, then
another lethal blow the same day. Assert resolves with `failure` and `hpZero: true`.

**e) A new day resets the save**

Advance the engine's `currentDay`. The next lethal blow should again trigger the
desperate-choice rather than immediate failure.

**f) (Edge case) `getCurrentDay` absent → the floor degrades to per-encounter**

When the resolver has no `getCurrentDay`, `currentDay` defaults to 0. The first lethal
blow finds no `combat_save` edge (`savedDay === null`), so the floor still fires once,
writing `combat_save` with `savedDay = 0`. A second lethal blow within the same
encounter then finds `savedDay(0) === currentDay(0)` and resolves as failure. This is
the documented degradation: without a real day source, the once-per-day floor degrades
to once-per-encounter.

## Scope fence (do NOT touch)

- Do NOT touch `machine.ts`, the live `PROMPT_VERSION`, or any v11 path (decision 1).
- Do NOT touch `combat-dc.ts` or `combat-state.ts` — pure model stays unchanged.
- Do NOT touch the existing iteration 1 tests.
- Do NOT add a death mechanic (greenfield, out of scope) — the floor + `hpZero` marker only.
- Do NOT add any `delete_relation` op (doesn't exist yet — out of scope).

## Verification

Before returning, run:
```
npx vitest run tests/sim/pipeline-sim.test.ts
npm run typecheck
```

Baseline: **existing tests must all pass** (the iteration 1 tests use a high-HP char so the
floor is never triggered). The 6 new tests must pass.

## Deliverables

- `src/engine/action/PipelineActionStateMachine.ts` — modified `handleCombatStep`, `resolveCombat`,
  `PipelineInternalActionState` with `desperateChoice`.
- `tests/sim/pipeline-sim.test.ts` — new `describe('T3 iteration 2 — floor + loss ladder')` block.
