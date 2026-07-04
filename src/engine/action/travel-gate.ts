import type { WorldMutation } from '../WorldEngine.js';

/** The three ops that already relocate the character (`mutations.ts`'s `applyMutations`
 *  converges all three onto `state.location`) — any one of them already satisfies travel and
 *  must suppress the gate's injection. */
const RELOCATE_TYPES = new Set(['set_location', 'move_to', 'cross_frontier']);

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Stage 2 T4 — the deterministic travel-coherence gate (D6, prompt-v12-scene-state.md).
 *
 * The bug it closes: a Blacksmith at The Town Forge typed "go to the woods and brawl"; the
 * model authored a forest fight with no `set_location`, so the scene teleported while the
 * engine kept the character at the Forge. D6's option B2 ("declare location as data") makes the
 * check clean equality over structured fields — never NLP over prose — and the remedy is to
 * inject the missing `set_location` deterministically, no LLM re-authoring.
 *
 * Layering (D6): the gate injects intent, geography enforces feasibility. This helper only
 * appends the missing relocate mutation; it does not call `applyGeography` — reachability of the
 * injected `set_location` is T5's finalize concern, not this gate's.
 *
 * Pure: no I/O beyond the `console.warn` telemetry (mirrors the drop-with-warn style used by
 * `applyGeography`/`relation-wiring.ts`).
 */
export function applyTravelCoherenceGate(
  mutations: WorldMutation[],
  sceneLocation: string | undefined,
  currentLocation: string,
): WorldMutation[] {
  const scene = sceneLocation?.trim();
  if (!scene) return mutations;
  if (normalize(scene) === normalize(currentLocation)) return mutations;
  if (mutations.some(m => RELOCATE_TYPES.has(m.type))) return mutations;

  console.warn(
    `[travel-gate] injecting missing travel: "${currentLocation}" -> "${scene}" (scene_location diverged with no relocate mutation)`,
  );
  return [...mutations, { type: 'set_location', name: scene }];
}
