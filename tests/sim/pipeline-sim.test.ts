/**
 * Sim harness Thread D Task 4 — dual-machine integration. Proves the pipeline machine
 * (`PipelineSimEngine`) runs end-to-end through the EXISTING driver code path
 * (`runScenario`/`runTurn`, not a bespoke harness), that `runComparison` drives one scenario
 * through both machines, and that a scripted pipeline stage failure fails loudly rather than
 * silently corrupting a curve. See docs/engine/stage-1-thread-d-backbone-plan.md, Task 4.
 */
import { describe, it, expect } from 'vitest';
import { runScenario, runComparison } from '../../src/sim/driver.js';
import { buildSimEngine } from '../../src/sim/engine-factory.js';
import { exampleComparisonScenario } from '../../src/sim/example-comparison-scenario.js';
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

/** Same shape as example-comparison-scenario.ts's pipeline script — a self-contained copy so
 *  this file doesn't depend on that example's exact wording, only its structure. */
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
    name: 'pipeline-test-scenario',
    character: BASE_CHARACTER,
    rollSource: { kind: 'fixed', value: 20 },
    llm: { kind: 'pipeline-scripted', script: combatPipelineScript() },
    machine: 'pipeline',
    week: [[{ input: 'attack the goblin', choicePolicy: 'first-real' }]],
    ...overrides,
  };
}

describe('sim driver — pipeline machine via runScenario (real driver code path)', () => {
  it('drives a scripted turn end-to-end through PipelineSimEngine and produces a valid SimResult', async () => {
    const result = await runScenario(pipelineScenario());

    expect(result.scenario).toBe('pipeline-test-scenario');
    expect(result.turns).toHaveLength(1);

    const turn = result.turns[0];
    expect(turn.outcome).toBe('success');
    expect(turn.distilledType).toBe('combat');
    expect(turn.wealth).toBe(5); // resolveMutate's +5, unmangled by finalize (collapse+validate only)
    expect(turn.rollsRemaining).toBe(2); // 3 seeded (DAILY_ROLL_ALLOWANCE) - 1 drained at start
    expect(turn.mutationsApplied).toBe(1);
  });

  it('runs multiple turns across a week purely in-memory (no DB)', async () => {
    const result = await runScenario(
      pipelineScenario({
        week: [
          [{ input: 'attack the goblin', choicePolicy: 'first-real' }],
          [{ input: 'attack the goblin', choicePolicy: 'first-real' }],
        ],
      }),
    );

    expect(result.turns).toHaveLength(2);
    expect(result.turns[1].wealth).toBe(10);
    expect(result.turns[1].rollsRemaining).toBe(1);
  });

  it('a legacy scenario with machine omitted is unaffected (defaults to legacy)', async () => {
    const legacyLikeCharacter = BASE_CHARACTER;
    const result = await runScenario({
      name: 'legacy-default',
      character: legacyLikeCharacter,
      rollSource: { kind: 'fixed', value: 20 },
      llm: {
        kind: 'scripted',
        script: () => ({
          distilledType: 'rest',
          stat: 'physical',
          baseDc: 5,
          required: false,
          done: true,
          decision: [],
          outcomeText: 'You rest.',
        }),
      },
      week: [[{ input: 'rest', choicePolicy: 'first-real' }]],
      // machine intentionally omitted
    });

    expect(result.turns).toHaveLength(1);
  });

  it('buildSimEngine(machine: "pipeline") returns a handle with no db/repos (nothing to spin up)', () => {
    const handle = buildSimEngine({ kind: 'fixed', value: 20 }, undefined, undefined, {
      machine: 'pipeline',
      script: combatPipelineScript(),
      seed: BASE_CHARACTER,
    });

    expect(handle.engine).toBeDefined();
    expect(handle.llm).toBeDefined();
    expect('db' in handle).toBe(false);
    expect('charRepo' in handle).toBe(false);
  });

  it('rejects a scenario whose machine/llm.kind are mismatched, rather than silently misrouting', async () => {
    await expect(
      runScenario(
        pipelineScenario({
          llm: {
            kind: 'scripted',
            script: () => ({ distilledType: 'x', stat: 'physical', baseDc: 5, required: false, done: true, decision: [] }),
          },
        }),
      ),
    ).rejects.toThrow(/machine 'pipeline' but llm\.kind is "scripted"/);
  });
});

describe('sim driver — runComparison', () => {
  it('runs one scenario through both machines and returns both SimResults', async () => {
    const { legacy, pipeline } = await runComparison(exampleComparisonScenario);

    expect(legacy.scenario).toBe('goblin-skirmish');
    expect(pipeline.scenario).toBe('goblin-skirmish');
    expect(legacy.turns).toHaveLength(1);
    expect(pipeline.turns).toHaveLength(1);

    // Both machines were hand-scripted to express "the same" turn (Task 4 spec: not
    // auto-derived from one another, but expected to agree on this simple case).
    expect(legacy.turns[0].outcome).toBe('success');
    expect(pipeline.turns[0].outcome).toBe('success');
    expect(legacy.turns[0].wealth).toBe(5);
    expect(pipeline.turns[0].wealth).toBe(5);
  });
});

