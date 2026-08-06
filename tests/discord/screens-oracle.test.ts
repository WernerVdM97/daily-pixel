/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// ── NO IdleMessageSelector mock, by design ──
// The six screens are single-reply flows: none of the handlers or the dispatcher's
// screen paint reads randomIdleMessage, and no nav target below fires the nav:sleep
// "Bedding down…" beat (the reason the M7.0 file mocks it). The recon note in
// json-seam-protocol.md (M8.0) records this — the mock would be dead weight here.

import { dispatchInteraction } from "../../src/discord/dispatchInteraction.js";
import {
  makeHarness,
  oracleChar,
  slashInteraction,
  buttonInteraction,
  snapshotAcks,
  type Recorded,
} from "./dispatch-harness.js";

/**
 * M8.0 — screens oracle (golden-transcript characterisation).
 *
 * Dispatch-level golden transcripts for every read-only-screen path the M8.1
 * seam migration will touch: the six screens' slash + nav arms, the charless
 * edges, look's null-location branch, and the character-gate reroute (a third
 * gated command — M1 owns /stats, M7.0 owns /sleep). Same pattern as the M7.0
 * bookend oracle: the REAL `dispatchInteraction`, hoisted mocks where the path
 * fires them, fake Date pinned to Wednesday 2026-07-15, a UNIQUE userId per
 * transcript, and a fresh `makeHarness()` per transcript.
 *
 * "Characterise, don't judge": snapshots capture CURRENT behaviour verbatim —
 * including anything that looks off — and never fix it (a fix here would poison
 * the M8.1 baseline). Known oddities are flagged in the transcript comments and
 * carried as review notes.
 */

// ── Determinism: freeze the clock (uniform with the two sibling oracles; the
// screens themselves never read Date) ──
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
});
afterAll(() => vi.useRealTimers());

/** At least one ack fired with real content (the M1.2 nonEmpty pattern). */
function nonEmpty(acks: Recorded[]): void {
  expect(acks.length).toBeGreaterThan(0);
  const meaningful = acks.some(
    (a) =>
      a.arg != null &&
      typeof a.arg === "object" &&
      ("embeds" in (a.arg as object) ||
        "components" in (a.arg as object) ||
        "content" in (a.arg as object) ||
        "toJSON" in (a.arg as object)),
  );
  expect(meaningful).toBe(true);
}

// Components V2 type constants (mirrors format.ts) — used to read reply text out of
// buildComponentPayload containers.
const CT_CONTAINER = 17;
const CT_TEXT_DISPLAY = 10;

/** Join the TEXT_DISPLAY section contents of a Components V2 payload. */
function payloadText(payload: unknown): string {
  const comps =
    ((payload as { components?: unknown } | null | undefined)?.components as
      | Array<{ type: number; components?: Array<{ type: number; content?: string }> }>
      | undefined) ?? [];
  const container = comps.find((c) => c.type === CT_CONTAINER);
  return (container?.components ?? [])
    .filter((c) => c.type === CT_TEXT_DISPLAY)
    .map((c) => c.content ?? "")
    .join("\n");
}

