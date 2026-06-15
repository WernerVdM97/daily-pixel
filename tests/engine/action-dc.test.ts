import { describe, it, expect } from 'vitest';
import {
  accumulateDc,
  computeItemBonus,
  resolveRoll,
  validateDcModifier,
} from '../../src/engine/action/dc.js';
import type { ItemData } from '../../src/engine/WorldEngine.js';

// RED: tests fail because src/engine/action/dc.ts doesn't exist yet

describe('DC accumulation', () => {
  it('returns base DC when no modifiers', () => {
    expect(accumulateDc(12, [])).toBe(12);
  });

  it('adds a single positive modifier', () => {
    expect(accumulateDc(12, [2])).toBe(14);
  });

  it('adds a single negative modifier', () => {
    expect(accumulateDc(12, [-3])).toBe(9);
  });

  it('accumulates multiple modifiers (literal signed)', () => {
    // "You make two bad decisions" → DC climbs
    expect(accumulateDc(10, [2, 3])).toBe(15);

    // "Two good decisions" → DC drops
    expect(accumulateDc(10, [-2, -1])).toBe(7);

    // Mixed
    expect(accumulateDc(10, [2, -3, -1])).toBe(8);
  });

  it('handles the full spec range (-5 to +5)', () => {
    expect(accumulateDc(10, [5])).toBe(15);
    expect(accumulateDc(10, [-5])).toBe(5);
    expect(accumulateDc(10, [5, -5, 5, -5])).toBe(10);
  });

  it('never goes below 0', () => {
    expect(accumulateDc(5, [-8])).toBe(0);
  });

  it('clamps to a reasonable maximum (30)', () => {
    expect(accumulateDc(20, [5, 5, 5])).toBe(30);
  });
});

describe('DC modifier validation', () => {
  it('accepts valid range -5 to +5', () => {
    expect(validateDcModifier(0)).toBe(true);
    expect(validateDcModifier(5)).toBe(true);
    expect(validateDcModifier(-5)).toBe(true);
  });

  it('rejects out of range', () => {
    expect(validateDcModifier(6)).toBe(false);
    expect(validateDcModifier(-6)).toBe(false);
    expect(validateDcModifier(100)).toBe(false);
  });

  it('rejects NaN', () => {
    expect(validateDcModifier(NaN)).toBe(false);
  });
});

describe('Item bonus computation', () => {
  const items: ItemData[] = [
    { id: 1, characterId: 1, name: 'Iron Sword', emoji: '⚔️', stat: 'physical', modifier: 2, quantity: 1 },
    { id: 2, characterId: 1, name: 'Lucky Charm', emoji: '🍀', stat: 'wisdom', modifier: 1, quantity: 1 },
    { id: 3, characterId: 1, name: 'Cursed Ring', emoji: '💍', stat: 'charisma', modifier: -1, quantity: 1 },
    { id: 4, characterId: 1, name: 'Old Map', emoji: '🗺️', stat: 'intelligence', modifier: 1, quantity: 2 },
  ];

  it('sums modifiers for matching stat', () => {
    // physical: Iron Sword (+2) = 2
    expect(computeItemBonus(items, 'physical')).toBe(2);
  });

  it('handles negative modifiers', () => {
    // charisma: Cursed Ring (-1) = -1
    expect(computeItemBonus(items, 'charisma')).toBe(-1);
  });

  it('returns 0 for stat with no items', () => {
    // no stamina items in the list
    expect(computeItemBonus([], 'physical')).toBe(0);
  });

  it('includes quantity in computation', () => {
    // intelligence: Old Map (+1) x2 = +2
    expect(computeItemBonus(items, 'intelligence')).toBe(2);
  });

  it('handles mixed positive and negative for same stat', () => {
    const mixed: ItemData[] = [
      { id: 1, characterId: 1, name: 'Helm', emoji: '⛑️', stat: 'physical', modifier: 1, quantity: 1 },
      { id: 2, characterId: 1, name: 'Rusty Blade', emoji: '🗡️', stat: 'physical', modifier: -1, quantity: 1 },
    ];
    expect(computeItemBonus(mixed, 'physical')).toBe(0);
  });
});

describe('Roll resolution', () => {
  it('success: roll + bonus >= DC', () => {
    // DC 12, d20=15, bonus=0 → success
    expect(resolveRoll(15, 0, 12)).toBe('success');
    // DC 12, d20=10, bonus=2 → success (12 >= 12)
    expect(resolveRoll(10, 2, 12)).toBe('success');
  });

  it('failure: roll + bonus < DC', () => {
    // DC 12, d20=8, bonus=0 → failure
    expect(resolveRoll(8, 0, 12)).toBe('failure');
    // DC 12, d20=10, bonus=1 → failure (11 < 12)
    expect(resolveRoll(10, 1, 12)).toBe('failure');
  });

  it('natural 1 is always failure', () => {
    expect(resolveRoll(1, 5, 2)).toBe('failure');
  });

  it('natural 20 is always success', () => {
    expect(resolveRoll(20, -5, 30)).toBe('success');
  });

  it('edge: exact match is success (meets DC)', () => {
    expect(resolveRoll(12, 0, 12)).toBe('success');
  });
});
