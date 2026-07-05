---
title: "T5 — per-round combat beat logging + sim combat scenario + metrics: spec handoff"
status: shipped
domain: engine
phase: poc
tags: [combat, engine, pipeline, thread-c, stage-3, telemetry, sim, spec]
related: ["[[stage-3-combat-spine-plan]]", "[[prompt-v12-pipeline]]"]
---

# T5 — per-round combat beat logging + sim combat scenario + metrics · spec handoff

**Contract:** the final Stage-3 task. Make each combat round emit a structured **beat log** (the data that later settles the parked prose-critic trigger, [[prompt-v12-pipeline]] §D7), aggregate combat outcomes into **sim metrics**, and add a **sim combat scenario** that exercises win / floor+desperate-choice / cap-derive. **Read `docs/engine/stage-3-combat-spine-plan.md` Task 5 first** (the contract) plus its "Settled decisions" block (ratified — do not re-litigate). This spec fixes every implementation-level decision so you do not guess.

Pipeline-only. `machine.ts` / the live `PROMPT_VERSION` stay frozen. No prose-critic build (T5 only *logs* its data). No band/`enemyMaxHp` rebalance. No death mechanic.

## Grounding (verified against the code — anchors)

- `resolveCombatRound(...)` returns `CombatRoundOutcome { band, enemyHpDelta, playerHpDelta, playerD20, enemyD20, margin }` (`src/engine/action/combat-dc.ts:13-20, 90`). `CombatBand` is exported there (`:11`).
- The combat handler `handleCombatStep` (`src/engine/action/PipelineActionStateMachine.ts:294`) has FOUR beat-emitting paths, each of which fights exactly one round (rolls the contested pair at `:362-366`, applies the band at `:369`):
  1. **WIN** (`:377`) → `resolveCombat(..., 'success')` — terminal.
  2. **Floor/desperate-choice** (`:385-424`) → `resolved: false` with forced options + `mutations[]`; OR second-lethal-blow (`:426-430`) → `resolveCombat(..., 'failure')` — terminal.
  3. **Cap-derive** (`:435`) → `resolveCombat(..., capVerdict)` — terminal (this step DID roll + apply a band before deriving, so it is a fought round).
  4. **CONTINUE** (`:445-507`) → `resolved: false` with `nextDecision` + `mutations[]`.
- `resolveCombat` (`:515`) is the terminal path; it already holds `roundResult` + `cs` + `playerHpDelta` + `finalEnemyHp`, and builds `finalMutations` before returning the outcome.
- Non-resolved `PipelineStepResult` is `{ resolved: false; state; nextDecision; mutations? }` (`:87`). `ActionOutcome` (`src/engine/WorldEngine.ts:114`) already carries optional `hpZero?`/`isDivineIntervention?` — the additive-optional-field precedent to mirror.
- `SimResult` (`src/sim/types.ts:174`) carries `stageCalls?`/`relationsPersisted?` — populated only for pipeline runs in `runPipelineScenario` (`src/sim/driver.ts:245`) by reading engine/gateway state at scenario end. `PipelineSimEngine` (`src/sim/PipelineSimEngine.ts`) already exposes `getPersistedRelationCount()` (`:228`) and collects non-terminal `result.mutations` in `stepAction` (`:189-210`) and terminal `outcome` in `applyOutcome` (`:241`). This is the collection precedent to mirror.
- `summarize()` (`src/sim/metrics.ts:29`) copies `relationsPersisted` through onto `SimSummary` with an `undefined`-guarded spread (`:58`); `renderTable` prints it only when present (`:164`).

## Sub-step 1 — per-round combat beat logging (`combat-dc.ts` + `PipelineActionStateMachine.ts`)

### 1a. The beat-log type (`combat-dc.ts`, new export)

Add, colocated with `CombatRoundOutcome`:

```ts
/**
 * One combat round's telemetry beat — the data that later settles the parked prose-critic
 * trigger (prompt-v12-pipeline §D7): the trigger question is whether a "material-change-only"
 * heuristic collapses into "always" in combat. `materialMutationFired` is computed semantically
 * (did enemyHp/player-HP actually move, or loot drop) — NOT `ops.length > 0` — so the telemetry
 * can genuinely answer that, rather than being trivially true.
 */
export interface CombatBeatLog {
  /** 1-based in-fight round this beat fought (the floor beat + its last-stand retry can share a round number — see the machine note). */
  round: number;
  band: CombatBand;
  enemyHpBefore: number;
  enemyHpAfter: number;
  /** Signed player-HP delta the band applied this round (0 on clean/glanced). */
  playerHpDelta: number;
  /** Did a state-changing (narratable) mutation fire this beat? enemyHp always moves in combat, so this is expected ~always true — that IS the §D7 signal. */
  materialMutationFired: boolean;
  /** The mutation op `type` names emitted this beat, in emission order (e.g. ['set_relation', 'modify_health']). */
  ops: string[];
  /** Combat-round beat marker — distinct from a generic CONTINUE beat (which carries no combatBeat). */
  marker: 'combat_round';
  /** Set only on the beat where the once-per-day survive-at-1 floor fired (the desperate-choice beat). */
  floorSave?: boolean;
}
```

### 1b. Carry the beat on the step/outcome contracts (`PipelineActionStateMachine.ts` + `WorldEngine.ts`)

- Add `combatBeat?: CombatBeatLog` to the **non-resolved** `PipelineStepResult` variant (`:87`).
- Add `combatBeat?: CombatBeatLog` to `ActionOutcome` (`src/engine/WorldEngine.ts:114`), documented like `hpZero?` — legacy never sets it, only the pipeline combat spine does.

Import `CombatBeatLog` in the machine (from `./combat-dc.js`).

### 1c. Emit a beat on every fought round

A single helper keeps the four paths honest. Add a private method (or module helper) that builds a beat from the round data:

```ts
private buildCombatBeat(
  cs: CombatState,
  roundResult: CombatRoundOutcome,
  enemyHpAfter: number,
  ops: string[],
  opts: { floorSave?: boolean } = {},
): CombatBeatLog {
  const materialMutationFired =
    roundResult.enemyHpDelta !== 0 || roundResult.playerHpDelta !== 0 || ops.some(o => o !== 'set_relation');
  return {
    round: cs.round,
    band: roundResult.band,
    enemyHpBefore: cs.enemyHp,
    enemyHpAfter,
    playerHpDelta: roundResult.playerHpDelta,
    materialMutationFired,
    ops,
    marker: 'combat_round',
    ...(opts.floorSave ? { floorSave: true } : {}),
  };
}
```

Note on `materialMutationFired`: `set_relation` alone (a round-counter-only bump) is bookkeeping, not material; enemyHp/player-HP deltas and any loot op ARE material. Compute from the semantic deltas + presence of a non-`set_relation` op, so the field means "something narratable changed", not "an op fired".

Wire it into each path, using the **ops actually emitted** by that path:

- **CONTINUE (`:497-507`):** `ops` = the returned `mutations[]` types (`['set_relation', ...(playerHpDelta < 0 ? ['modify_health'] : [])]`). `enemyHpAfter` = `newEnemyHp`. Attach the beat as `combatBeat` on the returned non-resolved result.
- **Desperate-choice (`:415-424`):** `ops` = the returned `mutations[]` types (`['modify_health', 'set_relation', 'set_relation']`). `enemyHpAfter` = `newEnemyHp`. Pass `{ floorSave: true }`. Attach as `combatBeat` on the returned non-resolved result.
- **Terminal via `resolveCombat` (WIN / second-lethal failure / cap-derive):** build the beat INSIDE `resolveCombat` after `finalMutations` is assembled. `ops` = `finalMutations.map(m => m.type)` (or `mutations` including the wage append — use the same list the outcome reports, `mutations.map(m => m.type)`). `enemyHpAfter` = `Math.max(0, finalEnemyHp)`. Attach as `combatBeat` on the resolved `outcome`.

Do NOT emit a beat on the generic bail path (`step():196-221`) — a voluntary flee / bail-bloodied is a choice, not a fought round; the round that preceded it already emitted its beat.

