// RED: Test fails because OutcomeRenderer doesn't exist yet

import { describe, it, expect } from 'vitest';
import type { ActionOutcome } from '../../src/engine/WorldEngine.js';
import { formatOutcome } from '../../src/engine/OutcomeRenderer.js';

describe('OutcomeRenderer — success', () => {
  const successOutcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 14,
    playerRolled: 16,
    outcome: 'success',
    outcomeText: 'The wolfsbane flares. The beast recoils, shrinking to the size of a common wolf before limping into the dark.',
    mutations: [],
  };

  it('shows roll vs DC with checkmark', () => {
    const result = formatOutcome(successOutcome, {
      stamina: 8,
      rollsRemaining: 1,
      health: 10,
      maxHealth: 12,
      wealth: 5,
    });

    expect(result).toContain('🎲');
    expect(result).toContain('16 vs 14');
    expect(result).toContain('✓');
    expect(result).toContain('Success');
  });

  it('includes the outcome text from the LLM', () => {
    const result = formatOutcome(successOutcome, {
      stamina: 8,
      rollsRemaining: 1,
      health: 10,
      maxHealth: 12,
      wealth: 5,
    });

    expect(result).toContain('The wolfsbane flares');
  });

  it('shows stamina and rolls in footer', () => {
    const result = formatOutcome(successOutcome, {
      stamina: 8,
      rollsRemaining: 1,
      health: 10,
      maxHealth: 12,
      wealth: 5,
    });

    expect(result).toContain('Stamina: 8/10');
    expect(result).toContain('Rolls: 1/2');
  });

  it('does not show health when unchanged', () => {
    const result = formatOutcome(successOutcome, {
      stamina: 8,
      rollsRemaining: 1,
      health: 10,
      maxHealth: 12,
      wealth: 5,
    });

    expect(result).not.toContain('Health');
  });

  it('shows health when it changed', () => {
    const result = formatOutcome(successOutcome, {
      stamina: 8,
      rollsRemaining: 1,
      health: 8,
      maxHealth: 12,
      wealth: 5,
      healthChanged: true,
    });

    expect(result).toContain('Health: 8/12');
  });

  it('does not show wealth when unchanged', () => {
    const result = formatOutcome(successOutcome, {
      stamina: 8,
      rollsRemaining: 1,
      health: 10,
      maxHealth: 12,
      wealth: 5,
    });

    expect(result).not.toContain('Wealth');
  });

  it('lists items gained in summary line', () => {
    const result = formatOutcome(successOutcome, {
      stamina: 8,
      rollsRemaining: 1,
      health: 10,
      maxHealth: 12,
      wealth: 5,
      itemsGained: [
        { emoji: '🦊', name: 'Wolf Pelt' },
        { emoji: '🍖', name: 'Wolf Meat' },
      ],
    });

    expect(result).toContain('+ 🦊 Wolf Pelt');
    expect(result).toContain('+ 🍖 Wolf Meat');
  });

  it('shows location change in summary', () => {
    const result = formatOutcome(successOutcome, {
      stamina: 8,
      rollsRemaining: 1,
      health: 10,
      maxHealth: 12,
      wealth: 5,
      newLocation: 'Deep Forest',
    });

    expect(result).toContain('→ Deep Forest');
  });

  it('includes items, location, and stats in full summary line', () => {
    const result = formatOutcome(successOutcome, {
      stamina: 8,
      rollsRemaining: 1,
      health: 10,
      maxHealth: 12,
      wealth: 5,
      itemsGained: [{ emoji: '🦊', name: 'Wolf Pelt' }],
      newLocation: 'Deep Forest',
    });

    // Expect a combined line with separator
    expect(result).toContain('+ 🦊 Wolf Pelt');
    expect(result).toContain('→ Deep Forest');
    expect(result).toContain('Stamina: 8/10');
    expect(result).toContain('Rolls: 1/2');
  });
});

