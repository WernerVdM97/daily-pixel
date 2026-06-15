import { describe, it, expect, beforeEach } from "vitest";
import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import { makeJournalCommand } from "../../src/discord/commands/journal.js";
describe("/journal", () => {
	let engine: MockWorldEngine;

	beforeEach(() => {
		engine = new MockWorldEngine();
		engine.setCharacter(MockWorldEngine.defaultCharacter());
	});

	it("returns error when user has no character", async () => {
		const handler = makeJournalCommand(new MockWorldEngine());
		const result = await handler({ user: { id: "no-char" } } as never);
		expect(result).toContain("character");
	});

	it("shows known locations with current location marked", () => {
		engine.setJournal({
			knownLocations: ["The Warden's Oak", "Dark Forest", "Stone Bridge"],
			currentLocation: "Dark Forest",
			npcsEncountered: [],
			recentActions: [],
		});
		const handler = makeJournalCommand(engine);
		const result = handler({ user: { id: "user-1" } } as never);
		expect(result).toContain("The Warden's Oak");
		expect(result).toContain("Dark Forest");
		expect(result).toContain("Stone Bridge");
		// Current location marked
		expect(result).toContain("←");
		expect(result).toMatch(/Dark Forest.*←/);
	});

	it("shows NPCs encountered with name, class, and location", () => {
		engine.setJournal({
			knownLocations: [],
			currentLocation: "The Warden's Oak",
			npcsEncountered: [
				{ name: "Greta", class: "Blacksmith", location: "The Warden's Oak" },
				{ name: "Thorn", class: null, location: "Dark Forest" },
			],
			recentActions: [],
		});
		const handler = makeJournalCommand(engine);
		const result = handler({ user: { id: "user-1" } } as never);

		expect(result).toContain("Greta");
		expect(result).toContain("Blacksmith");
		expect(result).toContain("Thorn");
		expect(result).toContain("Dark Forest");
	});

	it("shows NPCs without class as plain name", () => {
		engine.setJournal({
			knownLocations: [],
			currentLocation: "The Warden's Oak",
			npcsEncountered: [{ name: "Stranger", class: null, location: null }],
			recentActions: [],
		});
		const handler = makeJournalCommand(engine);
		const result = handler({ user: { id: "user-1" } } as never);
		expect(result).toContain("Stranger");
	});

	it("shows recent actions with type and outcome", () => {
		engine.setJournal({
			knownLocations: [],
			currentLocation: "The Warden's Oak",
			npcsEncountered: [],
			recentActions: [
				{ type: "hunt", outcome: "success", createdAt: "2026-01-01T12:00:00Z" },
				{
					type: "travel",
					outcome: "failure",
					createdAt: "2026-01-01T10:00:00Z",
				},
			],
		});
		const handler = makeJournalCommand(engine);
		const result = handler({ user: { id: "user-1" } } as never);

		expect(result).toContain("hunt");
		expect(result).toContain("success");
		expect(result).toContain("travel");
		expect(result).toContain("failure");
	});

	it("handles empty journal gracefully", () => {
		engine.setJournal({
			knownLocations: [],
			currentLocation: "The Warden's Oak",
			npcsEncountered: [],
			recentActions: [],
		});
		const handler = makeJournalCommand(engine);
		const result = handler({ user: { id: "user-1" } } as never);

		expect(result).toContain("Journal");
		expect(result).toContain("no locations");
		expect(result).toContain("no NPCs");
		expect(result).toContain("No actions");
	});
});
