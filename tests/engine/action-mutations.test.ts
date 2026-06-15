import { describe, it, expect } from 'vitest';
import {
  validateMutations,
  applyMutations,
  type MutationContext,
  type MutationError,
} from '../../src/engine/action/mutations.js';
import type { WorldMutation } from '../../src/engine/WorldEngine.js';

// RED: tests fail because src/engine/action/mutations.ts doesn't exist yet

function ctx(overrides?: Partial<MutationContext>): MutationContext {
  return {
    currentHealth: 12,
    maxHealth: 12,
    stamina: 10,
    wealth: 5,
    rollsRemaining: 2,
    location: 'The Warden\'s Oak',
    ...overrides,
  };
}

describe('Mutation validation', () => {
  it('accepts a valid set_location mutation', () => {
    const result = validateMutations(
      [{ type: 'set_location', name: 'Darkwood Forest' }],
      ctx(),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects set_location without name', () => {
    const result = validateMutations(
      [{ type: 'set_location' }],
      ctx(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('name');
  });

  it('rejects set_location with empty name', () => {
    const result = validateMutations(
      [{ type: 'set_location', name: '' }],
      ctx(),
    );
    expect(result.valid).toBe(false);
  });

  it('accepts valid modify_health within bounds', () => {
    const result = validateMutations(
      [{ type: 'modify_health', amount: -3 }],
      ctx({ currentHealth: 10 }),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects modify_health that would go below 0', () => {
    const result = validateMutations(
      [{ type: 'modify_health', amount: -10 }],
      ctx({ currentHealth: 5 }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('health');
  });

  it('rejects modify_health that would exceed max_health', () => {
    const result = validateMutations(
      [{ type: 'modify_health', amount: 10 }],
      ctx({ currentHealth: 10, maxHealth: 12 }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('exceed');
  });

  it('accepts modify_health healing up to max', () => {
    const result = validateMutations(
      [{ type: 'modify_health', amount: 5 }],
      ctx({ currentHealth: 5, maxHealth: 12 }),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects modify_health without amount', () => {
    const result = validateMutations(
      [{ type: 'modify_health' }],
      ctx(),
    );
    expect(result.valid).toBe(false);
  });

  it('accepts valid modify_stamina', () => {
    const result = validateMutations(
      [{ type: 'modify_stamina', amount: -2 }],
      ctx(),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects modify_stamina below 0', () => {
    const result = validateMutations(
      [{ type: 'modify_stamina', amount: -15 }],
      ctx({ stamina: 5 }),
    );
    expect(result.valid).toBe(false);
  });

  it('accepts valid modify_wealth', () => {
    const result = validateMutations(
      [{ type: 'modify_wealth', amount: 10 }],
      ctx(),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects modify_wealth below 0', () => {
    const result = validateMutations(
      [{ type: 'modify_wealth', amount: -20 }],
      ctx({ wealth: 5 }),
    );
    expect(result.valid).toBe(false);
  });

  it('accepts modify_rolls_remaining (draining a roll)', () => {
    const result = validateMutations(
      [{ type: 'modify_rolls_remaining', amount: -1 }],
      ctx({ rollsRemaining: 1 }),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects modify_rolls_remaining below 0', () => {
    const result = validateMutations(
      [{ type: 'modify_rolls_remaining', amount: -3 }],
      ctx({ rollsRemaining: 1 }),
    );
    expect(result.valid).toBe(false);
  });

  it('accepts valid add_item', () => {
    const result = validateMutations(
      [{ type: 'add_item', name: 'Iron Sword', emoji: '⚔️', stat: 'physical', modifier: 2, quantity: 1 }],
      ctx(),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects add_item without name', () => {
    const result = validateMutations(
      [{ type: 'add_item', emoji: '⚔️', stat: 'physical', modifier: 2 }],
      ctx(),
    );
    expect(result.valid).toBe(false);
  });

  it('accepts valid remove_item', () => {
    const result = validateMutations(
      [{ type: 'remove_item', name: 'Iron Sword' }],
      ctx(),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects remove_item without name', () => {
    const result = validateMutations(
      [{ type: 'remove_item' }],
      ctx(),
    );
    expect(result.valid).toBe(false);
  });

  it('accepts valid spawn_npc', () => {
    const result = validateMutations(
      [{ type: 'spawn_npc', name: 'Greta', class: 'Blacksmith', description: 'A stern woman' }],
      ctx(),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects spawn_npc without name', () => {
    const result = validateMutations(
      [{ type: 'spawn_npc', class: 'Blacksmith' }],
      ctx(),
    );
    expect(result.valid).toBe(false);
  });

  it('rejects unknown mutation type', () => {
    const result = validateMutations(
      [{ type: 'nuke_the_world' as any }],
      ctx(),
    );
    expect(result.valid).toBe(false);
  });

  it('returns all errors for multiple invalid mutations', () => {
    const result = validateMutations(
      [
        { type: 'set_location', name: '' },
        { type: 'modify_health', amount: -50 },
        { type: 'spawn_npc' },
      ],
      ctx(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(3);
  });
});

describe('Mutation application', () => {
  it('applies set_location', () => {
    const state = applyMutations(
      [{ type: 'set_location', name: 'Darkwood Forest' }],
      ctx(),
    );
    expect(state.location).toBe('Darkwood Forest');
  });

  it('applies modify_health (damage)', () => {
    const state = applyMutations(
      [{ type: 'modify_health', amount: -4 }],
      ctx({ currentHealth: 12 }),
    );
    expect(state.currentHealth).toBe(8);
  });

  it('applies modify_health (healing)', () => {
    const state = applyMutations(
      [{ type: 'modify_health', amount: 3 }],
      ctx({ currentHealth: 5, maxHealth: 12 }),
    );
    expect(state.currentHealth).toBe(8);
  });

  it('clamps health to max_health on healing', () => {
    const state = applyMutations(
      [{ type: 'modify_health', amount: 10 }],
      ctx({ currentHealth: 10, maxHealth: 12 }),
    );
    expect(state.currentHealth).toBe(12);
  });

  it('applies modify_stamina', () => {
    const state = applyMutations(
      [{ type: 'modify_stamina', amount: -3 }],
      ctx({ stamina: 10 }),
    );
    expect(state.stamina).toBe(7);
  });

  it('applies modify_wealth (gain)', () => {
    const state = applyMutations(
      [{ type: 'modify_wealth', amount: 15 }],
      ctx({ wealth: 5 }),
    );
    expect(state.wealth).toBe(20);
  });

  it('applies modify_wealth (loss)', () => {
    const state = applyMutations(
      [{ type: 'modify_wealth', amount: -3 }],
      ctx({ wealth: 10 }),
    );
    expect(state.wealth).toBe(7);
  });

  it('applies modify_rolls_remaining (drain)', () => {
    const state = applyMutations(
      [{ type: 'modify_rolls_remaining', amount: -1 }],
      ctx({ rollsRemaining: 2 }),
    );
    expect(state.rollsRemaining).toBe(1);
  });

  it('applies multiple mutations in sequence', () => {
    const state = applyMutations(
      [
        { type: 'modify_health', amount: -3 },
        { type: 'set_location', name: 'Darkwood Forest' },
        { type: 'modify_wealth', amount: 10 },
        { type: 'modify_rolls_remaining', amount: -1 },
      ],
      ctx({ currentHealth: 12, wealth: 5, rollsRemaining: 2 }),
    );
    expect(state.currentHealth).toBe(9);
    expect(state.location).toBe('Darkwood Forest');
    expect(state.wealth).toBe(15);
    expect(state.rollsRemaining).toBe(1);
  });

  it('returns items to add from add_item mutations', () => {
    const state = applyMutations(
      [
        { type: 'add_item', name: 'Wolf Pelt', emoji: '🐺', stat: 'charisma', modifier: 1, quantity: 1 },
      ],
      ctx(),
    );
    expect(state.itemsToAdd).toHaveLength(1);
    expect(state.itemsToAdd[0].name).toBe('Wolf Pelt');
  });

  it('returns items to remove from remove_item mutations', () => {
    const state = applyMutations(
      [
        { type: 'remove_item', name: 'Rusty Sword' },
      ],
      ctx(),
    );
    expect(state.itemsToRemove).toHaveLength(1);
    expect(state.itemsToRemove[0]).toBe('Rusty Sword');
  });

  it('returns npcs to spawn from spawn_npc mutations', () => {
    const state = applyMutations(
      [
        { type: 'spawn_npc', name: 'Greta', class: 'Blacksmith', description: 'A stern woman' },
      ],
      ctx(),
    );
    expect(state.npcsToSpawn).toHaveLength(1);
    expect(state.npcsToSpawn[0].name).toBe('Greta');
    expect(state.npcsToSpawn[0].class).toBe('Blacksmith');
  });
});
