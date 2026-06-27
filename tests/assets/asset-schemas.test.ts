import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  loadAndValidate,
  validateStatDef,
  validateAlignment,
  validateDayJob,
  validateItemSet,
  validateReleaseNotes,
  checkItemSetCoverage,
  checkDayJobLocations,
  checkAlignmentUniqueness,
  checkEdgeReferences,
  validateLocationSeed,
  validateEdgeSeed,
  STATS,
} from "../../src/assets/asset-schemas.js";
import { computeStats, type ClassDef, type ModifierDef } from "../../src/engine/StatComputer.js";
import { SEEDED_LOCATIONS, SEEDED_EDGES } from "../../src/db/migrate.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CC = path.join(ROOT, "assets", "char-creation");
const RN = path.join(ROOT, "assets", "release-notes");
const WORLD = path.join(ROOT, "assets", "world");
const cc = (name: string) => path.join(CC, name);
const world = (name: string) => path.join(WORLD, name);

// ── T1 · the real shipped files satisfy their schema ──
describe("T1 — real asset files satisfy their schema", () => {
  it("classes.yml", () => expect(() => loadAndValidate(cc("classes.yml"), validateStatDef)).not.toThrow());
  it("backgrounds.yml", () => expect(() => loadAndValidate(cc("backgrounds.yml"), validateStatDef)).not.toThrow());
  it("races.yml", () => expect(() => loadAndValidate(cc("races.yml"), validateStatDef)).not.toThrow());
  it("alignments.yml", () => expect(() => loadAndValidate(cc("alignments.yml"), validateAlignment)).not.toThrow());
  it("day-jobs.yml", () => expect(() => loadAndValidate(cc("day-jobs.yml"), validateDayJob)).not.toThrow());
  it("item-sets.yml", () => expect(() => loadAndValidate(cc("item-sets.yml"), validateItemSet)).not.toThrow());
  it("world/locations.yml", () => expect(() => loadAndValidate(world("locations.yml"), validateLocationSeed)).not.toThrow());
  it("world/edges.yml", () => expect(() => loadAndValidate(world("edges.yml"), validateEdgeSeed)).not.toThrow());
});

// ── T2 · every class/background/race carries all four integer stat modifiers ──
describe("T2 — modifier completeness", () => {
  for (const f of ["classes.yml", "backgrounds.yml", "races.yml"]) {
    it(`${f}: all four integer stat keys on every entry`, () => {
      const rows = loadAndValidate<ModifierDef>(cc(f), validateStatDef);
      for (const r of rows) {
        for (const s of STATS) {
          expect(Number.isInteger(r.modifiers[s]), `${f} "${r.name}" ${s}`).toBe(true);
        }
      }
    });
  }
});

// ── T3 · the killer test: computeStats finite for every combination ──
describe("T3 — computeStats yields finite integers for every class×background×race", () => {
  it("all combinations", () => {
    const classes = loadAndValidate<ClassDef>(cc("classes.yml"), validateStatDef);
    const bgs = loadAndValidate<ModifierDef>(cc("backgrounds.yml"), validateStatDef);
    const races = loadAndValidate<ModifierDef>(cc("races.yml"), validateStatDef);

    for (const cls of classes) {
      for (const bg of bgs) {
        for (const race of races) {
          const stats = computeStats(cls.name, bg.name, race.name, classes, bgs, races);
          for (const s of STATS) {
            expect(Number.isInteger(stats[s]), `${cls.name}/${bg.name}/${race.name} ${s}=${stats[s]}`).toBe(true);
          }
        }
      }
    }
  });
});

// ── T4 · cross-file integrity ──
describe("T4 — cross-file integrity", () => {
  it("every kit maps to known classes and every class has a kit", () => {
    const classes = loadAndValidate<ClassDef>(cc("classes.yml"), validateStatDef);
    const itemSets = loadAndValidate<{ name: string; for_classes: string[] }>(cc("item-sets.yml"), validateItemSet);
    expect(checkItemSetCoverage(itemSets, classes.map((c) => c.name))).toEqual([]);
  });

  it("day-job workplace_location is null or a seeded location", () => {
    const dayJobs = loadAndValidate<{ name: string; workplace_location?: string | null }>(cc("day-jobs.yml"), validateDayJob);
    expect(checkDayJobLocations(dayJobs, SEEDED_LOCATIONS.map((l) => l.name))).toEqual([]);
  });

  it("alignment law×moral cells are unique", () => {
    const alignments = loadAndValidate<{ name: string; axis: [string, string] }>(cc("alignments.yml"), validateAlignment);
    expect(checkAlignmentUniqueness(alignments)).toEqual([]);
  });

  it("every edge endpoint is a seeded location and (from, direction) is unique", () => {
    expect(checkEdgeReferences(SEEDED_EDGES, SEEDED_LOCATIONS.map((l) => l.name))).toEqual([]);
  });
});

// ── T5 · release-notes sweep (every file, tag == filename) ──
describe("T5 — release notes", () => {
  const files = fs.readdirSync(RN).filter((f) => f.endsWith(".yml"));

  it("ships at least one release-notes file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f} is valid and its tag matches the filename`, () => {
      const obj = yaml.load(fs.readFileSync(path.join(RN, f), "utf-8"));
      const expectedTag = f.replace(/\.yml$/, "");
      expect(validateReleaseNotes(obj, expectedTag)).toEqual([]);
    });
  }
});

// ── golden counts: adding/removing an option is a deliberate, reviewed diff ──
describe("golden entry counts", () => {
  const expected: Record<string, number> = {
    "classes.yml": 5,
    "backgrounds.yml": 12,
    "races.yml": 7,
    "alignments.yml": 9,
    "day-jobs.yml": 9,
    "item-sets.yml": 9,
  };
  for (const [f, n] of Object.entries(expected)) {
    it(`${f} has ${n} entries`, () => {
      const rows = yaml.load(fs.readFileSync(cc(f), "utf-8")) as unknown[];
      expect(rows.length).toBe(n);
    });
  }
});

// ── the validators reject bad data (not just accept good data) ──
describe("validators reject malformed entries", () => {
  it("flags a background missing a stat key (the original NaN bug)", () => {
    const bad = { name: "Broken", description: "x", modifiers: { physical: 1, wisdom: 0, intelligence: 0 } };
    const problems = validateStatDef(bad, 0);
    expect(problems.some((p) => p.includes("charisma"))).toBe(true);
  });

  it("flags an entry missing its emoji", () => {
    const bad = { name: "Glyphless", description: "x", modifiers: { physical: 1, wisdom: 0, intelligence: 0, charisma: 0 } };
    expect(validateStatDef(bad, 0).some((p) => p.includes("emoji"))).toBe(true);
  });

  it("loadAndValidate throws AssetSchemaError naming file + field", () => {
    expect(() => loadAndValidate(cc("classes.yml"), () => ["forced problem"])).toThrow(/forced problem/);
  });

  it("flags a release-notes tag that disagrees with the filename", () => {
    const obj = { tag: "v9.9.9", title: "t", highlights: ["h"] };
    expect(validateReleaseNotes(obj, "v0.2.4").some((p) => p.includes("filename"))).toBe(true);
  });
});