describe('sim — a scripted pipeline stage failure fails loudly', () => {
  it('propagates a scenario-author decide() bug uncaught, instead of silently producing wrong data', async () => {
    const badScript: PipelineScript = {
      decide: (_input, callNo) => {
        if (callNo > 0) {
          throw new Error('scenario bug: decide() called a second time but this script only scripted one beat');
        }
        return {
          distilledType: 'combat',
          stat: 'physical',
          baseDc: 10,
          required: false,
          decision: [
            { label: 'Press the attack', dcModifier: 0 },
            { label: 'Step back', dcModifier: null },
          ],
        };
      },
      resolveMutate: () => ({ mutations: [] }),
      resolveNarrate: () => ({ outcomeText: 'n/a' }),
    };

    await expect(
      runScenario(pipelineScenario({ llm: { kind: 'pipeline-scripted', script: badScript } })),
    ).rejects.toThrow(/scenario bug: decide\(\) called a second time/);
  });

  it('a heuristic-classify miss with no classify() callback resolves to the typed divine-intervention outcome, not a silent guess', async () => {
    // "hi" hits none of classifier.ts's category tables -> heuristic miss -> falls through to
    // llm.classify(), which PipelineScriptedGateway throws on when the script has no classify()
    // wired up. PipelineActionStateMachine.start() catches that specific throw and resolves the
    // typed divine-intervention outcome (isDivineIntervention: true) — a legitimate, clearly
    // flagged result, not the silent-wrong-data trap this test suite otherwise guards against.
    const result = await runScenario(
      pipelineScenario({ week: [[{ input: 'hi', choicePolicy: 'first-real' }]] }),
    );

    expect(result.turns[0].outcome).toBe('done');
    expect(result.turns[0].distilledType).toBe('divine_intervention');
  });

  it('resolveMutate/resolveNarrate script bugs propagate uncaught too (no wrapper swallows them)', async () => {
    const badScript: PipelineScript = {
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
      resolveMutate: () => {
        throw new Error('scenario bug: resolveMutate was never scripted for this actionType');
      },
      resolveNarrate: () => ({ outcomeText: 'n/a' }),
    };

    await expect(
      runScenario(pipelineScenario({ llm: { kind: 'pipeline-scripted', script: badScript } })),
    ).rejects.toThrow(/scenario bug: resolveMutate was never scripted/);
  });
});

describe('sim — scene-state spine (Stage 2 T3): cross-turn read-back through PipelineSimEngine', () => {
  it('a set_relation authored on turn 1\'s resolve persists and is read back into turn 2\'s decide() context.sceneState', async () => {
    // Indexed by PipelineScriptedGateway's gateway-instance-global decideCallCount: each action
    // costs exactly 2 decide() calls (one at start, one at the first step — see
    // PipelineActionStateMachine's beat-cap comment), so index 0/1 belong to turn 1 and 2/3 to
    // turn 2.
    const sceneStateByDecideCall: (unknown[] | undefined)[] = [];
    let resolveMutateCallCount = 0;

    const script: PipelineScript = {
      decide: (input, callNo) => {
        sceneStateByDecideCall[callNo] = input.context.sceneState;
        return {
          distilledType: 'investigate',
          stat: 'wisdom',
          baseDc: 8,
          required: false,
          decision: [
            { label: 'Search the room', dcModifier: 0 },
            { label: 'Step back', dcModifier: null },
          ],
        };
      },
      resolveMutate: () => {
        const isFirstAction = resolveMutateCallCount === 0;
        resolveMutateCallCount++;
        if (!isFirstAction) return { mutations: [] };
        // pc -> location edge, an endpoint pair that needs no npc store (per T3's exit-test spec).
        return {
          mutations: [
            {
              type: 'set_relation',
              from: { node: 'pc' },
              to: { node: 'location', name: "The Warden's Oak" },
              relType: 'knows_secret',
              props: { clue: 'a hidden door behind the bar' },
            },
          ],
        };
      },
      resolveNarrate: () => ({ outcomeText: 'You uncover a small clue.' }),
    };

    const result = await runScenario({
      name: 'scene-state-readback',
      character: BASE_CHARACTER, // location: "The Warden's Oak" — matches the authored edge's "to"
      rollSource: { kind: 'fixed', value: 20 },
      llm: { kind: 'pipeline-scripted', script },
      machine: 'pipeline',
      week: [[
        { input: 'search the room', choicePolicy: 'first-real' },
        { input: 'search the room again', choicePolicy: 'first-real' },
      ]],
    });

    expect(result.turns).toHaveLength(2);

    // Turn 1 (decide calls 0 and 1): nothing persisted yet, sceneState stays absent.
    expect(sceneStateByDecideCall[0]).toBeUndefined();
    expect(sceneStateByDecideCall[1]).toBeUndefined();

    // Turn 2 (decide calls 2 and 3): the edge set_relation authored on turn 1's resolve has been
    // persisted through PipelineSimEngine's private RelationRepository and read back via
    // buildPipelineContext's getSceneRelations hook.
    expect(sceneStateByDecideCall[2]).toEqual([
      {
        from: { type: 'pc', ref: '1' },
        to: { type: 'location', ref: "The Warden's Oak" },
        relType: 'knows_secret',
        props: { clue: 'a hidden door behind the bar' },
      },
    ]);
    expect(sceneStateByDecideCall[3]).toEqual(sceneStateByDecideCall[2]);
  });
});
