import { describe, it, expect, vi } from "vitest";
import {
  formatCharacterHeader,
  isWeekend,
  makeHiCommand,
} from "../../src/discord/commands/hi.js";
import {
  getDayJobActions,
  getWorkplaceLocation,
  COMMON_ACTIONS,
} from "../../src/controller/dayJob.js";
import type { CharacterData, StatBlock, WorldEngine } from "../../src/engine/WorldEngine.js";

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
    maxStamina: 10,
    rollsRemaining: 2,
    location: "The Warden's Oak",
    wealth: 15,
    lastActionState: null,
    hasRestedToday: false,
    createdAt: "2026-01-01T00:00:00Z",
    ...rest,
  };
}

const mockDayJobs = [
  {
    name: "Blacksmith",
    depends_on: ["physical"] as string[],
    base_income: 10,
    workplace_location: "The Town Forge",
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
    workplace_location: "The Forest Edge",
    description: "Track game.",
    actions: [
      { label: "Track game", income: 5, hook: "Deer sign everywhere." },
      { label: "Set traps", income: 4, hook: "The old trap line..." },
      { label: "Check snares", income: 3, hook: "One snare holds..." },
    ],
  },
  {
    name: "Wanderer",
    depends_on: ["charisma"] as string[],
    base_income: 2,
    workplace_location: null,
    description: "No roof, no boss.",
    actions: [
      { label: "Track game", income: 5, hook: "Deer sign everywhere." },
      { label: "Set traps", income: 4, hook: "The old trap line..." },
      { label: "Check snares", income: 3, hook: "One snare holds..." },
    ],
  },
];

describe("formatCharacterHeader", () => {
  it("shows status: name, class, HP, stamina, rolls, and wealth (emoji-only, no labels)", () => {
    const result = formatCharacterHeader(makeChar());
    expect(result).toContain("Aldric");
    expect(result).toContain("Warrior");
    expect(result).toContain("❤️ 10/12");
    expect(result).toContain("⚡ 8/");
    expect(result).toContain("🎲 2");
    expect(result).toContain("💰 15");
  });

  it("shows the rolls count without the word 'remaining'", () => {
    const result = formatCharacterHeader(makeChar());
    expect(result).not.toContain("remaining");
  });

  it("does not show ability scores (PHY/WIS/INT/CHA)", () => {
    const result = formatCharacterHeader(
      makeChar({ stats: { physical: 4, wisdom: -1, intelligence: 0, charisma: 1 } }),
    );
    expect(result).not.toContain("PHY");
    expect(result).not.toContain("WIS");
    expect(result).not.toContain("INT");
    expect(result).not.toContain("CHA");
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
  const labelsOf = (jobName: string) => {
    const job = mockDayJobs.find((j) => j.name === jobName)!;
    return new Set([...job.actions, ...COMMON_ACTIONS].map((a) => a.label));
  };

  it("surfaces 3 actions drawn from the job pool + common pool", () => {
    const actions = getDayJobActions("Blacksmith", mockDayJobs, { characterId: 1, dayNumber: 1 });
    expect(actions).toHaveLength(3);
    const pool = labelsOf("Blacksmith");
    for (const a of actions) {
      expect(pool.has(a.label)).toBe(true);
    }
    // distinct
    expect(new Set(actions.map((a) => a.label)).size).toBe(3);
  });

  it("is deterministic for the same (characterId, dayNumber) seed", () => {
    const a = getDayJobActions("Hunter", mockDayJobs, { characterId: 7, dayNumber: 3 });
    const b = getDayJobActions("Hunter", mockDayJobs, { characterId: 7, dayNumber: 3 });
    expect(a.map((x) => x.label)).toEqual(b.map((x) => x.label));
  });

  it("varies across days (different seed → likely different picks)", () => {
    // Across several days the same character should not see an identical set every time.
    const sets = [1, 2, 3, 4, 5].map((d) =>
      getDayJobActions("Hunter", mockDayJobs, { characterId: 7, dayNumber: d })
        .map((a) => a.label)
        .join(","),
    );
    expect(new Set(sets).size).toBeGreaterThan(1);
  });

  it("throws for unknown day job", () => {
    expect(() => getDayJobActions("Astronaut", mockDayJobs)).toThrow("day job");
  });

  it("returns actions with income and hook", () => {
    const actions = getDayJobActions("Hunter", mockDayJobs, { characterId: 1, dayNumber: 1 });
    for (const a of actions) {
      expect(typeof a.label).toBe("string");
      expect(typeof a.income).toBe("number");
      expect(typeof a.hook).toBe("string");
    }
  });
});

describe("getWorkplaceLocation", () => {
  it("returns the workplace_location from YAML for a fixed-location job", () => {
    const loc = getWorkplaceLocation("Blacksmith", mockDayJobs, { characterId: 1, dayNumber: 1 });
    expect(loc).toBe("The Town Forge");
  });

  it("returns null for unknown day jobs", () => {
    const loc = getWorkplaceLocation("Astronaut", mockDayJobs, { characterId: 1, dayNumber: 1 });
    expect(loc).toBeNull();
  });

  it("returns a safe location (not the Oak) for Wanderer", () => {
    const loc = getWorkplaceLocation("Wanderer", mockDayJobs, { characterId: 7, dayNumber: 3 });
    expect(
      ['Town Square', 'The Shrine of the First Flame', 'The Weary Lantern Inn', 'The Town Forge', "The Warden's Library"],
    ).toContain(loc);
  });

  it("is deterministic: same (characterId, dayNumber) → same Wanderer destination", () => {
    const a = getWorkplaceLocation("Wanderer", mockDayJobs, { characterId: 42, dayNumber: 5 });
    const b = getWorkplaceLocation("Wanderer", mockDayJobs, { characterId: 42, dayNumber: 5 });
    expect(a).toBe(b);
  });

  it("varies across days for Wanderer", () => {
    const destinations = [1, 2, 3, 4, 5].map(
      (d) => getWorkplaceLocation("Wanderer", mockDayJobs, { characterId: 7, dayNumber: d }),
    );
    // At least 2 different destinations across 5 days (not guaranteed but extremely likely)
    expect(new Set(destinations).size).toBeGreaterThan(1);
  });
});

describe("unfinished-action screen", () => {
  // A pending action resumes verbatim — the description is ignored on resume — so the
  // screen must not advertise a free-text `action <what you do>` continue that can't work.
  function makeEngineWithPending(): WorldEngine {
    return {
      getCharacter: () => makeChar({ lastActionState: "mid" as unknown as CharacterData["lastActionState"] }),
      getLocation: () => ({ name: "The Warden's Oak", emoji: "🌳", isSafe: true }),
      resumeAction: () => ({ nextDecision: { prompt: "What do you do?", narration: "The path forks." } }),
      getMeta: () => "1",
    } as unknown as WorldEngine;
  }

  it("does not offer the impossible free-text continue instruction", async () => {
    const hi = makeHiCommand(makeEngineWithPending(), mockDayJobs);
    const out = await hi({ user: { id: "u1" } });
    expect(out).toContain("Unfinished Action");
    expect(out).toContain("Press the **Action** button to continue.");
    expect(out).not.toContain("action <what you do>");
  });
});

describe("isWeekend", () => {
  it("returns true for Saturday (6) and Sunday (0)", () => {
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
