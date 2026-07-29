import { describe, it, expect, vi, afterEach } from 'vitest';
import { deriveEnemyMaxHp } from '../../src/engine/action/combat-dc.js';
import Database from 'better-sqlite3';
import { PipelineActionStateMachine, enemyConditionBand } from '../../src/engine/action/PipelineActionStateMachine.js';
import { createGeographyFinalize } from '../../src/engine/geography-finalize.js';
import { runMigrations, seedWorld, SEEDED_LOCATIONS, SEEDED_EDGES } from '../../src/db/migrate.js';
import { LocationRepository } from '../../src/db/repositories/location.js';
import { LocationEdgeRepository } from '../../src/db/repositories/locationEdge.js';
import { RelationRepository } from '../../src/db/repositories/relation.js';
import type { CharacterData, ItemData, WorldMutation, CombatStatusData } from '../../src/engine/WorldEngine.js';
import type { MutationContext } from '../../src/engine/action/mutations.js';
import type {
  ClassifyHit,
  PipelineDecideInput,
  PipelineDecideResult,
  PipelineLlmGateway,
  PipelineResolveMutateInput,
  PipelineResolveMutateResult,
  PipelineResolveNarrateInput,
  PipelineResolveNarrateResult,
  PipelineStageResult,
} from '../../src/llm/pipeline/types.js';
import type { CriticGateway, CriticInput, CriticVerdict, LlmContext } from '../../src/llm/LlmGateway.js';
import type { PipelineContextResolver } from '../../src/engine/action/pipeline-context.js';
import type { RelationRow } from '../../src/db/repositories/types.js';

// Deliberately NOT the legacy `MockLlmGateway` (single-decision-shaped) — the pipeline needs
// 4 distinct scriptable stages and sharing the legacy fixture would couple the two machines'
// test suites (Stage 1 backbone plan risk table).
class MockPipelineLlmGateway implements PipelineLlmGateway {
  classifyResult: ClassifyHit | Error = new Error('classify not scripted');
  decideResult: PipelineDecideResult | null = null;
  /** Optional per-call override queue (decide-scene-narration spec): when non-empty, `decide()`
   *  shifts one value per call instead of returning the static `decideResult` — needed for tests
   *  where the establishing decide and the continue decide must return different shapes (e.g.
   *  the combat empty-decision backstop). Falls back to `decideResult` once exhausted. */
  decideResultQueue: PipelineDecideResult[] = [];
  resolveMutateResult: PipelineResolveMutateResult = { mutations: [] };
  resolveNarrateResult: PipelineResolveNarrateResult = { outcomeText: 'It happens.' };

  classifyCalls: { rawInput: string; context: LlmContext }[] = [];
  decideCalls: PipelineDecideInput[] = [];
  resolveMutateCalls: PipelineResolveMutateInput[] = [];
  resolveNarrateCalls: PipelineResolveNarrateInput[] = [];

  async classify(rawInput: string, context: LlmContext): Promise<PipelineStageResult<ClassifyHit>> {
    this.classifyCalls.push({ rawInput, context });
    if (this.classifyResult instanceof Error) throw this.classifyResult;
    return { result: this.classifyResult, callId: 0 };
  }

  async decide(input: PipelineDecideInput): Promise<PipelineStageResult<PipelineDecideResult>> {
    this.decideCalls.push(input);
    if (this.decideResultQueue.length > 0) {
      return { result: this.decideResultQueue.shift() as PipelineDecideResult, callId: 0 };
    }
    if (!this.decideResult) throw new Error('decide not scripted');
    return { result: this.decideResult, callId: 0 };
  }

  async resolveMutate(input: PipelineResolveMutateInput): Promise<PipelineStageResult<PipelineResolveMutateResult>> {
    this.resolveMutateCalls.push(input);
    return { result: this.resolveMutateResult, callId: 0 };
  }

  async resolveNarrate(input: PipelineResolveNarrateInput): Promise<PipelineStageResult<PipelineResolveNarrateResult>> {
    this.resolveNarrateCalls.push(input);
    return { result: this.resolveNarrateResult, callId: 0 };
  }
}

/** Scriptable critic double for the T4 describe block below — one verdict per call by default
 *  (`verdict`), or a queue via `verdicts` for tests that need the ladder to change between calls
 *  (e.g. major-then-not-recritiqued). */
class MockCriticGateway implements CriticGateway {
  verdict: CriticVerdict = { ok: true, severity: 'minor', issues: [] };
  calls: CriticInput[] = [];

  async critique(input: CriticInput): Promise<CriticVerdict> {
    this.calls.push(input);
    return this.verdict;
  }
}

function testChar(overrides?: Partial<CharacterData>): CharacterData {
  return {
    id: 1,
    userId: 1,
    name: 'Aldric',
    class: 'Warrior',
    upbringing: 'Village',
    race: 'Human',
    alignment: 'lawful good',
    dayJob: 'Blacksmith',
    stats: { physical: 3, wisdom: -1, intelligence: 0, charisma: 0 },
    health: 12,
    maxHealth: 12,
    stamina: 10,
    maxStamina: 10,
    rollsRemaining: 2,
    location: "The Warden's Oak",
    wealth: 5,
    lastActionState: null,
    hasRestedToday: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const testItems: ItemData[] = [
  { id: 1, characterId: 1, name: 'Iron Sword', emoji: '⚔️', stat: 'physical', modifier: 2, quantity: 1 },
];

function combatDecideResult(overrides?: Partial<PipelineDecideResult>): PipelineDecideResult {
  return {
    distilledType: 'skirmish',
    stat: 'physical',
    baseDc: 12,
    required: false,
    decision: [
      { label: 'Strike hard', dcModifier: 2 },
      { label: 'Feint first', dcModifier: -1 },
    ],
    ...overrides,
  };
}

describe('PipelineActionStateMachine — happy path', () => {
  it('drives start -> step -> resolution end-to-end with needs_roll:true and a success verdict', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult();
    llm.resolveMutateResult = { mutations: [{ type: 'modify_health', amount: -2 }] };
    llm.resolveNarrateResult = { outcomeText: 'You land a clean hit.' };

    // rollD20 fixed high so success is guaranteed given the fixed bonus/DC below.
    const machine = new PipelineActionStateMachine(llm, () => 20);

    const startResult = await machine.start(testChar(), 'attack the goblin', testItems);
    expect(startResult.resolved).toBe(false);
    if (startResult.resolved) {
      expect(startResult.firstDecision.options.length).toBeGreaterThan(0);

      const stepResult = await machine.step(startResult.state, 'Strike hard', testChar(), testItems);
      expect(stepResult.resolved).toBe(true);
      if (stepResult.resolved) {
        expect(stepResult.outcome.outcome).toBe('success');
        expect(stepResult.outcome.outcomeText).toBe('You land a clean hit.');
        expect(stepResult.outcome.mutations).toEqual([{ type: 'modify_health', amount: -2 }]);
        expect(stepResult.outcome.playerRolled).toBe(20);
        expect(stepResult.outcome.isDivineIntervention).toBeUndefined();
      }
    }

    // Heuristic classify hits on "attack the goblin" — the LLM classify fallback is never called.
    expect(llm.classifyCalls).toHaveLength(0);
  });

  it('caps at the beat limit — a second step resolves without another decide call', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult();
    llm.resolveMutateResult = { mutations: [] };
    llm.resolveNarrateResult = { outcomeText: 'The fight ends.' };

    const machine = new PipelineActionStateMachine(llm, () => 20);
    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const decideCallsBeforeStep1 = llm.decideCalls.length;
    const step1 = await machine.step(started.state, 'Strike hard', testChar(), testItems);
    // First step: one prior decision beat only so far (0 before this step) -> another DECIDE
    // beat is presented, since realOptions is non-empty (combatDecideResult has 2 real options).
    expect(step1.resolved).toBe(false);
    expect(llm.decideCalls.length).toBe(decideCallsBeforeStep1 + 1);

    if (step1.resolved) {
      const step2 = await machine.step(step1.state, 'Strike hard', testChar(), testItems);
      expect(step2.resolved).toBe(true);
      // Beat cap: this is the second decision beat, so resolve happens WITHOUT calling decide again.
      expect(llm.decideCalls.length).toBe(decideCallsBeforeStep1 + 1);
    }
  });
});

describe('PipelineActionStateMachine — typed handoff', () => {
  it('passes a structured object (not prose) into resolveMutate and resolveNarrate', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult();
    llm.resolveMutateResult = { mutations: [{ type: 'modify_stamina', amount: -1 }] };
    llm.resolveNarrateResult = { outcomeText: 'A clash of steel.' };

    const machine = new PipelineActionStateMachine(llm, () => 20);
    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    // Force straight to resolve: script the follow-up decide call with zero real options.
    llm.decideResult = { ...combatDecideResult(), decision: [{ label: 'Step back', dcModifier: null }] };
    const stepResult = await machine.step(started.state, 'Strike hard', testChar(), testItems);
    expect(stepResult.resolved).toBe(true);

    expect(llm.resolveMutateCalls).toHaveLength(1);
    const mutateInput = llm.resolveMutateCalls[0];
    expect(mutateInput.actionType).toBe('combat');
    expect(mutateInput.verdict).toBe('success');
    expect(mutateInput.chosenOption).toEqual({ label: 'Strike hard', dcModifier: 2 });
    expect(mutateInput.decision).toMatchObject({
      distilledType: 'skirmish',
      stat: 'physical',
      required: false,
    });
    expect(Array.isArray(mutateInput.decision.decision)).toBe(true);
    expect(typeof mutateInput.context).toBe('object');
    expect(mutateInput.context.rawInput).toBe('attack the goblin');

    expect(llm.resolveNarrateCalls).toHaveLength(1);
    const narrateInput = llm.resolveNarrateCalls[0];
    expect(narrateInput.actionType).toBe('combat');
    expect(narrateInput.verdict).toBe('success');
    expect(narrateInput.chosenOption).toEqual({ label: 'Strike hard', dcModifier: 2 });
    expect(narrateInput.finalMutations).toEqual([{ type: 'modify_stamina', amount: -1 }]);
  });

  it('hands off the beat-cap resolve with the follow-up decide\'s real baseDc/options, not the accumulated DC or the clamped/bail-augmented pendingDecision.options', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult(); // baseDc: 12, decision: Strike hard(+2)/Feint first(-1)
    llm.resolveMutateResult = { mutations: [] };
    llm.resolveNarrateResult = { outcomeText: 'The fight ends.' };

    const machine = new PipelineActionStateMachine(llm, () => 20);
    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    // Follow-up decide (called inside step1): a distinct baseDc, and a single real option with
    // an out-of-range dcModifier and no bail entry — so `toActionDecision` clamps it and
    // `ensureBail` appends a synthetic "Step back" before it ever reaches pendingDecision.
    // decide() itself never returns either the clamp or the bail entry.
    const followUpDecide: PipelineDecideResult = {
      distilledType: 'skirmish',
      stat: 'physical',
      baseDc: 15,
      required: false,
      decision: [{ label: 'Desperate strike', dcModifier: 8 }],
    };
    llm.decideResult = followUpDecide;

    const step1 = await machine.step(started.state, 'Strike hard', testChar(), testItems);
    expect(step1.resolved).toBe(false);
    if (step1.resolved) throw new Error('expected unresolved step1');
    // Sanity-check the clamp/bail actually happened, so the assertion below is meaningful.
    expect(step1.nextDecision.options).toEqual([
      { label: 'Desperate strike', dcModifier: 5 },
      { label: 'Step back', dcModifier: null },
    ]);

    // Beat cap: this second step resolves without calling decide again, so the handoff must
    // come from the pinned `lastDecideResult` (followUpDecide), not a reconstruction.
    const decideCallsBeforeStep2 = llm.decideCalls.length;
    const step2 = await machine.step(step1.state, 'Desperate strike', testChar(), testItems);
    expect(step2.resolved).toBe(true);
    expect(llm.decideCalls.length).toBe(decideCallsBeforeStep2);

    expect(llm.resolveMutateCalls).toHaveLength(1);
    const decisionForHandoff = llm.resolveMutateCalls[0].decision;
    // decide's actual baseDc (15) — not the accumulated DC (12 + 2 + 5 = 19).
    expect(decisionForHandoff.baseDc).toBe(15);
    // decide's actual raw decision array — not pendingDecision.options (clamped dcModifier: 5,
    // plus ensureBail's synthetic "Step back" entry decide() never returned).
    expect(decisionForHandoff.decision).toEqual([{ label: 'Desperate strike', dcModifier: 8 }]);

    expect(llm.resolveNarrateCalls).toHaveLength(1);
    expect(llm.resolveNarrateCalls[0].decision).toBe(decisionForHandoff);
  });
});

describe('PipelineActionStateMachine — required (reactive) actions', () => {
  it('never adds a bail option to a required action\'s first decision', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = {
      distilledType: 'ambush',
      stat: 'physical',
      baseDc: 14,
      required: true,
      decision: [
        { label: 'Fight back', dcModifier: 3 },
        { label: 'Dodge', dcModifier: -2 },
      ],
    };

    const machine = new PipelineActionStateMachine(llm, () => 20);
    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    expect(started.resolved).toBe(false);
    if (started.resolved) {
      expect(started.firstDecision.options.some(o => o.dcModifier === null)).toBe(false);
    }
  });
});