/** The nav-button custom_ids a payload carries (rows after the container). */
function navIds(payload: unknown): string[] {
  const comps =
    ((payload as { components?: unknown } | null | undefined)?.components as
      | Array<{ type: number; components?: Array<{ custom_id?: string }> }>
      | undefined) ?? [];
  return comps
    .slice(1)
    .flatMap((r) => (r.components ?? []).map((b) => b.custom_id ?? ""));
}

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures — deterministic, self-describing (values are the executor's choice)
// ═══════════════════════════════════════════════════════════════════════════

// look (transcripts 1, 3): a SAFE Oak, one charted neighbour + one frontier with a
// teaser, and one player + one NPC whose description is >100 chars (the `…` cut).
const OAK_LOCATION = {
  name: "The Warden's Oak",
  description: "The great oak at the heart of the Vale, its boughs heavy with lanterns.",
  tags: ["town", "oak"],
  isSafe: true,
  emoji: "🌳",
};
const OAK_EXITS = {
  neighbours: [{ name: "Town Square", direction: "E", difficulty: 1 }],
  frontiers: [{ direction: "N", teaser: "A thin trail climbs into the pines.", difficulty: 2 }],
};
const NPC_LONG_DESC =
  "An itinerant herbalist who claims the pines hide an old shrine to the forest mother, and who trades poultices and rumours in equal measure, watching the northern trail."; // 168 chars
const OAK_ENTITIES = [
  { name: "Bryn", classOrType: "Rogue", description: null, isPlayer: true },
  { name: "Elara", classOrType: "Herbalist", description: NPC_LONG_DESC, isPlayer: false },
];

// map (transcripts 6, 7): a canned graph with a `current` marker + nodes/edges/frontiers.
const MAP_GRAPH = {
  current: "The Warden's Oak",
  nodes: [
    { name: "The Warden's Oak", emoji: "🌳", isSafe: true, nodeTier: 0, region: "The Vale", lastVisitedAt: "2026-07-15T09:00:00Z" },
    { name: "Town Square", emoji: "🏛️", isSafe: true, nodeTier: 1, region: "The Vale", lastVisitedAt: "2026-07-14T12:00:00Z" },
    { name: "The Broken Keep", emoji: "🏚️", isSafe: false, nodeTier: 2, region: "The Grey Hills", lastVisitedAt: "2026-07-13T12:00:00Z" },
  ],
  edges: [
    { from: "The Warden's Oak", to: "Town Square", direction: "E", difficulty: 1, flavour: null },
    { from: "Town Square", to: "The Broken Keep", direction: "N", difficulty: 2, flavour: null },
  ],
  frontiers: [
    { from: "The Warden's Oak", direction: "N", teaser: "A thin trail climbs into the pines.", difficulty: 2 },
  ],
};

// stats (transcript 9): items with NONZERO modifiers so the gear breakdown renders.
const STATS_ITEMS = [
  { id: 1, characterId: 1, name: "Iron Sword", emoji: "⚔️", stat: "physical", modifier: 2, quantity: 1 },
  { id: 2, characterId: 1, name: "Traveler's Cloak", emoji: "🧥", stat: "wisdom", modifier: 1, quantity: 1 },
];

// backpack (transcripts 11, 12): a quantity-2 item (grid + x2 suffix) and a 0-modifier
// utility item (the 📦 Utility block), plus a plain gear item for the stat group.
const BACKPACK_ITEMS = [
  { id: 1, characterId: 1, name: "Iron Sword", emoji: "⚔️", stat: "physical", modifier: 2, quantity: 1 },
  { id: 2, characterId: 1, name: "Throwing Daggers", emoji: "🗡️", stat: "physical", modifier: 1, quantity: 2 },
  { id: 3, characterId: 1, name: "Rations", emoji: "🍞", stat: "wisdom", modifier: 0, quantity: 3 },
];

// journal (transcripts 14, 15): a success with a discovery rail, a failure with a
// >140-char narrative (the truncation), and an NPC with class + location.
const FAIL_NARRATIVE =
  "The merchant's grin thins as you offer far too little for the smoked venison, and the haggling grinds on through the afternoon until the market bell drives the crowd away and the stall folds for the night with nothing exchanged but hard words and colder stares."; // 261 chars
const JOURNAL = {
  knownLocations: ["The Warden's Oak", "Town Square", "The Grey Hills"],
  currentLocation: "The Warden's Oak",
  npcsEncountered: [{ name: "Elara", class: "Herbalist", location: "The Warden's Oak" }],
  recentActions: [
    {
      type: "scout the ridge",
      outcome: "success",
      createdAt: "2026-07-15T10:00:00Z",
      narrative: "You crest the ridge and spy the Broken Keep below, its gate ajar.",
      location: "The Grey Hills",
      locationEmoji: "🏚️",
      discoveries: ["You sighted **The Broken Keep** on the north road."],
    },
    {
      type: "haggle for supplies",
      outcome: "failure",
      createdAt: "2026-07-14T16:00:00Z",
      narrative: FAIL_NARRATIVE,
      location: "Town Square",
      locationEmoji: "🏛️",
      discoveries: [],
    },
  ],
};

// The nav-bar shapes per current command (oracleChar: rollsRemaining 3 → Action shows,
// Rest hidden). View buttons only on their listed pages; the current command's own
// button is excluded (getNavButtons).
const NAV_LOOK = ["nav:hi", "nav:journal", "nav:action", "nav:stats", "nav:backpack", "nav:map"];
const NAV_MAP = ["nav:hi", "nav:journal", "nav:action", "nav:look", "nav:stats", "nav:backpack"];
const NAV_STATS = ["nav:hi", "nav:journal", "nav:action", "nav:look", "nav:backpack", "nav:map"];
const NAV_BACKPACK = ["nav:hi", "nav:journal", "nav:action", "nav:look", "nav:stats", "nav:map"];
const NAV_JOURNAL = ["nav:hi", "nav:action", "nav:look", "nav:stats", "nav:backpack", "nav:map"];
// help has no nav button in NAV_BUTTONS and no view button lists 'help' in
// showOnPages — only the globals (hi/journal/action) render.
const NAV_HELP = ["nav:hi", "nav:journal", "nav:action"];

// ═══════════════════════════════════════════════════════════════════════════
// look — 5 transcripts (the M8.1 look crossing's net)
// ═══════════════════════════════════════════════════════════════════════════

describe("screens oracle — look", () => {
  it("1 · slash /look with-char → full scene (code block, location, safe block, Paths, entities) + nav bar", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setLocation(OAK_LOCATION as never);
    h.engine.setExits(OAK_EXITS as never);
    h.engine.setNearbyEntities(OAK_ENTITIES as never);
    const { intr, _acks } = slashInteraction("slash-look", "look");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    // Branch-fired reads: the char's location, then the charted neighbour's (the
    // mock resolves EVERY name to the single canned location — see review notes).
    expect(h.engine.calls.getLocation).toEqual(["The Warden's Oak", "Town Square"]);
    expect(h.engine.calls.getNearbyEntities).toEqual([1]);
    expect(h.engine.calls.getExits).toEqual(["The Warden's Oak"]); // M8.1 residual: log-proven now
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    expect((reply.arg as any).flags).toBe(32768 | 64); // Components V2 + ephemeral
    const text = payloadText(reply.arg);
    // The harness's fixed scene-renderer stub — M8.0 pins the code-block wrapper, not real art.
    expect(text).toContain("```\n...\n```");
    expect(text).toContain("🌳 **The Warden's Oak**");
    expect(text).toContain("🛡️ This is a **safe** location. Rest and recover.");
    expect(text).toContain("**🧭 Paths**");
    expect(text).toContain("🏃 ⬆️ *uncharted* — _A thin trail climbs into the pines._");
    // Charted neighbour: mock's single-location staleness gives it the Oak's glyph.
    expect(text).toContain("🚶 ➡️ 🌳🛡️ Town Square");
    expect(text).toContain("**🌟 Nearby Adventurers**");
    expect(text).toContain("**Bryn** — Rogue");
    expect(text).toContain("**Other Figures**");
    expect(text).toContain(`🌿 **Elara** — _${NPC_LONG_DESC.slice(0, 100)}…_`);
    expect(navIds(reply.arg)).toEqual(NAV_LOOK);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("2 · slash /look with-char at a null location → 'lost to the warden's sight'; no exits/entities reads", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setLocation(null);
    const { intr, _acks } = slashInteraction("slash-look-null-loc", "look");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.getLocation).toEqual(["The Warden's Oak"]);
    expect(h.engine.calls.getNearbyEntities.length).toBe(0);
    expect(h.engine.calls.getExits.length).toBe(0); // M8.1 residual: log-proven now
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    const text = payloadText(reply.arg);
    expect(text).toContain(
      "You are at **The Warden's Oak**, but something feels off. The location is lost to the warden's sight.",
    );
    expect(navIds(reply.arg)).toEqual(NAV_LOOK);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("3 · nav:look (with-char) → the same scene through the generic nav branch + stamp", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setLocation(OAK_LOCATION as never);
    h.engine.setExits(OAK_EXITS as never);
    h.engine.setNearbyEntities(OAK_ENTITIES as never);
    const { intr, _acks } = buttonInteraction("nav-look", "nav:look");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.updateLastPlayed).toContain(1); // nav branch stamps pre-handler
    expect(h.engine.calls.getLocation).toEqual(["The Warden's Oak", "Town Square"]);
    expect(h.engine.calls.getNearbyEntities).toEqual([1]);
    expect(h.engine.calls.getExits).toEqual(["The Warden's Oak"]); // M8.1 residual: log-proven now
    const reply = _acks.find((a) => a.method === "reply")!;
    expect((reply.arg as any).flags).toBe(32768 | 64); // ephemeral per-clicker reply
    const text = payloadText(reply.arg);
    expect(text).toContain("🌳 **The Warden's Oak**");
    expect(text).toContain("🛡️ This is a **safe** location. Rest and recover.");
    expect(text).toContain("🏃 ⬆️ *uncharted* — _A thin trail climbs into the pines._");
    expect(text).toContain("🚶 ➡️ 🌳🛡️ Town Square");
    expect(text).toContain(`🌿 **Elara** — _${NPC_LONG_DESC.slice(0, 100)}…_`);
    expect(navIds(reply.arg)).toEqual(NAV_LOOK);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("4 · nav:look charless → 'first' copy, NO nav bar, no stamp, zero look reads", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.engine.setCharacter(null);
    const { intr, _acks } = buttonInteraction("nav-look-charless", "nav:look");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.updateLastPlayed.length).toBe(0); // the stamp no-ops without a char
    expect(h.engine.calls.characterExists.length).toBe(0); // the nav branch is ungated
    expect(h.engine.calls.getLocation.length).toBe(0);
    expect(h.engine.calls.getNearbyEntities.length).toBe(0);
    expect(h.engine.calls.getExits.length).toBe(0); // M8.1 residual: log-proven now
    const reply = _acks.find((a) => a.method === "reply")!;
    const text = payloadText(reply.arg);
    // M8.1 (DC-M8.4): the "yet"→"first" unification — the genuinely-reachable charless
    // nav edge now paints the router's NO_CHARACTER_COPY (this is ONE of the five pinned
    // charless-nav snapshots that churns; the M8.1 gate reads "only these five").
    expect(text).toContain("You don't have a character. Type `/join` first.");
    expect((reply.arg as any).components.length).toBe(1); // container only — !char → no nav bar
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("5 · slash /look charless → character-gate reroute to the join wizard (deferReply + editReply, no look content)", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.engine.setCharacter(null);
    const { intr, _acks } = slashInteraction("slash-look-reroute", "look");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const methods = _acks.map((a) => a.method);
    expect(methods).toContain("deferReply");
    expect(methods).toContain("editReply");
    expect(methods).not.toContain("reply");
    expect(h.engine.calls.characterExists).toContain("slash-look-reroute");
    expect(h.engine.calls.getLocation.length).toBe(0);
    expect(h.engine.calls.getNearbyEntities.length).toBe(0);
    // The gate handed the interaction to the join wizard — a fresh session at step 1.
    expect(h.joinWizards.getSession("slash-look-reroute")!.step).toBe(1);
    const edit = _acks.find((a) => a.method === "editReply")!;
    expect((edit.arg as any).embeds[0].title).toBe("⚔️  Forge Your Hero");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// map — 3 transcripts (the M8.1 map crossing's net)
// ═══════════════════════════════════════════════════════════════════════════

describe("screens oracle — map", () => {
  it("6 · slash /map with-char + place option → the focus drill-down (options.getString('place') path)", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setDiscoveredGraph(MAP_GRAPH as never);
    const { intr, _acks } = slashInteraction("slash-map-focus", "map", { place: "Town Square" });
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.getCharacter).toContain("slash-map-focus");
    expect(h.engine.calls.getDiscoveredGraph).toEqual([1]); // M8.1 residual: log-proven now
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    const text = payloadText(reply.arg);
    expect(text).toContain("🗺️ **Aldric's Map** — 3 charted · 1 road into the unknown");
    // A node focus zooms to that node's own roads — NOT the full-map tree.
    expect(text).toContain("🏛️🛡️ **Town Square** · The Vale");
    expect(text).toContain("├─ 🏃 ⬆️ 🏚️⚠️ The Broken Keep");
    expect(text).toContain("└─ 🚶 ⬅️ 🌳🛡️ The Warden's Oak");
    expect(text).not.toContain("**Unexplored paths**");
    expect(navIds(reply.arg)).toEqual(NAV_MAP);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("7 · nav:map (with-char, no options) → the full-map render + nav bar + stamp", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setDiscoveredGraph(MAP_GRAPH as never);
    const { intr, _acks } = buttonInteraction("nav-map", "nav:map");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.getDiscoveredGraph).toEqual([1]); // M8.1 residual: log-proven now
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    const text = payloadText(reply.arg);
    expect(text).toContain("🗺️ **Aldric's Map** — 3 charted · 1 road into the unknown");
    expect(text).toContain("**The Vale** (home)");
    expect(text).toContain("🌳🛡️ The Warden's Oak  ◀ you are here");
    expect(text).toContain("└─ 🏛️🛡️🚶 Town Square");
    // Cross-region edge: the child rail is region-scoped, so the Broken Keep renders
    // as a root in its own region (no effort glyph, no indent) rather than under Town Square.
    expect(text).toContain("🏚️⚠️ The Broken Keep");
    expect(text).toContain("**Unexplored paths**");
    expect(text).toContain("└─ 🏃 ⬆️ A thin trail climbs into the pines.");
    expect(navIds(reply.arg)).toEqual(NAV_MAP);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("8 · nav:map charless → 'first' copy, no nav bar, no stamp", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.engine.setCharacter(null);
    const { intr, _acks } = buttonInteraction("nav-map-charless", "nav:map");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.updateLastPlayed.length).toBe(0);
    expect(h.engine.calls.getDiscoveredGraph.length).toBe(0); // M8.1 residual: log-proven now
    const reply = _acks.find((a) => a.method === "reply")!;
    // M8.1 (DC-M8.4): the "yet"→"first" unification — one of the five pinned charless-nav snapshots.
    expect(payloadText(reply.arg)).toContain("You don't have a character. Type `/join` first.");
    expect((reply.arg as any).components.length).toBe(1);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// stats — 2 nav transcripts only (M1 owns the slash arms)
// ═══════════════════════════════════════════════════════════════════════════

describe("screens oracle — stats", () => {
  it("9 · nav:stats (with-char) → the stats sheet incl. the (+N base, +N 🎒) gear breakdown + nav bar + stamp", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setItems(STATS_ITEMS as never);
    const { intr, _acks } = buttonInteraction("nav-stats", "nav:stats");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.getItems).toContain(1);
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    const text = payloadText(reply.arg);
    expect(text).toContain("⚔️  **Aldric** — Warrior");
    expect(text).toContain("**Upbringing:** Village  |  **Race:** Human");
    expect(text).toContain("**Alignment:** lawful good");
    expect(text).toContain("**Day Job:** Town Guard");
    expect(text).toContain("💪 PHY  +5  (+3 base, +2 🎒)");
    expect(text).toContain("🧠 WIS  +0  (-1 base, +1 🎒)");
    expect(text).toContain("**Health:** 10/10  |  **Stamina:** 10/10");
    expect(text).toContain("**Location:** The Warden's Oak");
    expect(text).toContain("**Wealth:** 5 copper  |  **Rolls:** 3");
    expect(navIds(reply.arg)).toEqual(NAV_STATS);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("10 · nav:stats charless → 'first' copy, no nav bar, no stamp", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.engine.setCharacter(null);
    const { intr, _acks } = buttonInteraction("nav-stats-charless", "nav:stats");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.updateLastPlayed.length).toBe(0);
    expect(h.engine.calls.getItems.length).toBe(0);
    const reply = _acks.find((a) => a.method === "reply")!;
    // M8.1 (DC-M8.4): the "yet"→"first" unification — one of the five pinned charless-nav snapshots.
    expect(payloadText(reply.arg)).toContain("You don't have a character. Type `/join` first.");
    expect((reply.arg as any).components.length).toBe(1);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// backpack — 3 transcripts (the M8.1 backpack crossing's net)
// ═══════════════════════════════════════════════════════════════════════════

describe("screens oracle — backpack", () => {
  it("11 · slash /backpack with-char → emoji grid (quantity-2 item) + stat groups + 📦 Utility block", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setItems(BACKPACK_ITEMS as never);
    const { intr, _acks } = slashInteraction("slash-backpack", "backpack");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.getItems).toContain(1);
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    const text = payloadText(reply.arg);
    expect(text).toContain("🎒 **Backpack** (6/40)");
    expect(text).toContain("💪 **Physical** (+3)");
    expect(text).toContain("├─ ⚔️ Iron Sword +2");
    expect(text).toContain("└─ 🗡️ Throwing Daggers +1 x2");
    expect(text).toContain("📦 **Utility**");
    expect(text).toContain("└─ 🍞 Rations x3");
    expect(navIds(reply.arg)).toEqual(NAV_BACKPACK);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("12 · nav:backpack (with-char) → the same content + nav bar + stamp", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setItems(BACKPACK_ITEMS as never);
    const { intr, _acks } = buttonInteraction("nav-backpack", "nav:backpack");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.getItems).toContain(1);
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    const text = payloadText(reply.arg);
    expect(text).toContain("🎒 **Backpack** (6/40)");
    expect(text).toContain("└─ 🗡️ Throwing Daggers +1 x2");
    expect(text).toContain("📦 **Utility**");
    expect(text).toContain("└─ 🍞 Rations x3");
    expect(navIds(reply.arg)).toEqual(NAV_BACKPACK);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("13 · nav:backpack charless → 'first' copy, no nav bar, no stamp", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.engine.setCharacter(null);
    const { intr, _acks } = buttonInteraction("nav-backpack-charless", "nav:backpack");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.updateLastPlayed.length).toBe(0);
    expect(h.engine.calls.getItems.length).toBe(0);
    const reply = _acks.find((a) => a.method === "reply")!;
    // M8.1 (DC-M8.4): the "yet"→"first" unification — one of the five pinned charless-nav snapshots.
    expect(payloadText(reply.arg)).toContain("You don't have a character. Type `/join` first.");
    expect((reply.arg as any).components.length).toBe(1);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// journal — 3 transcripts (the M8.1 journal crossing's net)
// ═══════════════════════════════════════════════════════════════════════════

describe("screens oracle — journal", () => {
  it("14 · slash /journal with-char → chronicle (success + discovery rail, truncated failure) + NPC list + /map sign-off", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setJournal(JOURNAL as never);
    const { intr, _acks } = slashInteraction("slash-journal", "journal");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.getJournal).toContain(1);
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    const text = payloadText(reply.arg);
    expect(text).toContain("📖 **Aldric's Journal**");
    expect(text).toContain("**📜 Chronicle**");
    expect(text).toContain(
      "🏚️ The Grey Hills · You crest the ridge and spy the Broken Keep below, its gate ajar. — ✅ **Success**",
    );
    expect(text).toContain("    └─ You sighted **The Broken Keep** on the north road.");
    expect(text).toContain(`🏛️ Town Square · ${FAIL_NARRATIVE.slice(0, 137)}… — ❌ **Failed**`);
    expect(text).toContain("**🧑‍🤝‍🧑 NPCs Encountered**");
    // Note: the handler trims the line, so the intended two-space indent is stripped
    // (journal.ts: `…`.trim()` on the `  • ` template) — pinned verbatim, not fixed.
    expect(text).toContain("• **Elara** the Herbalist (at The Warden's Oak)");
    expect(text).toContain("*Use `/map` to see where you've been.*");
    expect(navIds(reply.arg)).toEqual(NAV_JOURNAL);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("15 · nav:journal (with-char) → the same content + nav bar + stamp", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setJournal(JOURNAL as never);
    const { intr, _acks } = buttonInteraction("nav-journal", "nav:journal");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.getJournal).toContain(1);
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    const text = payloadText(reply.arg);
    expect(text).toContain("🏚️ The Grey Hills · You crest the ridge and spy the Broken Keep below, its gate ajar. — ✅ **Success**");
    expect(text).toContain(`🏛️ Town Square · ${FAIL_NARRATIVE.slice(0, 137)}… — ❌ **Failed**`);
    expect(text).toContain("• **Elara** the Herbalist (at The Warden's Oak)");
    expect(navIds(reply.arg)).toEqual(NAV_JOURNAL);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("16 · nav:journal charless → 'first' copy, no nav bar, no stamp", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.engine.setCharacter(null);
    const { intr, _acks } = buttonInteraction("nav-journal-charless", "nav:journal");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.updateLastPlayed.length).toBe(0);
    expect(h.engine.calls.getJournal.length).toBe(0);
    const reply = _acks.find((a) => a.method === "reply")!;
    // M8.1 (DC-M8.4): the "yet"→"first" unification — one of the five pinned charless-nav snapshots.
    expect(payloadText(reply.arg)).toContain("You don't have a character. Type `/join` first.");
    expect((reply.arg as any).components.length).toBe(1);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// help — 2 transcripts (the M8.1 screen.help crossing's net)
// ═══════════════════════════════════════════════════════════════════════════

describe("screens oracle — help", () => {
  it("17 · slash /help with-char → command list + Economy block; globals-only nav bar", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    const { intr, _acks } = slashInteraction("slash-help", "help");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    const text = payloadText(reply.arg);
    expect(text).toContain("📜 **The Warden's Oak — Command List**");
    expect(text).toContain("**Economy**");
    expect(text).toContain("`/help`     — This list");
    // help is absent from NAV_BUTTONS entirely and no view button lists 'help' in
    // showOnPages — only the globals render.
    expect(navIds(reply.arg)).toEqual(NAV_HELP);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("18 · slash /help charless → the SAME content, NO gate reroute, characterExists never called", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.engine.setCharacter(null);
    const { intr, _acks } = slashInteraction("slash-help-charless", "help");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    // help is NOT in CHARACTER_GATED_COMMANDS — the membership check short-circuits,
    // so characterExists never runs (the DC-M8.3 no-gate design for screen.help).
    expect(h.engine.calls.characterExists.length).toBe(0);
    expect(h.engine.calls.updateLastPlayed.length).toBe(0); // stamp no-ops without a char
    const methods = _acks.map((a) => a.method);
    expect(methods).toEqual(["reply"]); // single reply, no defer/editReply reroute
    const reply = _acks.find((a) => a.method === "reply")!;
    const text = payloadText(reply.arg);
    expect(text).toContain("📜 **The Warden's Oak — Command List**");
    expect(text).toContain("**Economy**");
    expect(text).toContain("`/help`     — This list");
    expect((reply.arg as any).components.length).toBe(1); // !char → no nav bar
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});
