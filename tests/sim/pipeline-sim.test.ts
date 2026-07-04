/**
 * Sim harness Thread D Task 4 — dual-machine integration. Proves the pipeline machine
 * (`PipelineSimEngine`) runs end-to-end through the EXISTING driver code path
 * (`runScenario`/`runTurn`, not a bespoke harness), that `runComparison` drives one scenario
 * through both machines, and that a scripted pipeline stage failure fails loudly rather than
 * silently corrupting a curve. See docs/engine/stage-1-thread-d-backbone-plan.md, Task 4.
 */
import { describe, it, expect, vi } from 'vitest';
import { runScenario, runComparison } from '../../src/sim/driver.js';
import { summarize, renderTable } from '../../src/sim/metrics.js';
import { buildSimEngine } from '../../src/sim/engine-factory.js';
import { exampleComparisonScenario } from '../../src/sim/example-comparison-scenario.js';
import { combatWinScenario, combatFloorScenario, combatCapScenario } from '../../src/sim/combat-scenario.js';
import type { PipelineSimEngine } from '../../src/sim/PipelineSimEngine.js';
import type { CharacterSeed, DecisionScript, PipelineScript, Scenario } from '../../src/sim/types.js';

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

describe('sim — Stage 2 T5b: real geography reachability-gates pipeline movement', () => {
  /** No `sceneLocation` authored, so the D6 gate stays a no-op — this exercises geography
   *  finalize on the resolveMutate-authored `move_to` alone. */
  function movePipelineScript(target: string): PipelineScript {
    return {
      decide: () => ({
        distilledType: 'travel',
        stat: 'physical',
        baseDc: 5,
        required: false,
        decision: [
          { label: 'Go', dcModifier: 0 },
          { label: 'Step back', dcModifier: null },
        ],
      }),
      resolveMutate: () => ({ mutations: [{ type: 'move_to', name: target }] }),
      resolveNarrate: () => ({ outcomeText: 'You travel.' }),
    };
  }

  /** Drives one action to resolution, always picking the first real (non-bail) option — mirrors
   *  driver.ts's runTurn 'first-real' loop, inlined here since runScenario's SimResult carries no
   *  location field and these tests need to inspect post-resolve character state directly. */
  async function driveToResolution(engine: PipelineSimEngine, characterId: number, rawInput: string) {
    const start = await engine.startAction(characterId, rawInput);
    if (start.outcome) return start.outcome;
    let options = start.firstDecision.options;
    for (;;) {
      const real = options.find((o) => o.dcModifier !== null);
      if (!real) throw new Error('driveToResolution: no real option presented');
      const step = await engine.stepAction(characterId, real.label);
      if (step.resolved) return step.outcome;
      options = step.nextDecision.options;
    }
  }

  it('a move_to a node reachable from the seeded start location lands', async () => {
    const handle = buildSimEngine({ kind: 'fixed', value: 20 }, undefined, undefined, {
      machine: 'pipeline',
      // "Town Square" is a direct N spoke off "The Warden's Oak" (assets/world/edges.yml).
      script: movePipelineScript('Town Square'),
      seed: BASE_CHARACTER,
    });

    await driveToResolution(handle.engine, 1, 'walk to town square');

    expect(handle.engine.getCharacter('sim:pipeline')?.location).toBe('Town Square');
  });

  it('a move_to an unreachable/unknown place is dropped — the character stays put', async () => {
    const handle = buildSimEngine({ kind: 'fixed', value: 20 }, undefined, undefined, {
      machine: 'pipeline',
      // Not in assets/world/locations.yml at all — unknown AND unreachable.
      script: movePipelineScript('The Frozen Wastes'),
      seed: BASE_CHARACTER,
    });

    const outcome = await driveToResolution(handle.engine, 1, 'walk to the frozen wastes');

    expect(outcome.mutations).toEqual([]); // move_to dropped by createGeographyFinalize
    expect(handle.engine.getCharacter('sim:pipeline')?.location).toBe("The Warden's Oak");
  });
});

