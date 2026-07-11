import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import { WizardSession } from "../../src/discord/WizardSession.js";
import { makeJoinCommand, handleInteraction, type CharDefs } from "../../src/discord/commands/join.js";

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

/** A button interaction for a step choice, e.g. `join:choice:2:Warrior`. */
function mockChoiceInteraction(userId: string, customId: string) {
  return {
    user: { id: userId },
    customId,
    isModalSubmit: () => false,
    isButton: () => true,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

/** A modal-submit interaction for the name step. */
function mockNameModalInteraction(userId: string, name: string) {
  return {
    user: { id: userId },
    customId: "join:name:modal",
    isModalSubmit: () => true,
    fields: { getTextInputValue: () => name },
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

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

describe("/join", () => {
  let engine: MockWorldEngine;
  let wizard: WizardSession;

  beforeEach(() => {
    engine = new MockWorldEngine();
    engine.setCharacterExists(false);
    wizard = new WizardSession();
  });

  function makeHandler() {
    return makeJoinCommand(engine, wizard, {
      classes: [], backgrounds: [], races: [], alignments: [], dayJobs: [], itemSets: [],
    });
  }

  it("returns error when user already has a character", async () => {
    engine.setCharacterExists(true);
    const handler = makeHandler();
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
    const handler = makeHandler();
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
    const handler = makeHandler();
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
    expect(engine.calls.createCharacter[0].data.class).toBe("Warrior");
    expect(char.name).toBe("Aldric");
  });

  it("does not allow joining when character already exists", async () => {
    engine.setCharacterExists(true);
    const handler = makeHandler();
    const intr = mockInteraction("existing-user");
    const result = await handler(intr as never);
    expect(result).toBe("join_guard_has_character");
  });
});

// ═══ /join wizard-completion path (C1) ═══

describe("/join confirm → handleInteraction", () => {
  let engine: MockWorldEngine;
  let wizard: WizardSession;

  beforeEach(() => {
    engine = new MockWorldEngine();
    engine.setCharacterExists(false);
    wizard = new WizardSession();
  });

  it("creates the character, announces publicly, then swaps in the /hi screen", async () => {
    completeWizard(wizard, "finisher");
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
    completeWizard(wizard, "no-render");
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
    completeWizard(wizard, "flaky");
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
  let engine: MockWorldEngine;
  let wizard: WizardSession;

  beforeEach(() => {
    engine = new MockWorldEngine();
    engine.setCharacterExists(false);
    wizard = new WizardSession();
    makeJoinCommand(engine, wizard, FORMAT_DEFS); // sets the module-level defs read by the renderer
  });

  it("gives each option its own lines: label, then bonuses set off, then description", async () => {
    wizard.start("fmt-user");
    const nameIntr = mockNameModalInteraction("fmt-user", "Rowan");
    await handleInteraction(nameIntr as never, engine, wizard);

    const payload = nameIntr.editReply.mock.calls[0][0] as { embeds: Array<{ description: string }> };
    const description = payload.embeds[0].description;

    // Warrior carries bonuses — its own indented (blockquote) line, separate from the description.
    expect(description).toContain("🗡️ **Warrior**\n> 💪+3 🧠-1\nA stalwart fighter.");
    // Mage carries no bonuses — no blockquote line, straight to the description.
    expect(description).toContain("🔮 **Mage**\nA student of the arcane.");
    // Options are visually separated (blank line), not crowded onto one dashed line.
    expect(description).toContain("A stalwart fighter.\n\n🔮 **Mage**");
  });

  it("shows the chosen option's own emoji next to its value in the ledger", async () => {
    wizard.start("ledger-user");
    wizard.setName("ledger-user", "Bram"); // → step 2

    const chooseClass = mockChoiceInteraction("ledger-user", "join:choice:2:Warrior");
    await handleInteraction(chooseClass as never, engine, wizard);

    const payload = chooseClass.editReply.mock.calls[0][0] as { embeds: Array<{ description: string }> };
    const description = payload.embeds[0].description;

    // Warrior's own 🗡️ (not the fixed 🛡️ step icon) sits next to the chosen value.
    expect(description).toContain("🛡️ ~~Class~~ → 🗡️ **Warrior**");
  });

  it("falls back to no emoji (never the literal 'undefined') when a chosen value has no matching def", async () => {
    wizard.start("miss-user");
    wizard.setName("miss-user", "Ghost");
    // Bypass the button flow to persist a value FORMAT_DEFS.classes has no entry for —
    // simulates a custom/renamed value the def lookup can't find.
    wizard.choose("miss-user", 2, "class", "Rogue Scholar");

    const chooseUpbringing = mockChoiceInteraction("miss-user", "join:choice:3:Soldier");
    await handleInteraction(chooseUpbringing as never, engine, wizard);

    const payload = chooseUpbringing.editReply.mock.calls[0][0] as { embeds: Array<{ description: string }> };
    const description = payload.embeds[0].description;

    expect(description).toContain("🛡️ ~~Class~~ → **Rogue Scholar**");
    expect(description).not.toContain("undefined");
  });
});
