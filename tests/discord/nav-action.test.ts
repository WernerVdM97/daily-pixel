import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import { makeActionCommand } from "../../src/discord/commands/action.js";

/**
 * C2 — coverage for the "action" entry-point routing.
 *
 * The `nav:action` button handler in index.ts and the `/action` slash command
 * share the same three-way branch: out-of-actions (no rolls, not mid-action) →
 * resume (mid-action) → day-job menu (idle). We test that branch logic through
 * `makeActionCommand`, the exported, dependency-injected form of it, so the
 * routing the nav button relies on is guarded without standing up the whole
 * Discord client closure.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
function mockChatInteraction(userId: string, description: string | null = null) {
  return {
    user: { id: userId, tag: `${userId}#0001` },
    applicationId: "app-1",
    token: "tok-1",
    options: { getString: vi.fn(() => description) },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    fetchReply: vi.fn().mockResolvedValue({ id: "msg-1" }),
  };
}

const DAY_JOBS = [
  {
    name: "Blacksmith",
    depends_on: [],
    base_income: 5,
    workplace_location: "The Town Forge",
    description: "Hammer and anvil work.",
    actions: [
      { label: "Forge a blade", income: 5, hook: "A commission waits at the anvil." },
      { label: "Shoe a horse", income: 3, hook: "The stablemaster needs a steady hand." },
    ],
  },
];

function baseChar(overrides?: Record<string, unknown>) {
  return MockWorldEngine.defaultCharacter({
    id: 7,
    dayJob: "Blacksmith",
    rollsRemaining: 3,
    lastActionState: null,
    ...overrides,
  } as never);
}

describe("action entry-point routing (nav:action / /action)", () => {
  let engine: MockWorldEngine;

  beforeEach(() => {
    engine = new MockWorldEngine();
  });

  it("guards when the clicker has no character", async () => {
    engine.setCharacter(null);
    const handler = makeActionCommand(engine, () => "", DAY_JOBS as never);
    const intr = mockChatInteraction("nobody");
    const result = await handler(intr as never);

    expect(result).toBe("action_guard_no_character");
    expect(intr.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("/join") }),
    );
  });

  it("blocks with 'out of actions' when no rolls remain and not mid-action", async () => {
    engine.setCharacter(baseChar({ rollsRemaining: 0, lastActionState: null }));
    const handler = makeActionCommand(engine, () => "", DAY_JOBS as never);
    const intr = mockChatInteraction("spent");
    const result = await handler(intr as never);

    expect(result).toBe("action_no_rolls");
    expect(intr.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Out of actions") }),
    );
  });

  it("resumes the pending decision when mid-action, even with no rolls left", async () => {
    engine.setCharacter(baseChar({ rollsRemaining: 0, lastActionState: "{...}" }));
    engine.setResumeResult({
      state: { rawInput: "scout the ridge", decisions: [], accumulatedDc: 12 } as never,
      nextDecision: {
        prompt: "The ridge forks ahead.",
        options: [
          { label: "Climb", dcModifier: 2 },
          { label: "Step back", dcModifier: null },
        ],
      },
    });
    const handler = makeActionCommand(engine, () => "", DAY_JOBS as never);
    const intr = mockChatInteraction("midway");
    const result = await handler(intr as never);

    expect(result).toBe("action_resumed");
    expect(engine.calls.resumeAction).toContain(7);
    expect(intr.deferReply).toHaveBeenCalled();
  });

  it("shows the 'stale action' notice when the resumed decision has no options", async () => {
    engine.setCharacter(baseChar({ lastActionState: "{...}" }));
    engine.setResumeResult({
      state: { rawInput: "x", decisions: [], accumulatedDc: 12 } as never,
      nextDecision: { prompt: "Could not recover.", options: [] },
    });
    const handler = makeActionCommand(engine, () => "", DAY_JOBS as never);
    const intr = mockChatInteraction("stale");
    const result = await handler(intr as never);

    expect(result).toBe("action_resume_empty");
  });

  it("shows the day-job menu when idle with rolls and no description", async () => {
    engine.setMeta("day_number", "1");
    engine.setCharacter(baseChar({ rollsRemaining: 3, lastActionState: null }));
    const handler = makeActionCommand(engine, () => "", DAY_JOBS as never);
    const intr = mockChatInteraction("ready", null);
    const result = await handler(intr as never);

    expect(result).toBe("action_dayjob_menu");
    // The menu is a fresh ephemeral reply carrying buttons.
    expect(intr.reply).toHaveBeenCalled();
    const replyArg = intr.reply.mock.calls[0][0];
    expect(replyArg.components?.length ?? 0).toBeGreaterThan(0);
  });

  it("carries no hints in the menu embed when nothing is amiss", async () => {
    engine.setMeta("day_number", "1");
    engine.setCharacter(
      baseChar({ rollsRemaining: 3, stamina: 10, maxStamina: 10, lastActionState: null }),
    );
    const handler = makeActionCommand(engine, () => "", DAY_JOBS as never);
    const intr = mockChatInteraction("ready", null);
    await handler(intr as never);

    const replyArg = intr.reply.mock.calls[0][0];
    const description = replyArg.embeds[0].description as string;
    expect(description).toBe("Pick a task to start:");
  });

  it("surfaces every applicable hint in the menu embed", async () => {
    engine.setMeta("day_number", "1");
    engine.setLocation({
      name: "The Deep Mire",
      description: "A treacherous bog.",
      tags: ["mock"],
      isSafe: false,
      emoji: "🌫️",
    });
    engine.setCharacter(
      baseChar({
        rollsRemaining: 1,
        stamina: 1,
        maxStamina: 10,
        location: "The Deep Mire",
        lastActionState: null,
      }),
    );
    const handler = makeActionCommand(engine, () => "", DAY_JOBS as never);
    const intr = mockChatInteraction("beleaguered", null);
    await handler(intr as never);

    const replyArg = intr.reply.mock.calls[0][0];
    const description = replyArg.embeds[0].description as string;
    expect(description).toContain("🎲 Last action of the day");
    expect(description).toContain("😮‍💨 You're running on fumes (1/10 stamina).");
    expect(description).toContain("⚠️ This place isn't safe");
  });
});