describe('sim — scene-state spine (Stage 2 T3 review fix): drop-with-warn invariants', () => {
  it('an update_relation authored against an edge that was never set_relation\'d warns and persists nothing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Indexed the same way the read-back test above is: 2 decide() calls per action, so index
    // 0/1 belong to turn 1 and 2/3 to turn 2.
    const sceneStateByDecideCall: (unknown[] | undefined)[] = [];

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
      resolveMutate: () => ({
        // pc -> location edge, but this edge was never set_relation'd first — updateProps has
        // nothing to merge onto and must warn rather than silently vanish (the "drop-with-warn,
        // never silent" invariant this review fix restores).
        mutations: [
          {
            type: 'update_relation',
            from: { node: 'pc' },
            to: { node: 'location', name: "The Warden's Oak" },
            relType: 'disposition',
            props: { trust: 1 },
          },
        ],
      }),
      resolveNarrate: () => ({ outcomeText: 'Nothing here changes.' }),
    };

    try {
      const result = await runScenario({
        name: 'update-relation-missing-edge',
        character: BASE_CHARACTER,
        rollSource: { kind: 'fixed', value: 20 },
        llm: { kind: 'pipeline-scripted', script },
        machine: 'pipeline',
        week: [[
          { input: 'inspect the room', choicePolicy: 'first-real' },
          { input: 'inspect the room again', choicePolicy: 'first-real' },
        ]],
      });

      expect(result.turns).toHaveLength(2);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/dropping update_relation.*pc:1.*location:The Warden's Oak/),
      );

      // Nothing was persisted, so turn 2's decide() input still carries no sceneState.
      expect(sceneStateByDecideCall[2]).toBeUndefined();
      expect(sceneStateByDecideCall[3]).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a set_relation authored with an unresolvable npc endpoint is dropped end-to-end, with a warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const sceneStateByDecideCall: (unknown[] | undefined)[] = [];

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
      resolveMutate: () => ({
        // to: npc "Grum" — but PipelineSimEngine's resolver has getNearbyNpcs: () => [], so this
        // endpoint can never resolve. The whole edge (both endpoints) must drop, not just persist
        // with a dangling/half-resolved side.
        mutations: [
          {
            type: 'set_relation',
            from: { node: 'pc' },
            to: { node: 'npc', name: 'Grum' },
            relType: 'trust',
            props: { trust: 1 },
          },
        ],
      }),
      resolveNarrate: () => ({ outcomeText: 'Grum is nowhere to be found.' }),
    };

    try {
      const result = await runScenario({
        name: 'set-relation-unresolvable-npc',
        character: BASE_CHARACTER,
        rollSource: { kind: 'fixed', value: 20 },
        llm: { kind: 'pipeline-scripted', script },
        machine: 'pipeline',
        week: [[
          { input: 'talk to grum', choicePolicy: 'first-real' },
          { input: 'talk to grum again', choicePolicy: 'first-real' },
        ]],
      });

      expect(result.turns).toHaveLength(2);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/unresolved npc endpoint "Grum"/));

      // The edge was dropped, not persisted, so turn 2's decide() input carries no sceneState.
      expect(sceneStateByDecideCall[2]).toBeUndefined();
      expect(sceneStateByDecideCall[3]).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('sim — Stage 2 T5c: relationsPersisted sim metric (persistence across beats)', () => {
describe('T3 iteration 1 — combat round-loop core', () => {
  it('establishes in_combat edge via combatEnemy on the first combat beat', async () => {
    const sceneStateByDecideCall: (unknown[] | undefined)[] = [];

    const script: PipelineScript = {
      decide: (input, callNo) => {
        sceneStateByDecideCall[callNo] = input.context.sceneState;
        return {
          distilledType: 'combat',
          stat: 'physical',
          baseDc: 12,
          required: true,
          decision: [{ label: 'Press the attack', dcModifier: 0 }],
          ...(callNo === 0 ? { combatEnemy: { name: 'Goblin', anchor: 'location' } } : {}),
        };
      },
      resolveMutate: () => ({ mutations: [{ type: 'modify_wealth', amount: 1 }] }),
      resolveNarrate: () => ({ outcomeText: 'The goblin falls.' }),
    };

    // 'fight the goblin' hits ONLY the combat heuristic (no 'scout' colliding with search).
    const result = await runScenario({
      name: 'combat-establishment',
      character: BASE_CHARACTER,
      rollSource: { kind: 'sequence', values: [20, 1, 20, 1] },
      llm: { kind: 'pipeline-scripted', script },
      machine: 'pipeline',
      week: [[{ input: 'fight the goblin', choicePolicy: 'first-real' }]],
    });

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].outcome).toBe('success');
    expect(result.relationsPersisted).toBeGreaterThanOrEqual(1);

    // Decide call 0 (start) sees no sceneState (nothing persisted yet).
    expect(sceneStateByDecideCall[0]).toBeUndefined();

    // Decide call 1 (first round's continue via updatedContext) sees the in_combat edge.
    const state1 = sceneStateByDecideCall[1];
    expect(state1).toBeDefined();
    const combatEdge = (state1 as unknown[]).find(
      (e: unknown) => (e as Record<string, unknown>).relType === 'in_combat',
    );
    expect(combatEdge).toBeDefined();
    expect((combatEdge as Record<string, unknown>).props).toMatchObject({
      enemyName: 'Goblin',
      enemyHp: expect.any(Number),
      enemyMaxHp: expect.any(Number),
      round: expect.any(Number),
    });
  });

  it('multi-round fight resolves success after depleting enemyHp', async () => {
    const sceneStateByDecideCall: (unknown[] | undefined)[] = [];

    const script: PipelineScript = {
      decide: (input, callNo) => {
        sceneStateByDecideCall[callNo] = input.context.sceneState;
        return {
          distilledType: 'combat',
          stat: 'physical',
          baseDc: 12,
          required: true,
          decision: [{ label: 'Press the attack', dcModifier: 0 }],
          ...(callNo === 0 ? { combatEnemy: { name: 'Goblin', anchor: 'location' } } : {}),
        };
      },
      resolveMutate: () => ({ mutations: [{ type: 'modify_wealth', amount: 5 }] }),
      resolveNarrate: () => ({ outcomeText: 'The goblin falls to your blade.' }),
    };

    const result = await runScenario({
      name: 'combat-multi-round',
      character: BASE_CHARACTER,
      // Two clean hits (player 20 vs enemy 1 each round) with baseDc=12 → enemyMaxHp=12,
      // clean band = -6 enemyHpDelta → 2 rounds to kill.
      rollSource: { kind: 'sequence', values: [20, 1, 20, 1] },
      llm: { kind: 'pipeline-scripted', script },
      machine: 'pipeline',
      week: [[{ input: 'fight the goblin', choicePolicy: 'first-real' }]],
    });

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].outcome).toBe('success');
    expect(result.turns[0].wealth).toBe(5); // resolveMutate loot fires on terminal beat

    // Round 2's sceneState (from decide call 1) should show reduced enemyHp
    const state1 = sceneStateByDecideCall[1];
    const combatEdge = ((state1 as unknown[]) ?? []).find(
      (e: unknown) => (e as Record<string, unknown>).relType === 'in_combat',
    ) as Record<string, unknown> | undefined;
    expect(combatEdge).toBeDefined();
    const props = combatEdge!.props as Record<string, unknown>;
    // After one clean hit with crit amplification (-8), enemyHp should be 12 - 8 = 4
    expect(props.enemyHp).toBe(4);
    expect(props.enemyMaxHp).toBe(12);
    expect(props.round).toBe(2);
  });

  it('cap-derive resolves at MAX_COMBAT_ROUNDS by comparing HP fractions', async () => {
    // Physical=15 → abilityCheckBonus = floor(15/2 - 5) = 2, so paired equal
    // dice (+2 each) produce trade bands with 0 margin.
    const highStat: CharacterSeed = {
      ...BASE_CHARACTER,
      stats: { physical: 15, wisdom: 0, intelligence: 0, charisma: 0 },
      health: 20,
      maxHealth: 20,
    };

    const script: PipelineScript = {
      decide: (_input, callNo) => ({
        distilledType: 'combat',
        stat: 'physical',
        baseDc: 12,
        required: true,
        decision: [{ label: 'Fight', dcModifier: 0 }],
        ...(callNo === 0 ? { combatEnemy: { name: 'Boar', anchor: 'location' } } : {}),
      }),
      resolveMutate: () => ({ mutations: [{ type: 'modify_wealth', amount: 1 }] }),
      resolveNarrate: () => ({ outcomeText: 'The boar is driven off.' }),
    };

    const result = await runScenario({
      name: 'combat-cap-derive',
      character: highStat,
      // 4 rounds fought × 2 draws each + 1 cap step × 2 draws = 10 draws.
      // Each round: player&enemy both -2 so player=20-2n, enemy=12-2n.
      // Equal dice (8 vs 8) + equal bonus (2 vs 2) = margin 0 → trade (-2/-2).
      rollSource: { kind: 'sequence', values: [8, 8, 8, 8, 8, 8, 8, 8, 8, 8] },
      llm: { kind: 'pipeline-scripted', script },
      machine: 'pipeline',
      week: [[{ input: 'fight the boar', choicePolicy: 'first-real' }]],
    });

    expect(result.turns).toHaveLength(1);
    // After 4 trades: enemyHp=12-8=4, playerHp=20-8=12
    // playerFrac=12/20=0.6 >= enemyFrac=4/12=0.333 → success
    expect(result.turns[0].outcome).toBe('success');
    expect(result.relationsPersisted).toBeGreaterThanOrEqual(1);
  });

  it('non-combat action does not enter combat sub-mode (standard beat cap applies)', async () => {
    const script: PipelineScript = {
      decide: () => ({
        distilledType: 'investigate',
        stat: 'wisdom',
        baseDc: 8,
        required: false,
        decision: [
          { label: 'Search the area', dcModifier: 0 },
          { label: 'Step back', dcModifier: null },
        ],
      }),
      resolveMutate: () => ({ mutations: [] }),
      resolveNarrate: () => ({ outcomeText: 'You find nothing unusual.' }),
    };

    // Two beats = a non-combat action resolves in max 2 beats (beat cap).
    // Each beat resolves via needs_roll, consuming one d20 draw.
    const result = await runScenario({
      name: 'non-combat-unaffected',
      character: BASE_CHARACTER,
      rollSource: { kind: 'fixed', value: 10 },
      llm: { kind: 'pipeline-scripted', script },
      machine: 'pipeline',
      week: [[
        { input: 'search the area', choicePolicy: 'first-real' },
      ]],
    });

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].outcome).toBe('success');

    expect(result.turns[0].distilledType).toBe('investigate');
  });
});

  it('an edge set_relation\'d on an early beat is still counted in relationsPersisted after a later beat', async () => {
    let resolveMutateCallCount = 0;

    const script: PipelineScript = {
      decide: () => ({
        distilledType: 'investigate',
        stat: 'wisdom',
        baseDc: 8,
        required: false,
        decision: [
          { label: 'Search the room', dcModifier: 0 },
          { label: 'Step back', dcModifier: null },
        ],
      }),
      resolveMutate: () => {
        const isFirstAction = resolveMutateCallCount === 0;
        resolveMutateCallCount++;
        if (!isFirstAction) return { mutations: [] };
        // pc -> location edge (needs no npc store) authored on the first (early) beat.
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
      name: 'relations-persisted-metric',
      character: BASE_CHARACTER, // location: "The Warden's Oak" — matches the authored edge's "to"
      rollSource: { kind: 'fixed', value: 20 },
      llm: { kind: 'pipeline-scripted', script },
      machine: 'pipeline',
      // Two beats: the edge is authored on beat 1, and beat 2 runs after it with no further
      // relation mutations — proving the edge survives from an earlier beat to scenario end.
      week: [[
        { input: 'search the room', choicePolicy: 'first-real' },
        { input: 'search the room again', choicePolicy: 'first-real' },
      ]],
    });

    expect(result.turns).toHaveLength(2);
    expect(result.relationsPersisted).toBe(1);

    const summary = summarize(result);
    expect(summary.relationsPersisted).toBe(1);
    expect(summary.relationsPersisted).toBe(result.relationsPersisted);
  });
});

