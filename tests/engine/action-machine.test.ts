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
    hasRestedToday: false,
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

  it('resolves mid-action when the next beat has no real options, even when done:false', async () => {
    // The LLM follows the v7 prompt and returns an empty `decision` array to
    // signal "resolve now" — `done` is deprecated, so step() must infer it from
    // no real options instead of degrading to a lone "Step back" dead-end.
    const llm = new MockLlmGateway();
    llm.setDecision(huntFirstDecision());
    const machine = new ActionStateMachine(llm, () => 20); // high roll → success
    const start = await machine.start(testChar(), 'go hunt a wolf', testItems);
    if (start.resolved) return;

    // Next LLM call (and the narration call) returns an all-bail / empty decision.
    llm.setDecision({
      distilledType: 'hunt',
      stat: 'physical',
      baseDc: 12,
      required: false,
      done: false, // deprecated flag intentionally unset
      decision: [{ label: 'Step back', dcModifier: null }],
      mutations: [{ type: 'modify_health', amount: -2 }],
      outcomeText: 'You corner the wolf and finish the hunt.',
    });

    const result = await machine.step(start.state, 'Track the wolf', testChar(), testItems);

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.outcome.playerRolled).toBe(20); // rolled, not a dead-end
      expect(result.outcome.outcome).toBe('success');
      expect(result.outcome.outcomeText).toBe('You corner the wolf and finish the hunt.');
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

  it('infers done from a non-required, choice-less decision even when done:false', async () => {
    const llm = new MockLlmGateway();
    llm.setDecision({
      distilledType: 'travel',
      stat: 'physical',
      baseDc: 10,
      required: false,
      done: false, // LLM forgot to set done — the bot infers it from no real options
      decision: [],
    });

    const machine = new ActionStateMachine(llm);
    const start = await machine.start(testChar(), 'wander to the edge', testItems);

    expect(start.resolved).toBe(true);
    if (start.resolved) {
      expect(start.outcome.outcome).toBe('done');
      expect(start.outcome.playerRolled).toBeNull();
      // No mutations supplied → neutral resolution, not a dead-end.
      expect(start.outcome.mutations).toEqual([]);
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
      // d20=10 + physical ability(3) + Iron Sword(+2) = 15 >= DC(12) → success
      expect(result.outcome.playerRolled).toBe(10);
      expect(result.outcome.rollBonus).toBe(5);
      expect(result.outcome.outcome).toBe('success');
    }
  });

  it('uses the chosen option\'s stat for the resolution roll (per-option stat)', async () => {
    // Action default stat is physical(0), but the player picks the charisma(5) approach.
    // The roll must test charisma — proving the option stat overrode the action default.
    const llm = new MockLlmGateway();
    llm.setDecision({
      distilledType: 'talk',
      stat: 'physical', // action default — should be overridden by the chosen option
      baseDc: 12,
      required: false,
      done: false,
      decision: [
        { label: 'Charm him', stat: 'charisma', dcModifier: 0 },
        { label: 'Force it', stat: 'physical', dcModifier: 0 },
        { label: 'Bail', dcModifier: null },
      ],
    });

    const machine = new ActionStateMachine(llm, () => 10); // deterministic roll
    const char = testChar({ stats: { physical: 0, wisdom: 0, intelligence: 0, charisma: 5 } });
    const start = await machine.start(char, 'win him over', []);
    if (start.resolved) return;

    // The step call resolves the action.
    llm.setDecision({
      distilledType: 'talk', stat: 'physical', baseDc: 12, required: false, done: true,
      decision: [],
      mutations: [{ type: 'modify_wealth', amount: 5 }, { type: 'modify_stamina', amount: -1 }],
      outcomeText: 'He laughs, claps your shoulder, and presses a few coins into your hand.',
    });

    const result = await machine.step(start.state, 'Charm him', char, []);

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.outcome.rollStat).toBe('charisma');
      expect(result.outcome.rollBonus).toBe(5); // charisma 5 + no items — NOT physical 0
      // d20=10 + 5 = 15 >= DC 12 → success (would have failed on physical 0)
      expect(result.outcome.outcome).toBe('success');
    }
  });

  it('roll below DC (ability + no items) is failure', async () => {
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

// ── Coherence critic hook (Thread 2) on the resolution beat ──

import type { LlmGateway, CriticGateway, CriticInput } from '../../src/llm/LlmGateway.js';

/** Drive an action through start → step → step to force resolveWithRoll, returning the outcome. */
async function resolveWith(llm: LlmGateway, critic?: CriticGateway, wage = 0) {
  // nat-1 roll → deterministic failure (resolveRoll: d20===1 is always failure).
  const machine = new ActionStateMachine(llm, () => 1, undefined, critic);
  const started = await machine.start(testChar(), 'hunt the boar', testItems, 'work', wage);
  if (started.resolved) throw new Error('expected an open decision, not an auto-finish');
  const step1 = await machine.step(started.state, 'Strike', testChar(), testItems);
  if (step1.resolved) throw new Error('expected a second beat, not resolution');
  const step2 = await machine.step(step1.state, 'Strike', testChar(), testItems);
  if (!step2.resolved) throw new Error('expected resolution on the second step');
  return step2.outcome;
}

describe('ActionStateMachine — day-job wage paid at resolution', () => {
  it('pays the wage into the resolved outcome (even on a failed roll), as modify_wealth', async () => {
    const outcome = await resolveWith(beatLlm, undefined, 5);
    expect(outcome.outcome).toBe('failure'); // nat-1
    const wealth = (outcome.mutations as Array<{ type: string; amount: number }>)
      .filter(m => m.type === 'modify_wealth');
    expect(wealth).toEqual([{ type: 'modify_wealth', amount: 5 }]);
  });

  it('adds no wage mutation when wage is 0', async () => {
    const outcome = await resolveWith(beatLlm, undefined, 0);
    expect((outcome.mutations as Array<{ type: string }>).some(m => m.type === 'modify_wealth')).toBe(false);
  });

  it('pays the wage into an auto-finished outcome', async () => {
    const autoLlm: LlmGateway = {
      decide: async () => ({
        distilledType: 'craft', stat: 'physical', baseDc: 10, required: false, done: true,
        decision: [], mutations: [{ type: 'modify_stamina', amount: -1 }], outcomeText: 'Done.',
      }),
    };
    const machine = new ActionStateMachine(autoLlm, () => 12, undefined);
    const started = await machine.start(testChar(), 'craft nails', testItems, 'work', 4);
    if (!started.resolved) throw new Error('expected auto-finish');
    const wealth = (started.outcome.mutations as Array<{ type: string; amount: number }>)
      .filter(m => m.type === 'modify_wealth');
    expect(wealth).toEqual([{ type: 'modify_wealth', amount: 4 }]);
  });

  it('does NOT pay the wage when the player bails', async () => {
    const machine = new ActionStateMachine(beatLlm, () => 1, undefined);
    const started = await machine.start(testChar(), 'hunt the boar', testItems, 'work', 5);
    if (started.resolved) throw new Error('expected an open decision');
    const bailed = await machine.step(started.state, 'Bail', testChar(), testItems);
    if (!bailed.resolved) throw new Error('expected bail to resolve');
    expect(bailed.outcome.outcome).toBe('bailed');
    expect((bailed.outcome.mutations as Array<{ type: string }>).some(m => m.type === 'modify_wealth')).toBe(false);
  });
});

const optionBeat: LlmDecision = {
  distilledType: 'combat', stat: 'physical', baseDc: 12, required: false, done: false,
  decision: [{ label: 'Strike', dcModifier: 0 }, { label: 'Bail', dcModifier: null }],
};
const narrationBeat: LlmDecision = {
  distilledType: 'combat', stat: 'physical', baseDc: 12, required: false, done: false,
  decision: [], mutations: [{ type: 'modify_stamina', amount: -1 }], outcomeText: 'You triumph over the boar!',
};
/** Returns option beats normally, the narration beat once the verdict is attached. */
const beatLlm: LlmGateway = {
  decide: async (ctx) => (ctx.rollOutcome ? narrationBeat : optionBeat),
};

describe('ActionStateMachine — resolution critic hook', () => {
  it('rewrites outcome_text on a minor critic patch', async () => {
    const critic: CriticGateway = {
      critique: async () => ({
        ok: false, severity: 'minor', issues: ['narration reads as a win but the roll FAILED'],
        patch: { outcomeText: 'The boar crashes off into the bracken; you are left winded and empty-handed.' },
      }),
    };
    const outcome = await resolveWith(beatLlm, critic);
    expect(outcome.outcome).toBe('failure');
    expect(outcome.outcomeText).toBe('The boar crashes off into the bracken; you are left winded and empty-handed.');
  });

  it('keeps the narration text when the critic says ok', async () => {
    const critic: CriticGateway = { critique: async () => ({ ok: true, severity: 'minor', issues: [] }) };
    const outcome = await resolveWith(beatLlm, critic);
    expect(outcome.outcomeText).toBe('You triumph over the boar!');
  });

  it('passes beat=resolution + verdict + FINAL mutations (post-strip) to the critic', async () => {
    let seen: CriticInput | undefined;
    const critic: CriticGateway = {
      critique: async (input) => { seen = input; return { ok: true, severity: 'minor', issues: [] }; },
    };
    await resolveWith(beatLlm, critic);
    expect(seen?.beat).toBe('resolution');
    expect(seen?.rollOutcome).toBe('failure');
    // applyOutcomeToMutations adds the -2 failure stamina penalty alongside the kept -1 cost.
    const stamina = (seen?.finalMutations as Array<{ type: string; amount: number }>).filter(m => m.type === 'modify_stamina');
    expect(stamina).toEqual([{ type: 'modify_stamina', amount: -1 }, { type: 'modify_stamina', amount: -2 }]);
  });

  it('leaves outcome_text untouched when no critic is wired', async () => {
    const outcome = await resolveWith(beatLlm); // no critic
    expect(outcome.outcomeText).toBe('You triumph over the boar!');
  });
});

describe('ActionStateMachine — llm_call chain linkage', () => {
  it('accumulates every beat call id (+ resolution critic) onto the outcome', async () => {
    let id = 0;
    const llm: LlmGateway = {
      decide: async (ctx) => ({ ...(ctx.rollOutcome ? narrationBeat : optionBeat), _llmCallId: ++id }),
    };
    const critic: CriticGateway = {
      critique: async () => ({ ok: true, severity: 'minor', issues: [], _llmCallId: 99 }),
    };
    const machine = new ActionStateMachine(llm, () => 1, undefined, critic);
    const started = await machine.start(testChar(), 'work the forge', testItems, 'work', 0);
    if (started.resolved) throw new Error('expected an open decision');
    const s1 = await machine.step(started.state, 'Strike', testChar(), testItems);
    if (s1.resolved) throw new Error('expected a continue');
    const s2 = await machine.step(s1.state, 'Strike', testChar(), testItems);
    if (!s2.resolved) throw new Error('expected resolution');
    // start(1), continue(2), resolve-trigger decide(3), narration(4), resolution critic(99)
    expect(s2.outcome.llmCallIds).toEqual([1, 2, 3, 4, 99]);
  });

  it('carries the decision call id on an auto-finished outcome', async () => {
    const llm: LlmGateway = {
      decide: async () => ({
        distilledType: 'rest', stat: 'wisdom', baseDc: 10, required: false, done: true,
        decision: [], mutations: [{ type: 'modify_stamina', amount: 2 }], outcomeText: 'Rested.', _llmCallId: 7,
      }),
    };
    const machine = new ActionStateMachine(llm, () => 12, undefined);
    const started = await machine.start(testChar(), 'nap', testItems);
    if (!started.resolved) throw new Error('expected auto-finish');
    expect(started.outcome.llmCallIds).toEqual([7]);
  });
});
