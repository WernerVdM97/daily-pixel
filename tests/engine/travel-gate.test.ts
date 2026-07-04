import { describe, it, expect, vi } from 'vitest';
import { applyTravelCoherenceGate } from '../../src/engine/action/travel-gate.js';
import type { WorldMutation } from '../../src/engine/WorldEngine.js';

describe('applyTravelCoherenceGate', () => {
  it('injects a set_location and warns when the scene diverges with no relocate mutation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mutations: WorldMutation[] = [{ type: 'modify_health', amount: -2 }];

    const result = applyTravelCoherenceGate(mutations, 'the woods', 'The Town Forge');

    expect(result).toEqual([
      { type: 'modify_health', amount: -2 },
      { type: 'set_location', name: 'the woods' },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('is a no-op when the scene matches the current location', () => {
    const mutations: WorldMutation[] = [{ type: 'modify_health', amount: -2 }];
    const result = applyTravelCoherenceGate(mutations, 'The Town Forge', 'The Town Forge');
    expect(result).toEqual(mutations);
  });

  it('is a no-op when the scene matches the current location differing only by case', () => {
    const mutations: WorldMutation[] = [{ type: 'modify_health', amount: -2 }];
    const result = applyTravelCoherenceGate(mutations, 'the town forge', 'The Town Forge');
    expect(result).toEqual(mutations);
  });

  it('is a no-op when a set_location mutation is already present', () => {
    const mutations: WorldMutation[] = [{ type: 'set_location', name: 'the woods' }];
    const result = applyTravelCoherenceGate(mutations, 'the woods', 'The Town Forge');
    expect(result).toEqual(mutations);
  });

  it('is a no-op when a move_to mutation is already present', () => {
    const mutations: WorldMutation[] = [{ type: 'move_to', name: 'the woods' }];
    const result = applyTravelCoherenceGate(mutations, 'the woods', 'The Town Forge');
    expect(result).toEqual(mutations);
  });

  it('is a no-op when a cross_frontier mutation is already present', () => {
    const mutations: WorldMutation[] = [{ type: 'cross_frontier', direction: 'north', name: 'the woods' }];
    const result = applyTravelCoherenceGate(mutations, 'the woods', 'The Town Forge');
    expect(result).toEqual(mutations);
  });

  it('is a no-op when sceneLocation is undefined', () => {
    const mutations: WorldMutation[] = [{ type: 'modify_health', amount: -2 }];
    const result = applyTravelCoherenceGate(mutations, undefined, 'The Town Forge');
    expect(result).toEqual(mutations);
  });

  it('is a no-op when sceneLocation is an empty string', () => {
    const mutations: WorldMutation[] = [{ type: 'modify_health', amount: -2 }];
    const result = applyTravelCoherenceGate(mutations, '', 'The Town Forge');
    expect(result).toEqual(mutations);
  });

  it('is a no-op when sceneLocation is whitespace-only', () => {
    const mutations: WorldMutation[] = [{ type: 'modify_health', amount: -2 }];
    const result = applyTravelCoherenceGate(mutations, '   ', 'The Town Forge');
    expect(result).toEqual(mutations);
  });
});