describe('OutcomeRenderer — failure', () => {
  const failureOutcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 14,
    playerRolled: 3,
    outcome: 'failure',
    outcomeText: 'You lunge but the shale gives way beneath you.',
    mutations: [],
  };

  it('shows roll vs DC with cross', () => {
    const result = formatOutcome(failureOutcome, {
      stamina: 7,
      rollsRemaining: 1,
      health: 10,
      maxHealth: 12,
      wealth: 5,
    });

    expect(result).toContain('🎲');
    expect(result).toContain('3 vs 14');
    expect(result).toContain('✗');
    expect(result).toContain('Failure');
  });

  it('lists items lost', () => {
    const result = formatOutcome(failureOutcome, {
      stamina: 7,
      rollsRemaining: 1,
      health: 10,
      maxHealth: 12,
      wealth: 5,
      itemsLost: ['Iron Sword'],
    });

    expect(result).toContain('- Iron Sword');
  });

  it('shows health in footer when changed on failure', () => {
    const result = formatOutcome(failureOutcome, {
      stamina: 6,
      rollsRemaining: 1,
      health: 8,
      maxHealth: 12,
      wealth: 5,
      healthChanged: true,
    });

    expect(result).toContain('Health: 8/12');
  });
});

describe('OutcomeRenderer — skipped', () => {
  const skipOutcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 12,
    playerRolled: null,
    outcome: 'skipped',
    outcomeText: 'You retreat from the situation.',
    mutations: [],
  };

  it('shows skip symbol and text', () => {
    const result = formatOutcome(skipOutcome, {
      stamina: 9,
      rollsRemaining: 1,
      health: 10,
      maxHealth: 12,
      wealth: 5,
    });

    expect(result).toContain('↩');
    expect(result).toContain('Skipped');
    expect(result).toContain('You retreat from the situation.');
  });

  it('does not show a roll line for skipped', () => {
    const result = formatOutcome(skipOutcome, {
      stamina: 9,
      rollsRemaining: 1,
      health: 10,
      maxHealth: 12,
      wealth: 5,
    });

    expect(result).not.toContain('🎲');
  });
});

describe('OutcomeRenderer — timed out', () => {
  const timeoutOutcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 12,
    playerRolled: null,
    outcome: 'timed_out',
    outcomeText: 'The moment passes. Whatever you were doing, it\'s gone now.',
    mutations: [],
  };

  it('shows timeout symbol and text', () => {
    const result = formatOutcome(timeoutOutcome, {
      stamina: 8,
      rollsRemaining: 1,
      health: 10,
      maxHealth: 12,
      wealth: 5,
    });

    expect(result).toContain('⏰');
    expect(result).toContain('Timed out');
    expect(result).toContain('The moment passes.');
  });
});

describe('OutcomeRenderer — natural 1 / natural 20', () => {
  const nat1Outcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 5,
    playerRolled: 1,
    outcome: 'failure',
    outcomeText: 'You trip over your own feet.',
    mutations: [],
  };

  const nat20Outcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 30,
    playerRolled: 20,
    outcome: 'success',
    outcomeText: 'The gods smile upon you.',
    mutations: [],
  };

  it('marks nat1 as failure regardless of DC', () => {
    const result = formatOutcome(nat1Outcome, {
      stamina: 8,
      rollsRemaining: 0,
      health: 10,
      maxHealth: 12,
      wealth: 5,
    });

    expect(result).toContain('1 vs 5');
    expect(result).toContain('✗');
    expect(result).toContain('Failure');
  });

  it('marks nat20 as success regardless of DC', () => {
    const result = formatOutcome(nat20Outcome, {
      stamina: 8,
      rollsRemaining: 0,
      health: 10,
      maxHealth: 12,
      wealth: 5,
    });

    expect(result).toContain('20 vs 30');
    expect(result).toContain('✓');
    expect(result).toContain('Success');
  });
});
