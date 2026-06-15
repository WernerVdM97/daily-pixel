import { describe, it, expect, vi } from "vitest";
import {
  formatCharacterHeader,
  getDayJobActions,
  isWeekend,
} from "../../src/discord/commands/hi.js";
import type { CharacterData, StatBlock } from "../../src/engine/WorldEngine.js";

function makeChar(overrides?: Partial<CharacterData>): CharacterData {
  const stats: StatBlock = {
    physical: 4,
    wisdom: -1,
    intelligence: -1,
    charisma: 1,
  };
  const { stats: overStats, ...rest } = overrides ?? {};
  return {
    id: 1,
    userId: 1,
    name: "Aldric",
    class: "Warrior",
    upbringing: "Soldier",
    race: "Human",
    alignment: "lawful good",
    dayJob: "Blacksmith",
    stats: { ...stats, ...overStats },
    health: 10,
    maxHealth: 12,
    stamina: 8,
    rollsRemaining: 2,
    location: "The Warden's Oak",
    wealth: 15,
    lastActionState: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...rest,
  };
}

const mockDayJobs = [
  {
    name: "Blacksmith",
    depends_on: ["physical"] as string[],
    base_income: 10,
    description: "Hammer and anvil.",
    actions: [
      { label: "Forge blade", income: 6, hook: "The steel sings." },
      { label: "Repair armour", income: 4, hook: "A guardsman brings in..." },
      { label: "Shoe horses", income: 3, hook: "The chestnut mare..." },
    ],
  },
  {
    name: "Hunter",
    depends_on: ["physical", "wisdom"] as string[],
    base_income: 8,
    description: "Track game.",
    actions: [
      { label: "Track game", income: 5, hook: "Deer sign everywhere." },
      { label: "Set traps", income: 4, hook: "The old trap line..." },
      { label: "Check snares", income: 3, hook: "One snare holds..." },
    ],
  },
];

describe("formatCharacterHeader", () => {
  it("includes character name, class, health, stamina, and rolls", () => {
    const result = formatCharacterHeader(makeChar());
    expect(result).toContain("Aldric");
    expect(result).toContain("Warrior");
    expect(result).toContain("10");
    expect(result).toContain("12");
    expect(result).toContain("8");
    expect(result).toContain("2");
  });

  it("shows stats for all four attributes", () => {
    const result = formatCharacterHeader(
      makeChar({
        stats: { physical: 4, wisdom: -1, intelligence: 0, charisma: 1 },
      }),
    );
    expect(result).toContain("Physical:");
    expect(result).toContain("Wisdom:");
    expect(result).toContain("Intelligence:");
    expect(result).toContain("Charisma:");
  });

  it("shows low health warning", () => {
    const result = formatCharacterHeader(
      makeChar({ health: 3, maxHealth: 12 }),
    );
    expect(result).toContain("low health");
  });

  it("does not show low health warning when healthy", () => {
    const result = formatCharacterHeader(
      makeChar({ health: 10, maxHealth: 12 }),
    );
    expect(result).not.toContain("low health");
  });
});

describe("getDayJobActions", () => {
  it("returns the 3 actions for a known day job", () => {
    const actions = getDayJobActions("Blacksmith", mockDayJobs);
    expect(actions).toHaveLength(3);
    expect(actions[0].label).toBe("Forge blade");
    expect(actions[1].label).toBe("Repair armour");
    expect(actions[2].label).toBe("Shoe horses");
  });

  it("throws for unknown day job", () => {
    expect(() => getDayJobActions("Astronaut", mockDayJobs)).toThrow("day job");
  });

  it("returns actions with income and hook", () => {
    const actions = getDayJobActions("Hunter", mockDayJobs);
    expect(actions[0]).toEqual({
      label: "Track game",
      income: 5,
      hook: "Deer sign everywhere.",
    });
  });
});

describe("isWeekend", () => {
  it("returns true for Saturday (6) and Sunday (0)", () => {
    const realDay = new Date().getDay;
    vi.stubGlobal(
      "Date",
      class extends Date {
        getDay() {
          return 6;
        }
      },
    );
    expect(isWeekend()).toBe(true);

    vi.stubGlobal(
      "Date",
      class extends Date {
        getDay() {
          return 0;
        }
      },
    );
    expect(isWeekend()).toBe(true);
    vi.unstubAllGlobals();
  });

  it("returns false for weekdays (1-5)", () => {
    vi.stubGlobal(
      "Date",
      class extends Date {
        getDay() {
          return 3;
        }
      },
    );
    expect(isWeekend()).toBe(false);
    vi.unstubAllGlobals();
  });
});
