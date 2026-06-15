import type { StatBlock } from "./WorldEngine.js";

export interface ClassDef {
	name: string;
	modifiers: StatBlock;
}

export interface ModifierDef {
	name: string;
	modifiers: StatBlock;
}

/**
 * Computes the final character stats by summing modifiers from class,
 * upbringing (background), and race. Throws if any name is not found.
 */
export function computeStats(
	className: string,
	upbringingName: string,
	raceName: string,
	classes: ClassDef[],
	upbringings: ModifierDef[],
	races: ModifierDef[],
): StatBlock {
	const cls = classes.find((c) => c.name === className);
	if (!cls) {
		throw new Error(`Unknown class "${className}"`);
	}

	const up = upbringings.find((u) => u.name === upbringingName);
	if (!up) {
		throw new Error(`Unknown upbringing "${upbringingName}"`);
	}

	const race = races.find((r) => r.name === raceName);
	if (!race) {
		throw new Error(`Unknown race "${raceName}"`);
	}

	return {
		physical:
			cls.modifiers.physical + up.modifiers.physical + race.modifiers.physical,
		wisdom: cls.modifiers.wisdom + up.modifiers.wisdom + race.modifiers.wisdom,
		intelligence:
			cls.modifiers.intelligence +
			up.modifiers.intelligence +
			race.modifiers.intelligence,
		charisma:
			cls.modifiers.charisma + up.modifiers.charisma + race.modifiers.charisma,
	};
}
