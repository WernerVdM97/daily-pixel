import { describe, it, expect, beforeEach } from "vitest";
import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import { makeJournalCommand } from "../../src/discord/commands/journal.js";
import { SessionController } from "../../src/controller/SessionController.js";
import { GameRouter } from "../../src/protocol/router.js";
import { WizardSession } from "../../src/discord/WizardSession.js";
import type { CharDefs } from "../../src/controller/joinWizard.js";

// M8.1 (DC-M8.4/5): the handler is translate + paint — every call goes through a GameRouter
// over a real SessionController wrapping the SAME engine (the look.test.ts M8.1 pattern).
const EMPTY_DEFS: CharDefs = { classes: [], backgrounds: [], races: [], alignments: [], dayJobs: [], itemSets: [] };
const SCENE_STUB = () => ({ sceneName: "test", ascii: "..." });

function makeHandler(engine: MockWorldEngine) {
  const controller = new SessionController(engine, () => "", [], undefined, new WizardSession(), EMPTY_DEFS, SCENE_STUB);
  const router = new GameRouter(controller, { idle: () => "" });
  return makeJournalCommand(router);
}
describe("/journal", () => {
  let engine: MockWorldEngine;

  beforeEach(() => {
    engine = new MockWorldEngine();
    engine.setCharacter(MockWorldEngine.defaultCharacter());
  });

  it("returns error when user has no character", async () => {
    const handler = makeHandler(new MockWorldEngine());
    const result = await handler({ user: { id: "no-char" } } as never);
    expect(result).toContain("character");
  });

  it("no longer lists known locations (that's /map's job now)", async () => {
    engine.setJournal({
      knownLocations: ["The Warden's Oak", "Dark Forest", "Stone Bridge"],
      currentLocation: "Dark Forest",
      npcsEncountered: [],
      recentActions: [],
    });
    const handler = makeHandler(engine);
    const result = await handler({ user: { id: "user-1" } } as never);
    expect(result).not.toContain("Known Locations");
    expect(result).not.toContain("Stone Bridge"); // the location list is gone
    expect(result).toContain("/map"); // points the player at the map instead
  });

  it("renders a chronicle under its own header, each action tagged with where it happened + a bold outcome tag", async () => {
    engine.setJournal({
      knownLocations: [],
      currentLocation: "Wolf Hollow",
      npcsEncountered: [],
      recentActions: [
        { type: "combat", outcome: "success", createdAt: "2026-01-02T12:00:00Z", narrative: "drove off a starving wolf", location: "Wolf Hollow", locationEmoji: "🐺" },
        { type: "search", outcome: "failure", createdAt: "2026-01-01T12:00:00Z", narrative: "searched the broken shrine", location: "The Sunken Road", locationEmoji: "🪨" },
      ],
    });
    const handler = makeHandler(engine);
    const result = await handler({ user: { id: "user-1" } } as never);
    expect(result).toContain("**📜 Chronicle**");
    expect(result).toContain("🐺 Wolf Hollow · drove off a starving wolf — ✅ **Success**");
    expect(result).toContain("🪨 The Sunken Road · searched the broken shrine — ❌ **Failed**");
  });

  it("hangs discoveries off the action that produced them, as a box-drawing rail", async () => {
    engine.setJournal({
      knownLocations: [],
      currentLocation: "Wolf Hollow",
      npcsEncountered: [],
      recentActions: [
        {
          type: "explore",
          outcome: "success",
          createdAt: "2026-01-02T12:00:00Z",
          narrative: "pressed on past the tree line",
          location: "Wolf Hollow",
          locationEmoji: "🐺",
          discoveries: ["🗺️ Discovered **Whispering Vale**", "🤝 Met **Old Tom**"],
        },
      ],
    });
    const handler = makeHandler(engine);
    const result = await handler({ user: { id: "user-1" } } as never);
    expect(result).toContain("🐺 Wolf Hollow · pressed on past the tree line — ✅ **Success**");
    expect(result).toContain("└─ 🗺️ Discovered **Whispering Vale**");
    expect(result).toContain("└─ 🤝 Met **Old Tom**");
  });

  it("omits the discovery rail when an action has none", async () => {
    engine.setJournal({
      knownLocations: [],
      currentLocation: "Wolf Hollow",
      npcsEncountered: [],
      recentActions: [
        { type: "combat", outcome: "success", createdAt: "2026-01-02T12:00:00Z", narrative: "drove off a starving wolf", location: "Wolf Hollow", locationEmoji: "🐺" },
      ],
    });
    const handler = makeHandler(engine);
    const result = await handler({ user: { id: "user-1" } } as never);
    expect(result).not.toContain("└─");
  });

  it("gives NPCs Encountered its own header", async () => {
    engine.setJournal({
      knownLocations: [],
      currentLocation: "The Warden's Oak",
      npcsEncountered: [{ name: "Greta", class: "Blacksmith", location: "The Warden's Oak" }],
      recentActions: [],
    });
    const handler = makeHandler(engine);
    const result = await handler({ user: { id: "user-1" } } as never);
    expect(result).toContain("**🧑‍🤝‍🧑 NPCs Encountered**");
  });

  it("shows NPCs encountered with name, class, and location", async () => {
    engine.setJournal({
      knownLocations: [],
      currentLocation: "The Warden's Oak",
      npcsEncountered: [
        { name: "Greta", class: "Blacksmith", location: "The Warden's Oak" },
        { name: "Thorn", class: null, location: "Dark Forest" },
      ],
      recentActions: [],
    });
    const handler = makeHandler(engine);
    const result = await handler({ user: { id: "user-1" } } as never);

    expect(result).toContain("Greta");
    expect(result).toContain("Blacksmith");
    expect(result).toContain("Thorn");
    expect(result).toContain("Dark Forest");
  });

  it("shows NPCs without class as plain name", async () => {
    engine.setJournal({
      knownLocations: [],
      currentLocation: "The Warden's Oak",
      npcsEncountered: [{ name: "Stranger", class: null, location: null }],
      recentActions: [],
    });
    const handler = makeHandler(engine);
    const result = await handler({ user: { id: "user-1" } } as never);
    expect(result).toContain("Stranger");
  });

  it("falls back to the action type + a bold outcome tag when there's no narrative or location", async () => {
    engine.setJournal({
      knownLocations: [],
      currentLocation: "The Warden's Oak",
      npcsEncountered: [],
      recentActions: [
        { type: "hunt", outcome: "success", createdAt: "2026-01-01T12:00:00Z" },
        { type: "travel", outcome: "failure", createdAt: "2026-01-01T10:00:00Z" },
      ],
    });
    const handler = makeHandler(engine);
    const result = await handler({ user: { id: "user-1" } } as never);

    expect(result).toContain("hunt — ✅ **Success**");
    expect(result).toContain("travel — ❌ **Failed**");
    expect(result).toContain("(on the road)"); // no location → placeholder
  });

  it("handles empty journal gracefully", async () => {
    engine.setJournal({
      knownLocations: [],
      currentLocation: "The Warden's Oak",
      npcsEncountered: [],
      recentActions: [],
    });
    const handler = makeHandler(engine);
    const result = await handler({ user: { id: "user-1" } } as never);

    expect(result).toContain("Journal");
    expect(result).toContain("no NPCs");
    expect(result).toContain("No actions recorded yet");
  });
});
