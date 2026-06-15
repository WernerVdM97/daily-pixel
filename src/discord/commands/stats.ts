import type { WorldEngine, CharacterData } from "../../engine/WorldEngine.js";

export function makeStatsCommand(engine: WorldEngine) {
	return async (interaction: { user: { id: string } }) => {
		const character = engine.getCharacter(interaction.user.id);
		if (!character) {
			return "You don't have a character yet. Type `/join` to create one.";
		}
		return formatStats(character);
	};
}

export function formatStats(char: CharacterData): string {
	const lines: string[] = [];

	// Header
	lines.push(`⚔️  **${char.name}** — ${char.class}`);
	lines.push("═".repeat(30));
	lines.push(`**Upbringing:** ${char.upbringing}  |  **Race:** ${char.race}`);
	lines.push(`**Alignment:** ${char.alignment}`);
	lines.push(`**Day Job:** ${char.dayJob}`);
	lines.push("");

	// Stats
	lines.push("**Stats:**");
	lines.push(`  Physical:     ${padStat(char.stats.physical)}`);
	lines.push(`  Wisdom:       ${padStat(char.stats.wisdom)}`);
	lines.push(`  Intelligence: ${padStat(char.stats.intelligence)}`);
	lines.push(`  Charisma:     ${padStat(char.stats.charisma)}`);
	lines.push("");

	// Vitals
	lines.push(
		`**Health:** ${char.health}/${char.maxHealth}  |  **Stamina:** ${char.stamina}`,
	);
	lines.push(`**Location:** ${char.location}`);
	lines.push(
		`**Wealth:** ${char.wealth} copper  |  **Rolls:** ${char.rollsRemaining} remaining`,
	);

	return lines.join("\n");
}

function padStat(value: number): string {
	const sign = value >= 0 ? "+" : "";
	return `${sign}${value}`;
}
