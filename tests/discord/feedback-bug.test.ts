import { describe, it, expect, beforeEach, vi } from "vitest";
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

// A stub notifyAdmin for the tests below that don't care about paging (DC-M9.3.10 gave
// the slash handlers a required second factory param, mirroring the four modal leaves).
function stubNotifyAdmin() {
  return vi.fn(async (_label: string, _err: unknown) => {});
}

describe("/feedback", () => {
  let engine: MockWorldEngine;

  beforeEach(() => {
    engine = new MockWorldEngine();
    engine.setCharacter(MockWorldEngine.defaultCharacter({ id: 7 }));
  });

  it("returns error when user has no character", async () => {
    const engine = new MockWorldEngine();
    const handler = makeFeedbackCommand(makeRouter(engine), stubNotifyAdmin());
    const result = await handler(interaction("no-char", "hello") as never);
    expect(result).toContain("character");
  });

  it("calls engine.submitFeedback and returns confirmation", async () => {
    const handler = makeFeedbackCommand(makeRouter(engine), stubNotifyAdmin());
    const result = await handler(
      interaction("user-1", "The warden is wise") as never,
    );

    expect(engine.calls.submitFeedback).toHaveLength(1);
    expect(engine.calls.submitFeedback[0].characterId).toBe(7);
    expect(engine.calls.submitFeedback[0].text).toBe("The warden is wise");
    expect(result).toContain("Thanks");
  });

  // Regression (DC-M9.3.10): before the seam crossing, a throwing engine.submitFeedback
  // propagated out of this handler into the dispatcher's error net, which paged the admin.
  // The router now swallows the throw into a persistFailed fact — this handler must still
  // page, matching the four in-message modal leaves, or the slash path silently loses the
  // operator signal while the player-visible confirmation stays unchanged.
  it("pages notifyAdmin when the persist throws, but the player still gets the normal confirmation", async () => {
    const engine2 = new MockWorldEngine();
    engine2.setCharacter(MockWorldEngine.defaultCharacter({ id: 7 }));
    vi.spyOn(engine2, "submitFeedback").mockImplementation(() => {
      throw new Error("boom (submitFeedback)");
    });
    const notifyAdmin = stubNotifyAdmin();
    const handler = makeFeedbackCommand(makeRouter(engine2), notifyAdmin);
    const result = await handler(
      interaction("user-1", "The warden is wise") as never,
    );

    expect(result).toBe("🙏 Thanks. The warden listens.");
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][0]).toBe("Slash feedback submission failed");
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
    const handler = makeBugCommand(makeRouter(engine), stubNotifyAdmin());
    const result = await handler(interaction("no-char", "bug") as never);
    expect(result).toContain("character");
  });

  it("calls engine.submitBug and returns confirmation", async () => {
    const handler = makeBugCommand(makeRouter(engine), stubNotifyAdmin());
    const result = await handler(
      interaction("user-1", "Found a crash on /look") as never,
    );

    expect(engine.calls.submitBug).toHaveLength(1);
    expect(engine.calls.submitBug[0].characterId).toBe(7);
    expect(engine.calls.submitBug[0].text).toBe("Found a crash on /look");
    expect(result).toContain("noted");
  });

  // Regression (DC-M9.3.10): same loss-of-signal bug as /feedback, on the bug.submit path.
  it("pages notifyAdmin when the persist throws, but the player still gets the normal confirmation", async () => {
    const engine2 = new MockWorldEngine();
    engine2.setCharacter(MockWorldEngine.defaultCharacter({ id: 7 }));
    vi.spyOn(engine2, "submitBug").mockImplementation(() => {
      throw new Error("boom (submitBug)");
    });
    const notifyAdmin = stubNotifyAdmin();
    const handler = makeBugCommand(makeRouter(engine2), notifyAdmin);
    const result = await handler(
      interaction("user-1", "Found a crash on /look") as never,
    );

    expect(result).toBe("🐛 Bug noted. The warden will investigate.");
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][0]).toBe("Slash bug report failed");
  });
});
