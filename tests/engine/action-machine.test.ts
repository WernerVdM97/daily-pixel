import { describe, it, expect } from 'vitest';
import { MockLlmGateway } from '../../src/llm/MockLlmGateway.js';
import { ActionStateMachine } from '../../src/engine/action/machine.js';
import type {
  CharacterData,
  ItemData,
} from '../../src/engine/WorldEngine.js';
import type {
  InternalActionState,
} from '../../src/engine/action/machine.js';
import type { LlmDecision } from '../../src/llm/LlmGateway.js';

// RED: tests fail because src/engine/action/machine.ts doesn't exist yet

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
    location: 'The Warden\'s Oak',
    wealth: 5,
    lastActionState: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const testItems: ItemData[] = [
  { id: 1, characterId: 1, name: 'Iron Sword', emoji: '⚔️', stat: 'physical', modifier: 2, quantity: 1 },
];

function huntFirstDecision(): LlmDecision {
  return {
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: false,
    decision: [
      { label: 'Follow deer tracks', dcModifier: -2 },
      { label: 'Track the wolf', dcModifier: 2 },
      { label: 'Bail', dcModifier: null },
    ],
  };
}

function huntSecondDecision(): LlmDecision {
  return {
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: false,
    decision: [
      { label: 'Stalk quietly', dcModifier: -1 },
      { label: 'Rush in', dcModifier: 2 },
      { label: 'Bail', dcModifier: null },
    ],
  };
}

function huntFinalDecision(): LlmDecision {
  return {
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: true,
    decision: [
      { label: 'Attack!', dcModifier: 0 },
    ],
    mutations: [
      { type: 'modify_health', amount: -3 },
    ],
    outcomeText: 'The wolf snaps at you as you strike, but your blade finds its mark.',
  };
}

describe('ActionStateMachine — start', () => {
  it('emits the first decision from the LLM', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision(huntFirstDecision());

    const machine = new ActionStateMachine(llm);
    const result = await machine.start(testChar(), 'go hunt a wolf', testItems);

    expect(result.state.rawInput).toBe('go hunt a wolf');
    expect(result.state.decisions).toEqual([]);
    expect(result.state.accumulatedDc).toBe(12); // base DC
    expect(result.firstDecision.prompt.toLowerCase()).toContain('hunt');
    expect(result.firstDecision.options).toHaveLength(3);
    expect(result.firstDecision.options[0]).toEqual({
      label: 'Follow deer tracks',
      dcModifier: -2,
    });
  });

  it('rejects if character has no rolls remaining', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision(huntFirstDecision());

    const machine = new ActionStateMachine(llm);
    const char = testChar({ rollsRemaining: 0 });

    await expect(machine.start(char, 'go hunt', testItems)).rejects.toThrow('No rolls remaining');
  });

  it('includes character context in LLM call', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision(huntFirstDecision());

    const machine = new ActionStateMachine(llm);
    await machine.start(testChar(), 'go hunt', testItems);

    const ctx = llm.calls[0].context;
    expect(ctx.character.class).toBe('Warrior');
    expect(ctx.character.stats.physical).toBe(3);
    expect(ctx.rawInput).toBe('go hunt');
    expect(ctx.location.name).toBe('The Warden\'s Oak');
  });

  it('includes items in itemBonus computation', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision(huntFirstDecision());

    const machine = new ActionStateMachine(llm);
    await machine.start(testChar(), 'go hunt', testItems);

    // verify the context has scaling hint (which could include item info)
    const ctx = llm.calls[0].context;
    expect(ctx.scalingHint).toBeDefined();
  });
});

