/** The /backpack composition (M8.1, DC-M8.3) — `formatBackpack` + the capacity/grid
 *  constants lifted byte-for-byte from the pre-seam src/discord/commands/backpack.ts, with
 *  `composeBackpackScreen` the thin engine-read wrapper the controller's `openBackpack`
 *  calls. `BACKPACK_CAPACITY` moves with the composer — the command file no longer exports
 *  it (no importer exists outside the old file; the rewire drops the export). */

import type { WorldEngine, CharacterData, ItemData } from "../engine/WorldEngine.js";
import { STAT_LABELS } from "../engine/stat-format.js";
import { SEPARATOR } from "../discord/format.js";

/** How many item slots a character can carry. */
export const BACKPACK_CAPACITY = 40;
/** Slots per grid row — renders the pack as a tidy 10-wide grid (4 rows at full capacity). */
const GRID_COLS = 10;
/** Emoji shown for an unused slot in the grid. */
const EMPTY_SLOT = "⬜";

export function composeBackpackScreen(engine: WorldEngine, character: CharacterData): string {
  return formatBackpack(engine.getItems(character.id));
}

export function formatBackpack(items: ItemData[]): string {
  const lines: string[] = [];

  // Slots used = total quantity carried; the grid shows used + empty slots up to capacity.
  const used = items.reduce((sum, i) => sum + i.quantity, 0);
  lines.push(`🎒 **Backpack** (${used}/${BACKPACK_CAPACITY})`);
  lines.push(SEPARATOR);
  lines.push("");

  // Emoji grid: one emoji per carried unit, then ⬜ for each free slot, wrapped
  // into GRID_COLS-wide rows so the pack reads as a grid, not one long line.
  const filled = items.flatMap((item) => Array(item.quantity).fill(item.emoji));
  const empties = Array(Math.max(0, BACKPACK_CAPACITY - used)).fill(EMPTY_SLOT);
  const slots = [...filled, ...empties];
  for (let i = 0; i < slots.length; i += GRID_COLS) {
    lines.push(slots.slice(i, i + GRID_COLS).join(" "));
  }

  if (items.length === 0) {
    lines.push("");
    lines.push("Your pack is empty.");
    return lines.join("\n");
  }

  // Group by stat
  const groups: Record<string, ItemData[]> = {};
  for (const item of items) {
    const key = item.modifier !== 0 ? item.stat : "__utility__";
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  // Stat order: physical, wisdom, intelligence, charisma, then utility
  const statOrder = ["physical", "wisdom", "intelligence", "charisma"];

  for (const stat of statOrder) {
    const groupItems = groups[stat];
    if (!groupItems) continue;

    const total = groupItems.reduce(
      (sum, i) => sum + i.modifier,
      0,
    );
    const totalStr = total >= 0 ? `+${total}` : `${total}`;
    const info = STAT_LABELS[stat];
    lines.push("");
    lines.push(`${info.emoji} **${info.full}** (${totalStr})`);

    // Box-drawing rails like /map: items hang off the stat header, last one closes with └─.
    groupItems.forEach((item, j) => {
      const connector = j === groupItems.length - 1 ? "└─ " : "├─ ";
      const modStr =
        item.modifier >= 0 ? `+${item.modifier}` : `${item.modifier}`;
      const qtyStr = item.quantity > 1 ? ` x${item.quantity}` : "";
      lines.push(`${connector}${item.emoji} ${item.name} ${modStr}${qtyStr}`);
    });
  }

  // Utility items (0-modifier)
  const utility = groups["__utility__"];
  if (utility) {
    lines.push("");
    lines.push("📦 **Utility**");
    utility.forEach((item, j) => {
      const connector = j === utility.length - 1 ? "└─ " : "├─ ";
      const qtyStr = item.quantity > 1 ? ` x${item.quantity}` : "";
      lines.push(`${connector}${item.emoji} ${item.name}${qtyStr}`);
    });
  }

  return lines.join("\n");
}
