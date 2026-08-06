import { describe, it, expect } from "vitest";
import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import { makeStatsCommand } from "../../src/discord/commands/stats.js";
import { makeBackpackCommand } from "../../src/discord/commands/backpack.js";
import { SessionController } from "../../src/controller/SessionController.js";
import { GameRouter } from "../../src/protocol/router.js";
import { WizardSession } from "../../src/discord/WizardSession.js";
import type { CharDefs } from "../../src/controller/joinWizard.js";
import type {
  CharacterData,
  ItemData,
  StatBlock,
} from "../../src/engine/WorldEngine.js";

// M8.1 (DC-M8.4/5): the handlers are translate + paint — every call goes through a
// GameRouter over a real SessionController wrapping the SAME engine (the look.test.ts
// M8.1 pattern). The behavior asserts are unchanged.
const EMPTY_DEFS: CharDefs = { classes: [], backgrounds: [], races: [], alignments: [], dayJobs: [], itemSets: [] };
const SCENE_STUB = () => ({ sceneName: "test", ascii: "..." });

function makeHandler(engine: MockWorldEngine) {
  const controller = new SessionController(engine, () => "", [], undefined, new WizardSession(), EMPTY_DEFS, SCENE_STUB);
  const router = new GameRouter(controller, { idle: () => "" });
  return {
    stats: makeStatsCommand(router),
    backpack: makeBackpackCommand(router),
  };
}

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
    maxStamina: 10,
    rollsRemaining: 2,
    location: "The Warden's Oak",
    wealth: 15,
    lastActionState: null,
    hasRestedToday: false,
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
    const handler = makeHandler(engine);
    const result = await handler.stats({ user: { id: "no-char" } } as never);
    expect(result).toContain("don't have a character");
  });

  it("displays character name, class, and stats", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar());
    const handler = makeHandler(engine);
    const result = await handler.stats({ user: { id: "user-1" } } as never);

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
    const handler = makeHandler(engine);
    const result = await handler.stats({ user: { id: "user-1" } } as never);

    expect(result).toContain("Soldier");
    expect(result).toContain("Human");
    expect(result).toContain("lawful good");
  });

  it("displays day job and location", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar());
    const handler = makeHandler(engine);
    const result = await handler.stats({ user: { id: "user-1" } } as never);

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
    const handler = makeHandler(engine);
    const result = await handler.stats({ user: { id: "user-1" } } as never);

    expect(result).toContain("5");
    expect(result).toContain("12");
    expect(result).toContain("3");
    expect(result).toContain("42");
    expect(result).toContain("1");
  });

  it("shows stamina with its max (C3 vitals line), matching /hi", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(
      makeChar({ health: 5, maxHealth: 12, stamina: 3, maxStamina: 10 }),
    );
    const handler = makeHandler(engine);
    const result = await handler.stats({ user: { id: "user-1" } } as never);

    // Stamina must carry its ceiling, like health does and like /hi shows it.
    expect(result).toContain("**Health:** 5/12");
    expect(result).toContain("**Stamina:** 3/10");
  });

  it("folds item bonuses into the shown stat and breaks out the gear contribution", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar()); // base physical 4
    engine.setItems([makeItem({ stat: "physical", modifier: 2 })]); // +2 gear
    const handler = makeHandler(engine);
    const result = await handler.stats({ user: { id: "user-1" } } as never);

    // Effective physical is base 4 + gear 2 = 6, with the breakdown spelled out.
    const phyLine = result.split("\n").find((l) => l.includes("💪 PHY"))!;
    expect(phyLine).toContain("+6");
    expect(phyLine).toContain("+4 base");
    expect(phyLine).toContain("+2 🎒");
  });

  it("shows no gear breakdown for a stat with no item bonus", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar()); // base charisma 1, no items touch it
    engine.setItems([makeItem({ stat: "physical", modifier: 2 })]);
    const handler = makeHandler(engine);
    const result = await handler.stats({ user: { id: "user-1" } } as never);

    const chaLine = result.split("\n").find((l) => l.includes("💬 CHA"))!;
    expect(chaLine).toContain("+1");
    expect(chaLine).not.toContain("🎒");
  });

  it('drops the word "remaining" from the rolls line (one vocabulary with /hi)', async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar({ rollsRemaining: 2 }));
    const handler = makeHandler(engine);
    const result = await handler.stats({ user: { id: "user-1" } } as never);

    expect(result).toContain("**Rolls:** 2");
    expect(result).not.toContain("remaining");
  });
});

// ═══ /backpack ═══

describe("/backpack", () => {
  it("returns error when user has no character", async () => {
    const engine = new MockWorldEngine();
    const handler = makeHandler(engine);
    const result = await handler.backpack({ user: { id: "no-char" } } as never);
    expect(result).toContain("don't have a character");
  });

  it('displays "empty" when character has no items', async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar());
    engine.setItems([]);
    const handler = makeHandler(engine);
    const result = await handler.backpack({ user: { id: "user-1" } } as never);
    expect(result).toContain("empty");
  });

  it("renders item emojis in order", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar());
    engine.setItems([
      makeItem({ name: "Iron Sword", emoji: "⚔️" }),
      makeItem({ name: "Wooden Shield", emoji: "🛡️" }),
    ]);
    const handler = makeHandler(engine);
    const result = await handler.backpack({ user: { id: "user-1" } } as never);

    expect(result).toContain("⚔️");
    expect(result).toContain("🛡️");
  });

  it("repeats emoji for quantity > 1", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar());
    engine.setItems([
      makeItem({ name: "Travel Rations", emoji: "🍞", quantity: 3 }),
    ]);
    const handler = makeHandler(engine);
    const result = await handler.backpack({ user: { id: "user-1" } } as never);

    // Should have 3 bread emojis
    // The emoji grid line has 3, the legend has 1 → 4 total.
    // Check that the grid line itself has exactly 3.
    const gridLine = result.split("\n").find((l) => /^🍞/.test(l.trim()));
    expect(gridLine).toBeDefined();
    const gridMatches = (gridLine!.match(/🍞/g) ?? []).length;
    expect(gridMatches).toBe(3);
  });

  it("fills the rest of the 10 slots with empty-slot emojis", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar());
    engine.setItems([
      makeItem({ name: "Iron Sword", emoji: "⚔️" }),
      makeItem({ name: "Travel Rations", emoji: "🍞", quantity: 3 }),
    ]);
    const handler = makeHandler(engine);
    const result = await handler.backpack({ user: { id: "user-1" } } as never);

    // 4 used → header shows 4/40; the first grid row fills 4 slots, leaving 6 empties.
    expect(result).toContain("(4/40)");
    const gridLine = result.split("\n").find((l) => l.includes("⬜"))!;
    expect((gridLine.match(/⬜/g) ?? []).length).toBe(6);
  });

  it("shows a full 10-wide row of empty slots when the pack is empty", async () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(makeChar());
    engine.setItems([]);
    const handler = makeHandler(engine);
    const result = await handler.backpack({ user: { id: "user-1" } } as never);

    expect(result).toContain("(0/40)");
    expect(result).toContain("empty");
    // 40 empty slots wrap into four 10-wide rows; each grid row holds exactly 10.
    const gridLine = result.split("\n").find((l) => l.includes("⬜"))!;
    expect((gridLine.match(/⬜/g) ?? []).length).toBe(10);
  });
});
