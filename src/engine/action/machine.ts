import type { WorldMutation } from '../WorldEngine.js';

/**
 * Injectable resolver for world context — decouples the action machine from specific
 * repositories while letting it populate the LLM context with live world state.
 */
export interface WorldContextResolver {
  getNearbyNpcs(location: string): Array<{ id: number; name: string; description: string }>;
  getNearbyPcs(location: string, excludeCharId: number): Array<{ name: string; class: string }>;
  getRecentActions(characterId: number): Array<{ type: string; outcome: string; narrative?: string | null }>;
  /** All known location names — retained for the audit digest + stripped retry context. */
  getKnownLocations(): string[];
  /** Whether the named location is safe (true) or wild (false). Drives the scene safety tag. */
  isLocationSafe(location: string): boolean;
  /** v10 "here + exits": the current node's region + charted exits (move targets) and frontier
   *  exits (cross_frontier invitations), so travel is local and geographic. */
  getLocalGeography(location: string): {
    region: string | null;
    neighbours: { name: string; direction: string; difficulty: number }[];
    frontiers: { direction: string; teaser: string | null; difficulty: number }[];
  };
}



/** Flat extra stamina cost on a failed roll, so a loss carries real weight. */
const FAILURE_STAMINA_PENALTY = 2;

/**
 * Shape an outcome's mutations to its roll result. On failure: drop beneficial mutations (positive
 * stat/wealth/roll deltas, gained items), keep costs and world changes (move_to/set_location,
 * remove_item, add_npc/spawn_npc, update_npc, remove_npc), add a flat stamina penalty.
 * Success passes through unchanged.
 *
 * NOTE: outcome_text is still written before the roll, so on failure the narration may read as a
 * partial success — the deeper fix is rolling before flavour (see [[mvp-llm-prompt-architecture]]).
 */
export function applyOutcomeToMutations(outcome: string, mutations: WorldMutation[]): WorldMutation[] {
  if (outcome !== 'failure') return mutations;
  const kept = mutations.filter((m) => {
    switch (m.type) {
      case 'modify_wealth':
      case 'modify_stamina':
      case 'modify_health':
      case 'modify_rolls_remaining':
      case 'modify_max_stamina':
        return Number(m.amount ?? 0) < 0; // keep only costs, drop gains
      case 'add_item':
        return false; // no rewards on a failed action
      case 'cross_frontier':
        return false; // a failed roll doesn't break new ground; fall back to known location instead
      case 'reveal_location':
        return false; // a failed roll doesn't reveal new places
      case 'move_to':
      case 'set_location':
      case 'remove_item':
      case 'add_npc':
      case 'spawn_npc':
      case 'update_npc':
      case 'remove_npc':
        return true; // world changes survive failure
      default:
        return true;
    }
  });
  kept.push({ type: 'modify_stamina', amount: -FAILURE_STAMINA_PENALTY });
  return kept;
}