describe('ActionStateMachine — step', () => {
  it('continues the loop when LLM says not done', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision(huntFirstDecision()); // first call
    // second call will use huntSecondDecision
    const machine = new ActionStateMachine(llm);

    // Start
    const { state: s0 } = await machine.start(testChar(), 'go hunt a wolf', testItems);

    // Set next decision for the step call
    llm.setDecision(huntSecondDecision());

    // Step: choose "Track the wolf" (dcModifier: +2)
    const result = await machine.step(s0, 'Track the wolf', testChar(), testItems);

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.state.decisions).toHaveLength(1);
      expect(result.state.decisions[0].chosen).toBe('Track the wolf');
      expect(result.state.decisions[0].dcModifier).toBe(2);
      expect(result.state.accumulatedDc).toBe(14); // 12 + 2
      expect(result.nextDecision.options).toHaveLength(3);
    }
  });

  it('resolves when LLM says done (success keeps the LLM mutations)', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision(huntFinalDecision()); // done: true

    const machine = new ActionStateMachine(llm, () => 20); // high roll → success
    const start = await machine.start(testChar(), 'go hunt a wolf', testItems);
    if (start.resolved) return;

    const result = await machine.step(start.state, 'Attack!', testChar(), testItems);

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.outcome.distilledType).toBe('hunt');
      expect(result.outcome.outcome).toBe('success');
      expect(result.outcome.finalDc).toBe(12); // base DC, no modifiers accumulated
      expect(result.outcome.mutations).toEqual([
        { type: 'modify_health', amount: -3 },
      ]);
      expect(result.outcome.outcomeText).toBe(
        'The wolf snaps at you as you strike, but your blade finds its mark.',
      );
    }
  });

  it('roll-first: the dice decide the verdict and a narration call carries it', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision({
      distilledType: 'errand', stat: 'physical', baseDc: 12,
      required: false, done: true,
      decision: [{ label: 'Deliver it', dcModifier: 0 }],
      mutations: [{ type: 'modify_stamina', amount: -1 }],
      outcomeText: 'You weave through the crowd.',
    });

    const machine = new ActionStateMachine(llm, () => 1); // natural 1 → failure
    const start = await machine.start(testChar(), 'carry a message', testItems);
    if (start.resolved) return;

    const before = llm.calls.length;
    const result = await machine.step(start.state, 'Deliver it', testChar(), testItems);

    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    // The dice decided failure, independent of the LLM's content.
    expect(result.outcome.outcome).toBe('failure');
    // Resolution made a second (narration) call carrying the verdict.
    expect(llm.calls.length).toBe(before + 2);
    expect(llm.calls[llm.calls.length - 1].context.rollOutcome).toBe('failure');
  });

  it('on failure, strips rewards and adds a stamina penalty', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision({
      distilledType: 'errand', stat: 'physical', baseDc: 12,
      required: false, done: true,
      decision: [{ label: 'Push on', dcModifier: 0 }],
      mutations: [
        { type: 'modify_wealth', amount: 5 },   // reward — should be dropped
        { type: 'add_item', name: 'Trinket', emoji: '💍', stat: 'charisma', modifier: 1, quantity: 1 }, // dropped
        { type: 'modify_stamina', amount: -1 },  // cost — kept
        { type: 'set_location', name: 'The East Road' }, // world change — kept
      ],
    });

    const machine = new ActionStateMachine(llm, () => 1); // low roll → failure
    const start = await machine.start(testChar(), 'run an errand', testItems);
    if (start.resolved) return;

    const result = await machine.step(start.state, 'Push on', testChar(), testItems);

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.outcome.outcome).toBe('failure');
      const m = result.outcome.mutations;
      // no reward
      expect(m.find(x => x.type === 'modify_wealth')).toBeUndefined();
      expect(m.find(x => x.type === 'add_item')).toBeUndefined();
      // costs + world change kept
      expect(m).toContainEqual({ type: 'modify_stamina', amount: -1 });
      expect(m).toContainEqual({ type: 'set_location', name: 'The East Road' });
      // flat failure penalty added
      expect(m).toContainEqual({ type: 'modify_stamina', amount: -2 });
    }
  });

  it('resolves as bailed (−1 stamina) when player bails a real decision', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision(huntFirstDecision());

    const machine = new ActionStateMachine(llm);
    const start = await machine.start(testChar(), 'go hunt a wolf', testItems);
    expect(start.resolved).toBe(false);
    if (start.resolved) return;

    const result = await machine.step(start.state, 'Bail', testChar(), testItems);

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.outcome.outcome).toBe('bailed');
      expect(result.outcome.distilledType).toBe('hunt');
      expect(result.outcome.finalDc).toBe(12); // unchanged
      expect(result.outcome.playerRolled).toBeNull(); // no roll on bail
      expect(result.outcome.mutations).toEqual([{ type: 'modify_stamina', amount: -1 }]);
    }
  });

  it('auto-finishes a done, non-required, choice-less decision (travel/rest)', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision({
      distilledType: 'travel',
      stat: 'physical',
      baseDc: 10,
      required: false,
      done: true,
      decision: [],
      mutations: [
        { type: 'set_location', name: 'The Forest Edge' },
        { type: 'modify_stamina', amount: 2 },
      ],
      outcomeText: 'You wake an hour later, steadier.',
    });

    const machine = new ActionStateMachine(llm);
    const start = await machine.start(testChar(), 'go nap in the woods', testItems);

    expect(start.resolved).toBe(true);
    if (start.resolved) {
      expect(start.outcome.outcome).toBe('done');
      expect(start.outcome.playerRolled).toBeNull();
      expect(start.outcome.outcomeText).toBe('You wake an hour later, steadier.');
      expect(start.outcome.mutations).toContainEqual({ type: 'set_location', name: 'The Forest Edge' });
    }
  });

  it('does NOT auto-finish a required, choice-less done decision', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision({
      distilledType: 'ambush', stat: 'physical', baseDc: 12,
      required: true, done: true, decision: [],
    });

    const machine = new ActionStateMachine(llm);
    const start = await machine.start(testChar(), 'react', testItems);

    expect(start.resolved).toBe(false);
  });

  it('stamps the distilled type on each decision record (breadcrumb trail)', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision(huntFirstDecision()); // distilled_type 'hunt', done: false
    const machine = new ActionStateMachine(llm, () => 10);

    const start = await machine.start(testChar(), 'go hunt', testItems);
    if (start.resolved) return;
    const step1 = await machine.step(start.state, 'Follow deer tracks', testChar(), testItems);

    expect(step1.resolved).toBe(false);
    if (step1.resolved) return;
    expect(step1.state.decisions[0].distilledType).toBe('hunt');
  });

  it('accumulates DC across multiple steps', async () => {
    const llm = new MockLlmGateway();

    // First call: start
    llm.setDecision(huntFirstDecision());
    const machine = new ActionStateMachine(llm);
    const { state: s0 } = await machine.start(testChar(), 'go hunt', testItems);

    // Step 1: choose bad option (+2 DC)
    llm.setDecision(huntSecondDecision());
    const r1 = await machine.step(s0, 'Track the wolf', testChar(), testItems);
    expect(r1.resolved).toBe(false);
    if (!r1.resolved) {
      expect(r1.state.accumulatedDc).toBe(14); // 12 + 2
    }

    // Step 2: choose good option (-1 DC), LLM says done
    llm.setDecision({
      ...huntFinalDecision(),
      baseDc: 12, // base DC stays the same; accumulation is in the state
    });
    const r2 = await machine.step(
      (r1 as { resolved: false; state: InternalActionState }).state,
      'Stalk quietly',
      testChar(),
      testItems,
    );

    expect(r2.resolved).toBe(true);
    if (r2.resolved) {
      // finalDc should be baseDc(12) + sum of modifiers: +2 + (-1) = 13
      expect(r2.outcome.finalDc).toBe(13);
    }
  });

  it('rolls a d20 and applies item bonus during resolution', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision({
      ...huntFinalDecision(),
      baseDc: 15,
      stat: 'physical',
    });

    const machine = new ActionStateMachine(llm);
    const { state: s0 } = await machine.start(testChar(), 'hunt', testItems);

    const result = await machine.step(s0, 'Attack!', testChar(), testItems);

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      // Item bonus: Iron Sword gives +2 to physical rolls
      expect(result.outcome.playerRolled).not.toBeNull();
      expect(result.outcome.playerRolled! >= 1 && result.outcome.playerRolled! <= 20).toBe(true);
    }
  });

  it('adds item bonus to the d20 roll against final DC', async () => {
    // Use a deterministic roll by mocking the random function
    const llm = new MockLlmGateway();
    llm.setDecision({
      ...huntFinalDecision(),
      baseDc: 12,
      stat: 'physical',
    });

    // Create machine with seeded roll
    const machine = new ActionStateMachine(llm, () => 10); // always roll 10
    const char = testChar();
    const { state: s0 } = await machine.start(char, 'hunt', testItems);
    const result = await machine.step(s0, 'Attack!', char, testItems);

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      // d20=10 + item bonus(2) = 12 >= DC(12) → success
      expect(result.outcome.playerRolled).toBe(10);
      expect(result.outcome.outcome).toBe('success');
    }
  });

  it('roll below DC with no item bonus is failure', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision({
      ...huntFinalDecision(),
      baseDc: 15,
      stat: 'wisdom', // no wisdom items
    });

    const machine = new ActionStateMachine(llm, () => 8); // roll 8
    const char = testChar();
    const { state: s0 } = await machine.start(char, 'hunt', []);
    const result = await machine.step(s0, 'Attack!', char, []);

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.outcome.outcome).toBe('failure');
    }
  });
});