describe('T3 iteration 2 — floor + loss ladder', () => {
  /** Low-HP variant so the first damaging band triggers the floor. */
  const lowHpChar: CharacterSeed = {
    ...BASE_CHARACTER,
    health: 2,
    maxHealth: 10,
  };

  /** Script for combat rounds without a decide-stage sceneState inspection. */
  function combatScript(): PipelineScript {
    return {
      decide: (_input, callNo) => ({
        distilledType: 'combat',
        stat: 'physical',
        baseDc: 12,
        required: true,
        decision: [{ label: 'Press the attack', dcModifier: 0 }],
        ...(callNo === 0 ? { combatEnemy: { name: 'Goblin', anchor: 'location' } } : {}),
      }),
      resolveMutate: () => ({ mutations: [{ type: 'modify_wealth', amount: 1 }] }),
      resolveNarrate: () => ({ outcomeText: 'The goblin falls.' }),
    };
  }

  it('first lethal blow triggers desperate-choice (resolved: false with forced options bail bloodied / last stand)', async () => {
    // Heavy band (margin < -2): player d20=1, enemy d20=10 => player total=6, enemy total=12,
    // margin=-6 → heavy. With char.health=2, playerHpDelta=-3 → hpZeroReached.
    const handle = buildSimEngine({ kind: 'sequence', values: [1, 10] }, undefined, undefined, {
      machine: 'pipeline',
      script: combatScript(),
      seed: lowHpChar,
    });
    const engine = handle.engine as PipelineSimEngine;

    const start = await engine.startAction(1, 'fight the goblin');
    expect(start.outcome).toBeUndefined();

    const step = await engine.stepAction(1, 'Press the attack');
    expect(step.resolved).toBe(false);

    const decision = (step as { resolved: false; nextDecision: { prompt: string; options: { label: string; dcModifier: number | null }[] } }).nextDecision;
    const labels = decision.options.map((o) => o.label);
    expect(labels).toContain('Bail bloodied');
    expect(labels).toContain('Last stand');

    const bailOption = decision.options.find((o) => o.label === 'Bail bloodied');
    expect(bailOption?.dcModifier).toBeNull();

    const standOption = decision.options.find((o) => o.label === 'Last stand');
    expect(standOption?.dcModifier).toBe(0);

    // The non-terminal floor mutations were applied: HP floored to 1.
    expect(engine.getCharacter('sim:pipeline')?.health).toBe(1);

    // The combat_save and in_combat edges were persisted.
    expect(engine.getPersistedRelationCount()).toBeGreaterThanOrEqual(2);
  });

  it('bail bloodied resolves combat as bailed with enemy edge persisted', async () => {
    const handle = buildSimEngine({ kind: 'sequence', values: [1, 10] }, undefined, undefined, {
      machine: 'pipeline',
      script: combatScript(),
      seed: lowHpChar,
    });
    const engine = handle.engine as PipelineSimEngine;

    // Drive to desperate-choice state.
    const start = await engine.startAction(1, 'fight the goblin');
    expect(start.outcome).toBeUndefined();

    const desperate = await engine.stepAction(1, 'Press the attack');
    expect(desperate.resolved).toBe(false);
    expect(engine.getCharacter('sim:pipeline')?.health).toBe(1);

    // Bail bloodied (dcModifier: null) is caught by step()'s generic bail check.
    const bail = await engine.stepAction(1, 'Bail bloodied');
    expect(bail.resolved).toBe(true);
    expect((bail as { resolved: true; outcome: { outcome: string } }).outcome.outcome).toBe('bailed');

    // The in_combat edge from the desperate-choice beat is still persisted (not cleared by bail).
    // At least 2 edges: in_combat + combat_save.
    expect(engine.getPersistedRelationCount()).toBeGreaterThanOrEqual(2);

    // Character is at 1 HP from the floor.
    expect(engine.getCharacter('sim:pipeline')?.health).toBe(1);
  });

  it('last stand continues combat with player at 1 HP', async () => {
    const handle = buildSimEngine({ kind: 'sequence', values: [1, 10, 20, 1] }, undefined, undefined, {
      machine: 'pipeline',
      script: combatScript(),
      seed: lowHpChar,
    });
    const engine = handle.engine as PipelineSimEngine;

    // Drive to desperate-choice state.
    const start = await engine.startAction(1, 'fight the goblin');
    expect(start.outcome).toBeUndefined();

    const desperate = await engine.stepAction(1, 'Press the attack');
    expect(desperate.resolved).toBe(false);
    expect(engine.getCharacter('sim:pipeline')?.health).toBe(1);

    // Last stand clears desperateChoice and enters normal combat flow.
    // Roll [20, 1]: player nat-20 → forced clean band, playerHpDelta=0. No hpZero → continue.
    const stand = await engine.stepAction(1, 'Last stand');
    expect(stand.resolved).toBe(false);

    // HP remains at 1 (floor mutations persist; clean band does no player damage).
    expect(engine.getCharacter('sim:pipeline')?.health).toBe(1);
  });

  it('second lethal blow same day resolves failure with hpZero', async () => {
    const handle = buildSimEngine(
      { kind: 'sequence', values: [1, 10, 20, 1, 1, 10] },
      undefined,
      undefined,
      {
        machine: 'pipeline',
        script: combatScript(),
        seed: lowHpChar,
      },
    );
    const engine = handle.engine as PipelineSimEngine;

    // Round 1: heavy → desperate-choice (save set with currentDay=1).
    const start = await engine.startAction(1, 'fight the goblin');
    expect(start.outcome).toBeUndefined();

    const desperate = await engine.stepAction(1, 'Press the attack');
    expect(desperate.resolved).toBe(false);
    expect(engine.getCharacter('sim:pipeline')?.health).toBe(1);

    // Last stand → clean band (no player damage) → continue.
    const stand = await engine.stepAction(1, 'Last stand');
    expect(stand.resolved).toBe(false);

    // Round 2 (third combat step, second after last-stand): heavy → hpZeroReached.
    // savedDay(1) === currentDay(1) → failure with hpZero.
    const lethal = await engine.stepAction(1, 'Press the attack');
    expect(lethal.resolved).toBe(true);
    const lethalOutcome = (lethal as { resolved: true; outcome: { outcome: string; hpZero?: boolean } }).outcome;
    expect(lethalOutcome.outcome).toBe('failure');
    expect(lethalOutcome.hpZero).toBe(true);
  });

  it('a new day resets the save', async () => {
    const handle = buildSimEngine(
      { kind: 'sequence', values: [1, 10, 20, 1, 1, 10, 1, 10] },
      undefined,
      undefined,
      {
        machine: 'pipeline',
        script: combatScript(),
        seed: lowHpChar,
      },
    );
    const engine = handle.engine as PipelineSimEngine;

    // Round 1: heavy → desperate-choice (save set with currentDay=1).
    const start = await engine.startAction(1, 'fight the goblin');
    expect(start.outcome).toBeUndefined();

    let step = await engine.stepAction(1, 'Press the attack');
    expect(step.resolved).toBe(false);

    // Advance the day — save should reset.
    engine.currentDay = 2;

    // Last stand → clean band → continue.
    step = await engine.stepAction(1, 'Last stand');
    expect(step.resolved).toBe(false);

    // Next round: heavy → hpZeroReached. savedDay(1) !== currentDay(2) → save fires again.
    step = await engine.stepAction(1, 'Press the attack');
    expect(step.resolved).toBe(false);

    // The desperate-choice beat offers both options again.
    const decision2 = (step as { resolved: false; nextDecision: { options: { label: string }[] } }).nextDecision;
    const labels2 = decision2.options.map((o) => o.label);
    expect(labels2).toContain('Bail bloodied');
    expect(labels2).toContain('Last stand');

    // HP is still 1 (floored in round 1, clean band did no damage).
    expect(engine.getCharacter('sim:pipeline')?.health).toBe(1);
  });

  it('edge case: absent getCurrentDay degrades to per-encounter', async () => {
    // When getCurrentDay returns 0 (same as the default-fallback when absent), the save
    // fires on the first lethal blow with savedDay=0. A second lethal blow in the same
    // encounter finds savedDay(0) === currentDay(0) → failure.
    const handle = buildSimEngine(
      { kind: 'sequence', values: [1, 10, 20, 1, 1, 10] },
      undefined,
      undefined,
      {
        machine: 'pipeline',
        script: combatScript(),
        seed: lowHpChar,
      },
    );
    const engine = handle.engine as PipelineSimEngine;

    // Set currentDay to 0, same as the default fallback when getCurrentDay is absent.
    engine.currentDay = 0;

    // Round 1: heavy → desperate-choice (save set with savedDay=0).
    const start = await engine.startAction(1, 'fight the goblin');
    expect(start.outcome).toBeUndefined();

    const desperate = await engine.stepAction(1, 'Press the attack');
    expect(desperate.resolved).toBe(false);
    expect(engine.getCharacter('sim:pipeline')?.health).toBe(1);

    // Last stand → clean band → continue.
    const stand = await engine.stepAction(1, 'Last stand');
    expect(stand.resolved).toBe(false);

    // Second lethal blow: savedDay(0) === currentDay(0) → failure with hpZero.
    const lethal = await engine.stepAction(1, 'Press the attack');
    expect(lethal.resolved).toBe(true);
    const lethalOutcome = (lethal as { resolved: true; outcome: { outcome: string; hpZero?: boolean } }).outcome;
    expect(lethalOutcome.outcome).toBe('failure');
    expect(lethalOutcome.hpZero).toBe(true);
  });
});

