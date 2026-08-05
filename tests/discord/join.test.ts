import { describe, it, expect, vi } from "vitest";
import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import { WizardSession } from "../../src/discord/WizardSession.js";
import { makeJoinCommand, handleInteraction } from "../../src/discord/commands/join.js";
import { SessionController } from "../../src/controller/SessionController.js";
import { GameRouter } from "../../src/protocol/router.js";
import { composeWizardView, type CharDefs } from "../../src/controller/joinWizard.js";
import { wizardViewToDiscord } from "../../src/discord/viewToDiscord.js";

const CID_CONFIRM = "join:confirm";

/** Minimal char-creation defs — enough entries to exercise formatting, bonuses, and a miss. */
const FORMAT_DEFS: CharDefs = {
  classes: [
    { name: "Warrior", emoji: "🗡️", description: "A stalwart fighter.", modifiers: { physical: 3, wisdom: -1 } },
    { name: "Mage", emoji: "🔮", description: "A student of the arcane." },
  ],
  backgrounds: [{ name: "Soldier", emoji: "🎖️", description: "Trained for war." }],
  races: [{ name: "Human", emoji: "🧑", description: "Adaptable and driven." }],
  alignments: [{ name: "Lawful Good", emoji: "😇", description: "Order and compassion." }],
  dayJobs: [{ name: "Blacksmith", emoji: "🔨", description: "Forges steel." }],
  itemSets: [{ name: "Soldier's Kit", description: "Standard gear.", for_classes: ["Warrior"] }],
};

/** A button interaction at the wizard's final confirm step. */
function mockConfirmInteraction(userId: string) {
  return {
    user: { id: userId },
    customId: CID_CONFIRM,
    applicationId: "app-1",
    token: "tok-1",
    deferred: false,
    replied: false,
    isModalSubmit: () => false,
    isButton: () => true,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

/** Drive a wizard session through every step so confirm() succeeds. */
function completeWizard(wizard: WizardSession, userId: string) {
  wizard.start(userId);
  wizard.setName(userId, "Aldric");
  wizard.choose(userId, 2, "class", "Warrior");
  wizard.choose(userId, 3, "upbringing", "Soldier");
  wizard.choose(userId, 4, "race", "Human");
  wizard.choose(userId, 5, "alignment", "lawful good");
  wizard.choose(userId, 6, "dayJob", "Blacksmith");
  wizard.choose(userId, 7, "itemSet", "Soldier's Kit");
}

function mockInteraction(userId: string) {
  return {
    user: { id: userId },
    deferReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    channel: {
      createMessageComponentCollector: vi.fn(() => ({
        on: vi.fn(),
        stop: vi.fn(),
      })),
    },
  };
}

/** M7.3 (DC-M7.3.13): the handler is translate + paint — every call goes through a
 *  GameRouter over a real SessionController wrapping the SAME engine + wizard instance
 *  (the sleep.test.ts/hi.test.ts M7.1/M7.2 pattern). `makeJoinCommand(router)` sets the
 *  module-level router `handleInteraction` dispatches through. */
function makeFixture() {
  const engine = new MockWorldEngine();
  engine.setCharacterExists(false);
  const wizard = new WizardSession();
  const controller = new SessionController(engine, () => "", [], undefined, wizard, FORMAT_DEFS);
  const router = new GameRouter(controller, { idle: () => "" });
  const handler = makeJoinCommand(router);
  return { engine, wizard, router, handler };
}

describe("/join", () => {
  it("returns error when user already has a character", async () => {
    const { engine, handler } = makeFixture();
    engine.setCharacterExists(true);
    const intr = mockInteraction("existing-user");
    const result = await handler(intr as never);
    expect(result).toContain("join_guard_has_character");
    // Defers up front to beat Discord's 3s ack window, then answers via editReply.
    expect(intr.deferReply).toHaveBeenCalled();
    expect(intr.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("already have a character"),
      }),
    );
  });

  it("starts a wizard session when user has no character", async () => {
    const { wizard, handler } = makeFixture();
    const intr = mockInteraction("new-user");
    const result = await handler(intr as never);

    // Session should be started
    const session = wizard.getSession("new-user");
    expect(session).toBeDefined();
    expect(session!.step).toBe(1);
    expect(result).toContain("join_wizard_started");
    expect(intr.deferReply).toHaveBeenCalled();
    expect(intr.editReply).toHaveBeenCalled();
  });

  it("resumes existing wizard session if user re-joins", async () => {
    const { wizard, handler } = makeFixture();
    const intr1 = mockInteraction("user-1");
    const intr2 = mockInteraction("user-1");

    // First join
    await handler(intr1 as never);
    wizard.setName("user-1", "Bran");
    expect(wizard.getSession("user-1")!.step).toBe(2);

    // Second join — should not throw, should resume
    const result = await handler(intr2 as never);
    expect(result).toContain("join_wizard_started");
  });

  it("calls engine.createCharacter when wizard is confirmed", () => {
    // Direct test of wizard + engine integration (no Discord)
    const { engine } = makeFixture();
    const wizard = new WizardSession();
    wizard.start("user-final");
    wizard.setName("user-final", "Aldric");
    wizard.choose("user-final", 2, "class", "Warrior");
    wizard.choose("user-final", 3, "upbringing", "Soldier");
    wizard.choose("user-final", 4, "race", "Human");
    wizard.choose("user-final", 5, "alignment", "lawful good");
    wizard.choose("user-final", 6, "dayJob", "Blacksmith");
    wizard.choose("user-final", 7, "itemSet", "Soldier's Kit");

    const data = wizard.confirm("user-final");
    const char = engine.createCharacter("user-final", data);

    expect(engine.calls.createCharacter).toHaveLength(1);
    expect(engine.calls.createCharacter[0].discordUserId).toBe("user-final");
    expect(engine.calls.createCharacter[0].data.name).toBe("Aldric");
    expect(char.name).toBe("Aldric");
  });

  it("does not allow joining when character already exists", async () => {
    const { engine, handler } = makeFixture();
    engine.setCharacterExists(true);
    const intr = mockInteraction("existing-user");
    const result = await handler(intr as never);
    expect(result).toBe("join_guard_has_character");
  });
});

