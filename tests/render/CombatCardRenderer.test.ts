import { describe, it, expect } from "vitest";
import { renderCombatContinueCard, renderCombatTerminalCard, bandColor, type ContinueCardInput, type CombatTerminalCard } from "../../src/render/CombatCardRenderer.js";
import { BORDERS, PALETTES } from "../../src/render/AnsiRenderer.js";

const stripSgr = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const FRAME_WIDTH = 30;

function winCard(overrides: Partial<CombatTerminalCard> = {}): CombatTerminalCard {
  return {
    label: "COMBAT RESOLVED",
    playerD20: 16,
    bonus: 4,
    total: 20,
    enemyD20: 10,
    enemyBonus: 5,
    marker: "+",
    verdict: "WIN",
    margin: 5,
    band: "GLANCED",
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

    it("still fits exactly 30 wide with a long band name (truncated, not overflowed)", () => {
      const rendered = renderCombatTerminalCard(winCard({ band: "X".repeat(60) }));
      const lines = rendered.split("\n").filter((l) => l !== "```ansi" && l !== "```");
      for (const line of lines) {
        expect(stripSgr(line).length).toBe(FRAME_WIDTH);
      }
    });

    it("stays width-correct with double-digit enemyBonus/margin and a two-digit d20", () => {
      const rendered = renderCombatTerminalCard(winCard({ playerD20: 11, bonus: -2, total: 9, enemyD20: 8, enemyBonus: 12, margin: -3 }));
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
      // Box-drawing borders (redesign): ┌──┐ top, └──┘ bottom.
      expect(lines[0]).toContain('┌');
      expect(lines[lines.length - 1]).toContain('└');
      expect(lines.length).toBe(8); // 2 borders + 6 content lines
    });
  });

  describe("content", () => {
    it("shows the label, contested roll (player vs enemy), verdict, margin and band", () => {
      const rendered = renderCombatTerminalCard(winCard());
      const mono = stripSgr(rendered);
      expect(mono).toContain("COMBAT RESOLVED");
      expect(mono).toContain("16");
      // Combat is a contested roll: show the enemy's dice, not a misleading solo [DC N].
      expect(mono).toContain("vs 10 +5 = 15");
      expect(mono).not.toContain("[DC");
      expect(mono).toContain("+4 = 20");
      expect(mono).toContain("+ WIN");
      expect(mono).toContain("margin +5");
      // Band name replaces the old truncated-prose flavour line (F#22).
      expect(mono).toContain("GLANCED");
      expect(mono).not.toContain("The GLOOMFANG collapses.");
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
    it("neutralizes characters that would break the ansi fence (band line is engine-controlled, but still safe)", () => {
      // flavour is no longer rendered (B#20/F#22), but `band` is — test that the rendered
      // output has exactly 2 opening fence markers and 2 closing ones.
      const rendered = renderCombatTerminalCard(winCard({ band: "GLANCED" }));
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

  describe("continue card", () => {
    function continueInput(overrides: Partial<ContinueCardInput> = {}): ContinueCardInput {
      return {
        enemyName: "GLOOMFANG",
        woundWord: "BRUISED",
        pips: { filled: 3, total: 5 },
        playerHp: 18,
        playerMaxHp: 24,
        playerHpDelta: -3,
        ...overrides,
      };
    }

    it("keeps every line at exactly 30 visible chars with a last round", () => {
      const rendered = renderCombatContinueCard(continueInput({
        lastRound: { d20: 14, bonus: 3, dc: 15, margin: 2, band: "trade" },
      }));
      const lines = rendered.split("\n").filter((l) => l !== "```ansi" && l !== "```");
      for (const line of lines) {
        expect(stripSgr(line).length).toBe(FRAME_WIDTH);
      }
    });

    it("renders HP bars only (no dice readout) when lastRound is absent", () => {
      const rendered = renderCombatContinueCard(continueInput());
      const mono = stripSgr(rendered);
      expect(mono).toContain("GLOOMFANG");
      expect(mono).toContain("YOU");
      expect(mono).toContain("18/24");
      expect(mono).toContain("[▓▓▓░░]");
      expect(mono).not.toContain("margin"); // No dice line without a round
    });

    it("shows the floated dice readout with boxed DC and band word", () => {
      const rendered = renderCombatContinueCard(continueInput({
        lastRound: { d20: 14, bonus: 3, dc: 15, margin: 2, band: "trade" },
      }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("14 +3 = 17");
      expect(mono).toContain("[DC 15]");
      expect(mono).toContain("hit +2 margin");
      expect(mono).toContain("TRADE");
    });

    it("signs a negative margin correctly", () => {
      const rendered = renderCombatContinueCard(continueInput({
        lastRound: { d20: 8, bonus: 3, dc: 16, margin: -3, band: "heavy" },
      }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("hit -3 margin");
      expect(mono).toContain("HEAVY");
    });

    it("escalates to heavy border when band is heavy", () => {
      const rendered = renderCombatContinueCard(
        continueInput({ lastRound: { d20: 8, bonus: 3, dc: 16, margin: -3, band: "heavy" } }),
        PALETTES.house,
        BORDERS.heavy,
      );
      const mono = stripSgr(rendered);
      expect(mono).toContain('╔');
      expect(mono).toContain('║');
    });

    it("begins and ends with the ansi fence", () => {
      const rendered = renderCombatContinueCard(continueInput());
      expect(rendered.startsWith("```ansi\n")).toBe(true);
      expect(rendered.endsWith("\n```")).toBe(true);
    });

    it("renders well under 2000 chars", () => {
      const rendered = renderCombatContinueCard(continueInput({
        lastRound: { d20: 14, bonus: 3, dc: 15, margin: 2, band: "trade" },
      }));
      expect(rendered.length).toBeLessThan(2000);
    });

    it("survives monochrome strip — all numbers and band word readable (constraint 4)", () => {
      const rendered = renderCombatContinueCard(continueInput({
        lastRound: { d20: 14, bonus: 3, dc: 15, margin: 2, band: "trade" },
      }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("14 +3 = 17");
      expect(mono).toContain("[DC 15]");
      expect(mono).toContain("+2 margin");
      expect(mono).toContain("TRADE");
    });
  });

  describe("bandColor", () => {
    it("maps clean/glanced to life", () => {
      expect(bandColor("clean")).toBe("life");
      expect(bandColor("glanced")).toBe("life");
      expect(bandColor("CLEAN")).toBe("life");
    });
    it("maps trade to warmth", () => {
      expect(bandColor("trade")).toBe("warmth");
    });
    it("maps heavy to threat", () => {
      expect(bandColor("heavy")).toBe("threat");
    });
    it("falls back to chrome for unknown bands", () => {
      expect(bandColor("unknown")).toBe("chrome");
    });
  });
});