describe('T3 follow-up — voluntary mid-combat bail (flee at a cost)', () => {
  /** Script for combat rounds without a decide-stage sceneState inspection. */
  function combatScript(): PipelineScript {
    return {
      decide: (_input, callNo) => ({
        distilledType: 'combat',
        stat: 'physical',
        baseDc: 12,
        required: true,
        decision: [{ label: 'Press the attack', dcModifier: 0 }],
        ...(callNo === 0 ? { combatEnemy: { name: 'Goblin', anchor: 'location' } } : {}),
      }),
      resolveMutate: () => ({ mutations: [{ type: 'modify_wealth', amount: 1 }] }),
      resolveNarrate: () => ({ outcomeText: 'The goblin falls.' }),
    };
  }

  /** Same script, but records each decide call's sceneState so a test can inspect the
   *  persisted in_combat edge's enemyHp at that point in the fight. */
  function combatScriptCapturing(sceneStateByDecideCall: (unknown[] | undefined)[]): PipelineScript {
    return {
      decide: (input, callNo) => {
        sceneStateByDecideCall[callNo] = input.context.sceneState;
        return {
          distilledType: 'combat',
          stat: 'physical',
          baseDc: 12,
          required: true,
          decision: [{ label: 'Press the attack', dcModifier: 0 }],
          ...(callNo === 0 ? { combatEnemy: { name: 'Goblin', anchor: 'location' } } : {}),
        };
      },
      resolveMutate: () => ({ mutations: [{ type: 'modify_wealth', amount: 1 }] }),
      resolveNarrate: () => ({ outcomeText: 'The goblin falls.' }),
    };
  }

  // Roll [8, 10] with BASE_CHARACTER (physical=5 → playerBonus=5) and baseDc=12
  // (→ enemyBonus=clamp(12-10,0,10)=2): margin = (8+5)-(10+2) = 1 → 'trade' band
  // (enemyHpDelta=-2, playerHpDelta=-2). Neither die is a 1 or 20, so no crit override, and
  // BASE_CHARACTER's health=10/enemyMaxHp=12 both stay well clear of the floor — a clean
  // non-terminal round-2 continuation.
  const TRADE_ROLLS = { kind: 'sequence' as const, values: [8, 10] };

  it('a combat continuation beat offers a Flee the fight option', async () => {
    const handle = buildSimEngine(TRADE_ROLLS, undefined, undefined, {
      machine: 'pipeline',
      script: combatScript(),
      seed: BASE_CHARACTER,
    });
    const engine = handle.engine as PipelineSimEngine;

    const start = await engine.startAction(1, 'fight the goblin');
    expect(start.outcome).toBeUndefined();

    const step = await engine.stepAction(1, 'Press the attack');
    expect(step.resolved).toBe(false);

    const decision = (step as {
      resolved: false;
      nextDecision: { options: { label: string; dcModifier: number | null }[] };
    }).nextDecision;
    const labels = decision.options.map((o) => o.label);
    expect(labels).toContain('Press the attack');
    expect(labels).toContain('Flee the fight');

    const fleeOption = decision.options.find((o) => o.label === 'Flee the fight');
    expect(fleeOption?.dcModifier).toBeNull();
  });

  it('picking Flee the fight mid-combat bails, costs stamina, and leaves the enemy remembered', async () => {
    const sceneStateByDecideCall: (unknown[] | undefined)[] = [];
    const handle = buildSimEngine(TRADE_ROLLS, undefined, undefined, {
      machine: 'pipeline',
      script: combatScriptCapturing(sceneStateByDecideCall),
      seed: BASE_CHARACTER,
    });
    const engine = handle.engine as PipelineSimEngine;

    const start = await engine.startAction(1, 'fight the goblin');
    expect(start.outcome).toBeUndefined();
    const startingStamina = engine.getCharacter('sim:pipeline')?.stamina ?? 0;

    const step = await engine.stepAction(1, 'Press the attack');
    expect(step.resolved).toBe(false);

    // Round 2's decide call (callNo 1) sees the round-1-depleted in_combat edge:
    // enemyMaxHp=12, trade band enemyHpDelta=-2 → enemyHp=10.
    const state1 = sceneStateByDecideCall[1] as unknown[];
    const combatEdge = state1.find(
      (e) => (e as Record<string, unknown>).relType === 'in_combat',
    ) as Record<string, unknown> | undefined;
    expect(combatEdge).toBeDefined();
    const depletedEnemyHp = (combatEdge!.props as Record<string, unknown>).enemyHp;
    expect(depletedEnemyHp).toBe(10);

    const relationCountBeforeBail = engine.getPersistedRelationCount();
    expect(relationCountBeforeBail).toBeGreaterThanOrEqual(1);

    const bail = await engine.stepAction(1, 'Flee the fight');
    expect(bail.resolved).toBe(true);
    expect((bail as { resolved: true; outcome: { outcome: string } }).outcome.outcome).toBe('bailed');

    // BAIL_STAMINA_COST is 1 — the generic bail path's only mutation.
    expect(engine.getCharacter('sim:pipeline')?.stamina).toBe(startingStamina - 1);

    // The bail path doesn't touch relations, so the in_combat edge persisted during round 1's
    // CONTINUE survives unchanged — the enemy is remembered at its current (depleted) HP.
    expect(engine.getPersistedRelationCount()).toBe(relationCountBeforeBail);

    // Prove the depleted edge genuinely persisted in the DB (not just that the row count held
    // steady): start a fresh follow-up action so its decide() context is built from a real
    // `relationRepo.forNode` read-back, not the machine's in-memory synthesized round-2 state.
    // The bail step itself makes no decide call, so this is the next index (callNo 2).
    await engine.startAction(1, 'search the area');
    const state2 = sceneStateByDecideCall[2] as unknown[];
    const persistedCombatEdge = state2.find(
      (e) => (e as Record<string, unknown>).relType === 'in_combat',
    ) as Record<string, unknown> | undefined;
    expect(persistedCombatEdge).toBeDefined();
    expect((persistedCombatEdge!.props as Record<string, unknown>).enemyHp).toBe(10);
  });

  it('the first combat beat has no flee option (round 1 is the forced reaction)', async () => {
    const handle = buildSimEngine(TRADE_ROLLS, undefined, undefined, {
      machine: 'pipeline',
      script: combatScript(),
      seed: BASE_CHARACTER,
    });
    const engine = handle.engine as PipelineSimEngine;

    const start = await engine.startAction(1, 'fight the goblin');
    expect(start.outcome).toBeUndefined();

    const firstDecision = start.firstDecision as
      | { options: { label: string; dcModifier: number | null }[] }
      | undefined;
    expect(firstDecision).toBeDefined();
    expect(firstDecision!.options.some((o) => o.dcModifier === null)).toBe(false);
  });

  it('a wayward LLM-authored real option sharing the flee label cannot shadow the guaranteed bail', async () => {
    // Round 2's decide call (callNo 1) authors a REAL 'Flee the fight' option (dcModifier: 0) —
    // a BASE-Rule-3 violation, but the engine must not let it win step()'s label lookup over its
    // own guaranteed-null flee.
    const script: PipelineScript = {
      decide: (_input, callNo) => ({
        distilledType: 'combat',
        stat: 'physical',
        baseDc: 12,
        required: true,
        decision: callNo === 1
          ? [
            { label: 'Press the attack', dcModifier: 0 },
            { label: 'Flee the fight', dcModifier: 0 },
          ]
          : [{ label: 'Press the attack', dcModifier: 0 }],
        ...(callNo === 0 ? { combatEnemy: { name: 'Goblin', anchor: 'location' } } : {}),
      }),
      resolveMutate: () => ({ mutations: [{ type: 'modify_wealth', amount: 1 }] }),
      resolveNarrate: () => ({ outcomeText: 'The goblin falls.' }),
    };
    const handle = buildSimEngine(TRADE_ROLLS, undefined, undefined, {
      machine: 'pipeline',
      script,
      seed: BASE_CHARACTER,
    });
    const engine = handle.engine as PipelineSimEngine;

    const start = await engine.startAction(1, 'fight the goblin');
    expect(start.outcome).toBeUndefined();

    const step = await engine.stepAction(1, 'Press the attack');
    expect(step.resolved).toBe(false);

    const decision = (step as {
      resolved: false;
      nextDecision: { options: { label: string; dcModifier: number | null }[] };
    }).nextDecision;

    // Only one 'Flee the fight' option survives — the engine's own, not the LLM's real one.
    const fleeOptions = decision.options.filter((o) => o.label === 'Flee the fight');
    expect(fleeOptions).toHaveLength(1);
    expect(fleeOptions[0]?.dcModifier).toBeNull();

    const bail = await engine.stepAction(1, 'Flee the fight');
    expect(bail.resolved).toBe(true);
    expect((bail as { resolved: true; outcome: { outcome: string } }).outcome.outcome).toBe('bailed');
  });
});

