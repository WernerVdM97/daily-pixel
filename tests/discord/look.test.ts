import { describe, it, expect, beforeEach } from "vitest";
import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import { makeLookCommand } from "../../src/discord/commands/look.js";
import { SessionController } from "../../src/controller/SessionController.js";
import { GameRouter } from "../../src/protocol/router.js";
import { WizardSession } from "../../src/discord/WizardSession.js";
import type { CharDefs } from "../../src/controller/joinWizard.js";
import type { SceneFile } from "../../src/scenes/SceneLoader.js";
import { TagResolver } from "../../src/scenes/TagResolver.js";

function lookupSceneFn(scenes: Map<string, SceneFile>) {
	const resolver = new TagResolver(scenes);
	return (tags: string[]) => {
		const name = resolver.resolve(tags);
		const scene = scenes.get(name)!;
		return { sceneName: name, ascii: scene.body };
	};
}

// M8.1 (DC-M8.4/5): the handler is translate + paint — every call goes through a GameRouter
// over a real SessionController wrapping the SAME engine, with the TagResolver scenes as the
// controller's 7th constructor arg (resolveScene). The behavior asserts are unchanged.
const EMPTY_DEFS: CharDefs = { classes: [], backgrounds: [], races: [], alignments: [], dayJobs: [], itemSets: [] };

function makeHandler(engine: MockWorldEngine, resolveScene: (tags: string[]) => { sceneName: string; ascii: string }) {
	const controller = new SessionController(engine, () => "", [], undefined, new WizardSession(), EMPTY_DEFS, resolveScene);
	const router = new GameRouter(controller, { idle: () => "" });
	return makeLookCommand(router);
}

