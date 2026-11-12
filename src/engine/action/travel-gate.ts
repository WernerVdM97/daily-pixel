import type { WorldMutation } from '../WorldEngine.js';
import { RELOCATE_MUTATION_TYPES } from './mutations.js';

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** `ok` carries the (possibly augmented) list; `unresolvable` names a scene no place can hold. */
export type TravelCoherenceVerdict =
  | { kind: 'ok'; mutations: WorldMutation[] }
  | { kind: 'unresolvable'; sceneLocation: string };

/**
 * Closes the gap where the scene teleports in prose while the engine keeps the character put: it
 * appends the missing `set_location`, which geography drops in finalize if unreachable. A scene
 * naming no place the graph knows is reported instead of injected — the model echoed the
 * `Place · Region` display label back into `scene_location` — because injecting there only feeds a
 * drop, leaving the prose somewhere the character never went.
 */
export function applyTravelCoherenceGate(
  mutations: WorldMutation[],
  sceneLocation: string | undefined,
  currentLocation: string,
  knownLocations: string[],
): TravelCoherenceVerdict {
  const scene = sceneLocation?.trim();
  if (!scene) return { kind: 'ok', mutations };
  if (normalize(scene) === normalize(currentLocation)) return { kind: 'ok', mutations };
  if (!resolvesToKnownPlace(scene, knownLocations, mutations)) {
    console.warn(
      `[travel-gate] scene_location "${scene}" names no known place (character at "${currentLocation}") — refusing to relocate`,
    );
    return { kind: 'unresolvable', sceneLocation: scene };
  }
  // Shared with `mutations.ts` (`RELOCATE_MUTATION_TYPES`) — any one of these three already
  // relocates the character, so it already satisfies travel and must suppress the injection.
  if (mutations.some(m => RELOCATE_MUTATION_TYPES.has(m.type))) return { kind: 'ok', mutations };

  console.warn(
    `[travel-gate] injecting missing travel: "${currentLocation}" -> "${scene}" (scene_location diverged with no relocate mutation)`,
  );
  return { kind: 'ok', mutations: [...mutations, { type: 'set_location', name: scene }] };
}

/** An unknown name is legal only as a frontier the model crossed this beat, whose arrival it names.
 *  With no graph to check against (an unwired resolver) every name is taken on trust. */
function resolvesToKnownPlace(
  scene: string,
  knownLocations: string[],
  mutations: WorldMutation[],
): boolean {
  if (knownLocations.length === 0) return true;
  const norm = normalize(scene);
  if (knownLocations.some(l => normalize(l) === norm)) return true;
  return mutations.some(
    m => m.type === 'cross_frontier' && typeof m.name === 'string' && normalize(m.name) === norm,
  );
}
