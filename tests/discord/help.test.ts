import { describe, it, expect } from "vitest";
import { makeHelpCommand } from "../../src/discord/commands/help.js";
import { SessionController } from "../../src/controller/SessionController.js";
import { GameRouter } from "../../src/protocol/router.js";
import { WizardSession } from "../../src/discord/WizardSession.js";
import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";import type { CharDefs } from "../../src/controller/joinWizard.js";

// M8.1 (DC-M8.3/4): the handler is translate + paint — every call goes through a GameRouter
// over a real SessionController. screen.help has NO character guard (help works charless
// today), so the handler works with and without a character.
const EMPTY_DEFS: CharDefs = { classes: [], backgrounds: [], races: [], alignments: [], dayJobs: [], itemSets: [] };
const SCENE_STUB = () => ({ sceneName: "test", ascii: "..." });

function makeHandler(engine: MockWorldEngine) {
  const controller = new SessionController(engine, () => "", [], undefined, new WizardSession(), EMPTY_DEFS, SCENE_STUB);
  const router = new GameRouter(controller, { idle: () => "" });
  return makeHelpCommand(router);
}

describe("/help", () => {
  it("returns a command list", async () => {
    const handler = makeHandler(new MockWorldEngine());
    const result = await handler({ user: { id: "u1" } } as never);

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(100);
  });

  it("mentions all deterministic commands", async () => {
    const handler = makeHandler(new MockWorldEngine());
    const result = await handler({ user: { id: "u1" } } as never);

    expect(result).toContain("/join");
    expect(result).toContain("/stats");
    expect(result).toContain("/backpack");
    expect(result).toContain("/look");
    expect(result).toContain("/journal");
    expect(result).toContain("/help");
    expect(result).toContain("/feedback");
    expect(result).toContain("/bug");
    expect(result).toContain("/hi");
    expect(result).toContain("/sleep");
    expect(result).toContain("/action");
  });

  it("explains roll economy", async () => {
    const handler = makeHandler(new MockWorldEngine());
    const result = await handler({ user: { id: "u1" } } as never);

    expect(result.toLowerCase()).toContain("roll");
    expect(result.toLowerCase()).toContain("reset");
    expect(result.toLowerCase()).toContain("/sleep");
    expect(result.toLowerCase()).toContain("skip");
  });

  it("explains action types", async () => {
    const handler = makeHandler(new MockWorldEngine());
    const result = await handler({ user: { id: "u1" } } as never);

    expect(result.toLowerCase()).toContain("action");
  });

  it("mentions the rest /sleep command", async () => {
    const handler = makeHandler(new MockWorldEngine());
    const result = await handler({ user: { id: "u1" } } as never);

    expect(result).toContain("/sleep");
    expect(result.toLowerCase()).toContain("camp");
    expect(result.toLowerCase()).toContain("oak");
    expect(result.toLowerCase()).toContain("nightfall");
  });

  it("explains the economy section fully", async () => {
    const handler = makeHandler(new MockWorldEngine());
    const result = await handler({ user: { id: "u1" } } as never);

    expect(result).toContain("2 rolls per day");
    expect(result).toContain("consumes 1 roll");
    expect(result).toContain("Bail");
    expect(result).toContain("Skip");
  });
});
