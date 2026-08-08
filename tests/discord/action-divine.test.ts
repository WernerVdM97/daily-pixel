import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import { SessionController } from "../../src/controller/SessionController.js";
import { GameRouter } from "../../src/protocol/router.js";
import { WizardSession } from "../../src/discord/WizardSession.js";
import type { CharDefs } from "../../src/controller/joinWizard.js";
import { makeActionCommand } from "../../src/discord/commands/action.js";

/**
 * F#21 — divine intervention must render the distinct grey ⚠️ System embed
 * and stop, BEFORE the generic auto-finish branch would repaint it as a
 * normal ✅ DONE outcome (the bug this closes out: the System embed was dead
 * code because `firstDecision.options.length === 0` was unreachable whenever
 * `result.outcome` was already set).
 *
 * M9.2 (DC-M9.3): the handler crosses the seam onto `action.custom` — rehomed onto the
 * router-backed factory (the sleep.test.ts/hi.test.ts pattern).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
function mockChatInteraction(userId: string, description: string | null) {
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
    ],
  },
];

const EMPTY_DEFS: CharDefs = { classes: [], backgrounds: [], races: [], alignments: [], dayJobs: [], itemSets: [] };
const SCENE_STUB = () => ({ sceneName: "test", ascii: "..." });

function makeHandler(engine: MockWorldEngine) {
  const controller = new SessionController(engine, () => "", DAY_JOBS as never, undefined, new WizardSession(), EMPTY_DEFS, SCENE_STUB);
  const router = new GameRouter(controller, { idle: () => "" });
  return makeActionCommand(router, engine);
}

function baseChar(overrides?: Record<string, unknown>) {
  return MockWorldEngine.defaultCharacter({
    id: 7,
    dayJob: "Blacksmith",
    rollsRemaining: 3,
    lastActionState: null,
    ...overrides,
  } as never);
}

describe("action start — divine intervention routing (F#21)", () => {
  let engine: MockWorldEngine;

  beforeEach(() => {
    engine = new MockWorldEngine();
  });

  it("renders the ⚠️ System embed and returns 'action_divine', never the auto-finish outcome embed", async () => {
    engine.setCharacterExists(true);
    engine.setCharacter(baseChar({ rollsRemaining: 3, lastActionState: null }));
    engine.setStartActionResult({
      state: { rawInput: "poke the void", decisions: [], accumulatedDc: 0, kind: "quest" } as never,
      firstDecision: { prompt: '⚙️ system fault text', options: [] },
      outcome: {
        isDivineIntervention: true,
        outcome: 'done',
        outcomeText: '⚙️ The world stutters. Your action could not be processed and your action roll has been refunded.',
        mutations: [],
        distilledType: 'divine_intervention',
        finalDc: 0,
        playerRolled: null,
      } as never,
    });

    const handler = makeHandler(engine);
    const intr = mockChatInteraction("wanderer", "poke the void");
    const result = await handler(intr as never);

    expect(result).toBe("action_divine");

    // The handler first shows the "⏳ Thinking…" idle embed, then the System embed —
    // search all editReply calls rather than assuming call order/index.
    const systemCall = intr.editReply.mock.calls.find((call: any[]) => {
      const embed = call[0]?.embeds?.[0];
      return embed?.title === '⚠️ System';
    });
    expect(systemCall).toBeDefined();
    expect(systemCall![0].embeds[0].description).toContain('roll has been refunded');
    expect(systemCall![0].components).toEqual([]);

    // Guard against the auto-finish path repainting this as a normal outcome: no editReply
    // call should carry the distilled-type outcome embed title (breadcrumb emoji + capitalized
    // distilledType, per buildOutcomeEmbed), which is what the auto-finish branch renders.
    const autoFinishCall = intr.editReply.mock.calls.find((call: any[]) => {
      const embed = call[0]?.embeds?.[0];
      return embed?.title?.includes('Divine_intervention') || embed?.title?.includes('Divine intervention');
    });
    expect(autoFinishCall).toBeUndefined();
  });
});