// ═══ /join wizard-completion path (C1) ═══

describe("/join confirm → handleInteraction", () => {
  // The mock's createCharacter does not persist into getCharacter (M7.0 review note 3), so
  // the post-confirm /hi composition reads the canned char — set it per test.
  function seedCannedChar(engine: MockWorldEngine): void {
    engine.setCharacter(MockWorldEngine.defaultCharacter({ name: "Aldric", dayJob: "Blacksmith" }));
  }

  it("creates the character, announces publicly, then swaps in the /hi screen", async () => {
    const { engine, wizard } = makeFixture();
    completeWizard(wizard, "finisher");
    seedCannedChar(engine);
    const intr = mockConfirmInteraction("finisher");
    const renderHiScreen = vi.fn().mockResolvedValue({ content: "HI-SCREEN" });

    await handleInteraction(intr as never, engine, wizard, renderHiScreen);

    // Character persisted with the wizard's choices.
    expect(engine.calls.createCharacter).toHaveLength(1);
    expect(engine.calls.createCharacter[0].data.name).toBe("Aldric");

    // Acked the click, posted the public celebration, then replaced the wizard
    // with the player's own ephemeral /hi screen (deleteReply → followUp).
    expect(intr.deferUpdate).toHaveBeenCalled();
    expect(intr.followUp).toHaveBeenCalledTimes(2);
    expect(intr.deleteReply).toHaveBeenCalled();
    expect(renderHiScreen).toHaveBeenCalledWith("finisher");
  });

  it("falls back to a text pointer when no /hi renderer is supplied", async () => {
    const { engine, wizard } = makeFixture();
    completeWizard(wizard, "no-render");
    seedCannedChar(engine);
    const intr = mockConfirmInteraction("no-render");

    await handleInteraction(intr as never, engine, wizard, undefined);

    expect(engine.calls.createCharacter).toHaveLength(1);
    // No /hi screen → wizard collapses to a short pointer via editReply, no deleteReply.
    expect(intr.deleteReply).not.toHaveBeenCalled();
    expect(intr.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("/hi") }),
    );
  });

  it("does not throw when the public follow-up rejects (swallowed)", async () => {
    const { engine, wizard } = makeFixture();
    completeWizard(wizard, "flaky");
    seedCannedChar(engine);
    const intr = mockConfirmInteraction("flaky");
    intr.followUp.mockRejectedValue(new Error("Discord hiccup"));
    const renderHiScreen = vi.fn().mockResolvedValue({ content: "HI" });

    // The .catch(() => {}) swallows must keep this from rejecting.
    await expect(
      handleInteraction(intr as never, engine, wizard, renderHiScreen),
    ).resolves.toBeUndefined();
    // The character is still created despite the announcement failing.
    expect(engine.calls.createCharacter).toHaveLength(1);
  });
});

