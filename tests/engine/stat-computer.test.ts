import { describe, it, expect } from "vitest";
import {
	computeStats,
	type ClassDef,
	type ModifierDef,
} from "../../src/engine/StatComputer.js";
import type { StatBlock } from "../../src/engine/WorldEngine.js";

function makeClass(name: string, modifiers: StatBlock): ClassDef {
	return { name, modifiers };
}

function makeMod(name: string, modifiers: Partial<StatBlock>): ModifierDef {
	return {
		name,
		modifiers: {
			physical: 0,
			wisdom: 0,
			intelligence: 0,
			charisma: 0,
			...modifiers,
		},
	};
}

const classes = [
	makeClass("Warrior", {
		physical: 3,
		wisdom: -1,
		intelligence: 0,
		charisma: 0,
	}),
	makeClass("Ranger", {
		physical: 1,
		wisdom: 2,
		intelligence: 0,
		charisma: -1,
	}),
	makeClass("Wizard", {
		physical: -2,
		wisdom: 0,
		intelligence: 3,
		charisma: 0,
	}),
	makeClass("Bard", { physical: -1, wisdom: 0, intelligence: 1, charisma: 2 }),
	makeClass("Priest", { physical: 0, wisdom: 2, intelligence: 0, charisma: 1 }),
];

const upbringings = [
	makeMod("Soldier", { physical: 1, wisdom: 0, intelligence: -1, charisma: 0 }),
	makeMod("Merchant", {
		physical: -1,
		wisdom: 0,
		intelligence: 1,
		charisma: 1,
	}),
	makeMod("Scholar", {
		physical: -1,
		wisdom: 0,
		intelligence: 2,
		charisma: -1,
	}),
	makeMod("Folk Hero", {
		physical: 0,
		wisdom: 0,
		intelligence: 0,
		charisma: 1,
	}),
	makeMod("Outcast", { physical: 0, wisdom: 1, intelligence: 0, charisma: -1 }),
	makeMod("Noble", { physical: -1, wisdom: -1, intelligence: 1, charisma: 2 }),
];

const races = [
	makeMod("Human", { physical: 0, wisdom: 0, intelligence: 0, charisma: 1 }),
	makeMod("Dwarf", { physical: 1, wisdom: 1, intelligence: 0, charisma: -2 }),
	makeMod("Elf", { physical: -1, wisdom: 1, intelligence: 1, charisma: 0 }),
	makeMod("Halfling", {
		physical: -2,
		wisdom: 0,
		intelligence: 0,
		charisma: 2,
	}),
];

describe("computeStats", () => {
	it("sums class + upbringing + race modifiers", () => {
		// Warrior (3/-1/0/0) + Soldier (1/0/-1/0) + Human (0/0/0/1) = 4/-1/-1/1
		const result = computeStats(
			"Warrior",
			"Soldier",
			"Human",
			classes,
			upbringings,
			races,
		);
		expect(result).toEqual({
			physical: 4,
			wisdom: -1,
			intelligence: -1,
			charisma: 1,
		});
	});

	it("handles negative totals correctly", () => {
		// Wizard (-2/0/3/0) + Noble (-1/-1/1/2) + Halfling (-2/0/0/2) = -5/-1/4/4
		const result = computeStats(
			"Wizard",
			"Noble",
			"Halfling",
			classes,
			upbringings,
			races,
		);
		expect(result).toEqual({
			physical: -5,
			wisdom: -1,
			intelligence: 4,
			charisma: 4,
		});
	});

	it("handles zero totals", () => {
		// Bard (-1/0/1/2) + Merchant (-1/0/1/1) + Human (0/0/0/1) = -2/0/2/4
		const result = computeStats(
			"Bard",
			"Merchant",
			"Human",
			classes,
			upbringings,
			races,
		);
		expect(result).toEqual({
			physical: -2,
			wisdom: 0,
			intelligence: 2,
			charisma: 4,
		});
	});

	it("throws when class is not found", () => {
		expect(() =>
			computeStats("Ninja", "Soldier", "Human", classes, upbringings, races),
		).toThrow(/class.*Ninja/i);
	});

	it("throws when upbringing is not found", () => {
		expect(() =>
			computeStats(
				"Warrior",
				"Astronaut",
				"Human",
				classes,
				upbringings,
				races,
			),
		).toThrow(/upbringing.*Astronaut/i);
	});

	it("throws when race is not found", () => {
		expect(() =>
			computeStats("Warrior", "Soldier", "Dragon", classes, upbringings, races),
		).toThrow(/race.*Dragon/i);
	});

	it("handles max charisma build", () => {
		// Bard (-1/0/1/2) + Noble (-1/-1/1/2) + Halfling (-2/0/0/2) = -4/-1/2/6
		const result = computeStats(
			"Bard",
			"Noble",
			"Halfling",
			classes,
			upbringings,
			races,
		);
		expect(result.charisma).toBe(6);
	});
});
