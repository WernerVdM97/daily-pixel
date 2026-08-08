import { describe, it, expect, afterEach } from "vitest";
import { collapseNotice, announceCollapse, setCollapseBroadcaster } from "../../src/discord/collapse.js";

describe("collapseNotice", () => {
  it("fires on a health transition to 0, naming the character", () => {
    const notice = collapseNotice("Aldric", { health: 3, stamina: 5 }, { health: 0, stamina: 5 });
    expect(notice).toContain("Aldric");
    expect(notice).toContain("collapsed");
    expect(notice).not.toContain("spent");
  });

  it("fires on a stamina transition to 0", () => {
    const notice = collapseNotice("Bram", { health: 5, stamina: 2 }, { health: 5, stamina: 0 });
    expect(notice).toContain("Bram");
    expect(notice).toContain("spent");
    expect(notice).not.toContain("collapsed");
  });

  it("fires both when health and stamina bottom out together", () => {
    const notice = collapseNotice("Kara", { health: 1, stamina: 1 }, { health: 0, stamina: 0 });
    expect(notice).toContain("collapsed");
    expect(notice).toContain("spent");
  });

  it("does not fire when already at 0 (no transition)", () => {
    expect(collapseNotice("Aldric", { health: 0, stamina: 0 }, { health: 0, stamina: 0 })).toBeNull();
  });

  it("does not fire when vitals stay above 0", () => {
    expect(collapseNotice("Aldric", { health: 5, stamina: 5 }, { health: 3, stamina: 4 })).toBeNull();
  });

  it("returns null when either snapshot is missing", () => {
    expect(collapseNotice("Aldric", null, { health: 0, stamina: 0 })).toBeNull();
    expect(collapseNotice("Aldric", { health: 1, stamina: 1 }, undefined)).toBeNull();
  });
});

// ── M9.1 — the collapse FACT's lossless-mapping proof (DC-M9.2, the M9.0→M9.1 coordinator
// steer's required in-slice substitute for the "consuming adapter is in-slice" rule, since
// the real consumers — dispatchInteraction.ts's three announceCollapse call sites — don't
// land until M9.3). `buildCollapseFact` mirrors src/protocol/router.ts's private
// `outcomeFacts` construction EXACTLY (not imported — it's a private method):
//   facts.collapse = { name: char.name, prev: {health,stamina}, updated: {health,stamina} }
// so this test proves the fact SHAPE — not the router's internals — carries everything
// `collapseNotice`/`announceCollapse` read, across every vitals-transition class. ──

describe("collapse fact (DC-M9.2) — lossless-mapping proof (M9.1)", () => {
  function buildCollapseFact(
    prevChar: { health: number; stamina: number },
    char: { name: string; health: number; stamina: number },
  ): { name: string; prev: { health: number; stamina: number }; updated: { health: number; stamina: number } } {
    return {
      name: char.name,
      prev: { health: prevChar.health, stamina: prevChar.stamina },
      updated: { health: char.health, stamina: char.stamina },
    };
  }

  const TRANSITIONS: Array<{
    label: string;
    prevChar: { health: number; stamina: number };
    char: { name: string; health: number; stamina: number };
  }> = [
    { label: "health crosses to 0", prevChar: { health: 3, stamina: 5 }, char: { name: "Aldric", health: 0, stamina: 5 } },
    { label: "stamina crosses to 0", prevChar: { health: 5, stamina: 2 }, char: { name: "Bram", health: 5, stamina: 0 } },
    { label: "both cross to 0 together", prevChar: { health: 1, stamina: 1 }, char: { name: "Kara", health: 0, stamina: 0 } },
    { label: "neither crosses", prevChar: { health: 5, stamina: 5 }, char: { name: "Aldric", health: 3, stamina: 4 } },
    { label: "already at 0 before (no transition)", prevChar: { health: 0, stamina: 0 }, char: { name: "Aldric", health: 0, stamina: 0 } },
  ];

  afterEach(() => {
    setCollapseBroadcaster(null);
  });

  for (const { label, prevChar, char } of TRANSITIONS) {
    it(`${label}: collapseNotice(fact.name, fact.prev, fact.updated) === collapseNotice(char.name, prevChar, char)`, () => {
      const fact = buildCollapseFact(prevChar, char);
      expect(collapseNotice(fact.name, fact.prev, fact.updated)).toEqual(
        collapseNotice(char.name, prevChar, char),
      );
    });

    it(`${label}: announceCollapse fed from the fact delivers the identical string to a registered broadcaster`, async () => {
      const fact = buildCollapseFact(prevChar, char);

      const fromFact: string[] = [];
      setCollapseBroadcaster((content) => { fromFact.push(content); });
      await announceCollapse(fact.name, fact.prev, fact.updated);

      const fromCharSnapshots: string[] = [];
      setCollapseBroadcaster((content) => { fromCharSnapshots.push(content); });
      await announceCollapse(char.name, prevChar, char);

      expect(fromFact).toEqual(fromCharSnapshots);
    });
  }
});