// ═══ /join screen formatting (polish 0.3.1) ═══

describe("/join screen formatting", () => {
  // M7.3 (DC-M7.3.13): the composition + medium step are pinned directly — the old tests
  // drove handleInteraction and read the editReply embed; the semantic view now travels the
  // seam, so they compose the view and map it through wizardViewToDiscord instead. Byte
  // assertions unchanged.
  it("gives each option its own lines: label, then bonuses set off, then description", () => {
    const wizard = new WizardSession();
    wizard.start("fmt-user");
    const state = wizard.setName("fmt-user", "Rowan"); // → step 2
    const view = composeWizardView(state, FORMAT_DEFS);
    const description = wizardViewToDiscord(view).embeds[0].description;

    // Warrior carries bonuses — its own indented (blockquote) line, separate from the description.
    expect(description).toContain("🗡️ **Warrior**\n> 💪+3 🧠-1\nA stalwart fighter.");
    // Mage carries no bonuses — no blockquote line, straight to the description.
    expect(description).toContain("🔮 **Mage**\nA student of the arcane.");
    // Options are visually separated (blank line), not crowded onto one dashed line.
    expect(description).toContain("A stalwart fighter.\n\n🔮 **Mage**");
  });

  it("shows the chosen option's own emoji next to its value in the ledger", () => {
    const wizard = new WizardSession();
    wizard.start("ledger-user");
    wizard.setName("ledger-user", "Bram");
    wizard.choose("ledger-user", 2, "class", "Warrior"); // → step 3
    const view = composeWizardView(wizard.getSession("ledger-user")!, FORMAT_DEFS);
    const description = wizardViewToDiscord(view).embeds[0].description;

    // Warrior's own 🗡️ (not the fixed 🛡️ step icon) sits next to the chosen value.
    expect(description).toContain("🛡️ ~~Class~~ → 🗡️ **Warrior**");
  });

  it("falls back to no emoji (never the literal 'undefined') when a chosen value has no matching def", () => {
    const wizard = new WizardSession();
    wizard.start("miss-user");
    wizard.setName("miss-user", "Ghost");
    // Bypass the button flow to persist a value FORMAT_DEFS.classes has no entry for —
    // simulates a custom/renamed value the def lookup can't find.
    wizard.choose("miss-user", 2, "class", "Rogue Scholar");
    wizard.choose("miss-user", 3, "upbringing", "Soldier"); // → step 4
    const view = composeWizardView(wizard.getSession("miss-user")!, FORMAT_DEFS);
    const description = wizardViewToDiscord(view).embeds[0].description;

    expect(description).toContain("🛡️ ~~Class~~ → **Rogue Scholar**");
    expect(description).not.toContain("undefined");
  });
});
