import { describe, it, expect } from 'vitest';
import {
  validateMutations,
  applyMutations,
  collapseStackedDeltas,
  type MutationContext,
} from '../../src/engine/action/mutations.js';
import type { WorldMutation } from '../../src/engine/WorldEngine.js';
import { applyOutcomeToMutations } from '../../src/engine/action/machine.js';

// RED: tests fail because src/engine/action/mutations.ts doesn't exist yet

function ctx(overrides?: Partial<MutationContext>): MutationContext {
  return {
    currentHealth: 12,
    maxHealth: 12,
    stamina: 10,
    maxStamina: 10,
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

  it('rejects set_location naming an unknown location when knownLocations is provided', () => {
    const result = validateMutations(
      [{ type: 'set_location', name: 'Atlantis' }],
      ctx({ knownLocations: ['The Warden\'s Oak', 'The Dark Pines'] }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('unknown location');
  });

  it('accepts set_location matching a known location case-insensitively', () => {
    const result = validateMutations(
      [{ type: 'set_location', name: 'the dark pines' }],
      ctx({ knownLocations: ['The Warden\'s Oak', 'The Dark Pines'] }),
    );
    expect(result.valid).toBe(true);
  });

  it('snaps set_location to the canonical casing of a known location', () => {
    const applied = applyMutations(
      [{ type: 'set_location', name: 'the dark pines' }],
      ctx({ knownLocations: ['The Warden\'s Oak', 'The Dark Pines'] }),
    );
    expect(applied.location).toBe('The Dark Pines');
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

  it('clamps modify_stamina to the max ceiling (no 11/10)', () => {
    const state = applyMutations(
      [{ type: 'modify_stamina', amount: 5 }],
      ctx({ stamina: 9 }),
    );
    expect(state.stamina).toBe(10);
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

  it('returns items to remove from remove_item mutations (default qty 1)', () => {
    const state = applyMutations(
      [
        { type: 'remove_item', name: 'Rusty Sword' },
      ],
      ctx(),
    );
    expect(state.itemsToRemove).toHaveLength(1);
    expect(state.itemsToRemove[0]).toEqual({ name: 'Rusty Sword', quantity: 1 });
  });

  it('carries an explicit remove_item quantity', () => {
    const state = applyMutations(
      [
        { type: 'remove_item', name: 'Steel Ingot', quantity: 1 },
      ],
      ctx(),
    );
    expect(state.itemsToRemove[0]).toEqual({ name: 'Steel Ingot', quantity: 1 });
  });

  it('returns npcs to add from spawn_npc mutations (legacy alias)', () => {
    const state = applyMutations(
      [
        { type: 'spawn_npc', name: 'Greta', class: 'Blacksmith', description: 'A stern woman' },
      ],
      ctx(),
    );
    expect(state.npcsToAdd).toHaveLength(1);
    expect(state.npcsToAdd[0].name).toBe('Greta');
    expect(state.npcsToAdd[0].class).toBe('Blacksmith');
  });
});

describe('Mutation — modify_max_stamina', () => {
  it('increases max stamina and clamps current stamina to the new ceiling', () => {
    const state = applyMutations(
      [{ type: 'modify_max_stamina', amount: 2 }],
      ctx({ stamina: 9, maxStamina: 10 }),
    );
    expect(state.maxStamina).toBe(12);
    expect(state.stamina).toBe(9); // unchanged when below new ceiling
  });

  it('clamps current stamina when new ceiling is lower', () => {
    const state = applyMutations(
      [{ type: 'modify_max_stamina', amount: -2 }],
      ctx({ stamina: 10, maxStamina: 10 }),
    );
    expect(state.maxStamina).toBe(8);
    expect(state.stamina).toBe(8); // clamped to new ceiling
  });

  it('rejects modify_max_stamina that would reduce max stamina below 1', () => {
    const result = validateMutations(
      [{ type: 'modify_max_stamina', amount: -15 }],
      ctx({ stamina: 10, maxStamina: 10 }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('below 1');
  });

  it('rejects unknown mutation type', () => {
    const result = validateMutations(
      [{ type: 'modify_max_stamina', amount: 'not-a-number' } as unknown as WorldMutation],
      ctx(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('numeric');
  });

  it('is dropped by applyOutcomeToMutations on failure when positive (no reward)', () => {
    const result = applyOutcomeToMutations('failure', [
      { type: 'modify_max_stamina', amount: 1 },
      { type: 'modify_stamina', amount: -1 },
    ]);
    expect(result).not.toContainEqual(expect.objectContaining({ type: 'modify_max_stamina', amount: 1 }));
    expect(result).toContainEqual(expect.objectContaining({ type: 'modify_stamina', amount: -1 }));
  });

  it('is kept by applyOutcomeToMutations on failure when negative (cost)', () => {
    const result = applyOutcomeToMutations('failure', [
      { type: 'modify_max_stamina', amount: -1 },
    ]);
    expect(result).toContainEqual(expect.objectContaining({ type: 'modify_max_stamina', amount: -1 }));
  });
});

describe('Mutation v11 — move_to (primary travel verb)', () => {
  it('accepts a valid move_to mutation', () => {
    const result = validateMutations(
      [{ type: 'move_to', name: 'The Dark Pines' }],
      ctx(),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects move_to without name', () => {
    const result = validateMutations([{ type: 'move_to' }], ctx());
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('name');
  });

  it('rejects move_to with empty name', () => {
    const result = validateMutations([{ type: 'move_to', name: '' }], ctx());
    expect(result.valid).toBe(false);
  });

  it('rejects move_to naming an unknown location when knownLocations is provided', () => {
    const result = validateMutations(
      [{ type: 'move_to', name: 'Nowhere' }],
      ctx({ knownLocations: ['The Warden\'s Oak', 'The Dark Pines'] }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('unknown location');
  });

  it('applies move_to like set_location', () => {
    const state = applyMutations([{ type: 'move_to', name: 'The Dark Pines' }], ctx());
    expect(state.location).toBe('The Dark Pines');
  });
});

describe('Mutation v11 — add_npc', () => {
  it('accepts a valid add_npc mutation', () => {
    const result = validateMutations(
      [{ type: 'add_npc', name: 'Greta', class: 'Blacksmith', description: 'A stern woman' }],
      ctx(),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects add_npc without name', () => {
    const result = validateMutations(
      [{ type: 'add_npc', class: 'Blacksmith' }],
      ctx(),
    );
    expect(result.valid).toBe(false);
  });

  it('collects add_npc into npcsToAdd', () => {
    const state = applyMutations(
      [{ type: 'add_npc', name: 'Greta', class: 'Blacksmith', description: 'A stern woman' }],
      ctx(),
    );
    expect(state.npcsToAdd).toHaveLength(1);
    expect(state.npcsToAdd[0].name).toBe('Greta');
  });
});

describe('Mutation v11 — update_npc', () => {
  it('accepts a valid update_npc with resolved npcId', () => {
    const result = validateMutations(
      [{ type: 'update_npc', npcId: 42, description: 'He turns away.' }],
      ctx(),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects update_npc without npcId', () => {
    const result = validateMutations(
      [{ type: 'update_npc', description: 'Something changed' }],
      ctx(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('npcId');
  });

  it('rejects update_npc with sentinel npcId 0 (unknown handle fallback)', () => {
    const result = validateMutations(
      [{ type: 'update_npc', npcId: 0, description: 'Changed.' }],
      ctx(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('npcId');
  });

  it('collects update_npc into npcsToUpdate', () => {
    const state = applyMutations(
      [{ type: 'update_npc', npcId: 7, description: 'Wary now.' }],
      ctx(),
    );
    expect(state.npcsToUpdate).toHaveLength(1);
    expect(state.npcsToUpdate[0].npcId).toBe(7);
  });
});

describe('Mutation v11 — remove_npc', () => {
  it('accepts a valid remove_npc with resolved npcId', () => {
    const result = validateMutations(
      [{ type: 'remove_npc', npcId: 3 }],
      ctx(),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects remove_npc without npcId', () => {
    const result = validateMutations(
      [{ type: 'remove_npc' }],
      ctx(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('npcId');
  });

  it('rejects remove_npc with sentinel npcId 0 (unknown handle fallback)', () => {
    const result = validateMutations(
      [{ type: 'remove_npc', npcId: 0 }],
      ctx(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('npcId');
  });

  it('collects remove_npc into npcsToRemove', () => {
    const state = applyMutations(
      [{ type: 'remove_npc', npcId: 5 }],
      ctx(),
    );
    expect(state.npcsToRemove).toHaveLength(1);
    expect(state.npcsToRemove[0].npcId).toBe(5);
  });
});

describe('Mutation v11 — reveal_location', () => {
  it('accepts a valid reveal_location with name and direction', () => {
    const result = validateMutations(
      [{ type: 'reveal_location', name: 'The Ashen Spire', direction: 'E' }],
      ctx(),
    );
    expect(result.valid).toBe(true);
  });

  it('accepts reveal_location without direction (auto-assign)', () => {
    const result = validateMutations(
      [{ type: 'reveal_location', name: 'The Ashen Spire' }],
      ctx(),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects reveal_location without name', () => {
    const result = validateMutations(
      [{ type: 'reveal_location' }],
      ctx(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('name');
  });

  it('collects reveal_location into locationsToReveal', () => {
    const state = applyMutations(
      [{ type: 'reveal_location', name: 'The Ashen Spire', direction: 'NE' }],
      ctx(),
    );
    expect(state.locationsToReveal).toHaveLength(1);
    expect(state.locationsToReveal[0].name).toBe('The Ashen Spire');
    expect(state.locationsToReveal[0].direction).toBe('NE');
  });
});

describe('collapseStackedDeltas (§5a guard)', () => {
  it('collapses two modify_stamina into one', () => {
    const result = collapseStackedDeltas([
      { type: 'modify_stamina', amount: -2 },
      { type: 'modify_stamina', amount: -1 },
    ]);
    const stamina = result.filter(m => m.type === 'modify_stamina');
    expect(stamina).toHaveLength(1);
    expect(stamina[0].amount).toBe(-3);
  });

  it('caps negative stamina at -5', () => {
    const result = collapseStackedDeltas([
      { type: 'modify_stamina', amount: -3 },
      { type: 'modify_stamina', amount: -4 },
    ]);
    const stamina = result.filter(m => m.type === 'modify_stamina');
    expect(stamina[0].amount).toBe(-5);
  });

  it('does not cap positive stamina (healing)', () => {
    const result = collapseStackedDeltas([
      { type: 'modify_stamina', amount: 3 },
      { type: 'modify_stamina', amount: 4 },
    ]);
    const stamina = result.filter(m => m.type === 'modify_stamina');
    expect(stamina[0].amount).toBe(7);
  });

  it('caps negative health at -4', () => {
    const result = collapseStackedDeltas([
      { type: 'modify_health', amount: -2 },
      { type: 'modify_health', amount: -3 },
    ]);
    const health = result.filter(m => m.type === 'modify_health');
    expect(health[0].amount).toBe(-4);
  });

  it('does not cap positive health (healing)', () => {
    const result = collapseStackedDeltas([
      { type: 'modify_health', amount: 2 },
      { type: 'modify_health', amount: 3 },
    ]);
    const health = result.filter(m => m.type === 'modify_health');
    expect(health[0].amount).toBe(5);
  });

  it('passes non-scalar mutations through unchanged', () => {
    const muts: WorldMutation[] = [
      { type: 'add_npc', name: 'Greta', class: 'Blacksmith' },
      { type: 'modify_stamina', amount: -2 },
      { type: 'move_to', name: 'The Dark Pines' },
    ];
    const result = collapseStackedDeltas(muts);
    expect(result.some(m => m.type === 'add_npc')).toBe(true);
    expect(result.some(m => m.type === 'move_to')).toBe(true);
    expect(result.filter(m => m.type === 'modify_stamina')).toHaveLength(1);
  });

  it('collapses mixed positive and negative stamina correctly', () => {
    const result = collapseStackedDeltas([
      { type: 'modify_stamina', amount: -6 },
      { type: 'modify_stamina', amount: 2 },
    ]);
    const stamina = result.filter(m => m.type === 'modify_stamina');
    // Net is -4, which is above the -5 cap, so -4 passes through
    expect(stamina[0].amount).toBe(-4);
  });
});
