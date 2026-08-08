import { describe, it, expect } from "vitest";
import { buildComponentPayload, getNavButtons, navResponseMode, getOutcomeServiceButtons, parseOutcomeActionId, classEmoji, CLASS_EMOJI_FALLBACK, SEPARATOR, IS_COMPONENTS_V2 } from "../../src/discord/format.js";

const CONTAINER = 17;
const TEXT_DISPLAY = 10;
const MEDIA_GALLERY = 12;
const SEPARATOR_CT = 14;

function container(payload: ReturnType<typeof buildComponentPayload>) {
  return payload.components.find(c => c.type === CONTAINER) as {
    type: number;
    components: Array<{ type: number; content?: string; items?: Array<{ media: { url: string } }> }>;
  };
}

describe("buildComponentPayload", () => {
  it("wraps plain text in a Components V2 container", () => {
    const payload = buildComponentPayload("hello world");
    expect(payload.flags).toBe(IS_COMPONENTS_V2);
    const inner = container(payload).components;
    expect(inner).toHaveLength(1);
    expect(inner[0]).toEqual({ type: TEXT_DISPLAY, content: "hello world" });
  });

  it("splits sections on the SEPARATOR with a separator component between", () => {
    const payload = buildComponentPayload(`top${"\n"}${SEPARATOR}${"\n"}bottom`);
    const types = container(payload).components.map(c => c.type);
    expect(types).toEqual([TEXT_DISPLAY, SEPARATOR_CT, TEXT_DISPLAY]);
  });

  it("prepends a MediaGallery referencing the attachment when an image is given", () => {
    const payload = buildComponentPayload("a new day", { image: "daily-pixel-banner.png" });
    const inner = container(payload).components;
    expect(inner[0]).toEqual({
      type: MEDIA_GALLERY,
      items: [{ media: { url: "attachment://daily-pixel-banner.png" } }],
    });
    // Text still follows the image.
    expect(inner.some(c => c.type === TEXT_DISPLAY && c.content === "a new day")).toBe(true);
  });

  it("omits the MediaGallery when no image is given", () => {
    const inner = container(buildComponentPayload("plain")).components;
    expect(inner.some(c => c.type === MEDIA_GALLERY)).toBe(false);
  });

  it("appends nav button rows after the container", () => {
    const nav = getNavButtons({ rollsRemaining: 0, lastActionState: null }, "hi");
    const payload = buildComponentPayload("text", { navButtons: nav });
    // The container is first; nav action rows follow.
    expect(payload.components[0].type).toBe(CONTAINER);
    expect(payload.components.length).toBeGreaterThan(1);
  });

  it("folds the ephemeral option into the flags bitfield (no deprecated `ephemeral` field)", () => {
    const EPHEMERAL = 1 << 6;
    const payload = buildComponentPayload("hi", { ephemeral: true });
    expect("ephemeral" in payload).toBe(false);
    expect(payload.flags & EPHEMERAL).toBe(EPHEMERAL);
    expect(payload.flags & IS_COMPONENTS_V2).toBe(IS_COMPONENTS_V2);
    // Non-ephemeral leaves the bit clear.
    expect(buildComponentPayload("hi").flags & EPHEMERAL).toBe(0);
  });
});

describe("classEmoji", () => {
  it("maps known classes to their emoji", () => {
    expect(classEmoji("Warrior")).toBe("⚔️");
    expect(classEmoji("Ranger")).toBe("🏹");
    expect(classEmoji("Wizard")).toBe("🔮");
    expect(classEmoji("Bard")).toBe("🎵");
    expect(classEmoji("Priest")).toBe("✝️");
  });

  it("falls back for unknown, null, or undefined classes", () => {
    expect(classEmoji("Necromancer")).toBe(CLASS_EMOJI_FALLBACK);
    expect(classEmoji(null)).toBe(CLASS_EMOJI_FALLBACK);
    expect(classEmoji(undefined)).toBe(CLASS_EMOJI_FALLBACK);
    expect(classEmoji("")).toBe(CLASS_EMOJI_FALLBACK);
  });
});

