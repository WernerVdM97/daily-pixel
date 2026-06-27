import type { WorldEngine } from "../../engine/WorldEngine.js";
import { renderMap } from "../map-render.js";

/**
 * `/map [region|place]` — render the player's discovered subgraph (fog-of-war over
 * the shared world graph, §5). The optional argument fuzzily drills into a region or
 * zooms to a place's own roads (typos/casing tolerated — see resolveMapFocus).
 */
export function makeMapCommand(engine: WorldEngine) {
  return async (interaction: { user: { id: string }; focus?: string }): Promise<string> => {
    const character = engine.getCharacter(interaction.user.id);
    if (!character) {
      return "You don't have a character yet. Type `/join` to create one.";
    }
    const graph = engine.getDiscoveredGraph(character.id);
    return renderMap(character.name, graph, interaction.focus);
  };
}