describe('PipelineDecideResult shape', () => {
  it('carries no mutations/outcomeText fields — the decide mock output passes through untouched', async () => {
    const llm = new MockPipelineLlmGateway();
    const decideResult = combatDecideResult();
    llm.decideResult = decideResult;

    const machine = new PipelineActionStateMachine(llm, () => 20);
    await machine.start(testChar(), 'attack the goblin', testItems);

    expect(llm.decideCalls).toHaveLength(1);
    // decideResult is what the mock returned — assert the raw object has neither key.
    expect(Object.hasOwn(decideResult, 'mutations')).toBe(false);
    expect(Object.hasOwn(decideResult, 'outcomeText')).toBe(false);

    // Type-level assertion: PipelineDecideResult declares neither field. If someone widens the
    // interface to add `mutations`/`outcomeText`, `never` collapses and this file fails to
    // typecheck (npm run typecheck / vitest's esbuild transform does not surface this, so the
    // authoritative check is `tsc --noEmit`).
    type NoMutations = 'mutations' extends keyof PipelineDecideResult ? never : true;
    type NoOutcomeText = 'outcomeText' extends keyof PipelineDecideResult ? never : true;
    const _noMutations: NoMutations = true;
    const _noOutcomeText: NoOutcomeText = true;
    void _noMutations;
    void _noOutcomeText;
  });
});

describe('PipelineActionStateMachine — bail', () => {
  it('resolves with outcome: bailed and a stamina-cost mutation', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult({
      decision: [
        { label: 'Strike hard', dcModifier: 2 },
        { label: 'Step back', dcModifier: null },
      ],
    });

    const machine = new PipelineActionStateMachine(llm, () => 20);
    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const bailOption = started.firstDecision.options.find(o => o.dcModifier === null);
    expect(bailOption).toBeDefined();

    const result = await machine.step(started.state, bailOption!.label, testChar(), testItems);
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.outcome.outcome).toBe('bailed');
      expect(result.outcome.mutations).toEqual([{ type: 'modify_stamina', amount: -1 }]);
    }
    // Bailing never reaches resolve-mutate/resolve-narrate.
    expect(llm.resolveMutateCalls).toHaveLength(0);
    expect(llm.resolveNarrateCalls).toHaveLength(0);
  });
});

describe('PipelineActionStateMachine — needs_roll: false', () => {
  it('resolves a rest action without calling rollD20/resolveRoll (auto-success)', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = {
      distilledType: 'rest',
      stat: 'physical',
      baseDc: 0,
      required: false,
      decision: [{ label: 'Settle in', dcModifier: 0 }],
    };
    llm.resolveMutateResult = { mutations: [{ type: 'modify_stamina', amount: 3 }] };
    llm.resolveNarrateResult = { outcomeText: 'You rest by the fire.' };

    const rollD20 = vi.fn(() => 20);
    const machine = new PipelineActionStateMachine(llm, rollD20);

    const started = await machine.start(testChar(), 'rest at the camp', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    // classifier hits "rest" -> flags.needs_roll === false, so a single-real-option decide
    // (no bail present, since ensureBail adds one — the underlying option below is the only
    // real one) should resolve on the next step once the follow-up decide returns no real
    // options. Script the follow-up to zero real options to force resolve immediately.
    llm.decideResult = { ...llm.decideResult, decision: [{ label: 'Step back', dcModifier: null }] };
    const chosen = started.firstDecision.options.find(o => o.dcModifier !== null);
    expect(chosen).toBeDefined();

    const result = await machine.step(started.state, chosen!.label, testChar(), testItems);
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.outcome.outcome).toBe('success');
      expect(result.outcome.playerRolled).toBeNull();
    }
    expect(rollD20).not.toHaveBeenCalled();
  });
});

describe('PipelineActionStateMachine — D5b mutation-finalization inversion (Task 3)', () => {
  it('narrates and reports the FINAL mutations when an injected finalize drops a proposed one', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult();
    const proposed: WorldMutation[] = [
      { type: 'modify_health', amount: -2 },
      { type: 'add_item', name: 'Goblin Ear', emoji: '👂', stat: 'physical', modifier: 0 },
    ];
    llm.resolveMutateResult = { mutations: proposed };
    llm.resolveNarrateResult = { outcomeText: 'You strike true.' };

    // Deliberately drops the add_item mutation — proves outcome_text/final outcome are
    // authored against what finalize actually returns, not what resolveMutate proposed.
    const finalized: WorldMutation[] = [{ type: 'modify_health', amount: -2 }];
    const finalize = vi.fn((_proposed: WorldMutation[], _ctx: MutationContext) => ({
      mutations: finalized,
      minted: [],
    }));

    const machine = new PipelineActionStateMachine(llm, () => 20, undefined, finalize);
    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    // Force straight to resolve on the next step (zero real follow-up options).
    llm.decideResult = { ...combatDecideResult(), decision: [{ label: 'Step back', dcModifier: null }] };
    const stepResult = await machine.step(started.state, 'Strike hard', testChar(), testItems);
    expect(stepResult.resolved).toBe(true);

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize.mock.calls[0][0]).toEqual(proposed);

    // The MutationContext handed to finalize must be built from the actual char fields (not
    // stale/defaulted values) plus the resolver's known locations — the default no-op resolver
    // here returns [], so knownLocations must come through empty rather than undefined/omitted.
    expect(finalize.mock.calls[0][1]).toEqual({
      currentHealth: 12,
      maxHealth: 12,
      stamina: 10,
      maxStamina: 10,
      wealth: 5,
      rollsRemaining: 2,
      location: "The Warden's Oak",
      knownLocations: [],
    } satisfies MutationContext);

    // resolveNarrate must see the FINALIZED set, not the originally-proposed one.
    expect(llm.resolveNarrateCalls).toHaveLength(1);
    expect(llm.resolveNarrateCalls[0].finalMutations).toEqual(finalized);

    // The resolved ActionOutcome's mutations reflect the finalized set too.
    if (stepResult.resolved) {
      expect(stepResult.outcome.mutations).toEqual(finalized);
    }
  });

  it('defaults to an identity pass-through when no finalize is injected (no live wiring yet in Stage 1)', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult();
    const proposed: WorldMutation[] = [{ type: 'modify_stamina', amount: -1 }];
    llm.resolveMutateResult = { mutations: proposed };
    llm.resolveNarrateResult = { outcomeText: 'A clash of steel.' };

    const machine = new PipelineActionStateMachine(llm, () => 20); // no finalize override
    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    llm.decideResult = { ...combatDecideResult(), decision: [{ label: 'Step back', dcModifier: null }] };
    const stepResult = await machine.step(started.state, 'Strike hard', testChar(), testItems);
    expect(stepResult.resolved).toBe(true);

    expect(llm.resolveNarrateCalls[0].finalMutations).toEqual(proposed);
    if (stepResult.resolved) {
      expect(stepResult.outcome.mutations).toEqual(proposed);
    }
  });
});

describe('PipelineActionStateMachine — D6 travel-coherence gate (Task 4)', () => {
  it('injects the missing set_location on the forge->forest teleport (no set_location authored)', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult({ sceneLocation: 'the woods' });
    // resolveMutate authors a fight in the forest with NO relocate mutation — the D6 bug repro.
    llm.resolveMutateResult = { mutations: [{ type: 'modify_health', amount: -3 }] };
    llm.resolveNarrateResult = { outcomeText: 'A boar charges from the treeline.' };

    const machine = new PipelineActionStateMachine(llm, () => 20);
    const char = testChar({ location: 'The Town Forge' });
    const started = await machine.start(char, 'go to the woods and brawl', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    // Force straight to resolve on the first step (zero real follow-up options).
    llm.decideResult = { ...combatDecideResult({ sceneLocation: 'the woods' }), decision: [{ label: 'Step back', dcModifier: null }] };
    const stepResult = await machine.step(started.state, 'Strike hard', char, testItems);
    expect(stepResult.resolved).toBe(true);
    if (stepResult.resolved) {
      expect(stepResult.outcome.mutations).toEqual([
        { type: 'modify_health', amount: -3 },
        { type: 'set_location', name: 'the woods' },
      ]);
    }
  });

  it('does not inject a duplicate when resolveMutate already authored the travel', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult({ sceneLocation: 'the woods' });
    llm.resolveMutateResult = {
      mutations: [
        { type: 'set_location', name: 'the woods' },
        { type: 'modify_health', amount: -3 },
      ],
    };
    llm.resolveNarrateResult = { outcomeText: 'You march into the woods and the boar charges.' };

    const machine = new PipelineActionStateMachine(llm, () => 20);
    const char = testChar({ location: 'The Town Forge' });
    const started = await machine.start(char, 'go to the woods and brawl', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    llm.decideResult = { ...combatDecideResult({ sceneLocation: 'the woods' }), decision: [{ label: 'Step back', dcModifier: null }] };
    const stepResult = await machine.step(started.state, 'Strike hard', char, testItems);
    expect(stepResult.resolved).toBe(true);
    if (stepResult.resolved) {
      expect(stepResult.outcome.mutations).toEqual([
        { type: 'set_location', name: 'the woods' },
        { type: 'modify_health', amount: -3 },
      ]);
    }
  });

  it('fires the gate on a scene that diverges on the terminating decide, not just the opening one', async () => {
    const llm = new MockPipelineLlmGateway();
    // Opening decide's scene is coherent with the character's actual location.
    llm.decideResult = combatDecideResult({ sceneLocation: 'The Town Forge' });
    llm.resolveMutateResult = { mutations: [{ type: 'modify_health', amount: -3 }] };
    llm.resolveNarrateResult = { outcomeText: 'The fight spills into the trees.' };

    const machine = new PipelineActionStateMachine(llm, () => 20);
    const char = testChar({ location: 'The Town Forge' });
    const started = await machine.start(char, 'go to the woods and brawl', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    // The terminating (follow-up) decide is where the scene diverges — zero real options forces
    // the zero-real-options resolve branch in step(), which must refresh sceneLocation from THIS
    // decide rather than resolving against the stale opening one.
    llm.decideResult = {
      ...combatDecideResult({ sceneLocation: 'the deep woods' }),
      decision: [{ label: 'Step back', dcModifier: null }],
    };
    const stepResult = await machine.step(started.state, 'Strike hard', char, testItems);
    expect(stepResult.resolved).toBe(true);
    if (stepResult.resolved) {
      expect(stepResult.outcome.mutations).toContainEqual({ type: 'set_location', name: 'the deep woods' });
    }
  });

  it('runs the gate BEFORE finalize, so an injected finalize spy observes the gated set_location', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult({ sceneLocation: 'the woods' });
    // resolveMutate authors no relocate mutation — the gate must inject one before finalize runs.
    llm.resolveMutateResult = { mutations: [{ type: 'modify_health', amount: -3 }] };
    llm.resolveNarrateResult = { outcomeText: 'A boar charges from the treeline.' };

    const finalize = vi.fn((muts: WorldMutation[], _ctx: MutationContext) => ({ mutations: muts, minted: [] }));
    const machine = new PipelineActionStateMachine(llm, () => 20, undefined, finalize);
    const char = testChar({ location: 'The Town Forge' });
    const started = await machine.start(char, 'go to the woods and brawl', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    llm.decideResult = { ...combatDecideResult({ sceneLocation: 'the woods' }), decision: [{ label: 'Step back', dcModifier: null }] };
    const stepResult = await machine.step(started.state, 'Strike hard', char, testItems);
    expect(stepResult.resolved).toBe(true);

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize.mock.calls[0][0]).toContainEqual({ type: 'set_location', name: 'the woods' });
  });
});

describe('PipelineActionStateMachine — D6 x T5b: the gate injects intent, geography enforces feasibility', () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  it('drops the D6-injected set_location as unreachable when a REAL geography finalize is wired in', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    seedWorld(db, SEEDED_LOCATIONS, SEEDED_EDGES);
    const locationRepo = new LocationRepository(db);
    const edgeRepo = new LocationEdgeRepository(db);
    const finalize = createGeographyFinalize({ locationRepo, edgeRepo });

    const resolver = {
      getNearbyNpcs: () => [],
      getNearbyPcs: () => [],
      getRecentActions: () => [],
      getKnownLocations: () => locationRepo.findAll().map((l) => l.name),
      isLocationSafe: () => true,
      getLocalGeography: () => ({ region: null, neighbours: [], frontiers: [] }),
    };

    const llm = new MockPipelineLlmGateway();
    // "The Frozen Wastes" is neither a seeded location nor reachable from the Oak (assets/world/
    // {locations,edges}.yml) — an unknown/dark place, contrast with the identity-finalize D6
    // tests above where the gate's injected move always survives.
    llm.decideResult = combatDecideResult({ sceneLocation: 'The Frozen Wastes' });
    // resolveMutate authors no relocate mutation — the D6 gate must inject one, which real
    // geography then has to feasibility-check.
    llm.resolveMutateResult = { mutations: [{ type: 'modify_health', amount: -3 }] };
    llm.resolveNarrateResult = { outcomeText: 'The scene shifts, but the map disagrees.' };

    const machine = new PipelineActionStateMachine(llm, () => 20, resolver, finalize);
    const char = testChar({ location: "The Warden's Oak" });
    const started = await machine.start(char, 'go to the woods and brawl', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    // Force straight to resolve on the first step (zero real follow-up options) — same shape as
    // the identity-finalize D6 tests above.
    llm.decideResult = {
      ...combatDecideResult({ sceneLocation: 'The Frozen Wastes' }),
      decision: [{ label: 'Step back', dcModifier: null }],
    };
    const stepResult = await machine.step(started.state, 'Strike hard', char, testItems);
    expect(stepResult.resolved).toBe(true);
    if (stepResult.resolved) {
      // T4's gate injected `set_location` to the scene; real geography then dropped it as
      // unreachable/unknown — the char stays put. Proves the two stages compose: the gate injects
      // intent, geography enforces feasibility.
      expect(stepResult.outcome.mutations).toEqual([{ type: 'modify_health', amount: -3 }]);
    }
  });
});

