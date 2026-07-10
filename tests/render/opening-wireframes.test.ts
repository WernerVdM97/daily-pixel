import { describe, it, expect } from "vitest";
import { loadAsciiFile } from "../../src/assets/ascii-loader.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The opening-frame wireframes are canonical monochrome mocks the renderer is
// coded against (TODO "ANSI frame polish" §B). They are not loaded at runtime,
// so this test is their contract: one per classified action type, a proper box,
// and — the whole point of a wireframe — every body line exactly 30 wide so the
// mock and the renderer's output share one width invariant.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIREFRAME_DIR = path.join(__dirname, "..", "..", "assets", "ansi", "wireframes");

// Every classify.md action type must have an opening frame to show after
// routing and before the first decision.
const CLASSIFIED_TYPES = ["combat", "travel", "social", "skill", "search", "rest", "other"];

const FRAME_WIDTH = 30;

// Each classified type ships two width-validated files: the filled example and
// the slot template (the generic grid with [slot] placeholders).
const VARIANTS = [
  { suffix: ".ascii", label: "example" },
  { suffix: ".slots.ascii", label: "slot template" },
];

describe("opening-frame wireframes", () => {
  it("has an example and a slot template per classified action type", () => {
    for (const type of CLASSIFIED_TYPES) {
      for (const v of VARIANTS) {
        const file = path.join(WIREFRAME_DIR, `opening-${type}${v.suffix}`);
        expect(fs.existsSync(file), `missing ${v.label} for '${type}'`).toBe(true);
      }
    }
  });

  for (const type of CLASSIFIED_TYPES) {
    for (const v of VARIANTS) {
      describe(`opening-${type} (${v.label})`, () => {
        const { tags, body } = loadAsciiFile(path.join(WIREFRAME_DIR, `opening-${type}${v.suffix}`));
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

        it("carries the 'opening' and type tags", () => {
          expect(tags).toContain("opening");
          expect(tags).toContain(type);
        });
      });
    }
  }
});