describe('ActionStateMachine — resume', () => {
  it('reconstructs the pending decision from saved state', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision(huntFirstDecision());

    const machine = new ActionStateMachine(llm);
    const { state, firstDecision } = await machine.start(testChar(), 'go hunt a wolf', testItems);

    // Save the state as if persisted
    const savedState: InternalActionState = {
      ...state,
      pendingDecision: firstDecision, // stored in JSON
    };

    // Resume
    const resumed = machine.resume(savedState);

    expect(resumed.state.rawInput).toBe('go hunt a wolf');
    expect(resumed.state.decisions).toEqual([]);
    expect(resumed.nextDecision).toEqual(firstDecision);
  });

  it('resumes mid-action with accumulated decisions', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision(huntFirstDecision());
    const machine = new ActionStateMachine(llm);
    const { state: s0 } = await machine.start(testChar(), 'go hunt', testItems);

    // Step once
    llm.setDecision(huntSecondDecision());
    const r1 = await machine.step(s0, 'Track the wolf', testChar(), testItems);
    expect(r1.resolved).toBe(false);
    if (!r1.resolved) {
      const savedState = { ...r1.state, pendingDecision: r1.nextDecision };

      const resumed = machine.resume(savedState);

      expect(resumed.state.decisions).toHaveLength(1);
      expect(resumed.state.decisions[0].chosen).toBe('Track the wolf');
      expect(resumed.state.accumulatedDc).toBe(14);
      expect(resumed.nextDecision.options).toHaveLength(3);
    }
  });
});