describe('PipelineActionStateMachine — classify-fallback-total-failure', () => {
  it('sets isDivineIntervention: true rather than any string sentinel check', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.classifyResult = new Error('llm classify fallback rejected');

    const machine = new PipelineActionStateMachine(llm, () => 20);
    // Ambiguous input the heuristic table can't classify (matches zero tables).
    const result = await machine.start(testChar(), 'ponder the void', testItems);

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.outcome.isDivineIntervention).toBe(true);
      expect(result.outcome.outcome).toBe('done');
      expect(result.outcome.mutations).toEqual([]);
      expect(typeof result.outcome.outcomeText).toBe('string');
      expect(result.outcome.outcomeText.length).toBeGreaterThan(0);
      // Typed flag, not a string sentinel like legacy's distilledType === '__divine__'.
      expect(result.outcome.distilledType).not.toBe('__divine__');
    }
    expect(llm.classifyCalls).toHaveLength(1);
    // The rejection never escapes start() as an unhandled rejection/throw.
  });

  it('a heuristic miss whose LLM classify SUCCEEDS pins the returned ActionType + flags (T3)', async () => {
    const llm = new MockPipelineLlmGateway();
    // The fallback resolves the miss to a concrete type + flags — the machine must pin these
    // (not re-derive), then proceed into a normal decision beat.
    llm.classifyResult = {
      kind: 'hit',
      actionType: 'skill',
      flags: { unsafe_location: false, needs_roll: true, target_present: true },
    };
    llm.decideResult = combatDecideResult({ distilledType: 'tinker' });

    const machine = new PipelineActionStateMachine(llm, () => 20);
    // "ponder the void" matches zero heuristic tables → a miss → the LLM fallback runs.
    const result = await machine.start(testChar(), 'ponder the void', testItems);

    expect(llm.classifyCalls).toHaveLength(1);
    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.state.actionType).toBe('skill');
      expect(result.state.flags).toEqual({ unsafe_location: false, needs_roll: true, target_present: true });
    }
    // The pinned type is what DECIDE was routed with — proof it wasn't silently re-derived.
    expect(llm.decideCalls[0].actionType).toBe('skill');
    expect(llm.decideCalls[0].flags.needs_roll).toBe(true);
  });
});

/**
 * T5 — per-round combat beat logging. Round 1 of a fresh fight needs no scene-state
 * persistence (combat establishes fresh off `lastDecideResult.combatEnemy` regardless of any
 * resolver), so these assert directly against the raw `PipelineActionStateMachine.step()`
 * result — the ONLY place `combatBeat` is observable on a non-resolved beat.
 * `PipelineSimEngine.stepAction` (the sim harness's public wrapper, tests/sim/pipeline-sim.test.ts)
 * deliberately does not forward it on the non-resolved branch (mirrors the existing `mutations`
 * precedent — internal-only, consumed for accumulation, never re-exposed on `ActionStepResult`).
 */
describe('PipelineActionStateMachine — T5 combat telemetry beat shape', () => {
  function combatEnemyDecideResult(overrides?: Partial<PipelineDecideResult>): PipelineDecideResult {
    return {
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 10,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      combatEnemy: { name: 'Goblin', anchor: 'location' },
      ...overrides,
    };
  }

  it('a fought CONTINUE round carries a combatBeat with the right shape', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatEnemyDecideResult();

    // player d20=10, enemy d20=10 (no crit). testChar physical=3 + Iron Sword +2 = playerBonus 5;
    // baseDc=10 -> enemyBonus=clamp(0,0,10)=0. margin=(10+5)-(10+0)=5 -> glanced band
    // (enemyHpDelta -3, playerHpDelta 0). enemyMaxHp=deriveEnemyMaxHp(10)=10, so round 1 neither
    // wins, floors, nor caps — a clean CONTINUE.
    const rolls = [10, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(step.resolved).toBe(false);
    if (step.resolved) throw new Error('expected unresolved step');

    expect(step.combatBeat).toEqual({
      round: 1,
      band: 'glanced',
      enemyHpBefore: 10,
      enemyHpAfter: 7,
      playerHpDelta: 0,
      playerD20: 10,
      playerBonus: 5,
      dc: 10,
      enemyD20: 10,
      enemyBonus: 0,
      margin: 5,
      materialMutationFired: true,
      ops: ['set_relation'],
      marker: 'combat_round',
    });
    expect(step.combatBeat?.floorSave).toBeUndefined();
  });

  it('the desperate-choice (floor) beat carries floorSave: true', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatEnemyDecideResult();

    // player d20=1 forces `heavy` regardless of margin (amplified nominal playerHpDelta -3-2=-5); a
    // low-health character (3 HP) would-be-lethal on round 1, firing the once-per-day floor.
    // The beat persists the ACTUAL applied delta (floored to 1 HP): 1 - 3 = -2, not the -5 nominal.
    const rolls = [1, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);
    const lowChar = testChar({ health: 3 });

    const started = await machine.start(lowChar, 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Press the attack', lowChar, testItems);
    expect(step.resolved).toBe(false);
    if (step.resolved) throw new Error('expected unresolved step');

    expect(step.combatBeat).toEqual({
      round: 1,
      band: 'heavy',
      enemyHpBefore: 10,
      enemyHpAfter: 9,
      playerHpDelta: -2,
      playerD20: 1,
      playerBonus: 5,
      dc: 10,
      enemyD20: 10,
      enemyBonus: 0,
      margin: -4,
      materialMutationFired: true,
      ops: ['modify_health', 'set_relation', 'set_relation'],
      marker: 'combat_round',
      floorSave: true,
    });
  });

  it('a generic (non-combat) continue carries no combatBeat', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = {
      distilledType: 'investigate',
      stat: 'wisdom',
      baseDc: 8,
      required: false,
      decision: [
        { label: 'Search the room', dcModifier: 0 },
        { label: 'Feint first', dcModifier: -1 },
      ],
    };

    const machine = new PipelineActionStateMachine(llm, () => 10);
    const started = await machine.start(testChar(), 'search the room', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Search the room', testChar(), testItems);
    expect(step.resolved).toBe(false);
    if (step.resolved) throw new Error('expected unresolved step');

    expect(step.combatBeat).toBeUndefined();
  });
});

/**
 * ANSI-D — the accumulated per-fight round log (`ActionDecision.combatRounds` /
 * `ActionOutcome.combatRounds`). The multi-round accumulation case needs a DB-backed resolver to
 * round-trip `in_combat` between separate `step()` calls (see the `PipelineSimEngine` test,
 * tests/sim/pipeline-sim.test.ts, 'T5 — combat telemetry + metrics'); the two cases below —
 * first-round-kill and the legacy tolerant read — don't need persisted scene-state, so they stay
 * here against the raw machine.
 */
describe('PipelineActionStateMachine — ANSI-D combatRounds', () => {
  function combatEnemyDecideResult(overrides?: Partial<PipelineDecideResult>): PipelineDecideResult {
    return {
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 10,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      combatEnemy: { name: 'Goblin', anchor: 'location' },
      ...overrides,
    };
  }

  it('a first-round-kill fight has exactly one entry in combatRounds, matching the terminal combatBeat', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [combatEnemyDecideResult({ baseDc: 6 })];

    // baseDc=6 -> enemyMaxHp=6; player nat-20 (clean, amplified -8) kills outright in round 1.
    // playerBonus=5 (physical 3 + Iron Sword 2), enemyBonus=clamp(6-10,0,10)=0, dc=6,
    // margin=(20+5)-(1+0)=24 (mirrors the combatFrame test above using the same rolls/baseDc).
    const rolls = [20, 1];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    // SL-6: the WIN round now surfaces the fatal-blow interstitial instead of resolving
    // straight through — an extra step() is needed to actually terminate the fight, and it
    // must consume no further roll (rolls has only 2 entries, both already spent above).
    const interstitial = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(interstitial.resolved).toBe(false);
    if (interstitial.resolved) throw new Error('expected unresolved fatal-blow interstitial');
    expect(interstitial.nextDecision.options).toEqual([
      { label: 'Finish it', dcModifier: 0 },
      { label: 'Show mercy', dcModifier: 0 },
    ]);
    expect(interstitial.combatBeat).toBeUndefined();

    const step = await machine.step(interstitial.state, 'Finish it', testChar(), testItems);
    expect(step.resolved).toBe(true);
    if (!step.resolved) throw new Error('expected resolved step');
    expect(i).toBe(2); // the resume consumed no additional roll

    expect(step.outcome.combatRounds).toHaveLength(1);
    expect(step.outcome.combatRounds?.[0]).toEqual({
      round: 1,
      band: 'clean',
      enemyHpBefore: 6,
      enemyHpAfter: 0,
      playerHpDelta: 0,
      playerD20: 20,
      playerBonus: 5,
      dc: 6,
      enemyD20: 1,
      enemyBonus: 0,
      margin: 24,
      materialMutationFired: true,
      ops: ['set_relation'],
      marker: 'combat_round',
      fatalBlow: 'finish',
    });
    // Nothing derived twice: the sole round-log entry IS the terminal combatBeat, not a
    // second computation of the same round's maths.
    expect(step.outcome.combatBeat).toEqual(step.outcome.combatRounds?.[0]);
  });

  it('a legacy in-flight state whose pendingDecision has no combatRounds key reads tolerantly (empty, never throws)', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatEnemyDecideResult();

    // Two clean glanced rounds (no crit/floor/cap) so both step()s land on CONTINUE.
    const rolls = [10, 10, 10, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const round1 = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    if (round1.resolved) throw new Error('expected unresolved step');
    expect(round1.nextDecision.combatRounds).toHaveLength(1);

    // Simulate a fight in flight from before ANSI-D shipped: the persisted state's
    // pendingDecision JSON never had a `combatRounds` key at all (not merely `undefined`).
    const { combatRounds: _legacyOmitted, ...legacyPendingDecision } = round1.state.pendingDecision;
    const legacyState = { ...round1.state, pendingDecision: legacyPendingDecision };

    const round2 = await machine.step(legacyState, 'Press the attack', testChar(), testItems);
    expect(round2.resolved).toBe(false);
    if (round2.resolved) throw new Error('expected unresolved step');

    // Tolerant read: a missing list starts fresh from `[]`, never throws, and never carries
    // phantom rounds forward from a key that was never there.
    expect(round2.nextDecision.combatRounds).toHaveLength(1);
    expect(round2.nextDecision.combatRounds?.[0].round).toBe(1);
  });
});

/**
 * decide-scene-narration follow-up (v12 polish): DECIDE authors `narration` on CONTINUE beats
 * only — an amendment to D5b's "DECIDE authors no prose" — and the engine threads it onto the
 * next screen and the beat's `ActionDecisionRecord` (both `step()` record sites). The first
 * beat (NEW_ACTION) stays lean regardless, since DECIDE never authors narration there.
 */
describe('PipelineActionStateMachine — decide-scene-narration: narration threading', () => {
  it('NEW_ACTION stays narration-free and the CTA reads "what do you do?"', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult(); // 'skirmish', no `narration` field
    const machine = new PipelineActionStateMachine(llm, () => 20);

    const started = await machine.start(testChar(), 'search the ruins', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    expect(started.firstDecision.narration).toBeUndefined();
    expect(started.firstDecision.prompt).toBe('Skirmish — what do you do?');
  });

  it('a non-combat CONTINUE threads narration onto nextDecision and the normal step() record', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = {
      distilledType: 'investigate',
      stat: 'wisdom',
      baseDc: 10,
      required: false,
      decision: [
        { label: 'Search the room', dcModifier: 0 },
        { label: 'Check the ledger', dcModifier: 1 },
      ],
    };
    const machine = new PipelineActionStateMachine(llm, () => 20);
    const started = await machine.start(testChar(), 'investigate the room', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    expect(started.firstDecision.narration).toBeUndefined();

    // Beat 2 (CONTINUE) — DECIDE authors narration this time.
    llm.decideResult = {
      distilledType: 'investigate',
      stat: 'wisdom',
      baseDc: 10,
      required: false,
      narration: 'The ledger names a debt long overdue.',
      decision: [
        { label: 'Follow the debt', dcModifier: 0 },
        { label: 'Move on', dcModifier: -1 },
      ],
    };
    const step1 = await machine.step(started.state, 'Search the room', testChar(), testItems);
    if (step1.resolved) throw new Error('expected unresolved step');
    expect(step1.nextDecision.narration).toBe('The ledger names a debt long overdue.');
    expect(step1.nextDecision.prompt).toBe('Investigate — what do you do?');

    // Beat 3 hits the MAX_DECISIONS_PER_ACTION beat cap and resolves directly (no third decide
    // call) — the normal record site for THIS choice still captures beat 2's narration first.
    const step2 = await machine.step(step1.state, 'Follow the debt', testChar(), testItems);
    expect(step2.resolved).toBe(true);
    if (!step2.resolved) return;
    expect(step2.state.decisions).toHaveLength(2);
    expect(step2.state.decisions[0].narration).toBeUndefined(); // beat 1 (NEW_ACTION)
    expect(step2.state.decisions[1].narration).toBe('The ledger names a debt long overdue.'); // beat 2
  });

  it('bailing off a narrated CONTINUE beat still copies narration onto the bail record', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = {
      distilledType: 'investigate',
      stat: 'wisdom',
      baseDc: 10,
      required: false,
      decision: [
        { label: 'Search the room', dcModifier: 0 },
        { label: 'Check the corner', dcModifier: 1 },
      ],
    };
    const machine = new PipelineActionStateMachine(llm, () => 20);
    const started = await machine.start(testChar(), 'investigate the room', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    llm.decideResult = {
      distilledType: 'investigate',
      stat: 'wisdom',
      baseDc: 10,
      required: false,
      narration: 'A cold draft slips under the door.',
      decision: [{ label: 'Keep searching', dcModifier: 0 }],
    };
    const step1 = await machine.step(started.state, 'Search the room', testChar(), testItems);
    if (step1.resolved) throw new Error('expected unresolved step');
    // required:false + a single real option -> ensureBail added a 'Step back' bail option.
    const bailOption = step1.nextDecision.options.find(o => o.dcModifier === null);
    expect(bailOption?.label).toBe('Step back');

    const step2 = await machine.step(step1.state, bailOption!.label, testChar(), testItems);
    expect(step2.resolved).toBe(true);
    if (!step2.resolved) return;
    expect(step2.outcome.outcome).toBe('bailed');
    expect(step2.state.decisions).toHaveLength(2);
    expect(step2.state.decisions[0].narration).toBeUndefined(); // beat 1 (NEW_ACTION)
    expect(step2.state.decisions[1].narration).toBe('A cold draft slips under the door.'); // bail record
  });
});

