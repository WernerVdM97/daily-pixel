import { describe, it, expect } from "vitest";
import { TagResolver } from "../../src/scenes/TagResolver.js";
import type { SceneFile } from "../../src/scenes/SceneLoader.js";

function s(tags: string[]): SceneFile {
	return { tags, body: "mock body" };
}

describe("TagResolver", () => {
	it("picks the scene with the highest tag overlap", () => {
		const scenes = new Map<string, SceneFile>([
			["tavern", s(["tavern", "interior", "fire"])],
			["forest", s(["forest", "trees", "dark"])],
			["bridge", s(["bridge", "crossing", "river"])],
		]);

		const resolver = new TagResolver(scenes);

		expect(resolver.resolve(["forest", "trees", "dark"])).toBe("forest");
		expect(resolver.resolve(["tavern", "fire", "food"])).toBe("tavern");
		expect(resolver.resolve(["bridge", "river", "stone"])).toBe("bridge");
	});

	it("returns the first match on tie in overlap score", () => {
		const scenes = new Map<string, SceneFile>([
			["forest_dense", s(["forest", "dense", "dark"])],
			["forest_edge", s(["forest", "edge", "light"])],
		]);
		const resolver = new TagResolver(scenes);

		// Both scenes overlap on 'forest' (score 1 each)
		expect(resolver.resolve(["forest", "exploring"])).toBe("forest_dense");
	});

	it("falls back to unknown when no tags match", () => {
		const scenes = new Map<string, SceneFile>([
			["tavern", s(["tavern", "interior", "fire"])],
			["bridge", s(["bridge", "crossing", "river"])],
		]);
		const resolver = new TagResolver(scenes);

		expect(resolver.resolve(["desert", "sand", "heat"])).toBe("unknown");
	});

	it('falls back to unknown when scenes map has no unknown entry (returns "unknown" string)', () => {
		const scenes = new Map<string, SceneFile>([
			["tavern", s(["tavern", "interior"])],
		]);
		const resolver = new TagResolver(scenes);

		expect(resolver.resolve(["ocean", "waves"])).toBe("unknown");
	});

	it("handles empty location tags", () => {
		const scenes = new Map<string, SceneFile>([
			["tavern", s(["tavern", "interior"])],
			["unknown", s(["unknown", "generic", "wilderness"])],
		]);
		const resolver = new TagResolver(scenes);

		expect(resolver.resolve([])).toBe("unknown");
	});

	it("matches single tag when only one overlap exists", () => {
		const scenes = new Map<string, SceneFile>([
			["tavern", s(["tavern", "interior", "drink"])],
			["bridge", s(["bridge", "river", "stone"])],
			["road", s(["road", "travel", "open"])],
		]);
		const resolver = new TagResolver(scenes);

		// Only 'river' matches bridge
		expect(resolver.resolve(["river", "bank", "mud"])).toBe("bridge");
	});

	it("is case-sensitive (tags must match exactly)", () => {
		const scenes = new Map<string, SceneFile>([
			["tavern", s(["Tavern"])], // capital T
		]);
		const resolver = new TagResolver(scenes);
		// Lowercase 'tavern' doesn't match uppercase 'Tavern'
		expect(resolver.resolve(["tavern"])).toBe("unknown");
	});

	it("handles partial matches correctly (tag is not a substring match)", () => {
		const scenes = new Map<string, SceneFile>([
			["forest", s(["forest", "trees", "dark"])],
		]);
		const resolver = new TagResolver(scenes);

		// 'fore' is not 'forest'
		expect(resolver.resolve(["fore", "log"])).toBe("unknown");
	});
});
