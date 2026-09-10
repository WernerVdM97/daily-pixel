/** The /map composition (M8.1, DC-M8.6) — the map delegates to the pure `map-render.ts`
 *  module: this composer reads the character's discovered graph and calls `renderMap`,
 *  a byte-for-byte lift of the pre-seam makeMapCommand body after the character guard.
 *  `map-render.ts` imports nothing from discord.js (only the WorldEngine types + the pure
 *  format.js helpers), so the controller layer crosses into it directly — the DC-M8.6
 *  settle (same precedent as hiScreen importing format.js). The slash-arm focus extraction
 *  stays adapter-side in index.ts until M9; this side only forwards it. */

import type { WorldEngine, CharacterData } from "../engine/WorldEngine.js";
import { renderMap } from "../render/map-render.js";

export function composeMapScreen(engine: WorldEngine, character: CharacterData, focus?: string): string {
  const graph = engine.getDiscoveredGraph(character.id);
  return renderMap(character.name, graph, focus);
}