/**
 * decide-scene-narration follow-up: combat's contested roll resolves the moment the player
 * picks an option, so every combat continue-screen already sits on a fresh, engine-computed
 * result. The engine hands that round summary to DECIDE (so narration is faithful to the dice)
 * and composes `combatStatus` from the same engine truth — banded enemy condition, never exact
 * enemy HP, plus the player's own exact HP movement.
 */
describe('PipelineActionStateMachine — decide-scene-narration: combat continue enrichment', () => {
  function combatEnemyDecideResult(overrides?: Partial<PipelineDecideResult>): PipelineDecideResult {
    return {
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 10,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      combatEnemy: { name: 'Goblin', anchor: 'location' },
      ...overrides,
    };
  }

  it('enriches the continue-decide context with combatRoundSummary and threads narration + combatStatus', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [
      combatEnemyDecideResult(),
      combatEnemyDecideResult({
        narration: 'The goblin snarls, blood streaming from its arm.',
        decision: [
          { label: 'Press the attack', dcModifier: 0, stat: 'physical' },
          { label: 'Aim for the eyes', dcModifier: 2, stat: 'wisdom' },
        ],
      }),
    ];

    // player d20=10, enemy d20=10: playerBonus 3(physical)+2(Iron Sword)=5, enemyBonus
    // clamp(baseDc-10,0,10)=0. margin=5 -> 'glanced' (enemyHpDelta -3, playerHpDelta 0).
    // enemyMaxHp=deriveEnemyMaxHp(10)=10 -> round 1 neither wins, floors, nor caps: a CONTINUE.
    const rolls = [10, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(step.resolved).toBe(false);
    if (step.resolved) throw new Error('expected unresolved step');

    expect(llm.decideCalls).toHaveLength(2);
    expect(llm.decideCalls[1].context.combatRoundSummary).toEqual({
      band: 'glanced',
      playerHpDelta: 0,
      enemyHpDelta: -3,
      chosenOption: { label: 'Press the attack' },
    });

    expect(step.nextDecision.narration).toBe('The goblin snarls, blood streaming from its arm.');
    // enemyHp 7/10=0.7 -> round(3.5)=4 filled pips (Bloodied band); player took no damage.
    // ANSI-C: the engine emits structured CombatStatusData (banding maths only, no rendered
    // ANSI); the presentation layer composes the AnsiRenderer frame from it.
    const cs = step.nextDecision.combatStatus as CombatStatusData;
    expect(cs.enemyName).toBe('Goblin');
    expect(cs.pips).toEqual({ filled: 4, total: 5 }); // never exact enemy HP — banded only
    expect(cs.woundWord).toBe('Bloodied');
    expect(cs.playerHp).toBe(12); // player untouched this round
    expect(cs.playerMaxHp).toBe(12);
    expect(cs.playerHpDelta).toBe(0);
  });

  it('warns (telemetry only, no retry) when the continue options all share stat + dcModifier', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [
      combatEnemyDecideResult(),
      combatEnemyDecideResult({
        decision: [
          { label: 'Strike low', dcModifier: 1, stat: 'physical' },
          { label: 'Strike high', dcModifier: 1, stat: 'physical' },
        ],
      }),
    ];
    const rolls = [10, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const started = await machine.start(testChar(), 'attack the goblin', testItems);
      if (started.resolved) throw new Error('expected unresolved start');
      const step = await machine.step(started.state, 'Press the attack', testChar(), testItems);
      expect(step.resolved).toBe(false);
      if (step.resolved) throw new Error('expected unresolved step');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('mechanical-diversity'),
        expect.anything(),
        expect.anything(),
      );
      // Telemetry only — no bounded re-decide (unlike the single-option validator, which skips
      // combat by design; this check has no re-decide ladder at all).
      expect(llm.decideCalls).toHaveLength(2);
      expect(step.nextDecision.options.map(o => o.label)).toEqual(['Strike low', 'Strike high', 'Flee the fight']);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * decide-scene-narration follow-up: the combat empty-decision backstop (belt and braces). If
 * the fresh continue-decide yields zero real options, the engine injects two deterministic
 * options BEFORE the guaranteed flee append, so a flee-only screen never reaches the player.
 */
describe('PipelineActionStateMachine — decide-scene-narration: combat empty-decision backstop', () => {
  function combatEnemyDecideResult(overrides?: Partial<PipelineDecideResult>): PipelineDecideResult {
    return {
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 10,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      combatEnemy: { name: 'Goblin', anchor: 'location' },
      ...overrides,
    };
  }

  it('injects Press the attack + Fight defensively before flee, and sets emptyDecisionFallback', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [
      combatEnemyDecideResult(),
      combatEnemyDecideResult({ decision: [] }), // the dev-DB 34/35 pattern: an empty continue decision
    ];
    const rolls = [10, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const started = await machine.start(testChar(), 'attack the goblin', testItems);
      if (started.resolved) throw new Error('expected unresolved start');
      const step = await machine.step(started.state, 'Press the attack', testChar(), testItems);
      expect(step.resolved).toBe(false);
      if (step.resolved) throw new Error('expected unresolved step');

      expect(step.nextDecision.options.map(o => o.label)).toEqual([
        'Press the attack',
        'Fight defensively',
        'Flee the fight',
      ]);
      expect(step.nextDecision.options.find(o => o.label === 'Fight defensively')).toEqual({
        label: 'Fight defensively', dcModifier: -1, stat: 'physical',
      });
      // Never a flee-only screen — at least one non-flee option is always present.
      expect(step.nextDecision.options.some(o => o.label !== 'Flee the fight')).toBe(true);

      expect(step.combatBeat?.emptyDecisionFallback).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('fires the backstop when the only decide-authored option is a wayward "Flee the fight"', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [
      combatEnemyDecideResult(),
      // A wayward LLM authors a real (non-null dcModifier) 'Flee the fight' despite BASE Rule 3 —
      // it must be stripped as the guaranteed flee's duplicate BEFORE the emptiness check runs,
      // not after, or the backstop wrongly skips and the screen ends up flee-only.
      combatEnemyDecideResult({ decision: [{ label: 'Flee the fight', dcModifier: 1, stat: 'physical' }] }),
    ];
    const rolls = [10, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const started = await machine.start(testChar(), 'attack the goblin', testItems);
      if (started.resolved) throw new Error('expected unresolved start');
      const step = await machine.step(started.state, 'Press the attack', testChar(), testItems);
      expect(step.resolved).toBe(false);
      if (step.resolved) throw new Error('expected unresolved step');

      expect(step.nextDecision.options.map(o => o.label)).toEqual([
        'Press the attack',
        'Fight defensively',
        'Flee the fight',
      ]);
      // Exactly one flee option — the engine's guaranteed one, not the wayward authored one.
      expect(step.nextDecision.options.filter(o => o.label === 'Flee the fight')).toHaveLength(1);
      expect(step.nextDecision.options.find(o => o.label === 'Flee the fight')).toEqual({
        label: 'Flee the fight', dcModifier: null,
      });
      // Never a flee-only screen — at least one non-flee option is always present.
      expect(step.nextDecision.options.some(o => o.label !== 'Flee the fight')).toBe(true);

      expect(step.combatBeat?.emptyDecisionFallback).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * T4 — critic re-placement (D7): the single `CriticGateway.critique` interface invoked at two
 * in-machine sites (gated coherence critic over DECIDE, faithfulness prose critic over
 * RESOLVE-NARRATE). The critic is an OPTIONAL 5th constructor param — every describe block above
 * this one constructs the machine without one, so those 20 tests staying green already proves the
 * no-critic path is untouched; the explicit no-critic test below (#6) is a cheap extra belt.
 */
describe('PipelineActionStateMachine — T4 critic', () => {
  it('prose critic patches outcomeText only — mutations stay byte-identical to a no-critic run', async () => {
    const buildLlm = () => {
      const llm = new MockPipelineLlmGateway();
      llm.decideResult = combatDecideResult();
      llm.resolveMutateResult = { mutations: [{ type: 'modify_health', amount: -2 }] };
      llm.resolveNarrateResult = { outcomeText: 'You land a clean hit.' };
      return llm;
    };
    const forceResolve = (llm: MockPipelineLlmGateway) => {
      llm.decideResult = { ...combatDecideResult(), decision: [{ label: 'Step back', dcModifier: null }] };
    };

    // Baseline: no critic at all — captures the exact mutations array T4 must not disturb.
    const baselineLlm = buildLlm();
    const baselineMachine = new PipelineActionStateMachine(baselineLlm, () => 20);
    const baselineStarted = await baselineMachine.start(testChar(), 'attack the goblin', testItems);
    if (baselineStarted.resolved) throw new Error('expected unresolved start');
    forceResolve(baselineLlm);
    const baselineStep = await baselineMachine.step(baselineStarted.state, 'Strike hard', testChar(), testItems);
    if (!baselineStep.resolved) throw new Error('expected resolved step');

    // Critic run: a minor prose defect patches outcomeText only. Pinned to 'always' because this
    // test owns the prose critic's PATCHING contract, not the gating policy — the SL-3 default
    // ('narrate-gated') deliberately skips the narrate critic on a clean beat like this one, so
    // leaving the mode implicit would test the gate instead of the patch.
    const llm = buildLlm();
    const critic = new MockCriticGateway();
    critic.verdict = { ok: false, severity: 'minor', issues: ['prose drifted from the final mutations'], patch: { outcomeText: 'patched' } };
    const machine = new PipelineActionStateMachine(llm, () => 20, undefined, undefined, critic, 'always');
    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    forceResolve(llm);
    const step = await machine.step(started.state, 'Strike hard', testChar(), testItems);
    if (!step.resolved) throw new Error('expected resolved step');

    expect(step.outcome.outcomeText).toBe('patched');
    // This is the acceptance criterion in concrete form: the prose critic never receives or
    // returns mutations, so the finalized array is exactly what the no-critic run produced.
    expect(step.outcome.mutations).toEqual(baselineStep.outcome.mutations);
  });

  it('resolution major defect keeps the original outcomeText and leaves mutations untouched', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult();
    llm.resolveMutateResult = { mutations: [{ type: 'modify_health', amount: -2 }] };
    llm.resolveNarrateResult = { outcomeText: 'You land a clean hit.' };

    const critic = new MockCriticGateway();
    critic.verdict = { ok: false, severity: 'major', issues: ['structurally wrong'] };
    const machine = new PipelineActionStateMachine(llm, () => 20, undefined, undefined, critic);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    llm.decideResult = { ...combatDecideResult(), decision: [{ label: 'Step back', dcModifier: null }] };
    const step = await machine.step(started.state, 'Strike hard', testChar(), testItems);
    if (!step.resolved) throw new Error('expected resolved step');

    expect(step.outcome.outcomeText).toBe('You land a clean hit.');
    expect(step.outcome.mutations).toEqual([{ type: 'modify_health', amount: -2 }]);
  });

  it('coherence gate: a major verdict on a required decide beat triggers exactly ONE bounded re-decide', async () => {
    const llm = new MockPipelineLlmGateway();
    const originalDecide: PipelineDecideResult = {
      distilledType: 'ambush',
      stat: 'physical',
      baseDc: 14,
      required: true,
      decision: [
        { label: 'Fight back', dcModifier: 3 },
        { label: 'Dodge', dcModifier: -2 },
      ],
    };
    // A distinct distilledType on the re-decide result lets the assertion below prove the
    // RETURNED decision is the second (re-decided) call, not the discarded first one.
    const redecided: PipelineDecideResult = { ...originalDecide, distilledType: 'ambush-corrected' };
    const results = [originalDecide, redecided];
    let callCount = 0;
    llm.decide = async (input: PipelineDecideInput): Promise<PipelineStageResult<PipelineDecideResult>> => {
      llm.decideCalls.push(input);
      return { result: results[Math.min(callCount++, results.length - 1)], callId: 0 };
    };

    const critic = new MockCriticGateway();
    critic.verdict = { ok: false, severity: 'major', issues: ['combat silently converted'] };
    const machine = new PipelineActionStateMachine(llm, () => 20, undefined, undefined, critic);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);

    // Grew by exactly 1 (the original decide + the one bounded re-decide).
    expect(llm.decideCalls).toHaveLength(2);
    expect(llm.decideCalls[1].context.criticNote).toContain('combat silently converted');
    // The re-decide is NOT itself re-critiqued.
    expect(critic.calls).toHaveLength(1);
    if (started.resolved) throw new Error('expected unresolved start');
    expect(started.state.distilledType).toBe('ambush-corrected');
  });

  it('coherence gate: an ok verdict passes the decide result through untouched (no re-decide)', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = {
      distilledType: 'ambush',
      stat: 'physical',
      baseDc: 14,
      required: true,
      decision: [
        { label: 'Fight back', dcModifier: 3 },
        { label: 'Dodge', dcModifier: -2 },
      ],
    };
    const critic = new MockCriticGateway();
    critic.verdict = { ok: true, severity: 'minor', issues: [] };
    const machine = new PipelineActionStateMachine(llm, () => 20, undefined, undefined, critic);

    await machine.start(testChar(), 'attack the goblin', testItems);

    expect(llm.decideCalls).toHaveLength(1);
    expect(critic.calls).toHaveLength(1);
  });

  it('coherence gate: fires on every decide beat (required gate removed — §3 v12 QA)', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult(); // required: false
    const critic = new MockCriticGateway();
    critic.verdict = { ok: true, severity: 'minor', issues: [] };
    const machine = new PipelineActionStateMachine(llm, () => 20, undefined, undefined, critic);

    await machine.start(testChar(), 'attack the goblin', testItems);

    // §3: critic now fires on every decide beat, not just required ones.
    expect(critic.calls).toHaveLength(1);
    expect(critic.calls[0].beat).toBe('decision');
  });

  it('no critic constructed — critic logic is entirely a no-op', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult();
    llm.resolveMutateResult = { mutations: [{ type: 'modify_health', amount: -2 }] };
    llm.resolveNarrateResult = { outcomeText: 'You land a clean hit.' };

    const machine = new PipelineActionStateMachine(llm, () => 20); // no critic param at all
    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    llm.decideResult = { ...combatDecideResult(), decision: [{ label: 'Step back', dcModifier: null }] };
    const step = await machine.step(started.state, 'Strike hard', testChar(), testItems);
    expect(step.resolved).toBe(true);
    if (step.resolved) {
      expect(step.outcome.outcomeText).toBe('You land a clean hit.');
      expect(step.outcome.mutations).toEqual([{ type: 'modify_health', amount: -2 }]);
      expect(step.outcome.llmCallIds).toEqual([]);
    }
  });
});

/**
 * RA-4c — the anomaly gate (SL-3 measure-first). `criticGateMode` is an OPTIONAL 7th constructor
 * param defaulted to 'always', so every describe block above (which never passes it) stays on
 * today's unconditional-fire path — these tests are additive, not a regression risk to those.
 * "barter with the merchant" is a deliberate non-combat, heuristic-hit rawInput (classifier.ts's
 * social table) so `actionType` is never 'combat' here — the combat exemption is covered by its
 * own case in `tests/engine/critic-gate.test.ts` (the pure predicate) rather than re-derived via
 * a full combat establish flow here.
 */
describe('PipelineActionStateMachine — RA-4c anomaly gate', () => {
  function cleanDecideResult(overrides?: Partial<PipelineDecideResult>): PipelineDecideResult {
    return {
      distilledType: 'haggle',
      stat: 'charisma',
      baseDc: 12, // inside the anomaly band — see critic-gate.ts's BASE_DC_ANOMALY_MIN/MAX
      required: false,
      decision: [
        { label: 'Offer a fair price', dcModifier: 0 },
        { label: 'Lowball them', dcModifier: 2 },
      ],
      ...overrides,
    };
  }

  // SL-3's shipped default, settled on the RA-4 A/B: the decide critic earned real catches so it
  // keeps firing unconditionally, while the narrate critic is near-inert by construction (a narrate
  // `major` is discarded outright, so only a patched `minor` can act) and is gated. These two cases
  // pin the asymmetry — the whole point of the default is that the two beats behave DIFFERENTLY, so
  // a regression collapsing them back into one policy has to fail here.
  it('narrate-gated (the default): a clean DECIDE beat still critiques', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = cleanDecideResult();
    const critic = new MockCriticGateway();
    // Mode left implicit — this asserts the SHIPPED default, not an opt-in arm.
    const machine = new PipelineActionStateMachine(llm, () => 20, undefined, undefined, critic);

    const started = await machine.start(testChar(), 'barter with the merchant', testItems);

    expect(critic.calls).toHaveLength(1);
    expect(critic.calls[0].beat).toBe('decision');
    if (started.resolved) throw new Error('expected unresolved start');
  });

  it('narrate-gated (the default): a clean NARRATE beat is skipped, so only the decide beat is paid for', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = cleanDecideResult();
    llm.resolveMutateResult = { mutations: [] };
    llm.resolveNarrateResult = { outcomeText: 'You strike a fair deal.' };
    const critic = new MockCriticGateway();
    const machine = new PipelineActionStateMachine(llm, () => 20, undefined, undefined, critic);

    const started = await machine.start(testChar(), 'barter with the merchant', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    const step1 = await machine.step(started.state, 'Offer a fair price', testChar(), testItems);
    if (step1.resolved) throw new Error('expected unresolved step 1');
    const step2 = await machine.step(step1.state, 'Offer a fair price', testChar(), testItems);
    if (!step2.resolved) throw new Error('expected resolved step 2');

    // Every critic call was a decide beat; the narrate beat never spent one.
    expect(critic.calls.length).toBeGreaterThan(0);
    expect(critic.calls.every((c) => c.beat === 'decision')).toBe(true);
    // The unpatched narration proves the narrate critic genuinely never ran.
    expect(step2.outcome.outcomeText).toBe('You strike a fair deal.');
  });

  it('anomaly mode: a clean decide beat skips the critic entirely (no call at all)', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = cleanDecideResult();
    const critic = new MockCriticGateway();
    const machine = new PipelineActionStateMachine(llm, () => 20, undefined, undefined, critic, 'anomaly');

    const started = await machine.start(testChar(), 'barter with the merchant', testItems);

    expect(critic.calls).toHaveLength(0);
    if (started.resolved) throw new Error('expected unresolved start');
    // Pass-through proves the gate skip didn't also skip returning the original result.
    expect(started.state.lastDecideResult).toEqual(cleanDecideResult());
  });

  it('anomaly mode: a clean narrate beat skips the critic entirely', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = cleanDecideResult();
    llm.resolveMutateResult = { mutations: [] };
    llm.resolveNarrateResult = { outcomeText: 'You strike a fair deal.' };
    const critic = new MockCriticGateway();
    const machine = new PipelineActionStateMachine(llm, () => 20, undefined, undefined, critic, 'anomaly');

    const started = await machine.start(testChar(), 'barter with the merchant', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    // Step 1: still under the beat cap, so this calls decide() again — same clean shape.
    const step1 = await machine.step(started.state, 'Offer a fair price', testChar(), testItems);
    if (step1.resolved) throw new Error('expected unresolved step 1');
    // Step 2: beat cap reached (MAX_DECISIONS_PER_ACTION=2) — resolves WITHOUT another decide()
    // call, narrating against the same clean `lastDecideResult` carried from step 1.
    const step2 = await machine.step(step1.state, 'Offer a fair price', testChar(), testItems);
    expect(step2.resolved).toBe(true);

    expect(critic.calls).toHaveLength(0);
    if (step2.resolved) expect(step2.outcome.outcomeText).toBe('You strike a fair deal.');
  });

  it('anomaly mode: a baseDc outside the authored band invokes the critic', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = cleanDecideResult({ baseDc: 30 }); // above BASE_DC_ANOMALY_MAX
    const critic = new MockCriticGateway();
    const machine = new PipelineActionStateMachine(llm, () => 20, undefined, undefined, critic, 'anomaly');

    const started = await machine.start(testChar(), 'barter with the merchant', testItems);

    expect(critic.calls).toHaveLength(1);
    expect(critic.calls[0].beat).toBe('decision');
    // Fails-open shape (MockCriticGateway's default verdict, `ok: true`) still passes the
    // decide result through unchanged — the gate firing doesn't disturb that contract.
    if (started.resolved) throw new Error('expected unresolved start');
    expect(started.state.lastDecideResult).toEqual(cleanDecideResult({ baseDc: 30 }));
  });

  it('anomaly mode: an empty decision[] on a non-combat beat invokes the critic', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = cleanDecideResult({ decision: [] });
    llm.resolveMutateResult = { mutations: [] };
    llm.resolveNarrateResult = { outcomeText: 'You strike a fair deal.' };
    const critic = new MockCriticGateway();
    const machine = new PipelineActionStateMachine(llm, () => 20, undefined, undefined, critic, 'anomaly');

    // §2 v12 QA auto-resolve: an empty decision[] on beat 1 jumps straight to resolve within
    // start() — so this ONE call exercises both gate sites: critiqueDecide (the empty decide
    // result itself) AND critiqueNarration (resolving against that same anomalous decide result).
    await machine.start(testChar(), 'barter with the merchant', testItems);

    expect(critic.calls).toHaveLength(2);
    expect(critic.calls[0].beat).toBe('decision');
    expect(critic.calls[1].beat).toBe('resolution');
  });

  it("'always' mode (the default) invokes the critic on every beat, exactly as today", async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = cleanDecideResult();
    llm.resolveMutateResult = { mutations: [] };
    llm.resolveNarrateResult = { outcomeText: 'You strike a fair deal.' };
    const critic = new MockCriticGateway();
    // Explicit 'always' here; the default-omitted case is already covered by every T4 test above.
    const machine = new PipelineActionStateMachine(llm, () => 20, undefined, undefined, critic, 'always');

    const started = await machine.start(testChar(), 'barter with the merchant', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    const step1 = await machine.step(started.state, 'Offer a fair price', testChar(), testItems);
    if (step1.resolved) throw new Error('expected unresolved step 1');
    const step2 = await machine.step(step1.state, 'Offer a fair price', testChar(), testItems);
    expect(step2.resolved).toBe(true);

    // start()'s decide + step1's decide + step2's narrate = 3 critic calls, none skipped.
    expect(critic.calls).toHaveLength(3);
  });
});

describe('PipelineActionStateMachine — §2 v12 QA: auto-resolve + single-option validator', () => {
  it('auto-resolve: start() returns resolved:true when LLM returns decision:[] on beat 1', async () => {
    const llm = new MockPipelineLlmGateway();
    // Travel — no branching needed, LLM returns empty decision array.
    llm.decideResult = {
      distilledType: 'travel',
      stat: 'physical',
      baseDc: 10,
      required: false,
      decision: [],
    };
    llm.resolveMutateResult = { mutations: [{ type: 'set_location', location: 'The Dark Woods' }] };
    llm.resolveNarrateResult = { outcomeText: 'You journey into the dark woods.' };

    const machine = new PipelineActionStateMachine(llm, () => 15);
    const result = await machine.start(testChar(), 'travel to the dark woods', testItems);

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.outcome.outcome).toBe('success');
      expect(result.outcome.outcomeText).toBe('You journey into the dark woods.');
      expect(result.outcome.mutations).toEqual([{ type: 'set_location', location: 'The Dark Woods' }]);
      // resolveMutate was called with the synthetic option (rawInput as label)
      expect(llm.resolveMutateCalls).toHaveLength(1);
      expect(llm.resolveMutateCalls[0].chosenOption).toEqual({ label: 'travel to the dark woods', dcModifier: 0, stat: 'physical' });
      expect(llm.resolveNarrateCalls).toHaveLength(1);
      // No decisions were presented — decisions array is empty
      expect(result.state.decisions).toEqual([]);
    }
  });

  it('auto-resolve: no-roll action (needs_roll:false) auto-resolves as success without calling rollD20', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = {
      distilledType: 'rest',
      stat: 'wisdom',
      baseDc: 8,
      required: false,
      decision: [],
    };
    llm.resolveMutateResult = { mutations: [{ type: 'modify_stamina', amount: 3 }] };
    llm.resolveNarrateResult = { outcomeText: 'You rest beneath the oak.' };

    let rollCalled = false;
    const machine = new PipelineActionStateMachine(llm, () => { rollCalled = true; return 1; });
    const result = await machine.start(testChar(), 'rest at the campfire', testItems);

    expect(result.resolved).toBe(true);
    expect(rollCalled).toBe(false);
    if (result.resolved) {
      expect(result.outcome.outcome).toBe('success');
      expect(result.outcome.playerRolled).toBeNull();
      expect(result.outcome.mutations).toEqual([{ type: 'modify_stamina', amount: 3 }]);
    }
  });

  it('auto-resolve: does not trigger when LLM returns 1+ real options (normal path)', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult(); // 2 options

    const machine = new PipelineActionStateMachine(llm, () => 20);
    const result = await machine.start(testChar(), 'attack the goblin', testItems);

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.firstDecision.options.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('single-option validator: triggers one bounded re-decide when decision has exactly 1 option', async () => {
    const llm = new MockPipelineLlmGateway();
    // First decide returns a single option — validator should trigger re-decide.
    // The re-decide returns a proper 2-option spread.
    llm.decideResult = {
      distilledType: 'interact',
      stat: 'wisdom',
      baseDc: 12,
      required: false,
      decision: [{ label: 'The Warden pauses...', dcModifier: -2, stat: 'wisdom' }],
    };

    const machine = new PipelineActionStateMachine(llm, () => 20);
    // Override the mock's decideResult AFTER the first decide call, so the re-decide gets
    // the corrected 2-option result. The mock always returns `this.decideResult` — we need
    // it to change between calls. Use a simple counter approach via the decideCalls spy.
    const result = await machine.start(testChar(), 'talk to the warden', testItems);

    // The validator fired: first decide returned 1 option, re-decide got the (still 1-option)
    // result because our mock always returns the same value. The re-decide itself passes through.
    // We verify the validator was invoked by checking decide was called twice (original + re-decide).
    expect(llm.decideCalls.length).toBe(2);
    // The second call should carry the criticNote with the validator's guidance.
    expect(llm.decideCalls[1].context.criticNote).toContain('single option');
    expect(result.resolved).toBe(false);
  });

  it('single-option validator: does not trigger when decision has 2+ options', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatDecideResult(); // 2 options

    const machine = new PipelineActionStateMachine(llm, () => 20);
    await machine.start(testChar(), 'attack the goblin', testItems);

    // Only one decide call — validator didn't trigger a re-decide.
    expect(llm.decideCalls.length).toBe(1);
  });

  it('single-option validator: does not trigger on empty decision (auto-resolve path)', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = {
      distilledType: 'travel',
      stat: 'physical',
      baseDc: 10,
      required: false,
      decision: [],
    };
    llm.resolveMutateResult = { mutations: [] };
    llm.resolveNarrateResult = { outcomeText: 'You travel.' };

    const machine = new PipelineActionStateMachine(llm, () => 20);
    const result = await machine.start(testChar(), 'go to the forest', testItems);

    // Validator sees 0 options → no-op. Auto-resolve triggers instead.
    expect(llm.decideCalls.length).toBe(1);
    expect(result.resolved).toBe(true);
  });

  it('single-option validator: triggers on a single bail-only option (re-decides for real choices)', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = {
      distilledType: 'travel',
      stat: 'physical',
      baseDc: 10,
      required: false,
      decision: [{ label: 'Proceed', dcModifier: null }],
    };

    const machine = new PipelineActionStateMachine(llm, () => 20);
    const result = await machine.start(testChar(), 'go to the forest', testItems);

    // Validator triggers on decision.length === 1 regardless of dcModifier.
    // A single bail-only option IS a single option — the validator re-decides.
    expect(llm.decideCalls.length).toBe(2);
    expect(result.resolved).toBe(false);
  });
});

