// T5 — sim combat scenarios. Three standalone Scenario builders (not one multi-fight scenario):
// the pipeline sim carries HP across turns with no regen, so a low-HP floor fight can't cleanly
// share a scenario with a full-HP win. Each drives ONE fight through the real `runScenario` code
// path. Roll sequences/character shapes are lifted from the proven T3 recipes in
// tests/sim/pipeline-sim.test.ts (T3 iteration 1/2), not invented band math.
import type { CharacterSeed, PipelineScript, Scenario } from './types.js';

const BASE_CHARACTER: CharacterSeed = {
  class: 'Warrior',
  stats: { physical: 5, wisdom: 0, intelligence: 0, charisma: 0 },
  health: 10,
  maxHealth: 10,
  stamina: 10,
  maxStamina: 10,
  wealth: 0,
  location: "The Warden's Oak",
  alignment: 'lawful good',
  dayJob: 'Blacksmith',
};

/** Minimal combat script (T3 `combatScript()` shape): `combatEnemy` on the first decide() call,
 *  a single real option, trivial loot + narrate. */
function combatScript(baseDc: number): PipelineScript {
  return {
    decide: (_input, callNo) => ({
      distilledType: 'combat',
      stat: 'physical',
      baseDc,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      ...(callNo === 0 ? { combatEnemy: { name: 'Goblin', anchor: 'location' as const } } : {}),
    }),
    resolveMutate: () => ({ mutations: [{ type: 'modify_wealth', amount: 1 }] }),
    resolveNarrate: () => ({ outcomeText: 'The goblin falls.' }),
  };
}

/**
 * Full-HP warrior, two clean crits (nat-20 forces `clean` regardless of margin, amplified by
 * `CRIT_AMPLIFY_BONUS`): enemyMaxHp 12 depletes in 2 rounds (-8, -8). Exercises the WIN
 * termination path. Expected `combatMetrics`: `{ roundsFought: 2, floorSaves: 0, wins: 1, losses: 0 }`,
 * turn outcome `success`.
 */
export const combatWinScenario: Scenario = {
  name: 'combat-win',
  character: BASE_CHARACTER,
  rollSource: { kind: 'sequence', values: [20, 1, 20, 1] },
  llm: { kind: 'pipeline-scripted', script: combatScript(12) },
  machine: 'pipeline',
  week: [[{ input: 'attack the goblin', choicePolicy: 'first-real' }]],
};

/**
 * Low-HP char (health 2, maxHealth 10). Round 1 heavy band (nat-1 forces `heavy`, amplified)
 * floors the player to 1 HP and fires the once-per-day survive-at-1 save (the desperate-choice
 * beat, `floorSave: true`); `first-real` picks `Last stand`. Round 2 heavy again is a second
 * lethal blow the same day → `failure` + `hpZero`. Deliberately exercises floor + desperate-choice
 * + the loss path in one fight. Expected `combatMetrics`:
 * `{ roundsFought: 2, floorSaves: 1, wins: 0, losses: 1 }`, turn outcome `failure`.
 */
export const combatFloorScenario: Scenario = {
  name: 'combat-floor',
  character: { ...BASE_CHARACTER, health: 2, maxHealth: 10 },
  rollSource: { kind: 'sequence', values: [1, 10, 1, 10] },
  llm: { kind: 'pipeline-scripted', script: combatScript(12) },
  machine: 'pipeline',
  week: [[{ input: 'attack the goblin', choicePolicy: 'first-real' }]],
};

/**
 * High-stat char, equal-margin rolls trade every round (no crit, margin 0 lands in the `trade`
 * band): enemyHp 12→4 and playerHp 20→12 across 4 continued rounds, then the 5th call's own
 * round is ALSO fought (cs.round now exceeds `MAX_COMBAT_ROUNDS`, so this step derives the
 * verdict from HP fractions instead of continuing) — 5 fought rounds total, the last being the
 * cap-derive step. `playerFraction` (0.5) >= `enemyFraction` (~0.167) → `success`.
 *
 * DEVIATION FROM SPEC: the spec's prose describes this build as "physical 15 → bonus +2", but
 * `abilityCheckBonus` (dc.ts) is a raw stat pass-through (no D&D-style halving) — physical 15
 * yields playerBonus 15, which forces every round into the `clean` band (margin 13) and wins
 * outright in round 2, never reaching the cap-derive branch this scenario exists to exercise.
 * `physical: 2` (matching `enemyBonus = clamp(baseDc - 10, 0, 10) = 2` for baseDc 12) is the
 * value that actually produces the "trade every round" cap-derive path the spec's expected
 * `combatMetrics` describes; verified directly against the engine (5 fought rounds, cap-derive
 * verdict `success`) before locking in these numbers. Expected `combatMetrics`:
 * `{ roundsFought: 5, floorSaves: 0, wins: 1, losses: 0 }`, turn outcome `success`.
 */
export const combatCapScenario: Scenario = {
  name: 'combat-cap',
  character: {
    ...BASE_CHARACTER,
    stats: { physical: 2, wisdom: 0, intelligence: 0, charisma: 0 },
    health: 20,
    maxHealth: 20,
  },
  rollSource: { kind: 'sequence', values: [8, 8, 8, 8, 8, 8, 8, 8, 8, 8] },
  llm: { kind: 'pipeline-scripted', script: combatScript(12) },
  machine: 'pipeline',
  week: [[{ input: 'attack the goblin', choicePolicy: 'first-real' }]],
};