// Helper: collect the nav button ids a context produces.
function navIds(char: { rollsRemaining: number; lastActionState: unknown }, current?: string): string[] {
  return getNavButtons(char, current).flatMap(row =>
    row.components.map(b => b.custom_id.replace(/^nav:/, "")),
  );
}

describe("getNavButtons — action/sleep are mutually exclusive", () => {
  it("shows Action (not Sleep) while rolls remain", () => {
    const ids = navIds({ rollsRemaining: 2, lastActionState: null });
    expect(ids).toContain("action");
    expect(ids).not.toContain("sleep");
  });

  it("shows Sleep (not Action) when out of rolls and idle", () => {
    const ids = navIds({ rollsRemaining: 0, lastActionState: null });
    expect(ids).toContain("sleep");
    expect(ids).not.toContain("action");
  });

  it("shows Action (not Sleep) when out of rolls but mid-action — so you can resume", () => {
    const ids = navIds({ rollsRemaining: 0, lastActionState: { foo: 1 } });
    expect(ids).toContain("action");
    expect(ids).not.toContain("sleep");
  });

  it("hides Rest once the player has already rested today", () => {
    const ids = getNavButtons({
      rollsRemaining: 0,
      lastActionState: null,
      hasRestedToday: true,
    }).flatMap(row => row.components.map(b => b.custom_id.replace(/^nav:/, "")));
    expect(ids).not.toContain("sleep");
    expect(ids).not.toContain("action");
  });
});

describe("getNavButtons — view buttons (look/stats/backpack)", () => {
  const char = { rollsRemaining: 2, lastActionState: null };

  it("shows Look on hi (but not Stats/Backpack)", () => {
    const ids = navIds(char, "hi");
    expect(ids).toContain("look");
    expect(ids).not.toContain("stats");
    expect(ids).not.toContain("backpack");
  });

  it("cross-links the info pages (incl. map) to each other", () => {
    // On each info page, the OTHER info buttons of {backpack, stats, journal, look, map} appear.
    for (const [page, others] of [
      ["backpack", ["stats", "journal", "look", "map"]],
      ["stats", ["backpack", "journal", "look", "map"]],
      ["journal", ["backpack", "stats", "look", "map"]],
      ["look", ["backpack", "stats", "journal", "map"]],
      ["map", ["backpack", "stats", "journal", "look"]],
    ] as const) {
      const ids = navIds(char, page);
      for (const other of others) expect(ids).toContain(other);
      expect(ids).not.toContain(page); // never its own button
    }
  });

  it("keeps view buttons off action outcomes (no current page)", () => {
    const ids = navIds(char);
    expect(ids).not.toContain("look");
    expect(ids).not.toContain("stats");
    expect(ids).not.toContain("backpack");
  });

  it("never exceeds 5 buttons per action row (Discord cap)", () => {
    for (const page of ["hi", "journal", "look", "stats", "backpack", "map"]) {
      for (const rolls of [0, 2]) {
        const rows = getNavButtons({ rollsRemaining: rolls, lastActionState: null }, page);
        for (const row of rows) expect(row.components.length).toBeLessThanOrEqual(5);
      }
    }
  });
});

// ── DC-M9.6 — getNavButtons now accepts either the raw character shape
// ({ lastActionState }, hasPendingAction derived) or the protocol's `facts.nav` shape
// ({ hasPendingAction } already computed). Every existing call site passes the first
// shape; a widened dispatcher (M9.3) will pass the second. Both must render identical
// rows across every state the nav bar branches on. ──