/**
 * decide-scene-narration E2E acceptance — combat rounds simulating the dev-DB 34/35
 * pattern where every continue-decide returns `decision: []`. Verifies every spec criterion:
 * per-round narration + combatStatus, ≥2 mechanically distinct options + flee, never a
 * flee-only screen. Deliberately two consecutive rounds to prove the backstop survives
 * round-over-round (the enemy re-initialises in unit tests without a DB, but the backstop
 * fires independently each round — the dead-end is gone either way).
 */
describe('PipelineActionStateMachine — decide-scene-narration: E2E acceptance (empty-decision backstop multi-round)', () => {
  function combatEnemyDecideResult(overrides?: Partial<PipelineDecideResult>): PipelineDecideResult {
    return {
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 10,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      combatEnemy: { name: 'Goblin', anchor: 'location' },
      ...overrides,
    };
  }

  it('two consecutive empty continue-decides both fire the backstop, narrate, show combatStatus, offer distinct options + flee, and never flee-only', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [
      combatEnemyDecideResult(),
      combatEnemyDecideResult({ decision: [], narration: 'The goblin snarls, teeth bared — it circles left, looking for an opening.' }),
      combatEnemyDecideResult({ decision: [], narration: 'Your blade scrapes its tattered leather — it stumbles but rights itself, furious now.' }),
    ];
    // Two rounds of contested rolls (glanced band).
    const rolls = [10, 10, 10, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const started = await machine.start(testChar(), 'attack the goblin', testItems);
      expect(started.resolved).toBe(false);
      if (started.resolved) throw new Error('expected unresolved start');
      expect(started.firstDecision.narration).toBeUndefined();
      expect(started.firstDecision.prompt).toBe('Combat — what do you do?');

      // ── Round 1 ──
      const step1 = await machine.step(started.state, 'Press the attack', testChar(), testItems);
      expect(step1.resolved).toBe(false);
      if (step1.resolved) throw new Error('expected unresolved round 1');

      // Narration threads through.
      expect(step1.nextDecision.narration).toBe('The goblin snarls, teeth bared — it circles left, looking for an opening.');
      // ANSI-C: combatStatus is structured CombatStatusData (banding maths only, never
      // exact enemy HP) — the presentation layer composes the AnsiRenderer frame from it.
      const cs1 = step1.nextDecision.combatStatus as CombatStatusData;
      expect(cs1.pips.filled).toBeGreaterThanOrEqual(0);
      expect(cs1.pips.total).toBe(5);
      expect(cs1.woundWord).toMatch(/Healthy|Bloodied|Battered|Critical/);
      expect(cs1.enemyName).toBe('Goblin');
      expect(cs1.playerMaxHp).toBe(12);
      // ≥2 distinct backstop options; flee is a separate bail option (dcModifier: null).
      const realOptions1 = step1.nextDecision.options.filter(o => o.dcModifier !== null);
      expect(realOptions1.map(o => o.label)).toEqual(['Press the attack', 'Fight defensively']);
      const backstop1 = realOptions1.filter(o => o.label !== 'Flee the fight');
      expect(backstop1).toHaveLength(2);
      expect(backstop1[0].dcModifier).not.toEqual(backstop1[1].dcModifier);
      // Backstop flag set.
      expect(step1.combatBeat?.emptyDecisionFallback).toBe(true);

      // ── Round 2 (backstop fires again independently) ──
      const step2 = await machine.step(step1.state, 'Press the attack', testChar(), testItems);
      expect(step2.resolved).toBe(false);
      if (step2.resolved) throw new Error('expected unresolved round 2');

      expect(step2.nextDecision.narration).toBe('Your blade scrapes its tattered leather — it stumbles but rights itself, furious now.');
      const cs2 = step2.nextDecision.combatStatus as CombatStatusData;
      expect(cs2.pips.total).toBe(5);
      expect(cs2.woundWord).toMatch(/Healthy|Bloodied|Battered|Critical/);
      expect(cs2.enemyName).toBe('Goblin');
      expect(cs2.playerMaxHp).toBe(12);
      const realOptions2 = step2.nextDecision.options.filter(o => o.dcModifier !== null);
      expect(realOptions2.map(o => o.label)).toEqual(['Press the attack', 'Fight defensively']);
      const backstop2 = realOptions2.filter(o => o.label !== 'Flee the fight');
      expect(backstop2).toHaveLength(2);
      expect(backstop2[0].dcModifier).not.toEqual(backstop2[1].dcModifier);
      expect(step2.combatBeat?.emptyDecisionFallback).toBe(true);

      // Two warns — one per empty decision.
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('PipelineActionStateMachine — T2b combatFrame on terminal combat outcome', () => {
  function combatEnemyDecideResult(overrides?: Partial<PipelineDecideResult>): PipelineDecideResult {
    return {
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 10,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      combatEnemy: { name: 'Goblin', anchor: 'location' },
      ...overrides,
    };
  }

  it('a terminal combat WIN outcome carries combatFrame with enemyName, enemyMaxHp, margin', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [
      combatEnemyDecideResult({ baseDc: 6 }),
    ];
    // baseDc=6 -> enemyMaxHp=6 -> player crit (nat-20) clean amplified gives -8 enemyHpDelta
    // -> newEnemyHp = max(0, min(6, 6+(-8))) = 0 -> WIN
    // playerBonus=5 (physical 3 + Iron Sword 2), enemyBonus=0 -> margin = (20+5)-(1+0) = 24
    const rolls = [20, 1];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    expect(started.resolved).toBe(false);
    if (started.resolved) throw new Error('expected unresolved start');

    // SL-6: WIN now surfaces the fatal-blow interstitial first; resolve via 'Finish it'.
    const interstitial = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(interstitial.resolved).toBe(false);
    if (interstitial.resolved) throw new Error('expected unresolved fatal-blow interstitial');

    const step = await machine.step(interstitial.state, 'Finish it', testChar(), testItems);
    expect(step.resolved).toBe(true);
    if (!step.resolved) throw new Error('expected resolved step');

    expect(step.outcome.combatFrame).toBeDefined();
    expect(step.outcome.combatFrame?.enemyName).toBe('Goblin');
    expect(step.outcome.combatFrame?.enemyMaxHp).toBe(deriveEnemyMaxHp(6));
    expect(step.outcome.combatFrame?.margin).toBe(24);
  });

  it('a terminal combat LOSS outcome carries combatFrame', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [
      combatEnemyDecideResult({ baseDc: 10 }),
    ];
    // Seed a combat_save edge so the save-day check passes (second-lethal-blow today).
    const resolver: PipelineContextResolver = {
      getNearbyNpcs: () => [],
      getNearbyPcs: () => [],
      getRecentActions: () => [],
      getKnownLocations: () => [],
      isLocationSafe: () => true,
      getLocalGeography: () => ({ region: null, neighbours: [], frontiers: [] }),
      getCurrentDay: () => 1,
      getSceneRelations: () => [{
        id: 0,
        from_type: 'pc',
        from_ref: '1',
        to_type: 'pc',
        to_ref: '1',
        rel_type: 'combat_save',
        props: JSON.stringify({ savedDay: 1 }),
        created_by_action_id: null,
        updated_day: null,
      }] as RelationRow[],
    };
    // player nat-1 -> heavy amplified: playerHpDelta=-3-2=-5. With health=3, 3+(-5)<=0 -> hpZero.
    // savedDay=1 === currentDay=1 -> LOSS (resolveCombat with verdict='failure').
    const rolls = [1, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++], resolver);
    const lowChar = testChar({ health: 3 });

    const started = await machine.start(lowChar, 'attack the goblin', testItems);
    expect(started.resolved).toBe(false);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Press the attack', lowChar, testItems);
    expect(step.resolved).toBe(true);
    if (!step.resolved) throw new Error('expected resolved step');

    expect(step.outcome.combatFrame).toBeDefined();
    expect(step.outcome.combatFrame?.enemyName).toBe('Goblin');
    expect(step.outcome.combatFrame?.enemyMaxHp).toBe(deriveEnemyMaxHp(10));
    expect(typeof step.outcome.combatFrame?.margin).toBe('number');

    // The genuine-death terminal beat clamps the lethal nominal delta (-5) to the player's
    // actual HP (3) — the beat log can't record losing more HP than the player had.
    expect(step.outcome.combatBeat?.playerHpDelta).toBe(-3);
  });

  it('a non-combat outcome has combatFrame undefined', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.classifyResult = {
      kind: 'hit',
      actionType: 'search',
      flags: { needs_roll: true, unsafe_location: false, target_present: false },
    };

    llm.decideResult = combatDecideResult(); // skirmish, non-combat
    llm.resolveMutateResult = { mutations: [] };
    llm.resolveNarrateResult = { outcomeText: 'You find nothing of interest.' };

    const machine = new PipelineActionStateMachine(llm, () => 10);

    const started = await machine.start(testChar(), 'search the area', testItems);
    expect(started.resolved).toBe(false);
    if (started.resolved) throw new Error('expected unresolved start');

    // Step 1: non-combat continue.
    const step1 = await machine.step(started.state, 'Strike hard', testChar(), testItems);
    expect(step1.resolved).toBe(false);
    if (step1.resolved) throw new Error('expected unresolved step');

    // Step 2: beat cap forces resolve.
    const step2 = await machine.step(step1.state, 'Strike hard', testChar(), testItems);
    expect(step2.resolved).toBe(true);
    if (!step2.resolved) throw new Error('expected resolved step');

    expect(step2.outcome.combatFrame).toBeUndefined();
  });

  it('the combatFrame is absent on a CONTINUE (non-resolved) step', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [
      combatEnemyDecideResult({ baseDc: 10 }),
      combatEnemyDecideResult({
        narration: 'The goblin snarls.',
        decision: [
          { label: 'Press the attack', dcModifier: 0 },
          { label: 'Aim for the eyes', dcModifier: 2, stat: 'wisdom' },
        ],
      }),
    ];
    // A continue round: glanced band, enemyHp=7 (>0), playerHpDelta=0 (no hpZero).
    const rolls = [10, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    expect(started.resolved).toBe(false);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(step.resolved).toBe(false);
    // A continue step has no outcome property at all — combatFrame is trivially absent.
    expect('outcome' in step).toBe(false);
  });
});

