import type { WorldMutation } from '../WorldEngine.js';
import { RELOCATE_MUTATION_TYPES } from './mutations.js';

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Closes the gap where the scene teleports in prose while the engine keeps the character put: it
 * appends the missing `set_location`, which geography drops in finalize if unreachable.
 */
export function applyTravelCoherenceGate(
  mutations: WorldMutation[],
  sceneLocation: string | undefined,
  currentLocation: string,
): WorldMutation[] {
  const scene = sceneLocation?.trim();
  if (!scene) return mutations;
  if (normalize(scene) === normalize(currentLocation)) return mutations;
  // Shared with `mutations.ts` (`RELOCATE_MUTATION_TYPES`) — any one of these three already
  // relocates the character, so it already satisfies travel and must suppress the injection.
  if (mutations.some(m => RELOCATE_MUTATION_TYPES.has(m.type))) return mutations;

  console.warn(
    `[travel-gate] injecting missing travel: "${currentLocation}" -> "${scene}" (scene_location diverged with no relocate mutation)`,
  );
  return [...mutations, { type: 'set_location', name: scene }];
}
