/**
 * Sim harness Task 1 — `runScenario` drives the real WorldEngineImpl (in-memory DB, no
 * network) through a scripted character. See docs/engine/stage-0a-sim-harness-plan.md.
 */
import { describe, it, expect } from 'vitest';
import { runScenario } from '../../src/sim/driver.js';
import { DIVINE_INTERVENTION_TYPE } from '../../src/llm/FallbackLlmGateway.js';
import type { CharacterSeed, DecisionScript, Scenario } from '../../src/sim/types.js';

const BASE_CHARACTER: CharacterSeed = {
  class: 'Warrior',
  stats: { physical: 0, wisdom: 0, intelligence: 0, charisma: 0 },
  health: 10,
  maxHealth: 10,
  stamina: 10,
  maxStamina: 10,
  wealth: 0,
  location: "The Warden's Oak",
  alignment: 'lawful good',
  dayJob: 'Blacksmith',
};

/** Presents a real choice on an action's first beat, then resolves on the next — mirroring
 *  the firstDecision/resolveDecision pair in tests/engine/decision-pipeline.test.ts. Keyed
 *  off `previousDecisions` (reset per action) rather than `callNo`, so it works unchanged
 *  across any number of turns. */
function huntScript(): DecisionScript {
  return (ctx) => {
    if (!ctx.previousDecisions || ctx.previousDecisions.length === 0) {
      return {
        prompt: 'A wolf circles in the gloom.',
        distilledType: 'hunt',
        stat: 'physical',
        baseDc: 12,
        required: false,
        done: false,
        decision: [
          { label: 'Press the attack', dcModifier: 0 },
          { label: 'Circle around', dcModifier: 1 },
          { label: 'Bail', dcModifier: null },
        ],
      };
    }
    return {
      prompt: '',
      distilledType: 'hunt',
      stat: 'physical',
      baseDc: 12,
      required: false,
      done: true,
      decision: [{ label: 'Finish it', dcModifier: 0 }],
      mutations: [
        { type: 'add_item', name: 'Wolf Pelt', emoji: '🐺', stat: 'wisdom', modifier: 1, quantity: 1 },
        { type: 'modify_wealth', amount: 5 },
      ],
      outcomeText: 'Your blade finds its mark.',
    };
  };
}

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    name: 'test-scenario',
    character: BASE_CHARACTER,
    rollSource: { kind: 'fixed', value: 20 },
    llm: { kind: 'scripted', script: huntScript() },
    turns: [
      { input: 'hunt a wolf', choicePolicy: 'first-real' },
      { input: 'hunt a wolf', choicePolicy: 'first-real' },
      { input: 'hunt a wolf', choicePolicy: 'first-real' },
    ],
    ...overrides,
  };
}

describe('sim driver — runScenario', () => {
  it('drives a >=3-turn scenario to completion using the real WorldEngineImpl', async () => {
    const result = await runScenario(makeScenario());

    expect(result.scenario).toBe('test-scenario');
    expect(result.turns).toHaveLength(3);
    for (const turn of result.turns) {
      expect(turn.outcome).toBe('success');
      expect(turn.distilledType).toBe('hunt');
    }
  });

  it('rollSource fully determines the outcome — fixed 20 always succeeds', async () => {
    const result = await runScenario(
      makeScenario({
        rollSource: { kind: 'fixed', value: 20 },
        turns: [{ input: 'hunt a wolf', choicePolicy: 'first-real' }],
      }),
    );

    expect(result.turns[0].outcome).toBe('success');
    expect(result.turns[0].playerRolled).toBe(20);
  });

  it('rollSource fully determines the outcome — fixed 1 always fails', async () => {
    const result = await runScenario(
      makeScenario({
        rollSource: { kind: 'fixed', value: 1 },
        turns: [{ input: 'hunt a wolf', choicePolicy: 'first-real' }],
      }),
    );

    expect(result.turns[0].outcome).toBe('failure');
    expect(result.turns[0].playerRolled).toBe(1);
  });

  it('never triggers the divine-intervention fallback — a scripted gateway always returns a valid decision', async () => {
    const result = await runScenario(makeScenario());

    for (const turn of result.turns) {
      expect(turn.distilledType).not.toBe(DIVINE_INTERVENTION_TYPE);
    }
  });

  it('each TurnTrace reflects post-resolution character state read back via getCharacter/getItems', async () => {
    const result = await runScenario(
      makeScenario({ turns: [{ input: 'hunt a wolf', choicePolicy: 'first-real' }] }),
    );
    const turn = result.turns[0];

    expect(turn.wealth).toBe(5); // starting wealth 0 + modify_wealth +5
    expect(turn.itemCount).toBe(1); // Wolf Pelt granted
    expect(turn.mutationsApplied).toBe(2); // add_item + modify_wealth
    expect(turn.rollsRemaining).toBe(2); // 3 starting rolls - 1 drained
  });

  it('a "bail" choicePolicy retreats from the first real decision instead of pressing on', async () => {
    const result = await runScenario(
      makeScenario({
        rollSource: { kind: 'fixed', value: 20 },
        turns: [{ input: 'hunt a wolf', choicePolicy: 'bail' }],
      }),
    );

    expect(result.turns[0].outcome).toBe('bailed');
    expect(result.turns[0].playerRolled).toBeNull();
  });
});