describe('PipelineActionStateMachine — T2b B#5/B#6 continue-screen clamping (ANSI-C: structured combatStatus)', () => {
  function combatEnemyDecideResult(overrides?: Partial<PipelineDecideResult>): PipelineDecideResult {
    return {
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 10,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      combatEnemy: { name: 'Goblin', anchor: 'location' },
      ...overrides,
    };
  }

  // B#5's original "no crammed one-liner" render-layout guarantee (separate header/footer
  // blocks) now lives in AnsiRenderer's own frame tests (tests/render/AnsiRenderer.test.ts)
  // since the engine no longer renders a frame at all — it only emits the two combatants'
  // data as distinct fields, which this test proves stay distinct through the engine.
  it('B#5: combatStatus carries the enemy and player as separate structured fields, not a crammed shape', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [
      combatEnemyDecideResult(),
      combatEnemyDecideResult({
        narration: 'The goblin snarls.',
        decision: [
          { label: 'Press the attack', dcModifier: 0 },
          { label: 'Aim for the eyes', dcModifier: 2, stat: 'wisdom' },
        ],
      }),
    ];
    // Glanced band: enemyHpDelta=-3, playerHpDelta=0 -> continue.
    const rolls = [10, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(step.resolved).toBe(false);
    if (step.resolved) throw new Error('expected unresolved step');

    const cs = step.nextDecision.combatStatus as CombatStatusData;
    expect(cs).toBeDefined();
    expect(cs.enemyName).toBe('Goblin');
    expect(cs.pips.total).toBe(5);
    expect(typeof cs.playerHp).toBe('number');
    expect(cs.playerMaxHp).toBe(12);
  });

  it('B#6: displayed player HP clamped to [0, max] — non-lethal heavy damage with delta present', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [
      combatEnemyDecideResult({ baseDc: 10 }),
      combatEnemyDecideResult({
        narration: 'The goblin snarls.',
        decision: [
          { label: 'Press the attack', dcModifier: 0 },
          { label: 'Aim for the eyes', dcModifier: 2, stat: 'wisdom' },
        ],
      }),
    ];
    // Player nat-1 -> heavy amplified: playerHpDelta=-5. With health=8, 8+(-5)=3 > 0 -> continue.
    const rolls = [1, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);
    const woundedChar = testChar({ health: 8, maxHealth: 8 });

    const started = await machine.start(woundedChar, 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Press the attack', woundedChar, testItems);
    expect(step.resolved).toBe(false);
    if (step.resolved) throw new Error('expected unresolved step');

    const cs = step.nextDecision.combatStatus as CombatStatusData;
    expect(cs).toBeDefined();
    // Displayed HP should be 3 (clamped to [0, max], not negative).
    expect(cs.playerHp).toBe(3);
    expect(cs.playerMaxHp).toBe(8);
    expect(cs.playerHpDelta).toBe(-5);
  });

  it('B#6: when playerHpDelta is 0, the field is exactly 0 (no floater implied)', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [
      combatEnemyDecideResult({ baseDc: 10 }),
      combatEnemyDecideResult({
        narration: 'The goblin snarls.',
        decision: [
          { label: 'Press the attack', dcModifier: 0 },
          { label: 'Aim for the eyes', dcModifier: 2, stat: 'wisdom' },
        ],
      }),
    ];
    // Glanced band: playerHpDelta=0 -> no floater.
    const rolls = [10, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(step.resolved).toBe(false);
    if (step.resolved) throw new Error('expected unresolved step');

    const cs = step.nextDecision.combatStatus as CombatStatusData;
    expect(cs).toBeDefined();
    // Player HP 12/12 shows the player took no damage.
    expect(cs.playerHp).toBe(12);
    expect(cs.playerMaxHp).toBe(12);
    expect(cs.playerHpDelta).toBe(0);
  });
});

