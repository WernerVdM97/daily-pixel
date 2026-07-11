import { describe, it, expect } from "vitest";
import { renderOpeningFrame, type OpeningActionType, type OpeningFrameSlots } from "../../src/render/OpeningFrameRenderer.js";
import { PALETTES } from "../../src/render/AnsiRenderer.js";

const stripSgr = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Every classified action type gets an opening frame (classification framework §3.0's OPENING
// table) — mirrors CLASSIFIED_TYPES in tests/render/opening-wireframes.test.ts.
const TYPES: OpeningActionType[] = ["combat", "travel", "social", "skill", "search", "rest", "other"];

const FRAME_WIDTH = 30;

function richSlots(): OpeningFrameSlots {
  return {
    pcName: "Aldric",
    pcHp: 24,
    pcMaxHp: 30,
    locationName: "Oakhollow",
    locationEmoji: "\u{1F332}", // deliberately an emoji — must never leak into the fenced body
    sceneHint: "forage the treeline",
    enemyName: "Gloomfang",
  };
}

describe("OpeningFrameRenderer", () => {
  describe("width invariant (constraint 1, mirrors AnsiRenderer.test.ts)", () => {
    for (const type of TYPES) {
      it(`keeps every content line at exactly 30 visible chars for '${type}' (no slots)`, () => {
        const rendered = renderOpeningFrame(type);
        const lines = rendered.split("\n");
        for (const line of lines) {
          if (line === "```ansi" || line === "```") continue;
          expect(stripSgr(line).length).toBe(FRAME_WIDTH);
        }
      });

      it(`keeps every content line at exactly 30 visible chars for '${type}' (full slots)`, () => {
        const rendered = renderOpeningFrame(type, richSlots());
        const lines = rendered.split("\n");
        for (const line of lines) {
          if (line === "```ansi" || line === "```") continue;
          expect(stripSgr(line).length).toBe(FRAME_WIDTH);
        }
      });
    }

    it("still fits exactly 30 wide with a long enemy/pc/location name (truncated, not overflowed)", () => {
      const rendered = renderOpeningFrame("combat", {
        pcName: "A".repeat(60),
        enemyName: "B".repeat(60),
        pcHp: 3,
        pcMaxHp: 999,
      });
      const lines = rendered.split("\n").filter((l) => l !== "```ansi" && l !== "```");
      for (const line of lines) {
        expect(stripSgr(line).length).toBe(FRAME_WIDTH);
      }
    });
  });

  describe("char budget (constraint 2, mirrors AnsiRenderer.test.ts)", () => {
    for (const type of TYPES) {
      it(`renders '${type}' (coloured, fenced) under 2000 chars`, () => {
        const rendered = renderOpeningFrame(type, richSlots());
        expect(rendered.length).toBeLessThan(2000);
      });
    }
  });

  describe("frame structure", () => {
    for (const type of TYPES) {
      it(`'${type}' begins with the ansi fence and ends with the closing fence`, () => {
        const rendered = renderOpeningFrame(type);
        expect(rendered.startsWith("```ansi\n")).toBe(true);
        expect(rendered.endsWith("\n```")).toBe(true);
      });

      it(`'${type}' embeds real ESC bytes, not the literal text \\033`, () => {
        const rendered = renderOpeningFrame(type, richSlots());
        expect(rendered).toContain("\x1b[");
        expect(rendered).not.toContain("\\033");
      });

      it(`'${type}' is a closed box (border rows top and bottom)`, () => {
        const rendered = renderOpeningFrame(type);
        const mono = stripSgr(rendered);
        const lines = mono.split("\n").filter((l) => l !== "```ansi" && l !== "```");
        // Box-drawing borders (redesign): ┌──┐ top, └──┘ bottom.
        expect(lines[0]).toContain('┌');
        expect(lines[0]).toContain('┐');
        expect(lines[lines.length - 1]).toContain('└');
        expect(lines[lines.length - 1]).toContain('┘');
        expect(lines[0].length).toBe(30);
        expect(lines[lines.length - 1].length).toBe(30);
      });
    }
  });

  describe("single-width glyph safety", () => {
    it("never emits a raw emoji into the frame body even when locationEmoji is supplied", () => {
      const rendered = renderOpeningFrame("travel", richSlots());
      const mono = stripSgr(rendered);
      expect(mono).not.toContain("\u{1F332}");
    });

    it("does not leak locationEmoji into any other type's frame either", () => {
      for (const type of TYPES) {
        const rendered = renderOpeningFrame(type, richSlots());
        expect(stripSgr(rendered)).not.toContain("\u{1F332}");
      }
    });
  });

  describe("code fence integrity against caller-supplied text", () => {
    it("neutralizes a backtick in a caller-supplied enemy name so only the real fence markers survive", () => {
      const rendered = renderOpeningFrame("combat", { enemyName: "```GLOOM@everyone" });
      const fenceMatches = rendered.match(/```/g) ?? [];
      expect(fenceMatches.length).toBe(2);
      const body = rendered.slice("```ansi\n".length, rendered.length - "\n```".length);
      expect(body).not.toContain("`");
    });

    it("neutralizes a backtick in a caller-supplied pc name", () => {
      const rendered = renderOpeningFrame("combat", { pcName: "`Aldric`" });
      const fenceMatches = rendered.match(/```/g) ?? [];
      expect(fenceMatches.length).toBe(2);
    });

    it("neutralizes a backtick in a caller-supplied location name", () => {
      const rendered = renderOpeningFrame("travel", { locationName: "`Oakhollow`" });
      const fenceMatches = rendered.match(/```/g) ?? [];
      expect(fenceMatches.length).toBe(2);
    });

    it("social's own static art (a literal backtick in the placeholder bust) never breaks the fence", () => {
      // opening-social.ascii's bust art includes a literal backtick glyph (the chin line);
      // this asserts the composer sanitizes its OWN static content, not just caller input.
      const rendered = renderOpeningFrame("social");
      const fenceMatches = rendered.match(/```/g) ?? [];
      expect(fenceMatches.length).toBe(2);
    });
  });

  describe("content sanity per type", () => {
    it("combat shows an honest placeholder foe when no enemyName is supplied", () => {
      const rendered = renderOpeningFrame("combat");
      const mono = stripSgr(rendered);
      expect(mono).toContain("Unknown foe");
      expect(mono).toContain("?/?");
    });

    it("combat shows the real enemy name when supplied", () => {
      const rendered = renderOpeningFrame("combat", { enemyName: "Gloomfang" });
      const mono = stripSgr(rendered);
      expect(mono).toContain("Gloomfang");
    });

    it("combat opening frame names a known foe, not the Unknown-foe fallback (0.3.2 C4 part 1)", () => {
      const rendered = renderOpeningFrame("combat", { enemyName: "Shadow Stag" });
      const mono = stripSgr(rendered);
      expect(mono).toContain("Shadow Stag");
      expect(mono).not.toContain("Unknown foe");
    });

    it("combat re-entry (enemyCondition set) shows the banded wound word + pip bar, never exact HP (0.3.2 C4 part 2)", () => {
      const rendered = renderOpeningFrame("combat", {
        enemyName: "Shadow Stag",
        enemyCondition: { woundWord: "Battered", filled: 1, total: 5 },
      });
      const mono = stripSgr(rendered);
      expect(mono).toContain("Shadow Stag");
      expect(mono).toContain("Battered");
      expect(mono).toContain("▓░░░░");

      // The enemy HP line (identified by the wound word) carries no numeric HP anywhere —
      // banded only. The PC footer line legitimately still shows its own "?/?" placeholder
      // (no pcHp/pcMaxHp slot passed here), so the "no numbers" assertion is scoped to the
      // enemy line, not the whole frame.
      const enemyLine = mono.split("\n").find((l) => l.includes("Battered"));
      expect(enemyLine).toBeDefined();
      expect(enemyLine).not.toContain("?/?");
      expect(enemyLine).not.toMatch(/\d+\/\d+/);

      // Width/border invariants still hold — same frame shape as every other opening frame.
      const lines = rendered.split("\n");
      for (const line of lines) {
        if (line === "```ansi" || line === "```") continue;
        expect(stripSgr(line).length).toBe(FRAME_WIDTH);
      }
    });

    it("combat with no enemyCondition (fresh fight) renders byte-identical to the pre-C4 placeholder output", () => {
      const withoutCondition = renderOpeningFrame("combat", { enemyName: "Shadow Stag" });
      const mono = stripSgr(withoutCondition);
      // Exactly today's placeholder vocabulary — no band leaks in when enemyCondition is absent.
      expect(mono).toContain("?/?");
      expect(mono).not.toContain("Battered");
      expect(mono).not.toContain("Bloodied");
      expect(mono).not.toContain("Critical");
      expect(mono).not.toContain("▓");

      // Re-rendering with the exact same slots (no enemyCondition) is deterministic/stable.
      const again = renderOpeningFrame("combat", { enemyName: "Shadow Stag" });
      expect(again).toBe(withoutCondition);
    });

    it("combat shows real PC HP when both pcHp/pcMaxHp are supplied", () => {
      const rendered = renderOpeningFrame("combat", { pcName: "Aldric", pcHp: 24, pcMaxHp: 30 });
      const mono = stripSgr(rendered);
      expect(mono).toContain("Aldric");
      expect(mono).toContain("24/30");
    });

    it("combat falls back to an unknown PC HP suffix when hp/maxHp are omitted", () => {
      const rendered = renderOpeningFrame("combat", { pcName: "Aldric" });
      const mono = stripSgr(rendered);
      expect(mono).toContain("?/?");
    });

    it("combat keeps all three digits of a 3-digit PC HP number intact (regression: adaptive bar sizing)", () => {
      const rendered = renderOpeningFrame("combat", { pcName: "Aldric", pcHp: 100, pcMaxHp: 100 });
      const mono = stripSgr(rendered);
      expect(mono).toContain("100/100");
      expect(mono).not.toContain("100/10 ");
    });

    it("combat keeps all digits of the widest realistic PC HP number intact", () => {
      const rendered = renderOpeningFrame("combat", { pcName: "Aldric", pcHp: 999, pcMaxHp: 999 });
      const mono = stripSgr(rendered);
      expect(mono).toContain("999/999");
    });

    it("combat clamps a negative PC HP to 0 in the displayed suffix, agreeing with the (empty) bar", () => {
      const rendered = renderOpeningFrame("combat", { pcName: "Aldric", pcHp: -5, pcMaxHp: 30 });
      const mono = stripSgr(rendered);
      expect(mono).toContain("0/30");
      expect(mono).not.toContain("-5/30");
    });

    it("travel shows the origin location name and the literal rumoured-destination glyph", () => {
      const rendered = renderOpeningFrame("travel", { locationName: "Oakhollow" });
      const mono = stripSgr(rendered);
      expect(mono).toContain("Oakhollow");
      expect(mono).toContain("????");
    });

    it("travel falls back to a generic origin label when locationName is omitted", () => {
      const rendered = renderOpeningFrame("travel");
      const mono = stripSgr(rendered);
      expect(mono).toContain("Home");
    });

    it("social's frame is mute — carries no distilledType/sceneHint prose, only the static bust", () => {
      const rendered = renderOpeningFrame("social", richSlots());
      const mono = stripSgr(rendered);
      expect(mono).not.toContain("forage the treeline");
    });

    it("search carries the clue glyphs and ground scatter", () => {
      const rendered = renderOpeningFrame("search");
      const mono = stripSgr(rendered);
      expect(mono).toContain("?");
      expect(mono).toContain("Q");
    });

    it("rest carries the sleep glyphs", () => {
      const rendered = renderOpeningFrame("rest");
      const mono = stripSgr(rendered);
      expect(mono).toContain("z Z");
    });

    it("other renders the bare placeholder label", () => {
      const rendered = renderOpeningFrame("other");
      const mono = stripSgr(rendered);
      expect(mono).toContain(". . .");
    });
  });

  describe("colour role usage (palette-first — house is the default and only palette needed)", () => {
    it("rest's sleep glyphs use the 'status' role (magenta 35), distinct from chrome/player/warmth", () => {
      const rendered = renderOpeningFrame("rest", undefined, PALETTES.house);
      // Confirms the 'status' role actually resolves to a distinct SGR code — a typo'd role
      // name would either throw (Record index miss -> undefined -> "undefinedm" in the escape)
      // or silently collapse onto another role's code.
      expect(rendered).toContain(`\x1b[${PALETTES.house.sgr.status}m`);
    });

    it("defaults to the house palette when no palette argument is given", () => {
      const withDefault = renderOpeningFrame("combat", richSlots());
      const withExplicitHouse = renderOpeningFrame("combat", richSlots(), PALETTES.house);
      expect(withDefault).toBe(withExplicitHouse);
    });

    it("a non-default palette changes the emitted SGR codes but not the monochrome content", () => {
      const houseRendered = renderOpeningFrame("combat", richSlots(), PALETTES.house);
      const gloomRendered = renderOpeningFrame("combat", richSlots(), PALETTES.gloom);
      expect(gloomRendered).not.toBe(houseRendered);
      expect(stripSgr(gloomRendered)).toBe(stripSgr(houseRendered));
    });
  });
});
