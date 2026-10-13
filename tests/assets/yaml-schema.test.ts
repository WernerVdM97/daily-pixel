import { describe, it, expect } from "vitest";
import { load } from "js-yaml";
import { loadYamlFile } from "../../src/assets/yaml-loader.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Both loaders parse with js-yaml's *default* schema and never name one, so an upstream change to
// that default retypes every shipped asset silently: numbers become strings, mappings become Maps,
// or a merge key stops merging. These tests pin the schema the game data is read with.
const entry = (block: string): Record<string, unknown> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warden-yaml-schema-"));
  const file = path.join(dir, "probe.yml");
  fs.writeFileSync(file, `- ${block}\n`, "utf-8");
  return loadYamlFile(file)[0] as Record<string, unknown>;
};

describe("the schema the loaders parse with", () => {
  it("resolves core scalars to JS types, and leaves quoted ones alone", () => {
    expect(
      load(
        [
          "physical: 5",
          "wisdom: -2",
          "weight: 1.5",
          "xp: 1e3",
          "hex: 0x1F",
          'label: "5"',
          "alive: true",
          "dead: false",
          "nothing: null",
          "tilde: ~",
          "blank:",
        ].join("\n"),
      ),
    ).toEqual({
      physical: 5,
      wisdom: -2,
      weight: 1.5,
      xp: 1000,
      hex: 31,
      label: "5",
      alive: true,
      dead: false,
      nothing: null,
      tilde: null,
      blank: null,
    });
  });

  it("reads mappings as plain objects and sequences as arrays", () => {
    const parsed = load("entry:\n  tags: [oak, fire]\n") as Record<string, any>;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Array.isArray(parsed.entry.tags)).toBe(true);
    expect(Object.getPrototypeOf(parsed.entry)).toBe(Object.prototype);
  });

  // v4's default schema carried the timestamp tag; v5's core default does not, so an unquoted
  // date stays the string it looks like. Release notes' `date` field depends on that.
  it("keeps an unquoted date-like scalar a string", () => {
    const parsed = load("date: 2026-06-18\nstamp: 2026-06-18T09:00:00Z\n") as Record<string, unknown>;
    expect(parsed).toEqual({ date: "2026-06-18", stamp: "2026-06-18T09:00:00Z" });
  });

  // Also gone from v5's default: `!!merge`, so `<<` is a key like any other rather than a merge.
  // No shipped asset uses one; this fails loudly if one is ever added.
  it("keeps a `<<` key literal rather than merging it", () => {
    expect(entry("base: &base\n    hp: 10\n  child:\n    <<: *base\n    ac: 12")).toEqual({
      base: { hp: 10 },
      child: { "<<": { hp: 10 }, ac: 12 },
    });
  });

  it("rejects an empty source instead of returning undefined", () => {
    expect(() => load("")).toThrow(/empty/);
    expect(() => load("# only a comment\n")).toThrow(/empty/);
  });
});

describe("the loader seam", () => {
  it("hands a stat block back as numbers, which every validator assumes", () => {
    const read = entry("name: Warrior\n  modifiers: { physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }");
    expect(read.modifiers).toEqual({ physical: 3, wisdom: -1, intelligence: 0, charisma: 0 });
  });
});