describe("getNavButtons — dual shape (DC-M9.6)", () => {
  const STATES: Array<{ label: string; rollsRemaining: number; hasPendingAction: boolean; hasRestedToday: boolean }> = [
    { label: "rolls remain, idle, not rested", rollsRemaining: 2, hasPendingAction: false, hasRestedToday: false },
    { label: "out of rolls, idle, not rested", rollsRemaining: 0, hasPendingAction: false, hasRestedToday: false },
    { label: "out of rolls, mid-action", rollsRemaining: 0, hasPendingAction: true, hasRestedToday: false },
    { label: "out of rolls, idle, already rested", rollsRemaining: 0, hasPendingAction: false, hasRestedToday: true },
    { label: "rolls remain, mid-action, already rested", rollsRemaining: 3, hasPendingAction: true, hasRestedToday: true },
  ];

  for (const { label, rollsRemaining, hasPendingAction, hasRestedToday } of STATES) {
    for (const currentCommand of [undefined, "hi", "journal"]) {
      it(`${label} (currentCommand=${currentCommand ?? "none"}): both shapes produce identical rows`, () => {
        const viaLastActionState = getNavButtons(
          { rollsRemaining, lastActionState: hasPendingAction ? { inFlight: true } : null, hasRestedToday },
          currentCommand,
        );
        const viaHasPendingAction = getNavButtons(
          { rollsRemaining, hasPendingAction, hasRestedToday },
          currentCommand,
        );
        expect(viaHasPendingAction).toEqual(viaLastActionState);
      });
    }
  }

  it("the first shape's optional hasRestedToday behaves like an explicit false, matching the second shape's required field", () => {
    const omitted = getNavButtons({ rollsRemaining: 0, lastActionState: null });
    const explicitFalse = getNavButtons({ rollsRemaining: 0, lastActionState: null, hasRestedToday: false });
    const viaSecondShape = getNavButtons({ rollsRemaining: 0, hasPendingAction: false, hasRestedToday: false });
    expect(omitted).toEqual(explicitFalse);
    expect(omitted).toEqual(viaSecondShape);
  });
});

describe("getOutcomeServiceButtons — action-id custom_ids", () => {
  const ids = (actionId?: number) =>
    getOutcomeServiceButtons(actionId)[0].components.map((b) => b.custom_id);

  it("emits bare custom_ids when no action id is given (off-action surfaces)", () => {
    expect(ids()).toEqual(["outcome:feedback", "outcome:bug"]);
  });

  it("appends the action id so a report can be attributed to its action", () => {
    expect(ids(42)).toEqual(["outcome:feedback:42", "outcome:bug:42"]);
  });

  it("always yields exactly the two service buttons", () => {
    expect(getOutcomeServiceButtons(7)[0].components).toHaveLength(2);
  });
});

describe("parseOutcomeActionId — inverse of the custom_id suffix", () => {
  it("returns undefined for bare button/modal custom_ids", () => {
    expect(parseOutcomeActionId("outcome:feedback")).toBeUndefined();
    expect(parseOutcomeActionId("outcome:bug")).toBeUndefined();
    expect(parseOutcomeActionId("outcome:feedback:modal")).toBeUndefined();
    expect(parseOutcomeActionId("outcome:bug:modal")).toBeUndefined();
  });

  it("extracts the id from both button and modal forms", () => {
    expect(parseOutcomeActionId("outcome:feedback:42")).toBe(42);
    expect(parseOutcomeActionId("outcome:bug:modal:99")).toBe(99);
  });

  it("ignores a non-positive trailing segment (action ids start at 1)", () => {
    expect(parseOutcomeActionId("outcome:bug:0")).toBeUndefined();
  });

  it("round-trips with getOutcomeServiceButtons", () => {
    const id = getOutcomeServiceButtons(123)[0].components[0].custom_id;
    expect(parseOutcomeActionId(id)).toBe(123);
  });
});

describe("navResponseMode — update vs reply (Discord 50035 guard)", () => {
  it("edits in place only for a Components-V2 ephemeral source (the nav views)", () => {
    expect(navResponseMode({ ephemeral: true, componentsV2: true })).toBe("update");
  });

  it("replies fresh from a legacy-embed ephemeral source (the action outcome) — can't toggle into V2", () => {
    expect(navResponseMode({ ephemeral: true, componentsV2: false })).toBe("reply");
  });

  it("replies fresh from a public message — never overwrites the shared copy", () => {
    expect(navResponseMode({ ephemeral: false, componentsV2: true })).toBe("reply");
    expect(navResponseMode({ ephemeral: false, componentsV2: false })).toBe("reply");
  });
});
