import { describe, it, expect } from "vitest";
import { loadAsciiFile } from "../../src/assets/ascii-loader.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The combat continue/terminal wireframes are canonical monochrome mocks the
// round-maths dice-line frame code is coded against (ANSI-D "mocks first",
// docs/engine/poc-plus-0.3.1-polish-plan.md). Sibling to
// opening-wireframes.test.ts: same width invariant, different file family
// (these aren't OPENING-register frames, so they don't carry the "opening" tag).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIREFRAME_DIR = path.join(__dirname, "..", "..", "assets", "ansi", "wireframes");

// The two combat-round card types this block mocks: the between-decisions
// status (every round) and the fight-over data card (once, at the end).
const ROUND_TYPES = ["continue", "terminal"];

const FRAME_WIDTH = 30;

// Each type ships two width-validated files: the filled example and the slot
// template (the generic grid with [slot] placeholders).
const VARIANTS = [
  { suffix: ".ascii", label: "example" },
  { suffix: ".slots.ascii", label: "slot template" },
];

describe("combat-round wireframes", () => {
  it("has an example and a slot template per combat-round card type", () => {
    for (const type of ROUND_TYPES) {
      for (const v of VARIANTS) {
        const file = path.join(WIREFRAME_DIR, `combat-${type}${v.suffix}`);
        expect(fs.existsSync(file), `missing ${v.label} for '${type}'`).toBe(true);
      }
    }
  });

  for (const type of ROUND_TYPES) {
    for (const v of VARIANTS) {
      describe(`combat-${type} (${v.label})`, () => {
        const { tags, body } = loadAsciiFile(path.join(WIREFRAME_DIR, `combat-${type}${v.suffix}`));
        const lines = body.split("\n");

        it("keeps every body line exactly 30 chars wide", () => {
          const bad = lines
            .map((l, i) => ({ i, len: l.length }))
            .filter((x) => x.len !== FRAME_WIDTH);
          expect(bad, `off-width lines: ${JSON.stringify(bad)}`).toEqual([]);
        });

        it("is a closed box (border rows top and bottom)", () => {
          const border = "+" + "-".repeat(FRAME_WIDTH - 2) + "+";
          expect(lines[0]).toBe(border);
          expect(lines[lines.length - 1]).toBe(border);
        });

        it("carries the 'combat' and type tags", () => {
          expect(tags).toContain("combat");
          expect(tags).toContain(type);
        });
      });
    }
  }
});
