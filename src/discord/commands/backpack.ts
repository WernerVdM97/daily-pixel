import type { WorldEngine, ItemData } from "../../engine/WorldEngine.js";
import { STAT_LABELS } from "../../engine/stat-format.js";
import { SEPARATOR } from "../format.js";

export function makeBackpackCommand(engine: WorldEngine) {
  return async (interaction: { user: { id: string } }) => {
    const character = engine.getCharacter(interaction.user.id);
    if (!character) {
      return "You don't have a character yet. Type `/join` to create one.";
    }
    const items = engine.getItems(character.id);
    if (items.length === 0) {
      return `🎒 **Backpack**\n${SEPARATOR}\nYour pack is empty.`;
    }
    return formatBackpack(items);
  };
}

export function formatBackpack(items: ItemData[]): string {
  const lines: string[] = [];
  lines.push("🎒 **Backpack**");
  lines.push(SEPARATOR);
  lines.push("");

  // Emoji grid: repeat emoji for each quantity
  const emojis = items.flatMap((item) => Array(item.quantity).fill(item.emoji));
  lines.push(emojis.join(" "));

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