describe("/look", () => {
	let engine: MockWorldEngine;
	let scenes: Map<string, SceneFile>;

	beforeEach(() => {
		engine = new MockWorldEngine();
		scenes = new Map([
			[
				"oak",
				{
					tags: ["oak", "interior", "fire"],
					body: "  ,@@@@@@,\n ,@@@@@@@@,\n  @@  @@",
				},
			],
			[
				"forest",
				{ tags: ["forest", "trees", "dark"], body: "  ^  ^  ^\n ^^^ ^^^" },
			],
			["unknown", { tags: ["unknown", "generic"], body: "  . . .\n . . ." }],
		]);
	});

	it("returns error when user has no character", async () => {
		const handler = makeHandler(engine, lookupSceneFn(scenes));
		const result = await handler({ user: { id: "no-char" } } as never);
		expect(result).toContain("character");
	});

	it("renders ASCII scene and description for current location", async () => {
		engine.setCharacter(
			MockWorldEngine.defaultCharacter({ location: "The Warden's Oak" }),
		);
		engine.setLocation({
			name: "The Warden's Oak",
			description: "A massive ancient oak.",
			tags: ["oak", "interior", "fire", "sanctuary"],
			isSafe: true,
			emoji: "🌳",
		});

		const handler = makeHandler(engine, lookupSceneFn(scenes));
		const result = await handler({ user: { id: "user-1" } } as never);

		expect(result).toContain("The Warden's Oak");
		expect(result).toContain("A massive ancient oak.");
		expect(result).toContain(",@@@@@@,");
		// Header shows the location's own emoji, not a hardcoded house, and no
		// safety emoji (that's already in the safe/unsafe line below the description).
		expect(result).toContain("🌳 **The Warden's Oak**");
		expect(result).not.toContain("🏠");
		expect(result).not.toContain("🌳 🛡️");
	});

	it("lists the location's exits — charted neighbours and uncharted frontiers", async () => {
		engine.setCharacter(MockWorldEngine.defaultCharacter({ location: "The Warden's Oak" }));
		engine.setLocation({
			name: "The Warden's Oak", description: "The oak.", tags: ["oak"], isSafe: true, emoji: "🌳",
		});
		engine.setExits({
			neighbours: [{ name: "Town Square", direction: "N", difficulty: 1 }],
			frontiers: [{ direction: "E", teaser: "the road to the eastern town", difficulty: 2 }],
		});

		const handler = makeHandler(engine, lookupSceneFn(scenes));
		const result = await handler({ user: { id: "user-1" } } as never);

		expect(result).toContain("🧭 Paths");
		// Difficulty leads, the compass arrow (no letter / → arrow), then the destination's own
		// glyph + safety. (The mock returns one location for any name, so the glyph is the Oak's.)
		expect(result).toContain("🚶 ⬆️ 🌳🛡️ Town Square");
		expect(result).toContain("🏃 ➡️ *uncharted* — _the road to the eastern town_");
		expect(result).not.toMatch(/⬆️ N\b/); // no direction letter
	});

	it("orders paths clockwise from north (N, E, S, W)", async () => {
		engine.setCharacter(MockWorldEngine.defaultCharacter({ location: "The Warden's Oak" }));
		engine.setLocation({ name: "The Warden's Oak", description: "The oak.", tags: ["oak"], isSafe: true, emoji: "🌳" });
		engine.setExits({
			neighbours: [
				{ name: "Westward", direction: "W", difficulty: 1 },
				{ name: "Southward", direction: "S", difficulty: 1 },
				{ name: "Eastward", direction: "E", difficulty: 1 },
				{ name: "Northward", direction: "N", difficulty: 1 },
			],
			frontiers: [],
		});

		const handler = makeHandler(engine, lookupSceneFn(scenes));
		const result = await handler({ user: { id: "user-1" } } as never);
		const order = ["Northward", "Eastward", "Southward", "Westward"].map((n) => result.indexOf(n));
		expect(order).toEqual([...order].sort((a, b) => a - b)); // strictly increasing → N,E,S,W
	});

	it("falls back to unknown scene when location tags match nothing", async () => {
		engine.setCharacter(
			MockWorldEngine.defaultCharacter({ location: "The Void" }),
		);
		engine.setLocation({
			name: "The Void",
			description: "Nothingness.",
			tags: ["void", "nothing"],
			isSafe: false,
		});

		const handler = makeHandler(engine, lookupSceneFn(scenes));
		const result = await handler({ user: { id: "user-1" } } as never);

		expect(result).toContain("The Void");
		expect(result).toContain("Nothingness.");
		expect(result).toContain(". . ."); // unknown ascii
	});

	it("returns error when location not found in engine", async () => {
		engine.setCharacter(
			MockWorldEngine.defaultCharacter({ location: "Nowhere" }),
		);
		// Explicitly set null — _locationSet flag ensures getLocation returns null,
		// not the old mock default.
		engine.setLocation(null);

		const handler = makeHandler(engine, lookupSceneFn(scenes));
		const result = await handler({ user: { id: "user-1" } } as never);
		expect(result).toContain("lost");
	});

	it("shows safe indicator when location is safe", async () => {
		engine.setCharacter(MockWorldEngine.defaultCharacter({}));
		engine.setLocation({
			name: "The Warden's Oak",
			description: "Safe haven.",
			tags: ["oak", "sanctuary"],
			isSafe: true,
		});

		const handler = makeHandler(engine, lookupSceneFn(scenes));
		const result = await handler({ user: { id: "user-1" } } as never);

		expect(result).toContain("safe");
	});

	it("shows unsafe indicator for unsafe locations", async () => {
		engine.setCharacter(
			MockWorldEngine.defaultCharacter({ location: "Dark Forest" }),
		);
		engine.setLocation({
			name: "Dark Forest",
			description: "Dark and dangerous.",
			tags: ["forest", "dark", "dangerous"],
			isSafe: false,
		});

		const handler = makeHandler(engine, lookupSceneFn(scenes));
		const result = await handler({ user: { id: "user-1" } } as never);

		expect(result).toContain("⚠️");
		expect(result).toContain("unsafe");
		expect(result).not.toContain("🛡️");
	});

	describe("nearby entities", () => {
		it("shows nearby PCs and NPCs", async () => {
			engine.setCharacter(
				MockWorldEngine.defaultCharacter({ location: "The Warden's Oak", id: 1 }),
			);
			engine.setLocation({
				name: "The Warden's Oak",
				description: "Safe haven.",
				tags: ["oak", "sanctuary"],
				isSafe: true,
			});
			engine.setNearbyEntities([
				{ name: "Petrus", classOrType: "Priest", description: null, isPlayer: true },
				{ name: "Oom", classOrType: "Ranger", description: null, isPlayer: true },
				{ name: "Elder Bram", classOrType: "Herbalist", description: "A bent old man.", isPlayer: false },
				{ name: "Grey Wolf", classOrType: "Beast", description: "A massive she-wolf.", isPlayer: false },
			]);

			const handler = makeHandler(engine, lookupSceneFn(scenes));
			const result = await handler({ user: { id: "user-1" } } as never);

			// PCs highlighted
			expect(result).toContain("**Petrus** — Priest");
			expect(result).toContain("**Oom** — Ranger");
			// NPCs with emoji and description
			expect(result).toContain("**Elder Bram**");
			expect(result).toContain("_A bent old man._");
			expect(result).toContain("**Grey Wolf**");
			expect(result).toContain("_A massive she-wolf._");
		});

		it("shows nothing when no entities nearby", async () => {
			engine.setCharacter(
				MockWorldEngine.defaultCharacter({ location: "The Void", id: 1 }),
			);
			engine.setLocation({
				name: "The Void",
				description: "Nothingness.",
				tags: ["void"],
				isSafe: false,
			});
			engine.setNearbyEntities([]);

			const handler = makeHandler(engine, lookupSceneFn(scenes));
			const result = await handler({ user: { id: "user-1" } } as never);

			expect(result).not.toContain("Nearby");
			expect(result).not.toContain("Adventurers");
			expect(result).not.toContain("Figures");
		});
	});
});
