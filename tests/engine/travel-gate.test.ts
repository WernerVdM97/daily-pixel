import { describe, it, expect, vi } from 'vitest';
import { applyTravelCoherenceGate } from '../../src/engine/action/travel-gate.js';
import type { WorldMutation } from '../../src/engine/WorldEngine.js';

const graph = ['The Town Forge', 'the woods', 'Town Square'];

describe('applyTravelCoherenceGate', () => {
  it('injects a set_location and warns when the scene diverges with no relocate mutation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mutations: WorldMutation[] = [{ type: 'modify_health', amount: -2 }];

    const result = applyTravelCoherenceGate(mutations, 'the woods', 'The Town Forge', graph);

    expect(result).toEqual({
      kind: 'ok',
      mutations: [
        { type: 'modify_health', amount: -2 },
        { type: 'set_location', name: 'the woods' },
      ],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('is a no-op when the scene matches the current location', () => {
    const mutations: WorldMutation[] = [{ type: 'modify_health', amount: -2 }];
    const result = applyTravelCoherenceGate(mutations, 'The Town Forge', 'The Town Forge', graph);
    expect(result).toEqual({ kind: 'ok', mutations });
  });

  it('is a no-op when the scene matches the current location differing only by case', () => {
    const mutations: WorldMutation[] = [{ type: 'modify_health', amount: -2 }];
    const result = applyTravelCoherenceGate(mutations, 'the town forge', 'The Town Forge', graph);
    expect(result).toEqual({ kind: 'ok', mutations });
  });

  it('is a no-op when a set_location mutation is already present', () => {
    const mutations: WorldMutation[] = [{ type: 'set_location', name: 'the woods' }];
    const result = applyTravelCoherenceGate(mutations, 'the woods', 'The Town Forge', graph);
    expect(result).toEqual({ kind: 'ok', mutations });
  });

  it('is a no-op when a move_to mutation is already present', () => {
    const mutations: WorldMutation[] = [{ type: 'move_to', name: 'the woods' }];
    const result = applyTravelCoherenceGate(mutations, 'the woods', 'The Town Forge', graph);
    expect(result).toEqual({ kind: 'ok', mutations });
  });

  it('is a no-op when a cross_frontier mutation is already present', () => {
    const mutations: WorldMutation[] = [{ type: 'cross_frontier', direction: 'north', name: 'the woods' }];
    const result = applyTravelCoherenceGate(mutations, 'the woods', 'The Town Forge', graph);
    expect(result).toEqual({ kind: 'ok', mutations });
  });

  it('is a no-op when sceneLocation is undefined', () => {
    const mutations: WorldMutation[] = [{ type: 'modify_health', amount: -2 }];
    const result = applyTravelCoherenceGate(mutations, undefined, 'The Town Forge', graph);
    expect(result).toEqual({ kind: 'ok', mutations });
  });

  it('is a no-op when sceneLocation is an empty string', () => {
    const mutations: WorldMutation[] = [{ type: 'modify_health', amount: -2 }];
    const result = applyTravelCoherenceGate(mutations, '', 'The Town Forge', graph);
    expect(result).toEqual({ kind: 'ok', mutations });
  });

  it('is a no-op when sceneLocation is whitespace-only', () => {
    const mutations: WorldMutation[] = [{ type: 'modify_health', amount: -2 }];
    const result = applyTravelCoherenceGate(mutations, '   ', 'The Town Forge', graph);
    expect(result).toEqual({ kind: 'ok', mutations });
  });

  it('reports a compound display label as unresolvable rather than relocating to it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mutations: WorldMutation[] = [{ type: 'modify_health', amount: -2 }];

    // "Town Square" is a real node; the `Place · Region` label the model was shown is not.
    const result = applyTravelCoherenceGate(mutations, 'Town Square · The Vale', 'The Town Forge', graph);

    expect(result).toEqual({ kind: 'unresolvable', sceneLocation: 'Town Square · The Vale' });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('reports an unknown scene even when the mutations already relocate elsewhere', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mutations: WorldMutation[] = [{ type: 'move_to', name: 'the woods' }];

    const result = applyTravelCoherenceGate(mutations, 'The Vale', 'The Town Forge', graph);

    expect(result).toEqual({ kind: 'unresolvable', sceneLocation: 'The Vale' });
    warn.mockRestore();
  });

  it('accepts an unknown scene that a cross_frontier mints this beat', () => {
    const mutations: WorldMutation[] = [{ type: 'cross_frontier', direction: 'north', name: 'The Ashen Reach' }];
    const result = applyTravelCoherenceGate(mutations, 'The Ashen Reach', 'The Town Forge', graph);
    expect(result).toEqual({ kind: 'ok', mutations });
  });

  it('accepts a frontier whose authored name only matches the scene once sanitized', () => {
    // Finalize mints `sanitizeAuthored(name)`, so markdown or a whitespace run in the authored
    // name must not void a beat that would have arrived at exactly the declared scene.
    const mutations: WorldMutation[] = [
      { type: 'cross_frontier', direction: 'north', name: 'The **Ashen**  Reach' },
    ];
    const result = applyTravelCoherenceGate(mutations, 'The Ashen Reach', 'The Town Forge', graph);
    expect(result).toEqual({ kind: 'ok', mutations });
  });

  it('takes any name on trust when the gate has no graph to check against', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mutations: WorldMutation[] = [];

    const result = applyTravelCoherenceGate(mutations, 'the woods', 'The Town Forge', []);

    expect(result).toEqual({ kind: 'ok', mutations: [{ type: 'set_location', name: 'the woods' }] });
    warn.mockRestore();
  });
});
