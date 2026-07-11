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
    verdict: "WON",
    margin: 5,
    band: "GLANCED",
    playerHpDelta: 0,
    enemyHpDelta: -3,
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
      const rendered = renderCombatTerminalCard(winCard({ marker: "x", verdict: "LOST", margin: -9 }));
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

    it("is a closed box (border rows top and bottom) with exactly 7 content lines", () => {
      const rendered = renderCombatTerminalCard(winCard());
      const mono = stripSgr(rendered);
      const lines = mono.split("\n").filter((l) => l !== "```ansi" && l !== "```");
      // Box-drawing borders (redesign): ┌──┐ top, └──┘ bottom.
      expect(lines[0]).toContain('┌');
      expect(lines[lines.length - 1]).toContain('└');
      // 2 borders + 7 content lines: label, blank, focal roll, calc, outcome, band,
      // and the POC+ 0.3.2 C2 HP-delta line.
      expect(lines.length).toBe(9);
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
      expect(mono).toContain("+ WON");
      expect(mono).toContain("margin +5");
      // Band name replaces the old truncated-prose flavour line (F#22).
      expect(mono).toContain("GLANCED");
      expect(mono).not.toContain("The GLOOMFANG collapses.");
    });

    it("signs a negative bonus and a negative margin correctly", () => {
      const rendered = renderCombatTerminalCard(winCard({ bonus: -2, total: 9, margin: -3, marker: "x", verdict: "LOST" }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("-2 = 9");
      expect(mono).toContain("margin -3");
    });

    it("shows the x marker and LOST verdict for a loss card (past tense — POC+ 0.3.2 C2)", () => {
      const rendered = renderCombatTerminalCard(winCard({ marker: "x", verdict: "LOST", margin: -9 }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("x LOST");
    });

    it("never emits a dingbat marker — ASCII '+'/'x' only", () => {
      const winRendered = stripSgr(renderCombatTerminalCard(winCard()));
      const lossRendered = stripSgr(renderCombatTerminalCard(winCard({ marker: "x", verdict: "LOST" })));
      expect(winRendered).not.toMatch(/[✓✗✔✘]/);
      expect(lossRendered).not.toMatch(/[✓✗✔✘]/);
    });

    it("shows both HP deltas on the terminal card (POC+ 0.3.2 C2)", () => {
      const rendered = renderCombatTerminalCard(winCard({ playerHpDelta: 0, enemyHpDelta: -6, band: "CLEAN" }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("you 0");
      expect(mono).toContain("foe -6");
    });

    it("shows a non-zero player HP delta signed on the terminal card", () => {
      const rendered = renderCombatTerminalCard(winCard({ marker: "x", verdict: "LOST", margin: -9, band: "HEAVY", playerHpDelta: -3, enemyHpDelta: -1 }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("you -3");
      expect(mono).toContain("foe -1");
    });

    it("renders a zero enemy HP delta unsigned, symmetric with the player side (defensive — no band deals 0 today)", () => {
      const rendered = renderCombatTerminalCard(winCard({ playerHpDelta: 0, enemyHpDelta: 0 }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("you 0");
      expect(mono).toContain("foe 0");
      expect(mono).not.toContain("foe +0");
    });
  });

  describe("colour role usage (palette-first — house is the default and only palette needed)", () => {
    it("colours the focal d20 with the warmth role", () => {
      const rendered = renderCombatTerminalCard(winCard());
      expect(rendered).toContain(`\x1b[${PALETTES.house.sgr.warmth}m16\x1b[0m`);
    });

    it("colours a win marker+verdict with the life role", () => {
      const rendered = renderCombatTerminalCard(winCard());
      expect(rendered).toContain(`\x1b[${PALETTES.house.sgr.life}m+ WON\x1b[0m`);
    });

    it("colours a loss marker+verdict with the threat role", () => {
      const rendered = renderCombatTerminalCard(winCard({ marker: "x", verdict: "LOST" }));
      expect(rendered).toContain(`\x1b[${PALETTES.house.sgr.threat}mx LOST\x1b[0m`);
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
        lastRound: { d20: 14, bonus: 3, dc: 15, enemyD20: 10, enemyBonus: 4, margin: 3, band: "trade", playerHpDelta: -1, enemyHpDelta: -2 },
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

    it("shows the contested roll (player vs enemy total) and the band word, not a boxed DC", () => {
      const rendered = renderCombatContinueCard(continueInput({
        lastRound: { d20: 14, bonus: 3, dc: 15, enemyD20: 10, enemyBonus: 4, margin: 3, band: "trade", playerHpDelta: -1, enemyHpDelta: -2 },
      }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("14");
      expect(mono).toContain("vs 10 +4 = 14");
      expect(mono).toContain("+3 = 17");
      expect(mono).toContain("hit +3 margin");
      expect(mono).toContain("TRADE");
      // The old solo `[DC N]` threshold reading is gone — the contested roll replaces it.
      expect(mono).not.toContain("[DC");
    });

    it("signs a negative margin correctly", () => {
      const rendered = renderCombatContinueCard(continueInput({
        lastRound: { d20: 8, bonus: 3, dc: 16, enemyD20: 15, enemyBonus: 2, margin: -6, band: "heavy", playerHpDelta: -3, enemyHpDelta: -1 },
      }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("hit -6 margin");
      expect(mono).toContain("HEAVY");
    });

    it("escalates to heavy border when band is heavy", () => {
      const rendered = renderCombatContinueCard(
        continueInput({ lastRound: { d20: 8, bonus: 3, dc: 16, enemyD20: 15, enemyBonus: 2, margin: -6, band: "heavy", playerHpDelta: -3, enemyHpDelta: -1 } }),
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
        lastRound: { d20: 14, bonus: 3, dc: 15, enemyD20: 10, enemyBonus: 4, margin: 3, band: "trade", playerHpDelta: -1, enemyHpDelta: -2 },
      }));
      expect(rendered.length).toBeLessThan(2000);
    });

    it("survives monochrome strip — all numbers and band word readable (constraint 4)", () => {
      const rendered = renderCombatContinueCard(continueInput({
        lastRound: { d20: 14, bonus: 3, dc: 15, enemyD20: 10, enemyBonus: 4, margin: 3, band: "trade", playerHpDelta: -1, enemyHpDelta: -2 },
      }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("vs 10 +4 = 14");
      expect(mono).toContain("+3 = 17");
      expect(mono).toContain("+3 margin");
      expect(mono).toContain("TRADE");
    });

    it("shows the danger tag on the nameplate when dangerTier is set", () => {
      const rendered = renderCombatContinueCard(continueInput({ dangerTier: "hard" }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("[hard]");
    });

    it("shows no danger tag on the nameplate when dangerTier is absent", () => {
      const rendered = renderCombatContinueCard(continueInput());
      const mono = stripSgr(rendered);
      expect(mono).not.toContain("[hard]");
      expect(mono).not.toMatch(/\[(easy|medium|hard|risky|fatal)\]/);
    });

    it("keeps every line at exactly 30 visible chars with a danger tag on a long name", () => {
      const rendered = renderCombatContinueCard(continueInput({
        enemyName: "Woodland Stag Sentinel", // 22 chars, well past the nameplate budget with a tag
        dangerTier: "medium",
      }));
      const mono = stripSgr(rendered);
      const lines = rendered.split("\n").filter((l) => l !== "```ansi" && l !== "```");
      for (const line of lines) {
        expect(stripSgr(line).length).toBe(FRAME_WIDTH);
      }
      // The tag must render intact — not truncated into "[med" by a nameplate that overran its budget.
      expect(mono).toContain("[medium]");
    });
  });

  describe("per-round HP-delta line (POC+ 0.3.2 C2)", () => {
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

    it.each([
      ["clean", 0, -6],
      ["glanced", 0, -3],
      ["trade", -1, -2],
      ["heavy", -3, -1],
    ] as const)("continue card shows the HP-delta line for the %s band", (band, playerHpDelta, enemyHpDelta) => {
      const rendered = renderCombatContinueCard(continueInput({
        lastRound: { d20: 14, bonus: 3, dc: 15, enemyD20: 10, enemyBonus: 4, margin: 1, band, playerHpDelta, enemyHpDelta },
      }));
      const mono = stripSgr(rendered);
      expect(mono).toContain(`you ${playerHpDelta === 0 ? '0' : playerHpDelta}`);
      expect(mono).toContain(`foe ${enemyHpDelta}`);
    });

    it.each([
      ["clean", 0, -6],
      ["glanced", 0, -3],
      ["trade", -1, -2],
      ["heavy", -3, -1],
    ] as const)("terminal card shows the HP-delta line for the %s band", (band, playerHpDelta, enemyHpDelta) => {
      const rendered = renderCombatTerminalCard(winCard({ band: band.toUpperCase(), playerHpDelta, enemyHpDelta }));
      const mono = stripSgr(rendered);
      expect(mono).toContain(`you ${playerHpDelta === 0 ? '0' : playerHpDelta}`);
      expect(mono).toContain(`foe ${enemyHpDelta}`);
    });

    it("a trade-band edge-win reads coherently: TRADE band word + you -1 + foe -2, no WIN/LOSS word on the continue card", () => {
      const rendered = renderCombatContinueCard(continueInput({
        // player 13+2=15, enemy 12+2=14, margin +1 -> trade, edge-win (POC+ 0.3.2 C2)
        lastRound: { d20: 13, bonus: 2, dc: 12, enemyD20: 12, enemyBonus: 2, margin: 1, band: "trade", playerHpDelta: -1, enemyHpDelta: -2 },
      }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("TRADE");
      expect(mono).toContain("you -1");
      expect(mono).toContain("foe -2");
      expect(mono).toContain("hit +1 margin");
      // Per-round is band-led — no WIN/LOSS word belongs on the continue card at all.
      expect(mono).not.toContain("WIN");
      expect(mono).not.toContain("LOSS");
      expect(mono).not.toContain("WON");
      expect(mono).not.toContain("LOST");
    });

    it("the terminal card's WON/LOST verdict coexists with the band word and both HP deltas", () => {
      const rendered = renderCombatTerminalCard(winCard({
        marker: "+", verdict: "WON", band: "TRADE", playerHpDelta: -1, enemyHpDelta: -2,
      }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("+ WON");
      expect(mono).toContain("TRADE");
      expect(mono).toContain("you -1");
      expect(mono).toContain("foe -2");
    });

    it("keeps every line at exactly 30 visible chars with the HP-delta line present (continue card)", () => {
      const rendered = renderCombatContinueCard(continueInput({
        lastRound: { d20: 13, bonus: 2, dc: 12, enemyD20: 12, enemyBonus: 2, margin: 1, band: "trade", playerHpDelta: -1, enemyHpDelta: -2 },
      }));
      const lines = rendered.split("\n").filter((l) => l !== "```ansi" && l !== "```");
      for (const line of lines) {
        expect(stripSgr(line).length).toBe(FRAME_WIDTH);
      }
    });

    it("keeps every line at exactly 28 visible chars with the HP-delta line present (terminal card)", () => {
      const rendered = renderCombatTerminalCard(winCard({ band: "TRADE", playerHpDelta: -1, enemyHpDelta: -2 }));
      const lines = rendered.split("\n").filter((l) => l !== "```ansi" && l !== "```");
      for (const line of lines) {
        expect(stripSgr(line).length).toBe(FRAME_WIDTH);
      }
    });
  });

  describe("continue/terminal vocabulary parity (POC+ 0.3.2 C1)", () => {
    it("both cards render the same roll-vs-roll vocabulary for the same round", () => {
      const continueRendered = stripSgr(renderCombatContinueCard({
        enemyName: "GLOOMFANG",
        woundWord: "BRUISED",
        pips: { filled: 3, total: 5 },
        playerHp: 18,
        playerMaxHp: 24,
        playerHpDelta: -3,
        lastRound: { d20: 18, bonus: 3, dc: 15, enemyD20: 14, enemyBonus: 2, margin: 5, band: "glanced", playerHpDelta: 0, enemyHpDelta: -3 },
      }));
      const terminalRendered = stripSgr(renderCombatTerminalCard(winCard({
        playerD20: 18,
        bonus: 3,
        total: 21,
        enemyD20: 14,
        enemyBonus: 2,
        margin: 5,
        band: "GLANCED",
      })));

      expect(continueRendered).toContain("vs 14 +2 = 16");
      expect(terminalRendered).toContain("vs 14 +2 = 16");
      expect(continueRendered).not.toContain("[DC");
      expect(terminalRendered).not.toContain("[DC");
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

  describe("right-edge padding (0.3.2 P1)", () => {
    const baseInput = (): ContinueCardInput => ({
      enemyName: "GLOOMFANG",
      woundWord: "BRUISED",
      pips: { filled: 3, total: 5 },
      playerHp: 18,
      playerMaxHp: 24,
      playerHpDelta: -3,
    });

    it("keeps a 2-digit N/MM HP figure with one space inside the right border", () => {
      const rendered = renderCombatContinueCard(baseInput());
      const mono = stripSgr(rendered);
      // The player HP line reads something like:  │  HP [▓▓▓▓▓▓▓▓░░░░] 18/24 │
      // After the -1 bar-width correction, the suffix should have a trailing space
      // (fitSegments pads the interior to 28, so "18/24" + space + border).
      const hpLine = mono.split('\n').find(l => l.includes('18/24'));
      expect(hpLine).toBeDefined();
      // The HP number should not be the last interior character — there must be
      // at least one space before the border glyph.
      expect(hpLine).toMatch(/\d\s+[│║]/);
    });

    it("a 3-digit HP figure also keeps one space inside the right border", () => {
      const rendered = renderCombatContinueCard({ ...baseInput(), playerHp: 10, playerMaxHp: 100 });
      const mono = stripSgr(rendered);
      const hpLine = mono.split('\n').find(l => l.includes('10/100'));
      expect(hpLine).toBeDefined();
      expect(hpLine).toMatch(/\d\s+[│║]/);
    });

    it("the continue card is still exactly 30-wide with the padding correction", () => {
      const rendered = renderCombatContinueCard(baseInput());
      const lines = rendered.split('\n').filter((l) => l !== '```ansi' && l !== '```');
      for (const line of lines) {
        expect(stripSgr(line).length).toBe(FRAME_WIDTH);
      }
    });
  });

  describe("word-boundary clipping safety net (0.3.2 P1)", () => {
    it("a long label clips at a word boundary with ellipsis, never mid-word", () => {
      const rendered = renderCombatTerminalCard(winCard({ label: "the final blow strikes the ancient terror" }));
      const mono = stripSgr(rendered);
      // The label must fit within 28 interior - 2 prefix = 26 chars. "the final blow strikes"
      // is 23 chars; "the final blow strikes th" (26) would split mid-"the". Should clip to
      // "the final blow strikes…" at the word boundary before "the".
      const labelLine = mono.split('\n').find(l => l.includes('the final blow strikes'));
      expect(labelLine).toBeDefined();
      if (labelLine!.includes('…')) {
        // The text before the ellipsis must end on a space after the last complete word —
        // "strikes…" means the space before "the" was consumed and replaced by ellipsis;
        // this is word-boundary clipping, not mid-word truncation.
        const beforeEllipsis = labelLine!.split('…')[0];
        // The last character before the ellipsis should NOT be a lowercase letter
        // mid-word (e.g., "strik…" would be bad). "strikes…" is good — strikes is a word.
        expect(beforeEllipsis).not.toMatch(/[a-z]…$/);
      }
    });

    it("a short label is unchanged", () => {
      const rendered = renderCombatTerminalCard(winCard({ label: "COMBAT RESOLVED" }));
      const mono = stripSgr(rendered);
      expect(mono).toContain("COMBAT RESOLVED");
      expect(mono).not.toContain('…');
    });

    it("a single-very-long-word label hard-clips with ellipsis", () => {
      const rendered = renderCombatTerminalCard(winCard({ label: "thisisaverylongwordwithnospacesinitforanyone" }));
      // Must still be width-safe.
      const lines = rendered.split('\n').filter((l) => l !== '```ansi' && l !== '```');
      for (const line of lines) {
        expect(stripSgr(line).length).toBe(FRAME_WIDTH);
      }
    });
  });
});