**Round-numbering caveat (document it in a code comment):** the floor beat persists `combatRoundUpdate(cs, ..., cs.round)` (same round number), so the floor beat and the subsequent last-stand beat can share a `round` value. This is intended — `round` is the in-fight round label; "rounds fought" is the beat COUNT, not the max round.

## Sub-step 2 — combat metrics (`src/sim/{types.ts,PipelineSimEngine.ts,metrics.ts}`)

### 2a. `types.ts` — the aggregate + the SimResult field

```ts
/** Scenario-level combat aggregates (T5). Pipeline-only, mirroring stageCalls/relationsPersisted. */
export interface CombatMetrics {
  /** Total combat rounds fought across the scenario (one per emitted combatBeat). */
  roundsFought: number;
  /** Rounds where the once-per-day survive-at-1 floor fired. */
  floorSaves: number;
  /** Combat fights resolved as a win (terminal combat beat, outcome 'success'). */
  wins: number;
  /** Combat fights resolved as a loss (terminal combat beat, outcome 'failure'). */
  losses: number;
}
```

Add to `SimResult`: `combatMetrics?: CombatMetrics;` — documented as pipeline-only (`undefined` for legacy runs), like `relationsPersisted?`.

### 2b. `PipelineSimEngine.ts` — accumulate + expose

- Private fields: `private combatBeats: CombatBeatLog[] = [];` and `private combatWins = 0; private combatLosses = 0;` (import `CombatBeatLog` from the engine combat-dc module).
- In `stepAction` non-resolved branch (near the `result.mutations` handling, `:189`): `if (result.combatBeat) this.combatBeats.push(result.combatBeat);`
- In `applyOutcome` (`:241`): `if (outcome.combatBeat) { this.combatBeats.push(outcome.combatBeat); if (outcome.outcome === 'success') this.combatWins++; else if (outcome.outcome === 'failure') this.combatLosses++; }`. (A bailed combat has no `combatBeat` on its outcome, so it counts as neither — correct.)
- New public method mirroring `getPersistedRelationCount`:
```ts
getCombatMetrics(): CombatMetrics {
  return {
    roundsFought: this.combatBeats.length,
    floorSaves: this.combatBeats.filter(b => b.floorSave).length,
    wins: this.combatWins,
    losses: this.combatLosses,
  };
}
```
Rationale for collecting at BOTH sites (not just the outcome): a bailed/fled fight resolves via the generic bail path whose outcome carries no `combatBeat`, so its earlier fought rounds would be lost if we only read the terminal outcome. Per-beat collection captures every fought round regardless of how the fight ends.

### 2c. `driver.ts` — attach at scenario end

In `runPipelineScenario` (`:245`), add `combatMetrics: engine.getCombatMetrics()` to the returned `SimResult` (alongside `stageCalls`/`relationsPersisted`). No change to the legacy `runScenario` body.

### 2d. `metrics.ts` — surface on the summary + table

- Add `combatMetrics?: CombatMetrics;` to `SimSummary`, copied through in `summarize` with an `undefined`-guarded spread (mirror the `relationsPersisted` line at `:58`).
- In `renderTable`, when `s.combatMetrics` is present, append lines (e.g. `Combat rounds:  N`, `Floor-saves:    N`, `Wins/Losses:    W/L`). Keep legacy output byte-for-byte unchanged (only emit when present), matching the `relationsPersisted` guard.

## Sub-step 3 — sim combat scenario (`src/sim/combat-scenario.ts`, new)

