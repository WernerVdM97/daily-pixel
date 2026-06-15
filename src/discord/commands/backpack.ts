import type { WorldEngine, ItemData } from "../../engine/WorldEngine.js";

export function makeBackpackCommand(engine: WorldEngine) {
	return async (interaction: { user: { id: string } }) => {
		const character = engine.getCharacter(interaction.user.id);
		if (!character) {
			return "You don't have a character yet. Type `/join` to create one.";
		}
		const items = engine.getItems(character.id);
		if (items.length === 0) {
			return "🎒 **Backpack**\n" + "═".repeat(20) + "\nYour pack is empty.";
		}
		return formatBackpack(items);
	};
}

export function formatBackpack(items: ItemData[]): string {
	const lines: string[] = [];
	lines.push("🎒 **Backpack**");
	lines.push("═".repeat(20));
	lines.push("");

	// Emoji grid: repeat emoji for each quantity
	const emojis = items.flatMap((item) => Array(item.quantity).fill(item.emoji));
	lines.push(emojis.join(" "));

	// Legend
	lines.push("");
	for (const item of items) {
		const modStr =
			item.modifier >= 0 ? `+${item.modifier}` : `${item.modifier}`;
		const qtyStr = item.quantity > 1 ? ` x${item.quantity}` : "";
		lines.push(
			`  ${item.emoji} ${item.name} (${item.stat} ${modStr})${qtyStr}`,
		);
	}

	return lines.join("\n");
}
