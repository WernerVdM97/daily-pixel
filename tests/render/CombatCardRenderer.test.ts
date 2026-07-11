import { describe, it, expect } from "vitest";
import { renderCombatTerminalCard, type CombatTerminalCard } from "../../src/render/CombatCardRenderer.js";
import { PALETTES } from "../../src/render/AnsiRenderer.js";

const stripSgr = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const FRAME_WIDTH = 30;
const INTERIOR_WIDTH = 28;

function winCard(overrides: Partial<CombatTerminalCard> = {}): CombatTerminalCard {
  return {
    label: "COMBAT RESOLVED",
    playerD20: 16,
    bonus: 4,
    total: 20,
    dc: 15,
    marker: "+",
    verdict: "WIN",
    margin: 5,
    flavour: "The GLOOMFANG collapses.",
    ...overrides,
  };
}

describe("CombatCardRenderer", () => {
  describe("width invariant (mirrors AnsiRenderer.test.ts / OpeningFrameRenderer.test.ts)", () => {
    it("keeps every interior line at exactly 28 visible chars (win card)", () => {
      const rendered = renderCombatTerminalCard(winCard());
      const lines = rendered.split("\n");
      for (const line of lines) {
        if (line === "```ansi" || line === "```") continue;
        expect(stripSgr(line).length).toBe(FRAME_WIDTH);
      }
    });

    it("keeps every interior line at exactly 28 visible chars (loss card)", () => {
      const rendered = renderCombatTerminalCard(winCard({ marker: "x", verdict: "LOSS", margin: -9 }));
      const lines = rendered.split("\n");
      for (const line of lines) {
        if (line === "```ansi" || line === "```") continue;
        expect(stripSgr(line).length).toBe(FRAME_WIDTH);
      }
    });

    it("still fits exactly 30 wide with a long flavour line (truncated, not overflowed)", () => {
      const rendered = renderCombatTerminalCard(winCard({ flavour: "X".repeat(60) }));
      const lines = rendered.split("\n").filter((l) => l !== "```ansi" && l !== "```");
      for (const line of lines) {
        expect(stripSgr(line).length).toBe(FRAME_WIDTH);
      }
    });

    it("stays width-correct with double-digit dc/margin and a two-digit d20", () => {
      const rendered = renderCombatTerminalCard(winCard({ playerD20: 11, bonus: -2, total: 9, dc: 18, margin: -3 }));
      const lines = rendered.split("\n").filter((l) => l !== "```ansi" && l !== "```");
      for (const line of lines) {
        expect(stripSgr(line).length).toBe(FRAME_WIDTH);
      }
    });
  });

  describe("frame structure", () => {
    it("begins with the ansi fence and ends with the closing fence", () => {
      const rendered = renderCombatTerminalCard(winCard());
      expect(rendered.startsWith("```ansi\n")).toBe(true);
      expect(rendered.endsWith("\n```")).toBe(true);
    });

    it("embeds real ESC bytes, not the literal text \\033", () => {
      const rendered = renderCombatTerminalCard(winCard());
      expect(rendered).toContain("\x1b[");
      expect(rendered).not.toContain("\\033");
    });

    it("is a closed box (border rows top and bottom) with exactly 6 content lines", () => {
      const rendered = renderCombatTerminalCard(winCard());
      const mono = stripSgr(rendered);
      const lines = mono.split("\n").filter((l) => l !== "```ansi" && l !== "```");
      const border = "+" + "-".repeat(INTERIOR_WIDTH) + "+";
      expect(lines[0]).toBe(border);
      expect(lines[lines.length - 1]).toBe(border);
      expect(lines.length).toBe(8); // 2 borders + 6 content lines
    });
  });

  describe("content", () => {
    it("shows the label, focal roll, calc, dc, marker/verdict, margin and flavour", () => {
      const rendered = renderCombatTerminalCard(winCard());
      const mono = stripSgr(rendered);
      expect(mono).toContain("COMBAT RESOLVED");
      expect(mono).toContain("16");
      expect(mono).toContain("d20");
      expect(mono).toContain("+4 = 20");
      expect(mono).toContain("vs DC 15");
      expect(mono).toContain("+ WIN");
      expect(mono).toContain("margin +5");
      expect(mono).toContain("The GLOOMFANG collapses.");
    });

    it("signs a negative bonus and a negative margin correctly", () => {
      const rendered = renderCombatTerminalCard(winCard({ bonus: -2, total: 9, margin: -3, marker: "x", verdict: "LOSS" }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("-2 = 9");
      expect(mono).toContain("margin -3");
    });

    it("shows the x marker and LOSS verdict for a loss card", () => {
      const rendered = renderCombatTerminalCard(winCard({ marker: "x", verdict: "LOSS", margin: -9 }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("x LOSS");
    });

    it("never emits a dingbat marker — ASCII '+'/'x' only", () => {
      const winRendered = stripSgr(renderCombatTerminalCard(winCard()));
      const lossRendered = stripSgr(renderCombatTerminalCard(winCard({ marker: "x", verdict: "LOSS" })));
      expect(winRendered).not.toMatch(/[✓✗✔✘]/);
      expect(lossRendered).not.toMatch(/[✓✗✔✘]/);
    });
  });

  describe("colour role usage (palette-first — house is the default and only palette needed)", () => {
    it("colours the focal d20 with the warmth role", () => {
      const rendered = renderCombatTerminalCard(winCard());
      expect(rendered).toContain(`\x1b[${PALETTES.house.sgr.warmth}m16\x1b[0m`);
    });

    it("colours a win marker+verdict with the life role", () => {
      const rendered = renderCombatTerminalCard(winCard());
      expect(rendered).toContain(`\x1b[${PALETTES.house.sgr.life}m+ WIN\x1b[0m`);
    });

    it("colours a loss marker+verdict with the threat role", () => {
      const rendered = renderCombatTerminalCard(winCard({ marker: "x", verdict: "LOSS" }));
      expect(rendered).toContain(`\x1b[${PALETTES.house.sgr.threat}mx LOSS\x1b[0m`);
    });

    it("defaults to the house palette when no palette argument is given", () => {
      const withDefault = renderCombatTerminalCard(winCard());
      const withExplicitHouse = renderCombatTerminalCard(winCard(), PALETTES.house);
      expect(withDefault).toBe(withExplicitHouse);
    });

    it("a non-default palette changes the emitted SGR codes but not the monochrome content", () => {
      const houseRendered = renderCombatTerminalCard(winCard(), PALETTES.house);
      const gloomRendered = renderCombatTerminalCard(winCard(), PALETTES.gloom);
      expect(gloomRendered).not.toBe(houseRendered);
      expect(stripSgr(gloomRendered)).toBe(stripSgr(houseRendered));
    });
  });

  describe("code fence integrity against caller-supplied text", () => {
    it("neutralizes a backtick in a caller-supplied flavour line so only the real fence markers survive", () => {
      const rendered = renderCombatTerminalCard(winCard({ flavour: "```GLOOM@everyone" }));
      const fenceMatches = rendered.match(/```/g) ?? [];
      expect(fenceMatches.length).toBe(2);
      const body = rendered.slice("```ansi\n".length, rendered.length - "\n```".length);
      expect(body).not.toContain("`");
    });
  });

  describe("char budget", () => {
    it("renders (coloured, fenced) well under 2000 chars", () => {
      const rendered = renderCombatTerminalCard(winCard());
      expect(rendered.length).toBeLessThan(2000);
    });
  });
});
