import type { WorldEngine, ItemData } from "../../engine/WorldEngine.js";
import { STAT_LABELS } from "../../engine/stat-format.js";
import { SEPARATOR } from "../format.js";

/** How many item slots a character can carry. */
export const BACKPACK_CAPACITY = 10;
/** Emoji shown for an unused slot in the grid. */
const EMPTY_SLOT = "⬜";

export function makeBackpackCommand(engine: WorldEngine) {
  return async (interaction: { user: { id: string } }) => {
    const character = engine.getCharacter(interaction.user.id);
    if (!character) {
      return "You don't have a character yet. Type `/join` to create one.";
    }
    return formatBackpack(engine.getItems(character.id));
  };
}

export function formatBackpack(items: ItemData[]): string {
  const lines: string[] = [];

  // Slots used = total quantity carried; the grid shows used + empty slots up to capacity.
  const used = items.reduce((sum, i) => sum + i.quantity, 0);
  lines.push(`🎒 **Backpack** (${used}/${BACKPACK_CAPACITY})`);
  lines.push(SEPARATOR);
  lines.push("");

  // Emoji grid: one emoji per carried unit, then ⬜ for each free slot.
  const filled = items.flatMap((item) => Array(item.quantity).fill(item.emoji));
  const empties = Array(Math.max(0, BACKPACK_CAPACITY - used)).fill(EMPTY_SLOT);
  lines.push([...filled, ...empties].join(" "));

  if (items.length === 0) {
    lines.push("");
    lines.push("Your pack is empty.");
    return lines.join("\n");
  }

  // Group by stat
  const groups: Record<string, ItemData[]> = {};
  for (const item of items) {
    const key = item.modifier !== 0 ? item.stat : '__utility__';
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  // Stat order: physical, wisdom, intelligence, charisma, then utility
  const statOrder = ['physical', 'wisdom', 'intelligence', 'charisma'];

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

    for (const item of groupItems) {
      const modStr =
        item.modifier >= 0 ? `+${item.modifier}` : `${item.modifier}`;
      const qtyStr = item.quantity > 1 ? ` x${item.quantity}` : "";
      lines.push(`  ${item.emoji} ${item.name} ${modStr}${qtyStr}`);
    }
  }

  // Utility items (0-modifier)
  const utility = groups['__utility__'];
  if (utility) {
    lines.push("");
    lines.push("📦 **Utility**");
    for (const item of utility) {
      const qtyStr = item.quantity > 1 ? ` x${item.quantity}` : "";
      lines.push(`  ${item.emoji} ${item.name}${qtyStr}`);
    }
  }

  return lines.join("\n");
}
