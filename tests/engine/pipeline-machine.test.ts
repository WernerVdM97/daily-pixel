import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PipelineActionStateMachine } from '../../src/engine/action/PipelineActionStateMachine.js';
import { createGeographyFinalize } from '../../src/engine/geography-finalize.js';
import { runMigrations, seedWorld, SEEDED_LOCATIONS, SEEDED_EDGES } from '../../src/db/migrate.js';
import { LocationRepository } from '../../src/db/repositories/location.js';
import { LocationEdgeRepository } from '../../src/db/repositories/locationEdge.js';
import type { CharacterData, ItemData, WorldMutation } from '../../src/engine/WorldEngine.js';
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
} from '../../src/llm/pipeline/types.js';
import type { LlmContext } from '../../src/llm/LlmGateway.js';

// Deliberately NOT the legacy `MockLlmGateway` (single-decision-shaped) — the pipeline needs
// 4 distinct scriptable stages and sharing the legacy fixture would couple the two machines'
// test suites (Stage 1 backbone plan risk table).
class MockPipelineLlmGateway implements PipelineLlmGateway {
  classifyResult: ClassifyHit | Error = new Error('classify not scripted');
  decideResult: PipelineDecideResult | null = null;
  resolveMutateResult: PipelineResolveMutateResult = { mutations: [] };
  resolveNarrateResult: PipelineResolveNarrateResult = { outcomeText: 'It happens.' };

  classifyCalls: { rawInput: string; context: LlmContext }[] = [];
  decideCalls: PipelineDecideInput[] = [];
  resolveMutateCalls: PipelineResolveMutateInput[] = [];
  resolveNarrateCalls: PipelineResolveNarrateInput[] = [];

  async classify(rawInput: string, context: LlmContext): Promise<ClassifyHit> {
    this.classifyCalls.push({ rawInput, context });
    if (this.classifyResult instanceof Error) throw this.classifyResult;
    return this.classifyResult;
  }

  async decide(input: PipelineDecideInput): Promise<PipelineDecideResult> {
    this.decideCalls.push(input);
    if (!this.decideResult) throw new Error('decide not scripted');
    return this.decideResult;
  }

  async resolveMutate(input: PipelineResolveMutateInput): Promise<PipelineResolveMutateResult> {
    this.resolveMutateCalls.push(input);
    return this.resolveMutateResult;
  }

  async resolveNarrate(input: PipelineResolveNarrateInput): Promise<PipelineResolveNarrateResult> {
    this.resolveNarrateCalls.push(input);
    return this.resolveNarrateResult;
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
    expect(Object.prototype.hasOwnProperty.call(decideResult, 'mutations')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(decideResult, 'outcomeText')).toBe(false);

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
});