describe('T5 — combat telemetry + metrics', () => {
  /** Script for combat rounds without a decide-stage sceneState inspection (same T3 shape). */
  function combatScript(): PipelineScript {
    return {
      decide: (_input, callNo) => ({
        distilledType: 'combat',
        stat: 'physical',
        baseDc: 12,
        required: true,
        decision: [{ label: 'Press the attack', dcModifier: 0 }],
        ...(callNo === 0 ? { combatEnemy: { name: 'Goblin', anchor: 'location' } } : {}),
      }),
      resolveMutate: () => ({ mutations: [{ type: 'modify_wealth', amount: 1 }] }),
      resolveNarrate: () => ({ outcomeText: 'The goblin falls.' }),
    };
  }

  it('the terminal WIN beat carries a combatBeat with band + enemyHpAfter 0', async () => {
    const handle = buildSimEngine({ kind: 'sequence', values: [20, 1, 20, 1] }, undefined, undefined, {
      machine: 'pipeline',
      script: combatScript(),
      seed: BASE_CHARACTER,
    });
    const engine = handle.engine as PipelineSimEngine;

    await engine.startAction(1, 'fight the goblin');
    const step1 = await engine.stepAction(1, 'Press the attack');
    expect(step1.resolved).toBe(false);

    const step2 = await engine.stepAction(1, 'Press the attack');
    expect(step2.resolved).toBe(true);
    const outcome = (step2 as {
      resolved: true;
      outcome: {
        outcome: string;
        combatBeat?: {
          round: number;
          band: string;
          enemyHpBefore: number;
          enemyHpAfter: number;
          playerHpDelta: number;
          materialMutationFired: boolean;
          ops: string[];
          marker: string;
        };
      };
    }).outcome;
    expect(outcome.outcome).toBe('success');
    expect(outcome.combatBeat).toBeDefined();
    expect(outcome.combatBeat?.band).toBe('clean');
    expect(outcome.combatBeat?.enemyHpAfter).toBe(0);
    expect(outcome.combatBeat?.marker).toBe('combat_round');
    expect(outcome.combatBeat?.round).toBe(2);
    expect(outcome.combatBeat?.enemyHpBefore).toBe(4);
    expect(outcome.combatBeat?.playerHpDelta).toBe(0);
    expect(outcome.combatBeat?.materialMutationFired).toBe(true);
    // Terminal ops carry the engine-authored final in_combat edge write (enemyHp → 0) plus the
    // LLM loot. Both survive validation now the edge is emitted with its `type: 'set_relation'`.
    expect(outcome.combatBeat?.ops).toContain('set_relation');
    expect(outcome.combatBeat?.ops).toContain('modify_wealth');

    expect(engine.getCombatMetrics()).toEqual({ roundsFought: 2, floorSaves: 0, wins: 1, losses: 0 });
  });

  it('a win finalizes the in_combat edge at enemyHp 0 (defeated foe not resumed by the next fight)', async () => {
    // The terminal set_relation must land, or the edge lingers at the last CONTINUE round's HP and
    // a fresh fight would re-establish onto a still-"active" (enemyHp > 0) edge (plan decision 5).
    const sceneStateByDecideCall: (unknown[] | undefined)[] = [];
    const script: PipelineScript = {
      decide: (input, callNo) => {
        sceneStateByDecideCall[callNo] = input.context.sceneState;
        return {
          distilledType: 'combat',
          stat: 'physical',
          baseDc: 12,
          required: true,
          decision: [{ label: 'Press the attack', dcModifier: 0 }],
          ...(callNo === 0 ? { combatEnemy: { name: 'Goblin', anchor: 'location' as const } } : {}),
        };
      },
      resolveMutate: () => ({ mutations: [{ type: 'modify_wealth', amount: 1 }] }),
      resolveNarrate: () => ({ outcomeText: 'The goblin falls.' }),
    };
    const handle = buildSimEngine({ kind: 'sequence', values: [20, 1, 20, 1] }, undefined, undefined, {
      machine: 'pipeline',
      script,
      seed: BASE_CHARACTER,
    });
    const engine = handle.engine as PipelineSimEngine;

    await engine.startAction(1, 'fight the goblin');
    await engine.stepAction(1, 'Press the attack'); // round 1 → CONTINUE (edge at enemyHp 4)
    const win = await engine.stepAction(1, 'Press the attack'); // round 2 → WIN
    expect(win.resolved).toBe(true);

    // A fresh follow-up action reads the persisted edge back through relationRepo.forNode, proving
    // the terminal write reached the DB (not just the in-memory synthesized round state).
    await engine.startAction(1, 'search the area');
    const readBack = sceneStateByDecideCall[2] as unknown[];
    const persistedEdge = readBack?.find(
      (e) => (e as Record<string, unknown>).relType === 'in_combat',
    ) as Record<string, unknown> | undefined;
    expect(persistedEdge).toBeDefined();
    expect((persistedEdge!.props as Record<string, unknown>).enemyHp).toBe(0);
  });

  it('a voluntary bail carries no terminal combatBeat, but its earlier fought round still counts', async () => {
    // Trade band (margin 1, no crit) with BASE_CHARACTER — a clean non-terminal round 1.
    const handle = buildSimEngine({ kind: 'sequence', values: [8, 10] }, undefined, undefined, {
      machine: 'pipeline',
      script: combatScript(),
      seed: BASE_CHARACTER,
    });
    const engine = handle.engine as PipelineSimEngine;

    await engine.startAction(1, 'fight the goblin');
    const step1 = await engine.stepAction(1, 'Press the attack');
    expect(step1.resolved).toBe(false);
    expect(engine.getCombatMetrics()).toEqual({ roundsFought: 1, floorSaves: 0, wins: 0, losses: 0 });

    const bail = await engine.stepAction(1, 'Flee the fight');
    expect(bail.resolved).toBe(true);
    const outcome = (bail as { resolved: true; outcome: { outcome: string; combatBeat?: unknown } }).outcome;
    expect(outcome.outcome).toBe('bailed');
    expect(outcome.combatBeat).toBeUndefined();

    // The bail itself fought no round — round 1's beat (before the bail) is still counted.
    expect(engine.getCombatMetrics()).toEqual({ roundsFought: 1, floorSaves: 0, wins: 0, losses: 0 });
  });

  it('combatWinScenario yields the exact win combatMetrics end-to-end', async () => {
    const result = await runScenario(combatWinScenario);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].outcome).toBe('success');
    expect(result.combatMetrics).toEqual({ roundsFought: 2, floorSaves: 0, wins: 1, losses: 0 });
    expect(summarize(result).combatMetrics).toEqual(result.combatMetrics);
  });

  it('combatFloorScenario yields the exact floor/desperate-choice/loss combatMetrics end-to-end', async () => {
    const result = await runScenario(combatFloorScenario);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].outcome).toBe('failure');
    expect(result.combatMetrics).toEqual({ roundsFought: 2, floorSaves: 1, wins: 0, losses: 1 });
    expect(summarize(result).combatMetrics).toEqual(result.combatMetrics);
  });

  it('combatCapScenario yields the exact cap-derive combatMetrics end-to-end', async () => {
    const result = await runScenario(combatCapScenario);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].outcome).toBe('success');
    expect(result.combatMetrics).toEqual({ roundsFought: 5, floorSaves: 0, wins: 1, losses: 0 });
    expect(summarize(result).combatMetrics).toEqual(result.combatMetrics);
  });

  it('a legacy scenario carries no combatMetrics and renderTable output is unchanged', async () => {
    const legacyScript: DecisionScript = () => ({
      prompt: '',
      distilledType: 'rest',
      stat: 'physical',
      baseDc: 0,
      required: false,
      done: true,
      decision: [{ label: 'Rest', dcModifier: 0 }],
      mutations: [],
      outcomeText: 'You rest quietly.',
    });

    const result = await runScenario({
      name: 'legacy-unaffected',
      character: BASE_CHARACTER,
      rollSource: { kind: 'fixed', value: 20 },
      llm: { kind: 'scripted', script: legacyScript },
      week: [[{ input: 'rest', choicePolicy: 'first-real' }]],
    });

    expect(result.combatMetrics).toBeUndefined();

    const summary = summarize(result);
    expect(summary.combatMetrics).toBeUndefined();
    const table = renderTable(summary);
    expect(table).not.toContain('Combat rounds');
    expect(table).not.toContain('Floor-saves');
    expect(table).not.toContain('Wins/Losses');
  });
});
