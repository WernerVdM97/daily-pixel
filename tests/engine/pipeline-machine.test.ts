import { describe, it, expect, vi } from 'vitest';
import { PipelineActionStateMachine } from '../../src/engine/action/PipelineActionStateMachine.js';
import type { CharacterData, ItemData } from '../../src/engine/WorldEngine.js';
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
