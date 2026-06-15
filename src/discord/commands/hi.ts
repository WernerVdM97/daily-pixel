import type { WorldEngine, CharacterData } from "../../engine/WorldEngine.js";

// ── Day job types (from day-jobs.yml shape) ──

export interface DayJobDef {
	name: string;
	depends_on: string[];
	base_income: number;
	description: string;
	/** Exactly 3 actions per day job — enforced by getDayJobActions at runtime. */
	actions: DayJobAction[];
}

export interface DayJobAction {
	label: string;
	income: number;
	hook: string;
}

// ── Pure formatters (tested in isolation) ──

export function formatCharacterHeader(char: CharacterData): string {
	const lines: string[] = [];
	lines.push(`⚔️  **${char.name}** — ${char.class}`);
	lines.push("═".repeat(30));

	// Stats line
	const stat = (label: string, val: number): string => {
		const sign = val >= 0 ? "+" : "";
		return `${label}: ${sign}${val}`;
	};
	lines.push(
		`${stat("Physical", char.stats.physical)}  ${stat("Wisdom", char.stats.wisdom)}  ` +
			`${stat("Intelligence", char.stats.intelligence)}  ${stat("Charisma", char.stats.charisma)}`,
	);

	// Vitals
	const hpPct = char.health / char.maxHealth;
	const hpWarn = hpPct < 0.34 ? " ⚠️ **low health!**" : "";
	lines.push(`❤️ HP: ${char.health}/${char.maxHealth}${hpWarn}`);
	lines.push(
		`⚡ Stamina: ${char.stamina}  |  🎲 Rolls: ${char.rollsRemaining} remaining`,
	);

	return lines.join("\n");
}

export function getDayJobActions(
	dayJobName: string,
	dayJobs: DayJobDef[],
): DayJobAction[] {
	const job = dayJobs.find((j) => j.name === dayJobName);
	if (!job) {
		throw new Error(`Unknown day job "${dayJobName}"`);
	}
	if (job.actions.length !== 3) {
		throw new Error(`Day job "${dayJobName}" must have exactly 3 actions`);
	}
	return job.actions;
}

export function isWeekend(): boolean {
	const day = new Date().getDay(); // 0 = Sunday, 6 = Saturday
	return day === 0 || day === 6;
}

// ── Command factory ──

export function makeHiCommand(engine: WorldEngine, dayJobs: DayJobDef[], oakScene: string) {
	return async (interaction: { user: { id: string } }): Promise<string> => {
		const character = engine.getCharacter(interaction.user.id);
		if (!character) {
			return "You don't have a character yet. Type `/join` to create one.";
		}

		// Build Message 1 content (atmosphere)
		const header = formatCharacterHeader(character);

		// Determine day-job actions or weekend hooks
		const weekend = isWeekend();
		let actionLines: string[] = [];
		if (weekend) {
			actionLines = [
				"🌅 **Weekend — The world is yours.**",
				"",
				"Adventure hooks:",
				"  • **Travel** — Head east, west, or into the wilds.",
				"  • **Scout** — Survey the area for threats or resources.",
				"  • **Hunt** — Track game in the forest.",
				"  • **Talk** — Seek out NPCs and learn their stories.",
				"  • **Explore** — Go where no one has yet.",
			];
		} else {
			try {
				const actions = getDayJobActions(character.dayJob, dayJobs);
				actionLines = [
					`🔨 **${character.dayJob} — Daily Work**`,
					"",
					...actions.map(
						(a, i) => `  ${["①", "②", "③"][i]} **${a.label}** — ${a.hook}`,
					),
					"",
					"📦 Use `/action <what you do>` to carry out your choice,",
					"   or type `/action something else…` to go rogue.",
				];
			} catch {
				actionLines = [
					`🔨 **${character.dayJob}**`,
					"",
					"  Use `/action <what you do>` to start an action.",
				];
			}
		}

		// Resumption — show the pending decision prompt instead of the greeting
		if (character.lastActionState) {
			const resumeResult = engine.resumeAction(character.id);
			const prompt = resumeResult.nextDecision.prompt;
			return [
				'⏳ **Unfinished Action**',
				'═'.repeat(30),
				'',
				prompt,
				'',
				'Use `/action` to continue.',
			].join('\n');
		}

		const sceneBlock = oakScene ? ['```', oakScene, '```', ''] : [];
		return [...sceneBlock, header, "", "─".repeat(30), ...actionLines].join("\n");
	};
}
