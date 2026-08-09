import { describe, it, expect, beforeEach } from "vitest";
import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import { SessionController } from "../../src/controller/SessionController.js";
import { GameRouter } from "../../src/protocol/router.js";
import { WizardSession } from "../../src/controller/WizardSession.js";
import type { CharDefs } from "../../src/controller/joinWizard.js";
import { makeFeedbackCommand } from "../../src/discord/commands/feedback.js";
import { makeBugCommand } from "../../src/discord/commands/bug.js";

// M9.2 (DC-M9.2.1): both commands cross the seam onto the `slash-feedback`/`slash-bug`
// surfaces — the sleep.test.ts/hi.test.ts pattern (a GameRouter over a real
// SessionController wrapping the same MockWorldEngine).
const EMPTY_DEFS: CharDefs = { classes: [], backgrounds: [], races: [], alignments: [], dayJobs: [], itemSets: [] };
const SCENE_STUB = () => ({ sceneName: "test", ascii: "..." });

function makeRouter(engine: MockWorldEngine): GameRouter {
  const controller = new SessionController(engine, () => "", [], undefined, new WizardSession(), EMPTY_DEFS, SCENE_STUB);
  return new GameRouter(controller, { idle: () => "" });
}

function interaction(userId: string, text: string) {
  return { user: { id: userId }, text };
}

describe("/feedback", () => {
  let engine: MockWorldEngine;

  beforeEach(() => {
    engine = new MockWorldEngine();
    engine.setCharacter(MockWorldEngine.defaultCharacter({ id: 7 }));
  });

  it("returns error when user has no character", async () => {
    const engine = new MockWorldEngine();
    const handler = makeFeedbackCommand(makeRouter(engine));
    const result = await handler(interaction("no-char", "hello") as never);
    expect(result).toContain("character");
  });

  it("calls engine.submitFeedback and returns confirmation", async () => {
    const handler = makeFeedbackCommand(makeRouter(engine));
    const result = await handler(
      interaction("user-1", "The warden is wise") as never,
    );

    expect(engine.calls.submitFeedback).toHaveLength(1);
    expect(engine.calls.submitFeedback[0].characterId).toBe(7);
    expect(engine.calls.submitFeedback[0].text).toBe("The warden is wise");
    expect(result).toContain("Thanks");
  });
});

describe("/bug", () => {
  let engine: MockWorldEngine;

  beforeEach(() => {
    engine = new MockWorldEngine();
    engine.setCharacter(MockWorldEngine.defaultCharacter({ id: 7 }));
  });

  it("returns error when user has no character", async () => {
    const engine = new MockWorldEngine();
    const handler = makeBugCommand(makeRouter(engine));
    const result = await handler(interaction("no-char", "bug") as never);
    expect(result).toContain("character");
  });

  it("calls engine.submitBug and returns confirmation", async () => {
    const handler = makeBugCommand(makeRouter(engine));
    const result = await handler(
      interaction("user-1", "Found a crash on /look") as never,
    );

    expect(engine.calls.submitBug).toHaveLength(1);
    expect(engine.calls.submitBug[0].characterId).toBe(7);
    expect(engine.calls.submitBug[0].text).toBe("Found a crash on /look");
    expect(result).toContain("noted");
  });
});