/**
 * C3 (0.3.2 polish) — an npc-anchored fight should read its enemy's identity/HP off the real
 * NPC, not a DC-derived guess: a known 24-HP stag must render as 24/24, not the ambient minion
 * band. `nearbyNpcs` from the resolver now carries the NPC's own `health`; the seeding priority
 * is real NPC health > LLM `maxHp` hint > `deriveEnemyMaxHp(baseDc)` (the ambient fallback, which
 * must stay untouched for the location-anchored path).
 */
describe('PipelineActionStateMachine — C3: npc-anchored combat seeds real HP/name', () => {
  function combatEnemyDecideResult(overrides?: Partial<PipelineDecideResult>): PipelineDecideResult {
    return {
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 10,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      combatEnemy: { name: 'Goblin', anchor: 'location' },
      ...overrides,
    };
  }

  function npcResolver(npcs: { id: number; name: string; description: string; health?: number | null }[]): PipelineContextResolver {
    return {
      getNearbyNpcs: () => npcs,
      getNearbyPcs: () => [],
      getRecentActions: () => [],
      getKnownLocations: () => [],
      isLocationSafe: () => true,
      getLocalGeography: () => ({ region: null, neighbours: [], frontiers: [] }),
    };
  }

  function setRelationEdge(mutations: WorldMutation[] | undefined): { props: { enemyName: string; enemyHp: number; enemyMaxHp: number; round: number } } {
    const edge = mutations?.find((m) => m.type === 'set_relation');
    if (!edge) throw new Error('expected a set_relation mutation');
    return edge as unknown as { props: { enemyName: string; enemyHp: number; enemyMaxHp: number; round: number } };
  }

  it('a known-NPC fight seeds enemyMaxHp/enemyName from the NPC\'s real health, not baseDc', async () => {
    const llm = new MockPipelineLlmGateway();
    // baseDc=14 -> deriveEnemyMaxHp(14)=14, distinct from the stag's real health (24), so a
    // pass proves the real value won and the DC-derived guess was never used.
    llm.decideResult = combatEnemyDecideResult({
      baseDc: 14,
      combatEnemy: { name: 'Stag', anchor: 'npc' },
    });
    const resolver = npcResolver([{ id: 7, name: 'Stag', description: 'A wary stag.', health: 24 }]);

    // player d20=10, enemy d20=10, enemyBonus=clamp(14-10,0,10)=4 -> margin=1 -> trade
    // (enemyHpDelta -2, playerHpDelta -1 per the margin>0 tie-break) — a clean CONTINUE, no win.
    const machine = new PipelineActionStateMachine(llm, () => 10, resolver);

    const started = await machine.start(testChar(), 'attack the stag', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(step.resolved).toBe(false);
    if (step.resolved) throw new Error('expected unresolved step');

    const edge = setRelationEdge(step.mutations);
    expect(edge.props.enemyMaxHp).toBe(24);
    expect(edge.props.enemyHp).toBe(22);
    expect(edge.props.enemyName).toBe('Stag');
    expect(deriveEnemyMaxHp(14)).toBe(14); // sanity: the DC-derived guess this must NOT use
  });

  it('no combatEnemy signal (the post-gateway-fix state for an empty LLM name) establishes \'Minion\'', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatEnemyDecideResult({ baseDc: 10, combatEnemy: undefined });

    const machine = new PipelineActionStateMachine(llm, () => 10);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(step.resolved).toBe(false);
    if (step.resolved) throw new Error('expected unresolved step');

    expect(setRelationEdge(step.mutations).props.enemyName).toBe('Minion');
  });

  it('a location-anchored (ambient) fight still derives enemyMaxHp from baseDc — fallback untouched', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatEnemyDecideResult({ baseDc: 10 }); // anchor: 'location' (default)

    // player d20=10, enemy d20=10, enemyBonus=0 -> margin=5 -> glanced (enemyHpDelta -3).
    const machine = new PipelineActionStateMachine(llm, () => 10);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(step.resolved).toBe(false);
    if (step.resolved) throw new Error('expected unresolved step');

    const edge = setRelationEdge(step.mutations);
    expect(edge.props.enemyMaxHp).toBe(deriveEnemyMaxHp(10));
    expect(edge.props.enemyName).toBe('Goblin');
  });

  it('the resolved NPC\'s real health outranks the LLM-authored maxHp hint', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatEnemyDecideResult({
      baseDc: 10,
      combatEnemy: { name: 'Stag', anchor: 'npc', maxHp: 30 },
    });
    const resolver = npcResolver([{ id: 7, name: 'Stag', description: 'A wary stag.', health: 24 }]);
    const machine = new PipelineActionStateMachine(llm, () => 10, resolver);

    const started = await machine.start(testChar(), 'attack the stag', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(step.resolved).toBe(false);
    if (step.resolved) throw new Error('expected unresolved step');

    // Real health (24) wins over both the LLM's hint (30) and baseDc's derivation (10).
    expect(setRelationEdge(step.mutations).props.enemyMaxHp).toBe(24);
  });

  it('a null NPC health falls through to the LLM maxHp hint', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatEnemyDecideResult({
      baseDc: 10,
      combatEnemy: { name: 'Stag', anchor: 'npc', maxHp: 18 },
    });
    const resolver = npcResolver([{ id: 7, name: 'Stag', description: 'A wary stag.', health: null }]);
    const machine = new PipelineActionStateMachine(llm, () => 10, resolver);

    const started = await machine.start(testChar(), 'attack the stag', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(step.resolved).toBe(false);
    if (step.resolved) throw new Error('expected unresolved step');

    expect(setRelationEdge(step.mutations).props.enemyMaxHp).toBe(18);
  });

  it('a null NPC health with no LLM hint falls through to deriveEnemyMaxHp(baseDc)', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResult = combatEnemyDecideResult({
      baseDc: 12,
      combatEnemy: { name: 'Stag', anchor: 'npc' },
    });
    const resolver = npcResolver([{ id: 7, name: 'Stag', description: 'A wary stag.', health: null }]);
    const machine = new PipelineActionStateMachine(llm, () => 10, resolver);

    const started = await machine.start(testChar(), 'attack the stag', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const step = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(step.resolved).toBe(false);
    if (step.resolved) throw new Error('expected unresolved step');

    expect(setRelationEdge(step.mutations).props.enemyMaxHp).toBe(deriveEnemyMaxHp(12));
  });

  it('enemyMaxHp stays constant and enemyHp is non-increasing across rounds once the fight is persisted for real', async () => {
    // A real (in-memory) RelationRepository, not a static stub — this is the only way to prove
    // round 2's `readCombatState` reads back the SAME enemyMaxHp rather than re-seeding it off
    // combatEnemy again (the raw machine's default no-op resolver can't round-trip `in_combat`
    // between separate step() calls; see the ANSI-D describe block's header comment above).
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const relationRepo = new RelationRepository(db);

    const llm = new MockPipelineLlmGateway();
    // Queue covers all three `decide()` calls: `start()`'s NEW_ACTION beat, then round 1 and
    // round 2's CONTINUE beats.
    llm.decideResultQueue = [
      combatEnemyDecideResult({ baseDc: 10, combatEnemy: { name: 'Stag', anchor: 'npc' } }),
      combatEnemyDecideResult({ baseDc: 10, combatEnemy: { name: 'Stag', anchor: 'npc' } }),
      combatEnemyDecideResult({ baseDc: 10, combatEnemy: { name: 'Stag', anchor: 'npc' } }),
    ];
    const resolver: PipelineContextResolver = {
      ...npcResolver([{ id: 7, name: 'Stag', description: 'A wary stag.', health: 30 }]),
      getSceneRelations: (node) => relationRepo.forNode(node.type, node.ref),
    };

    // Both rounds: player d20=10, enemy d20=10 -> glanced (enemyHpDelta -3, playerHpDelta 0) —
    // never a crit/floor/win, so the fight just continues twice off the NPC-seeded 30 HP.
    const rolls = [10, 10, 10, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++], resolver);
    const char = testChar();

    const started = await machine.start(char, 'attack the stag', testItems);
    if (started.resolved) throw new Error('expected unresolved start');

    const round1 = await machine.step(started.state, 'Press the attack', char, testItems);
    expect(round1.resolved).toBe(false);
    if (round1.resolved) throw new Error('expected unresolved step');
    const edge1 = setRelationEdge(round1.mutations);
    expect(edge1.props.enemyMaxHp).toBe(30);
    expect(edge1.props.enemyHp).toBe(27);

    // Persist round 1's edge for real (mirrors `WorldEngineImpl.applyResolution` /
    // `persistAuthoredRelations`) so round 2's `readCombatState` finds live state instead of
    // re-seeding from `combatEnemy`. Hand-resolved key (`npc:7`) rather than going through
    // `resolveAuthoredRelation` — the anchor's `name` is already the resolved npc id, not a
    // display name, so re-resolving it against `nearbyNpcs` by name would fail (documented
    // caveat in `combat-state.ts`'s `toAnchor`).
    relationRepo.set({
      fromType: 'pc', fromRef: String(char.id),
      toType: 'npc', toRef: '7',
      relType: 'in_combat',
      props: edge1.props,
    });

    const round2 = await machine.step(round1.state, 'Press the attack', char, testItems);
    expect(round2.resolved).toBe(false);
    if (round2.resolved) throw new Error('expected unresolved step');
    const edge2 = setRelationEdge(round2.mutations);

    expect(edge2.props.enemyMaxHp).toBe(30); // constant — not re-derived, not grown
    expect(edge2.props.enemyHp).toBeLessThanOrEqual(edge1.props.enemyHp); // monotonically non-increasing
    expect(edge2.props.enemyName).toBe('Stag');

    db.close();
  });
});

describe('PipelineActionStateMachine — C6 combat empty-decision guard (0.3.2)', () => {
  it('a combat action with an empty DECIDE decision[] yields an unresolved start whose first step() runs a contested round, never a one-shot auto-resolve', async () => {
    const llm = new MockPipelineLlmGateway();
    // CLASSIFY hits combat, DECIDE returns empty decisions with a combatEnemy.
    llm.classifyResult = { kind: 'hit', actionType: 'combat', flags: { unsafe_location: false, needs_roll: true, target_present: true } };
    llm.decideResult = {
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 6,
      required: true,
      decision: [],
      combatEnemy: { name: 'Goblin', anchor: 'location' },
    };

    // Player nat-20 against a weak foe (baseDc=6 → enemyMaxHp=6, enemyBonus=0).
    // Crit clean: amplified -8 kills in one round — the fight resolves on step(),
    // proving handleCombatStep ran (its termination ladder fired) rather than the
    // one-shot resolve() path.
    const rolls = [20, 1];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);

    // Guard: start() must NOT auto-resolve. The synthesised first decision must have
    // a real non-bail option.
    expect(started.resolved).toBe(false);
    if (started.resolved) throw new Error('expected unresolved start — guard did not fire');

    const realOptions = started.firstDecision.options.filter(o => o.dcModifier !== null);
    expect(realOptions.length).toBeGreaterThanOrEqual(1);
    expect(realOptions[0].label).toBe('Press the attack');
    expect(started.firstDecision.options.some(o => o.dcModifier === null)).toBe(true); // flee present

    // step() must route through handleCombatStep, running the contested round. SL-6 now
    // surfaces the fatal-blow interstitial on a WIN rather than resolving straight through —
    // still proof the termination ladder fired (a one-shot resolve() would never reach it).
    const interstitial = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(interstitial.resolved).toBe(false); // round-1 kill → fatal-blow interstitial, not a terminal outcome
    if (interstitial.resolved) throw new Error('expected unresolved fatal-blow interstitial');
    expect(interstitial.nextDecision.options.map(o => o.label)).toEqual(['Finish it', 'Show mercy']);

    const step = await machine.step(interstitial.state, 'Finish it', testChar(), testItems);
    expect(step.resolved).toBe(true);
    if (!step.resolved) throw new Error('expected resolved step');

    // A combatBeat proves a contested roll ran inside handleCombatStep.
    // On a resolved step, combatBeat lives on the outcome (same shape as terminal path).
    expect(step.outcome.combatBeat).toBeDefined();
    expect(step.outcome.combatBeat!.round).toBe(1);
    expect(step.outcome.combatBeat!.band).toBe('clean');
    expect(step.outcome.combatBeat!.marker).toBe('combat_round');
  });
});

