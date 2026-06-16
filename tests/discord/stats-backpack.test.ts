import { describe, it, expect } from "vitest";
import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import { makeStatsCommand } from "../../src/discord/commands/stats.js";
import { makeBackpackCommand } from "../../src/discord/commands/backpack.js";
import type {
  CharacterData,
  ItemData,
  StatBlock,
} from "../../src/engine/WorldEngine.js";

function makeChar(overrides?: Partial<CharacterData>): CharacterData {
  const stats: StatBlock = {
    physical: 4,
    wisdom: -1,
    intelligence: -1,
    charisma: 1,
  };
  const { stats: overStats, ...restOverrides } = overrides ?? {};
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
    ...restOverrides,
  };
}

function makeItem(overrides?: Partial<ItemData>): ItemData {
  return {
    id: 1,
    characterId: 1,
    name: "Iron Sword",
    emoji: "⚔️",
    stat: "physical",
    modifier: 2,
    quantity: 1,
    ...overrides,
  };
}

// ═══ /stats ═══

describe("/stats", () => {
  it("returns error when user has no character", async () => {
    const engine = new MockWorldEngine();
    // default: no character
    const handler = makeStatsCommand(engine);
    const result = await handler({ user: { id: "no-char" } } as never);
    expect(result).toContain("don't have a character");
  });

  it("displays character name, class, and stats", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar());
    const handler = makeStatsCommand(engine);
    const result = await handler({ user: { id: "user-1" } } as never);

    expect(result).toContain("Aldric");
    expect(result).toContain("Warrior");
    expect(result).toContain("💪 PHY");
    expect(result).toContain("+4");
    expect(result).toContain("🧠 WIS");
    expect(result).toContain("-1");
  });

  it("displays upbringing, race, and alignment", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar());
    const handler = makeStatsCommand(engine);
    const result = await handler({ user: { id: "user-1" } } as never);

    expect(result).toContain("Soldier");
    expect(result).toContain("Human");
    expect(result).toContain("lawful good");
  });

  it("displays day job and location", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar());
    const handler = makeStatsCommand(engine);
    const result = await handler({ user: { id: "user-1" } } as never);

    expect(result).toContain("Blacksmith");
    expect(result).toContain("The Warden's Oak");
  });

  it("displays health, stamina, wealth, and rolls", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(
      makeChar({
        health: 5,
        maxHealth: 12,
        stamina: 3,
        wealth: 42,
        rollsRemaining: 1,
      }),
    );
    const handler = makeStatsCommand(engine);
    const result = await handler({ user: { id: "user-1" } } as never);

    expect(result).toContain("5");
    expect(result).toContain("12");
    expect(result).toContain("3");
    expect(result).toContain("42");
    expect(result).toContain("1");
  });
});

// ═══ /backpack ═══

describe("/backpack", () => {
  it("returns error when user has no character", async () => {
    const engine = new MockWorldEngine();
    const handler = makeBackpackCommand(engine);
    const result = await handler({ user: { id: "no-char" } } as never);
    expect(result).toContain("don't have a character");
  });

  it('displays "empty" when character has no items', async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar());
    engine.setItems([]);
    const handler = makeBackpackCommand(engine);
    const result = await handler({ user: { id: "user-1" } } as never);
    expect(result).toContain("empty");
  });

  it("renders item emojis in order", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar());
    engine.setItems([
      makeItem({ name: "Iron Sword", emoji: "⚔️" }),
      makeItem({ name: "Wooden Shield", emoji: "🛡️" }),
    ]);
    const handler = makeBackpackCommand(engine);
    const result = await handler({ user: { id: "user-1" } } as never);

    expect(result).toContain("⚔️");
    expect(result).toContain("🛡️");
  });

  it("repeats emoji for quantity > 1", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar());
    engine.setItems([
      makeItem({ name: "Travel Rations", emoji: "🍞", quantity: 3 }),
    ]);
    const handler = makeBackpackCommand(engine);
    const result = await handler({ user: { id: "user-1" } } as never);

    // Should have 3 bread emojis
    // The emoji grid line has 3, the legend has 1 → 4 total.
    // Check that the grid line itself has exactly 3.
    const gridLine = result.split("\n").find((l) => /^🍞/.test(l.trim()));
    expect(gridLine).toBeDefined();
    const gridMatches = (gridLine!.match(/🍞/g) ?? []).length;
    expect(gridMatches).toBe(3);
  });
});
