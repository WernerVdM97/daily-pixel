import { describe, it, expect } from "vitest";
import { renderFrame, hpBar, PALETTES, type FrameSpec } from "../../src/render/AnsiRenderer.js";

const stripSgr = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function fullCombatFrame(): FrameSpec {
  return {
    header: { name: "GLOOMFANG", level: 4, hp: 6, maxHp: 20, floater: "-6" },
    message: [
      "A wild GLOOMFANG lunges",
      "from the bracken!",
    ],
    footer: { name: "WARDEN", level: 3, hp: 24, maxHp: 30, floater: "-3" },
  };
}

function spriteAndMessageFrame(): FrameSpec {
  return {
    sprite: [
      "   /\\    ",
      "  ( oo )  ",
      "   \\__/   ",
    ],
    floater: "+4",
    message: ["You found a shiny acorn."],
  };
}

describe("AnsiRenderer", () => {
  describe("constraint 1: monochrome width", () => {
    it("keeps every content line at exactly 30 visible chars for a full combat frame", () => {
      const rendered = renderFrame(fullCombatFrame());
      const lines = rendered.split("\n");
      for (const line of lines) {
        if (line === "```ansi" || line === "```") continue;
        expect(stripSgr(line).length).toBeLessThanOrEqual(30);
      }
    });

    it("keeps every content line at exactly 30 visible chars for a sprite+message frame", () => {
      const rendered = renderFrame(spriteAndMessageFrame());
      const lines = rendered.split("\n");
      for (const line of lines) {
        if (line === "```ansi" || line === "```") continue;
        expect(stripSgr(line).length).toBeLessThanOrEqual(30);
      }
    });

    it("pads short content to exactly 30 visible chars, not just under it", () => {
      const rendered = renderFrame({ message: ["hi"] });
      const lines = rendered.split("\n").filter((l) => l !== "```ansi" && l !== "```");
      for (const line of lines) {
        expect(stripSgr(line).length).toBe(30);
      }
    });
  });

  describe("constraint 2: char budget", () => {
    it("renders a full combat frame (header+footer+floaters+2-line message, coloured, fenced) under 2000 chars", () => {
      const rendered = renderFrame(fullCombatFrame());
      expect(rendered.length).toBeLessThan(2000);
    });
  });

  describe("constraint 3: hpBar clamping", () => {
    it("renders all-empty when hp is negative", () => {
      expect(hpBar(-5, 20, 10)).toBe("░░░░░░░░░░");
    });

    it("renders all-filled when hp exceeds maxHp", () => {
      expect(hpBar(999, 20, 10)).toBe("██████████");
    });

    it("renders all-empty when maxHp is zero (no divide-by-zero)", () => {
      const bar = hpBar(5, 0, 10);
      expect(bar).toBe("░░░░░░░░░░");
      expect(bar).not.toMatch(/NaN|Infinity/);
    });

    it("renders all-empty when maxHp is negative", () => {
      const bar = hpBar(5, -3, 10);
      expect(bar).toBe("░░░░░░░░░░");
      expect(bar).not.toMatch(/NaN|Infinity/);
    });

    it("output length is always max(0, width)", () => {
      expect(hpBar(5, 10, 8).length).toBe(8);
      expect(hpBar(-5, 10, 8).length).toBe(8);
      expect(hpBar(5, 0, 8).length).toBe(8);
      expect(hpBar(5, 10, 0).length).toBe(0);
      expect(hpBar(5, 10, -4).length).toBe(0);
    });

    it("fills round(hp/maxHp*width) glyphs for a normal fraction", () => {
      // 6/20 * 10 = 3
      expect(hpBar(6, 20, 10)).toBe("███░░░░░░░");
      // 24/30 * 16 = 12.8 -> rounds to 13
      expect(hpBar(24, 30, 16)).toBe("█████████████░░░");
    });
  });

  describe("constraint 4: colour is never the sole carrier of meaning", () => {
    it("keeps HP numbers, signed floaters, and combatant names legible with SGR stripped", () => {
      const rendered = renderFrame(fullCombatFrame());
      const mono = stripSgr(rendered);

      expect(mono).toContain("24/30");
      expect(mono).toContain("6/20");
      expect(mono).toContain("-6");
      expect(mono).toContain("-3");
      expect(mono).toContain("GLOOMFANG");
      expect(mono).toContain("WARDEN");
    });

    it("still shows a short bar for low HP without relying on red", () => {
      const rendered = renderFrame(fullCombatFrame());
      const mono = stripSgr(rendered);
      // GLOOMFANG at 6/20 (30%) should render a mostly-empty bar even
      // with colour stripped — legibility comes from bar length + number.
      const headerHpLine = mono.split("\n").find((l) => l.includes("6/20"));
      expect(headerHpLine).toBeDefined();
      expect(headerHpLine).toContain("░");
    });
  });

  describe("frame structure", () => {
    it("begins with the ansi fence and ends with the closing fence", () => {
      const rendered = renderFrame(fullCombatFrame());
      expect(rendered.startsWith("```ansi\n")).toBe(true);
      expect(rendered.endsWith("\n```")).toBe(true);
    });

    it("embeds real ESC bytes, not the literal text \\033", () => {
      const rendered = renderFrame(fullCombatFrame());
      expect(rendered).toContain("\x1b[");
      expect(rendered).not.toContain("\\033");
    });

    it("renders a compact frame with only header + footer + floaters + message (no sprite)", () => {
      const rendered = renderFrame(fullCombatFrame());
      const mono = stripSgr(rendered);
      expect(mono).toContain("A wild GLOOMFANG lunges");
      expect(mono).toContain("from the bracken!");
    });

    it("truncates message input beyond the 2-line budget", () => {
      const rendered = renderFrame({
        message: ["line one", "line two", "line three should be dropped"],
      });
      const mono = stripSgr(rendered);
      expect(mono).toContain("line one");
      expect(mono).toContain("line two");
      expect(mono).not.toContain("line three");
    });

    it("clamps a message line longer than the 26-char interior budget", () => {
      const longLine = "x".repeat(40);
      const rendered = renderFrame({ message: [longLine] });
      const lines = rendered.split("\n").filter((l) => l !== "```ansi" && l !== "```");
      for (const line of lines) {
        expect(stripSgr(line).length).toBe(30);
      }
    });

    it("clamps a sprite line longer than the 28-char interior budget", () => {
      const longLine = "y".repeat(40);
      const rendered = renderFrame({ sprite: [longLine] });
      const lines = rendered.split("\n").filter((l) => l !== "```ansi" && l !== "```");
      for (const line of lines) {
        expect(stripSgr(line).length).toBe(30);
      }
    });

    it("truncates overflowing segments from the tail, preserving leading content", () => {
      // Frame-level floater is "  " (indent) + text with no self-truncation,
      // so a 30-char text overflows the 28-wide interior by 4 and forces
      // fitSegments to actually truncate. If truncation ate from the front
      // (the historical bug), the leading 2-space indent would be consumed
      // first and the line would start directly with "A".
      const rendered = renderFrame({ floater: "A".repeat(30) });
      const mono = stripSgr(rendered);
      const floaterLine = mono.split("\n").find((l) => l.includes("A"));
      expect(floaterLine).toBeDefined();
      const body = floaterLine!.slice(1, -1); // strip the | | borders
      expect(body.startsWith("  A")).toBe(true); // leading indent survives
      expect(body).toBe("  " + "A".repeat(26)); // trailing overflow dropped
      expect(body.length).toBe(28);
    });
  });

  describe("HP line adaptive bar width (wide numeric suffixes)", () => {
    it("keeps the box intact and shows full 3-digit HP values", () => {
      const rendered = renderFrame({ header: { name: "GLOOMFANG", hp: 999, maxHp: 999 } });
      const mono = stripSgr(rendered);
      const hpLine = mono.split("\n").find((l) => l.includes("999/999"));
      expect(hpLine).toBeDefined();
      expect(hpLine).toContain("HP [");
      expect(hpLine).toContain("]");
      expect(hpLine!.indexOf("[")).toBeLessThan(hpLine!.indexOf("]"));
      expect(hpLine!.length).toBe(30);
    });

    it("keeps the box intact and shows full 4-digit HP values", () => {
      const rendered = renderFrame({ header: { name: "GLOOMFANG", hp: 9999, maxHp: 9999 } });
      const mono = stripSgr(rendered);
      const hpLine = mono.split("\n").find((l) => l.includes("9999/9999"));
      expect(hpLine).toBeDefined();
      expect(hpLine).toContain("HP [");
      expect(hpLine).toContain("]");
      expect(hpLine!.indexOf("[")).toBeLessThan(hpLine!.indexOf("]"));
      expect(hpLine!.length).toBe(30);
    });

    it("still fits exactly for small (1-digit) HP values", () => {
      const rendered = renderFrame({ header: { name: "RAT", hp: 3, maxHp: 5 } });
      const mono = stripSgr(rendered);
      const hpLine = mono.split("\n").find((l) => l.includes("3/5"));
      expect(hpLine).toBeDefined();
      expect(hpLine!.length).toBe(30);
    });

    it("rounds a fractional HP value for display without touching bar fill maths", () => {
      const rendered = renderFrame({ header: { name: "SPRITE", hp: 5.7, maxHp: 10 } });
      const mono = stripSgr(rendered);
      expect(mono).toContain("6/10");
      expect(mono).not.toContain("5.7");
    });
  });

  describe("bar/hpText (banded HP display)", () => {
    it("renders the bar string verbatim inside HP [...]", () => {
      const rendered = renderFrame({
        header: { name: "GLOOMFANG", hp: 3, maxHp: 20, bar: "▓▓░░░", hpText: "Battered" },
      });
      const mono = stripSgr(rendered);
      expect(mono).toContain("HP [▓▓░░░]");
      expect(mono).toContain("Battered");
    });

    it("when hpText is a wound word, shows that word instead of hp/maxHp", () => {
      const rendered = renderFrame({
        header: { name: "GLOOMFANG", hp: 3, maxHp: 20, bar: "▓▓░░░", hpText: "Battered" },
      });
      const mono = stripSgr(rendered);
      expect(mono).toContain("Battered");
      expect(mono).not.toContain("3/20");
    });

    it("when hpText is empty string, no suffix after the bracket", () => {
      const rendered = renderFrame({
        header: { name: "GLOOMFANG", hp: 3, maxHp: 20, bar: "▓▓░░░", hpText: "" },
      });
      const mono = stripSgr(rendered);
      // The ] must be immediately followed by spaces (padding) with no number or word.
      const hpLine = mono.split("\n").find((l) => l.includes("HP ["));
      expect(hpLine).toBeDefined();
      expect(hpLine).not.toMatch(/3\/20/);
      expect(hpLine).not.toMatch(/\] [a-zA-Z]/);
      expect(hpLine).toMatch(/\][ ]*\|/);
    });

    it("when bar is set but hpText is undefined, falls back to hp/maxHp numbers", () => {
      const rendered = renderFrame({
        header: { name: "GLOOMFANG", hp: 3, maxHp: 20, bar: "▓▓░░░" },
      });
      const mono = stripSgr(rendered);
      expect(mono).toContain("3/20");
      expect(mono).toContain("HP [▓▓░░░]");
    });

    it("banded line still produces exactly 30 visible chars per line (constraint 1)", () => {
      const rendered = renderFrame({
        header: { name: "GLOOMFANG", hp: 3, maxHp: 20, bar: "▓▓░░░", hpText: "Battered" },
      });
      const lines = rendered.split("\n").filter((l) => l !== "```ansi" && l !== "```");
      for (const line of lines) {
        expect(stripSgr(line).length).toBe(30);
      }
    });

    it("banded line survives monochrome strip — bar glyphs and wound word visible with SGR stripped (constraint 4)", () => {
      const rendered = renderFrame({
        header: { name: "GLOOMFANG", hp: 3, maxHp: 20, bar: "▓▓░░░", hpText: "Battered" },
      });
      const mono = stripSgr(rendered);
      expect(mono).toContain("▓▓░░░");
      expect(mono).toContain("Battered");
      expect(mono).toContain("GLOOMFANG");
    });
  });

  describe("code fence integrity against caller-supplied text", () => {
    it("neutralizes a triple-backtick in a name and in a message so only the real fence markers survive", () => {
      const rendered = renderFrame({
        header: { name: "```GLOOM@everyone", hp: 6, maxHp: 20 },
        message: ["```@everyone breaks out```"],
      });

      // Only the opening ```ansi and the single closing ``` should remain;
      // no stray backtick run from caller text should appear anywhere else.
      const fenceMatches = rendered.match(/```/g) ?? [];
      expect(fenceMatches.length).toBe(2);
      expect(rendered.startsWith("```ansi\n")).toBe(true);
      expect(rendered.endsWith("\n```")).toBe(true);

      const body = rendered.slice("```ansi\n".length, rendered.length - "\n```".length);
      expect(body).not.toContain("`");
    });
  });

  describe("palette-driven rendering (ANSI-B)", () => {
    // Captured from renderFrame(fullCombatFrame()) BEFORE the palette module
    // landed, when `chrome` was still hardcoded to SGR 30 (black). ANSI-B's
    // standing acceptance is that the combat frame's output is byte-identical
    // to this except the chrome colour, so this fixture is the baseline proof
    // rather than a re-derived one — see poc-plus-0.3.1-polish-plan.md "ANSI-B".
    const preChangeFixture =
      "```ansi\n" +
      "\x1b[30m+----------------------------+\x1b[0m\n" +
      "\x1b[30m|\x1b[0m  \x1b[31mGLOOMFANG\x1b[0m           Lv 4  \x1b[30m|\x1b[0m\n" +
      "\x1b[30m|\x1b[0m  HP [\x1b[31m█████\x1b[0m\x1b[30m░░░░░░░░░░░\x1b[0m] 6/20\x1b[30m|\x1b[0m\n" +
      "\x1b[30m|\x1b[0m  \x1b[31m-6\x1b[0m                        \x1b[30m|\x1b[0m\n" +
      "\x1b[30m|\x1b[0m  \x1b[34mWARDEN\x1b[0m              Lv 3  \x1b[30m|\x1b[0m\n" +
      "\x1b[30m|\x1b[0m  HP [\x1b[32m████████████\x1b[0m\x1b[30m░░░\x1b[0m] 24/30\x1b[30m|\x1b[0m\n" +
      "\x1b[30m|\x1b[0m  \x1b[31m-3\x1b[0m                        \x1b[30m|\x1b[0m\n" +
      "\x1b[30m+----------------------------+\x1b[0m\n" +
      "\x1b[30m|\x1b[0m  A wild GLOOMFANG lunges   \x1b[30m|\x1b[0m\n" +
      "\x1b[30m|\x1b[0m  from the bracken!         \x1b[30m|\x1b[0m\n" +
      "\x1b[30m+----------------------------+\x1b[0m\n" +
      "```";

    it("renders the combat frame byte-identical to the pre-palette fixture once chrome (37) is reconciled back to 30", () => {
      const rendered = renderFrame(fullCombatFrame(), PALETTES.house);
      const reconciled = rendered.replace(/\x1b\[37m/g, "\x1b[30m");
      expect(reconciled).toBe(preChangeFixture);
    });

    it("defaults to the house palette when no palette argument is given", () => {
      const withDefault = renderFrame(fullCombatFrame());
      const withExplicitHouse = renderFrame(fullCombatFrame(), PALETTES.house);
      expect(withDefault).toBe(withExplicitHouse);
    });

    it("only differs from the pre-palette fixture on chrome's SGR code, no other codes changed", () => {
      const rendered = renderFrame(fullCombatFrame(), PALETTES.house);
      const renderedCodes = rendered.match(/\x1b\[[0-9;]*m/g) ?? [];
      const fixtureCodes = preChangeFixture.match(/\x1b\[[0-9;]*m/g) ?? [];
      expect(renderedCodes.length).toBe(fixtureCodes.length);
      for (let i = 0; i < renderedCodes.length; i++) {
        const rendCode = renderedCodes[i];
        const fixCode = fixtureCodes[i];
        if (rendCode === fixCode) continue;
        // The only permitted divergence: chrome moved 30 -> 37.
        expect(fixCode).toBe("\x1b[30m");
        expect(rendCode).toBe("\x1b[37m");
      }
    });

    it("a non-default palette actually changes the emitted SGR codes", () => {
      const houseRendered = renderFrame(fullCombatFrame(), PALETTES.house);
      const gloomRendered = renderFrame(fullCombatFrame(), PALETTES.gloom);
      expect(gloomRendered).not.toBe(houseRendered);
      // Monochrome content is unaffected by palette choice — only colour codes differ.
      expect(stripSgr(gloomRendered)).toBe(stripSgr(houseRendered));
    });
  });
});
