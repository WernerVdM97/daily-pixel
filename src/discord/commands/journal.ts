import type { WorldEngine } from "../../engine/WorldEngine.js";

export function makeJournalCommand(engine: WorldEngine) {
	return (interaction: { user: { id: string } }): string => {
		const character = engine.getCharacter(interaction.user.id);
		if (!character) {
			return "You don't have a character yet. Type `/join` to create one.";
		}

		const journal = engine.getJournal(character.id);
		const lines: string[] = [];

		lines.push("📖 **Journal**");
		lines.push("═".repeat(30));

		// Known locations
		lines.push("");
		lines.push("**Known Locations:**");
		if (journal.knownLocations.length === 0) {
			lines.push("  *You know of no locations yet.*");
		} else {
			for (const loc of journal.knownLocations) {
				const marker = loc === journal.currentLocation ? " ←" : "";
				lines.push(`  • ${loc}${marker}`);
			}
		}

		// NPCs encountered
		lines.push("");
		lines.push("**NPCs Encountered:**");
		if (journal.npcsEncountered.length === 0) {
			lines.push("  *You have met no NPCs yet.*");
		} else {
			for (const npc of journal.npcsEncountered) {
				const detail = npc.class ? `the ${npc.class}` : "";
				const where = npc.location ? ` (at ${npc.location})` : "";
				lines.push(`  • **${npc.name}** ${detail}${where}`.trim());
			}
		}

		// Recent actions
		lines.push("");
		lines.push("**Recent Actions:**");
		if (journal.recentActions.length === 0) {
			lines.push("  *No actions recorded yet.*");
		} else {
			for (const action of journal.recentActions) {
				lines.push(`  • ${action.type} — ${action.outcome}`);
			}
		}

		return lines.join("\n");
	};
}
