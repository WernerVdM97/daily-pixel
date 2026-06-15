import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import { WizardSession } from "../../src/discord/WizardSession.js";
import { makeJoinCommand } from "../../src/discord/commands/join.js";

function mockInteraction(userId: string) {
	return {
		user: { id: userId },
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

	it("returns error when user already has a character", async () => {
		engine.setCharacterExists(true);
		const handler = makeJoinCommand(engine, wizard);
		const intr = mockInteraction("existing-user");
		const result = await handler(intr as never);
		expect(result).toContain("join_guard_has_character");
		expect(intr.reply).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("already have a character"),
			}),
		);
	});

	it("starts a wizard session when user has no character", async () => {
		const handler = makeJoinCommand(engine, wizard);
		const intr = mockInteraction("new-user");
		const result = await handler(intr as never);

		// Session should be started
		const session = wizard.getSession("new-user");
		expect(session).toBeDefined();
		expect(session!.step).toBe(1);
		expect(result).toContain("join_wizard_started");
		expect(intr.reply).toHaveBeenCalled();
	});

	it("resumes existing wizard session if user re-joins", async () => {
		const handler = makeJoinCommand(engine, wizard);
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
		const handler = makeJoinCommand(engine, wizard);
		const intr = mockInteraction("existing-user");
		const result = await handler(intr as never);
		expect(result).toBe("join_guard_has_character");
	});
});
