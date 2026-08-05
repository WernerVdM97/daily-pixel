import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadYamlFile } from "../../src/assets/yaml-loader.js";
import { buildStepOptions, type CharDefs } from "../../src/controller/joinWizard.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "char-creation");

const defs: CharDefs = {
  classes: loadYamlFile(path.join(DIR, "classes.yml")) as CharDefs["classes"],
  backgrounds: loadYamlFile(path.join(DIR, "backgrounds.yml")) as CharDefs["backgrounds"],
  races: loadYamlFile(path.join(DIR, "races.yml")) as CharDefs["races"],
  alignments: loadYamlFile(path.join(DIR, "alignments.yml")) as CharDefs["alignments"],
  dayJobs: loadYamlFile(path.join(DIR, "day-jobs.yml")) as CharDefs["dayJobs"],
  itemSets: loadYamlFile(path.join(DIR, "item-sets.yml")) as CharDefs["itemSets"],
};

const names = (step: number) => buildStepOptions(step, defs).map(o => o.label);

describe("join wizard options are data-driven (no YAML option dropped)", () => {
  it("offers every class from YAML", () => {
    expect(names(2)).toEqual(defs.classes.map(d => d.name));
  });

  it("offers every upbringing — including the ones the old hardcoded list dropped", () => {
    expect(names(3)).toEqual(defs.backgrounds.map(d => d.name));
    expect(names(3)).toEqual(expect.arrayContaining(["Artisan", "Farmstead", "Temple-Raised", "Urchin", "Entertainer", "Scout"]));
  });

  it("offers every race — including Half-Elf, Half-Orc, Dúnedain", () => {
    expect(names(4)).toEqual(defs.races.map(d => d.name));
    expect(names(4)).toEqual(expect.arrayContaining(["Half-Elf", "Half-Orc", "Dúnedain"]));
  });

  it("offers every alignment, with lowercase persisted values", () => {
    expect(names(5)).toEqual(defs.alignments.map(d => d.name));
    expect(buildStepOptions(5, defs).map(o => o.value)).toContain("lawful good");
  });

  it("offers every day job — including Wanderer", () => {
    expect(names(6)).toEqual(defs.dayJobs.map(d => d.name));
    expect(names(6)).toContain("Wanderer");
  });

  it("filters starting kits by the chosen class", () => {
    const ranger = buildStepOptions(7, defs, "Ranger");
    expect(ranger.length).toBeGreaterThan(0);
    expect(ranger.every(o => o.emoji === "🎒")).toBe(true);
  });

  it("every option carries a non-empty description and an emoji", () => {
    for (const step of [2, 3, 4, 5, 6]) {
      for (const opt of buildStepOptions(step, defs)) {
        expect(opt.description.length, `${opt.label} description`).toBeGreaterThan(0);
        expect(opt.emoji.length, `${opt.label} emoji`).toBeGreaterThan(0);
      }
    }
  });
});