describe('enemyConditionBand — pure banding function (direct unit coverage)', () => {
  it('bands the five tiers by hpFraction', () => {
    expect(enemyConditionBand(0)).toEqual({ filled: 0, woundWord: 'Slain' });
    expect(enemyConditionBand(0.1)).toEqual({ filled: 1, woundWord: 'Critical' });
    expect(enemyConditionBand(0.15)).toEqual({ filled: 1, woundWord: 'Battered' });
    expect(enemyConditionBand(0.4)).toEqual({ filled: 2, woundWord: 'Bloodied' });
    expect(enemyConditionBand(0.8)).toEqual({ filled: 4, woundWord: 'Healthy' });
    expect(enemyConditionBand(1)).toEqual({ filled: 5, woundWord: 'Healthy' });
  });

  it('clamps a negative fraction to the Slain floor, never a negative pip count', () => {
    // Genuinely negative is over-kill, not unknown — it still reads 'Slain', unlike non-finite
    // input below.
    expect(enemyConditionBand(-1)).toEqual({ filled: 0, woundWord: 'Slain' });
  });

  // RA-5a review nit, folded into RA-5c since this task adds a new caller (the fatal-blow
  // interstitial's combatStatus): `NaN <= 0` is `false`, so an unguarded NaN falls through
  // every tier to 'Critical' and returns `filled: NaN` — a broken pip bar. No live path feeds
  // NaN today, but the function is exported, so this pins the guard directly rather than
  // relying on indirect coverage.
  //
  // Fix (RA-5c review): non-finite input means *unknown*, not *dead* — defaulting it to 'Slain'
  // is a false claim in the wrong direction, and a regression from the pre-guard behaviour
  // (which read 'Critical' for NaN, just with a broken `filled: NaN`). Only the pip count is
  // fixed here; the wound word for non-finite input stays 'Critical'. `Infinity` is likewise
  // non-finite, so it takes the same 'Critical' path — pinned deliberately, not left to fall
  // out of the `>= 0.8` tier.
  it('is total: NaN/Infinity read Critical with a real (non-NaN) pip count, never a false Slain claim', () => {
    expect(enemyConditionBand(NaN)).toEqual({ filled: 0, woundWord: 'Critical' });
    expect(enemyConditionBand(Infinity)).toEqual({ filled: 0, woundWord: 'Critical' });
    expect(enemyConditionBand(-Infinity)).toEqual({ filled: 0, woundWord: 'Critical' });
  });
});

describe('PipelineActionStateMachine — SL-6 fatal-blow interstitial (RA-5c)', () => {
  function combatEnemyDecideResult(overrides?: Partial<PipelineDecideResult>): PipelineDecideResult {
    return {
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 6,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      combatEnemy: { name: 'Goblin', anchor: 'location' },
      ...overrides,
    };
  }

  it('a won round returns an unresolved two-option decision — no LLM call, no roll, no mutation, combatRounds unchanged', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [combatEnemyDecideResult()];
    // baseDc=6 -> enemyMaxHp=6; nat-20 crit (amplified -8) kills outright in round 1.
    const rolls = [20, 1];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    const decideCallsBeforeStep = llm.decideCalls.length;

    const interstitial = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    expect(interstitial.resolved).toBe(false);
    if (interstitial.resolved) throw new Error('expected unresolved fatal-blow interstitial');

    expect(interstitial.nextDecision.options).toEqual([
      { label: 'Finish it', dcModifier: 0 },
      { label: 'Show mercy', dcModifier: 0 },
    ]);
    // No beat fought at the interstitial itself — the log carries forward unchanged (empty here,
    // a first-round kill), and there is no `combatBeat`/`mutations` on this non-terminal arm.
    expect(interstitial.nextDecision.combatRounds).toEqual([]);
    expect(interstitial.combatBeat).toBeUndefined();
    expect(interstitial.mutations).toBeUndefined();
    expect(llm.decideCalls.length).toBe(decideCallsBeforeStep); // no decide() call for the interstitial
    expect(i).toBe(2); // only the round's own contested roll consumed, nothing extra
  });

  // Fix (RA-5c review): the interstitial's own combatStatus must not band the foe 'Slain' — the
  // player hasn't chosen finish/spare yet, so a 'Slain' readout beside "Finish it, or let it
  // live?" would contradict the very choice on offer. baseDc=6 -> enemyMaxHp=6 (ENEMY_HP_MIN),
  // so the nominal display HP of 1 gives fraction 1/6 ≈ 0.167 -> 'Battered', not 'Critical'.
  it("the interstitial's own combatStatus bands the foe as a last-gasp survivor, never Slain, for a kill from full HP", async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [combatEnemyDecideResult()];
    const rolls = [20, 1];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    const interstitial = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    if (interstitial.resolved) throw new Error('expected unresolved fatal-blow interstitial');

    expect(interstitial.nextDecision.combatStatus?.woundWord).not.toBe('Slain');
    expect(interstitial.nextDecision.combatStatus?.woundWord).toBe('Battered');
  });

  it("'Finish it' resolves success with the foe at 0 HP, banding Slain, and consumes no extra roll", async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [combatEnemyDecideResult()];
    const rolls = [20, 1];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    const interstitial = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    if (interstitial.resolved) throw new Error('expected unresolved fatal-blow interstitial');

    const step = await machine.step(interstitial.state, 'Finish it', testChar(), testItems);
    expect(i).toBe(2); // the resume rolled nothing further
    if (!step.resolved) throw new Error('expected resolved step');

    expect(step.outcome.outcome).toBe('success');
    expect(step.outcome.combatBeat?.enemyHpAfter).toBe(0);
    expect(step.outcome.combatBeat?.fatalBlow).toBe('finish');
    const enemyMaxHp = step.outcome.combatFrame!.enemyMaxHp;
    expect(enemyConditionBand(step.outcome.combatBeat!.enemyHpAfter / enemyMaxHp).woundWord).toBe('Slain');

    const edgeMutation = step.outcome.mutations.find(
      (m) => m.type === 'set_relation' && (m as unknown as { relType: string }).relType === 'in_combat',
    ) as { props: { enemyHp: number; round: number } } | undefined;
    expect(edgeMutation?.props.enemyHp).toBe(0);
  });

  it("'Show mercy' resolves success with the terminal BEAT reporting the foe alive at 1 HP and a non-Slain band, while the persisted EDGE closes (SL-7)", async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [combatEnemyDecideResult()];
    const rolls = [20, 1];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    const interstitial = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    if (interstitial.resolved) throw new Error('expected unresolved fatal-blow interstitial');

    const step = await machine.step(interstitial.state, 'Show mercy', testChar(), testItems);
    expect(i).toBe(2); // no extra roll on the resume
    if (!step.resolved) throw new Error('expected resolved step');

    expect(step.outcome.outcome).toBe('success');
    // The BEAT is the narrative record of the round: still 1 HP, still a wounded (non-Slain)
    // band — the outcome frame must read a survivor, not a kill.
    expect(step.outcome.combatBeat?.enemyHpAfter).toBe(1);
    expect(step.outcome.combatBeat?.fatalBlow).toBe('spare');
    const enemyMaxHp = step.outcome.combatFrame!.enemyMaxHp;
    expect(enemyConditionBand(1 / enemyMaxHp).woundWord).not.toBe('Slain');

    // SL-7 supersedes RA-5c's `enemyHp: 1, round: 1` edge invariant: sparing was found to be a
    // guaranteed-win farm (every band deals net-negative enemy HP, so a re-engaged 1-HP edge
    // dies for free). The EDGE is combat bookkeeping and must instead read CLOSED (enemyHp: 0)
    // so the next combat action re-establishes a fresh fight rather than continuing this one —
    // deliberately diverging from the beat's 1 HP above.
    const edgeMutation = step.outcome.mutations.find(
      (m) => m.type === 'set_relation' && (m as unknown as { relType: string }).relType === 'in_combat',
    ) as { props: { enemyHp: number; round: number } } | undefined;
    expect(edgeMutation?.props.enemyHp).toBe(0);
  });

  it('the lethal option is listed first, matching combatWinScenario\'s first-real choice policy', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [combatEnemyDecideResult()];
    const rolls = [20, 1];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    const interstitial = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    if (interstitial.resolved) throw new Error('expected unresolved fatal-blow interstitial');

    const real = interstitial.nextDecision.options.filter(o => o.dcModifier !== null);
    expect(real[0].label).toBe('Finish it');
    expect(interstitial.nextDecision.options.every(o => o.dcModifier !== null)).toBe(true);
  });
});

describe('PipelineActionStateMachine — Stage 2: fatalBlow/decisionPrompt resolve handoff (RA-1/RA-2, Release gate)', () => {
  function combatEnemyDecideResult(overrides?: Partial<PipelineDecideResult>): PipelineDecideResult {
    return {
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 6,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      combatEnemy: { name: 'Goblin', anchor: 'location' },
      ...overrides,
    };
  }

  it("'Show mercy' hands both resolveMutate and resolveNarrate fatalBlow: 'spare' and the interstitial's real decisionPrompt", async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [combatEnemyDecideResult()];
    const rolls = [20, 1];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    const interstitial = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    if (interstitial.resolved) throw new Error('expected unresolved fatal-blow interstitial');

    const step = await machine.step(interstitial.state, 'Show mercy', testChar(), testItems);
    if (!step.resolved) throw new Error('expected resolved step');

    const mutateCall = llm.resolveMutateCalls[llm.resolveMutateCalls.length - 1];
    const narrateCall = llm.resolveNarrateCalls[llm.resolveNarrateCalls.length - 1];
    expect(mutateCall.fatalBlow).toBe('spare');
    expect(narrateCall.fatalBlow).toBe('spare');
    // Pinning "contains" rather than the whole string: a later wording tweak to the interstitial
    // prompt shouldn't spuriously break this test.
    expect(mutateCall.decisionPrompt).toContain('Finish it, or let it live?');
    expect(narrateCall.decisionPrompt).toContain('Finish it, or let it live?');
  });

  it("'Finish it' hands both resolveMutate and resolveNarrate fatalBlow: 'finish' and the same decisionPrompt", async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [combatEnemyDecideResult()];
    const rolls = [20, 1];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++]);

    const started = await machine.start(testChar(), 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    const interstitial = await machine.step(started.state, 'Press the attack', testChar(), testItems);
    if (interstitial.resolved) throw new Error('expected unresolved fatal-blow interstitial');

    const step = await machine.step(interstitial.state, 'Finish it', testChar(), testItems);
    if (!step.resolved) throw new Error('expected resolved step');

    const mutateCall = llm.resolveMutateCalls[llm.resolveMutateCalls.length - 1];
    const narrateCall = llm.resolveNarrateCalls[llm.resolveNarrateCalls.length - 1];
    expect(mutateCall.fatalBlow).toBe('finish');
    expect(narrateCall.fatalBlow).toBe('finish');
    expect(mutateCall.decisionPrompt).toContain('Finish it, or let it live?');
    expect(narrateCall.decisionPrompt).toContain('Finish it, or let it live?');
  });

  it('a combat LOSS (second lethal blow today, no fatal-blow interstitial) carries neither fatalBlow nor decisionPrompt in either handoff', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.decideResultQueue = [
      combatEnemyDecideResult({ baseDc: 10 }),
    ];
    // Seed a combat_save edge so the save-day check fails through (second-lethal-blow today) —
    // the same reachable LOSS path as the T2b combatFrame suite, not a fabricated state.
    const resolver: PipelineContextResolver = {
      getNearbyNpcs: () => [],
      getNearbyPcs: () => [],
      getRecentActions: () => [],
      getKnownLocations: () => [],
      isLocationSafe: () => true,
      getLocalGeography: () => ({ region: null, neighbours: [], frontiers: [] }),
      getCurrentDay: () => 1,
      getSceneRelations: () => [{
        id: 0,
        from_type: 'pc',
        from_ref: '1',
        to_type: 'pc',
        to_ref: '1',
        rel_type: 'combat_save',
        props: JSON.stringify({ savedDay: 1 }),
        created_by_action_id: null,
        updated_day: null,
      }] as RelationRow[],
    };
    const rolls = [1, 10];
    let i = 0;
    const machine = new PipelineActionStateMachine(llm, () => rolls[i++], resolver);
    const lowChar = testChar({ health: 3 });

    const started = await machine.start(lowChar, 'attack the goblin', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    const step = await machine.step(started.state, 'Press the attack', lowChar, testItems);
    if (!step.resolved) throw new Error('expected resolved step');
    expect(step.outcome.outcome).toBe('failure');

    const mutateCall = llm.resolveMutateCalls[llm.resolveMutateCalls.length - 1];
    const narrateCall = llm.resolveNarrateCalls[llm.resolveNarrateCalls.length - 1];
    expect(mutateCall.fatalBlow).toBeUndefined();
    expect(narrateCall.fatalBlow).toBeUndefined();
    expect(mutateCall.decisionPrompt).toBeUndefined();
    expect(narrateCall.decisionPrompt).toBeUndefined();
  });

  it('a non-combat resolution carries neither fatalBlow nor decisionPrompt in either handoff', async () => {
    const llm = new MockPipelineLlmGateway();
    llm.classifyResult = {
      kind: 'hit',
      actionType: 'search',
      flags: { needs_roll: true, unsafe_location: false, target_present: false },
    };
    llm.decideResult = {
      distilledType: 'search',
      stat: 'wisdom',
      baseDc: 10,
      required: false,
      decision: [{ label: 'Strike hard', dcModifier: 0 }],
    };
    llm.resolveMutateResult = { mutations: [] };
    llm.resolveNarrateResult = { outcomeText: 'You find nothing of interest.' };

    const machine = new PipelineActionStateMachine(llm, () => 10);

    const started = await machine.start(testChar(), 'search the area', testItems);
    if (started.resolved) throw new Error('expected unresolved start');
    const step1 = await machine.step(started.state, 'Strike hard', testChar(), testItems);
    if (step1.resolved) throw new Error('expected unresolved step');
    const step2 = await machine.step(step1.state, 'Strike hard', testChar(), testItems);
    if (!step2.resolved) throw new Error('expected resolved step');

    const mutateCall = llm.resolveMutateCalls[llm.resolveMutateCalls.length - 1];
    const narrateCall = llm.resolveNarrateCalls[llm.resolveNarrateCalls.length - 1];
    expect(mutateCall.fatalBlow).toBeUndefined();
    expect(narrateCall.fatalBlow).toBeUndefined();
    expect(mutateCall.decisionPrompt).toBeUndefined();
    expect(narrateCall.decisionPrompt).toBeUndefined();
  });
});
