/**
 * Thread D Task 5 — pipeline stage latency/count measurement (docs/engine/stage-1-thread-d-backbone-plan.md).
 * Proves `PipelineScriptedGateway` records one `stageCalls` entry per actual stage invocation and
 * that `summarizePipelineStages` groups/counts them correctly. Scripted latencies are near-zero —
 * this is measurement-plumbing coverage, not a performance assertion (Stage 1's "stub prompts,
 * prove the pipe works" spirit).
 */
import { describe, it, expect } from 'vitest';
import { runScenario } from '../../src/sim/driver.js';
import { summarizePipelineStages } from '../../src/sim/metrics.js';
import type { CharacterSeed, PipelineScript, Scenario } from '../../src/sim/types.js';

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

function combatPipelineScript(): PipelineScript {
  return {
    decide: () => ({
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 10,
      required: false,
      decision: [
        { label: 'Press the attack', dcModifier: 0 },
        { label: 'Step back', dcModifier: null },
      ],
    }),
    resolveMutate: () => ({ mutations: [{ type: 'modify_wealth', amount: 5 }] }),
    resolveNarrate: () => ({ outcomeText: 'Your blade finds its mark.' }),
  };
}

function pipelineScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    name: 'pipeline-stage-metrics-scenario',
    character: BASE_CHARACTER,
    rollSource: { kind: 'fixed', value: 20 },
    llm: { kind: 'pipeline-scripted', script: combatPipelineScript() },
    machine: 'pipeline',
    week: [[{ input: 'attack the goblin', choicePolicy: 'first-real' }]],
    ...overrides,
  };
}

describe('PipelineScriptedGateway.stageCalls + summarizePipelineStages', () => {
  it('records decide/resolve-mutate/resolve-narrate entries for a resolved turn (heuristic hit, no classify call)', async () => {
    const result = await runScenario(pipelineScenario());

    expect(result.stageCalls).toBeDefined();
    // The combat script's beat always offers a real + a bail option, so `step()`'s
    // isLastDecision check (PipelineActionStateMachine.ts) never short-circuits on the first
    // choice — decide() fires for beat 1 AND beat 2 (mirrors the legacy machine's own
    // up-to-twice-per-beat shape, see example-comparison-scenario.ts) before resolve fires once.
    const stages = result.stageCalls!.map((c) => c.stage);
    expect(stages).toEqual(['decide', 'decide', 'resolve-mutate', 'resolve-narrate']);
    for (const call of result.stageCalls!) {
      expect(call.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('accumulates across multiple turns in one scenario (gateway-instance-global, like decideCallCount)', async () => {
    const result = await runScenario(
      pipelineScenario({
        week: [
          [{ input: 'attack the goblin', choicePolicy: 'first-real' }],
          [{ input: 'attack the goblin', choicePolicy: 'first-real' }],
        ],
      }),
    );

    expect(result.stageCalls).toHaveLength(8); // (2 decide + resolve-mutate + resolve-narrate) x 2 turns
    const summary = summarizePipelineStages(result.stageCalls!);
    const byStage = Object.fromEntries(summary.map((s) => [s.stage, s]));
    expect(byStage.decide.count).toBe(4);
    expect(byStage['resolve-mutate'].count).toBe(2);
    expect(byStage['resolve-narrate'].count).toBe(2);
  });

  it('records a classify entry when the heuristic misses and the fallback fires (typed divine-intervention path)', async () => {
    // "hi" hits no heuristic table -> classify() fallback fires -> throws (no classify() scripted)
    // -> PipelineActionStateMachine resolves the typed divine-intervention outcome without ever
    // calling decide/resolveMutate/resolveNarrate. See pipeline-sim.test.ts for the outcome-shape
    // assertion; this test only cares about what stageCalls records.
    const result = await runScenario(
      pipelineScenario({ week: [[{ input: 'hi', choicePolicy: 'first-real' }]] }),
    );

    expect(result.turns[0].distilledType).toBe('divine_intervention');
    const stages = result.stageCalls!.map((c) => c.stage);
    expect(stages).toEqual(['classify']);
  });

  it('summarizePipelineStages groups counts, total, and max latency per stage', () => {
    const summary = summarizePipelineStages([
      { stage: 'decide', latencyMs: 1 },
      { stage: 'decide', latencyMs: 3 },
      { stage: 'resolve-mutate', latencyMs: 2 },
    ]);

    expect(summary).toEqual([
      { stage: 'decide', count: 2, totalLatencyMs: 4, maxLatencyMs: 3 },
      { stage: 'resolve-mutate', count: 1, totalLatencyMs: 2, maxLatencyMs: 2 },
    ]);
  });

  it('summarizePipelineStages returns an empty array for no calls', () => {
    expect(summarizePipelineStages([])).toEqual([]);
  });
});