describe('ActionStateMachine — required enforcement', () => {
  it('strips bail options from decision when required is true', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision({
      ...MockLlmGateway.defaultDecision(),
      required: true,
      decision: [
        { label: 'Fight back', dcModifier: 0 },
        { label: 'Dodge', dcModifier: -2 },
        { label: 'Bail', dcModifier: null },
      ],
    });

    const machine = new ActionStateMachine(llm);
    const { firstDecision, state } = await machine.start(testChar(), 'defend', []);

    // Bail option stripped
    expect(firstDecision.options).toHaveLength(2);
    expect(firstDecision.options.every(o => o.dcModifier !== null)).toBe(true);
    expect(state.required).toBe(true);
  });

  it('does not strip bail when required is false', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision({
      ...MockLlmGateway.defaultDecision(),
      required: false,
      decision: [
        { label: 'Explore', dcModifier: 0 },
        { label: 'Bail', dcModifier: null },
      ],
    });

    const machine = new ActionStateMachine(llm);
    const { firstDecision } = await machine.start(testChar(), 'explore', []);

    expect(firstDecision.options).toHaveLength(2);
    expect(firstDecision.options.some(o => o.dcModifier === null)).toBe(true);
  });
});

describe('ActionStateMachine — dcModifier clamping', () => {
  it('clamps dcModifier above +5 down to +5', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision({
      ...MockLlmGateway.defaultDecision(),
      decision: [
        { label: 'Do something crazy', dcModifier: 15 },
        { label: 'Bail', dcModifier: null },
      ],
    });

    const machine = new ActionStateMachine(llm);
    const { firstDecision } = await machine.start(testChar(), 'try', []);

    expect(firstDecision.options[0].dcModifier).toBe(5);
  });

  it('clamps dcModifier below -5 up to -5', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision({
      ...MockLlmGateway.defaultDecision(),
      decision: [
        { label: 'Cheat fate', dcModifier: -10 },
      ],
    });

    const machine = new ActionStateMachine(llm);
    const { firstDecision } = await machine.start(testChar(), 'try', []);

    expect(firstDecision.options[0].dcModifier).toBe(-5);
  });

  it('leaves valid dcModifier unchanged', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision({
      ...MockLlmGateway.defaultDecision(),
      decision: [
        { label: 'Normal action', dcModifier: 2 },
      ],
    });

    const machine = new ActionStateMachine(llm);
    const { firstDecision } = await machine.start(testChar(), 'try', []);

    expect(firstDecision.options[0].dcModifier).toBe(2);
  });
});