A new module exporting THREE standalone `Scenario` builders (not one multi-fight scenario — the pipeline sim carries HP across turns with no regen, so a low-HP floor fight can't cleanly share a scenario with a full-HP win). Each drives ONE fight through the real `runScenario` code path. Model the `PipelineScript` + roll sequences on the EXISTING T3 tests in `tests/sim/pipeline-sim.test.ts` (they are already-proven recipes — reuse them, do not invent new band math):

1. **`combatWinScenario`** — full-HP warrior (physical 5, health 10), `baseDc 12`, roll sequence `[20, 1, 20, 1]` (two clean crits → enemyMaxHp 12 depletes in 2 rounds). choicePolicy `first-real`. Expected `combatMetrics`: `{ roundsFought: 2, floorSaves: 0, wins: 1, losses: 0 }`, turn outcome `success`.
2. **`combatFloorScenario`** — low-HP char (health 2, maxHealth 10), `baseDc 12`, roll sequence `[1, 10, 1, 10]`: round 1 heavy → floor fires (player→1 HP, save set, desperate-choice beat), `first-real` picks `Last stand`, round 2 heavy again → second lethal blow same day → `failure` + `hpZero`. Expected `combatMetrics`: `{ roundsFought: 2, floorSaves: 1, wins: 0, losses: 1 }`, turn outcome `failure`. (This deliberately exercises floor + desperate-choice + the loss path in one fight.)
3. **`combatCapScenario`** — high-HP char (physical 2 so `playerBonus 2 == enemyBonus clamp(12-10,0,10) 2` → margin 0 → `trade` every round; health 20, maxHealth 20), `baseDc 12`, roll sequence `[8,8,8,8,8,8,8,8,8,8]` (4 fought + 1 cap-derive step). choicePolicy `first-real`. The cap-derive step ALSO fights its round before deriving, so the fractions are taken post-5th-round: enemyHp 12→2, playerHp 20→10; `playerFrac 0.5 ≥ enemyFrac ≈0.167` → `success`. Expected `combatMetrics`: `{ roundsFought: 5, floorSaves: 0, wins: 1, losses: 0 }`, turn outcome `success`. (NB: `abilityCheckBonus` is a raw stat pass-through, not halved — physical 15 would force `clean` and win by round 2, never reaching the cap.)

Each builder returns a fully-formed `Scenario` (`machine: 'pipeline'`, `llm: { kind: 'pipeline-scripted', script }`). Keep the scripts minimal (the T3 `combatScript()` shape: `combatEnemy` on `callNo === 0`, a single `Press the attack`/`Fight` real option, trivial loot + narrate).

## Tests

Add a new `describe('T5 — combat telemetry + metrics')` block. Prefer the new scenario file driven through `runScenario` for the end-to-end assertions; use direct-engine tests (the `buildSimEngine(...)` handle pattern already in the file) only where you need to inspect a single `combatBeat` on a step/outcome result.

- **Beat shape (unit / direct-engine):** a CONTINUE beat carries `combatBeat` with `marker: 'combat_round'`, correct `round`/`band`/`enemyHpBefore`/`enemyHpAfter`/`ops`, `materialMutationFired: true`, no `floorSave`. A generic non-combat continue carries NO `combatBeat`.
- **Floor beat:** the desperate-choice beat's `combatBeat.floorSave === true`.
- **Terminal beat:** the resolved win/loss/cap outcome carries `combatBeat` with the right `band`/`enemyHpAfter` (0 on a win).
- **Bail emits no terminal beat:** a voluntary `Flee the fight` / `Bail bloodied` outcome has `combatBeat === undefined`, and the fought round(s) before it are still counted in `roundsFought`.
- **Scenario metrics (end-to-end via `runScenario`):** each of the three scenarios yields the exact `combatMetrics` above, and `summarize(result).combatMetrics` equals `result.combatMetrics`.
- **Legacy unchanged:** a legacy scenario's `SimResult.combatMetrics` is `undefined` and its `renderTable` output is unchanged (no combat lines).

## Scope fence — do NOT

- Touch `machine.ts`, the live `PROMPT_VERSION`, or prod `startAction`/`applyResolution`.
- Build the prose critic, or add any critic gating/trigger logic — T5 only LOGS the data.
- Rebalance the band table, `enemyMaxHp` derivation, or `MAX_COMBAT_ROUNDS`.
- Add a death mechanic / HP-0 consequence (the `hpZero` marker already exists; leave it).
- Change the generic (non-combat) beat flow, the bail path's behaviour, or any Stage 2 relation logic.
- Edit prompt templates under `assets/prompts/` (this task touches none).

## Verification (run before returning; report exact counts)

```bash
npm run typecheck        # must be clean
npm test -- --run        # baseline 1139 passing → must be 1139 + your new tests, 0 failures
```

Report: typecheck result, total test count + pass/fail, the new test names, and the three scenarios' observed `combatMetrics`.
