/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// ── Determinism: pin the idle-message RNG before the module graph loads ──
// The slash `/action` interstitial ("**You:** …\n\n⏳ **Starting…**\n_${idle}_") DOES
// fire this path (unlike M8.0's read-only screens) — fixed so the snapshot is stable.
vi.mock("../../src/engine/IdleMessageSelector.js", () => ({
  randomIdleMessage: () => "The warden tends the fire.",
}));

// ── Determinism: neutralise the public broadcast + collapse notice (the M1 pattern) ──
const { broadcastOutcomeSpy, announceCollapseSpy } = vi.hoisted(() => ({
  broadcastOutcomeSpy: vi.fn(async () => {}),
  announceCollapseSpy: vi.fn(async () => {}),
}));
vi.mock("../../src/discord/weekly-recap.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/discord/weekly-recap.js")>()),
  broadcastOutcome: broadcastOutcomeSpy,
}));
vi.mock("../../src/discord/collapse.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/discord/collapse.js")>()),
  announceCollapse: announceCollapseSpy,
}));

import { dispatchInteraction } from "../../src/discord/dispatchInteraction.js";
import type { ActionOutcome, ActionResumeResult } from "../../src/engine/WorldEngine.js";
import {
  makeHarness,
  oracleChar,
  slashInteraction,
  snapshotAcks,
  type Recorded,
} from "./dispatch-harness.js";

/**
 * M9.0 — action-paths oracle (golden-transcript characterisation).
 *
 * Dispatch-level golden transcripts for the two surfaces the M9 port will rewrite and no
 * oracle covers today: the slash `/action` arm (guards, day-job menu fallback, resume,
 * stale, divine intervention, auto-finish + broadcast, first decision) and the `/feedback`
 * + `/bug` slash arms. Same pattern as the M7.0/M8.0 oracles: the REAL `dispatchInteraction`,
 * hoisted mocks where the path fires them, fake Date pinned to Wednesday 2026-07-15, a
 * UNIQUE userId per transcript, and a fresh `makeHarness()` per transcript.
 *
 * "Characterise, don't judge": snapshots capture CURRENT behaviour verbatim — including
 * anything that looks off — and never fix it (a fix here would poison the M9.2/M9.3
 * baseline). Known oddities are flagged in the transcript comments.
 */

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

// Components V2 type constants (mirrors format.ts) — needed ONLY for the /feedback + /bug
// transcripts (15-18), which paint through the generic dispatcher post-handler path
// (buildComponentPayload). Every /action screen below builds its OWN legacy embed inline
// ("/action manages its own buttons" — dispatchInteraction.ts ~:148) so none of its
// transcripts need this V2 unwrap.
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

/** The nav-button custom_ids a V2 payload carries (rows after the container). */
function navIds(payload: unknown): string[] {
  const comps =
    ((payload as { components?: unknown } | null | undefined)?.components as
      | Array<{ type: number; components?: Array<{ custom_id?: string }> }>
      | undefined) ?? [];
  return comps.slice(1).flatMap((r) => (r.components ?? []).map((b) => b.custom_id ?? ""));
}

/** Flatten a plain (non-V2) Discord button-row array — the shape `/action`'s own screens
 *  build directly (getNavButtons / getOutcomeServiceButtons / menuViewToDiscord all return
 *  plain `{ type, components: [{ custom_id, ... }] }` rows, never a V2 container). */
function rawIds(rows: unknown): string[] {
  return ((rows as Array<{ components: Array<{ custom_id: string }> }>) ?? []).flatMap((r) =>
    r.components.map((b) => b.custom_id),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures — deterministic, self-describing (values are the executor's choice)
// ═══════════════════════════════════════════════════════════════════════════

// A first-decision result (no `actionType` — deliberately omitted, mirroring the M1 oracle's
// DECISION_RESULT: buildDecisionMessage then renders no OPENING frame, keeping the ANSI
// frame renderer out of this oracle's determinism scope).
const DECISION_RESULT = {
  state: { rawInput: "scout the northern ridge", decisions: [], accumulatedDc: 10, kind: "quest" },
  firstDecision: {
    prompt: "The trail forks at a mossy stone. Which way?",
    options: [
      { label: "Take the left fork", dcModifier: 0, stat: "physical" },
      { label: "Take the right fork", dcModifier: 2 },
    ],
  },
};

const RESOLVED_OUTCOME: ActionOutcome = {
  distilledType: "scout",
  finalDc: 11,
  playerRolled: 14,
  outcome: "success",
  rollBonus: 3,
  rollStat: "physical",
  mutations: [{ type: "modify_stamina", amount: -1 }],
  outcomeText: "You crest the ridge and chart the northern approach.",
  actionId: 88,
};

// A resolved `ActionStartResult` (LLM auto-finished at start) — no `actionType` (same
// determinism-scope reasoning as DECISION_RESULT; `firstDecision` is never read once
// `outcome` is present).
const RESOLVED_START_RESULT = {
  state: { rawInput: "scout the northern ridge", decisions: [], accumulatedDc: 11, kind: "quest" },
  firstDecision: { prompt: "", options: [] },
  outcome: RESOLVED_OUTCOME,
};

const DIVINE_OUTCOME: ActionOutcome = {
  distilledType: "divine",
  finalDc: 0,
  playerRolled: null,
  outcome: "skipped",
  mutations: [],
  outcomeText: "A quiet hand steadies your roll — this one didn't count against you.",
  isDivineIntervention: true,
};

const DIVINE_RESULT = {
  state: { rawInput: "pray at the shrine", decisions: [], accumulatedDc: 10, kind: "quest" },
  firstDecision: { prompt: "", options: [] },
  outcome: DIVINE_OUTCOME,
};

const RESUME_DECISION_RESULT: ActionResumeResult = {
  state: {
    rawInput: "scout the northern ridge",
    decisions: [
      { prompt: "The gate creaks. What do you do?", options: [], chosen: "Advance carefully", dcModifier: 0 },
    ],
    accumulatedDc: 11,
  },
  nextDecision: {
    prompt: "A shadow shifts ahead. Press on?",
    options: [
      { label: "Push forward", dcModifier: 1 },
      { label: "Fall back", dcModifier: 0 },
    ],
  },
};

// The 280-char boundary text for transcript 6 (candidate churn class b — the router's
// action.custom will clip at 280, the slash arm today does not).
const LONG_DESCRIPTION =
  "I creep along the tree line at the edge of the northern ridge, watching the mist for any sign of movement, listening for hoofbeats or voices on the wind, and marking every game trail and broken branch that might tell me which way the herd has gone before the light fails and the cold sets in for the night."; // 306 chars

describe("action oracle — slash /action guards + gate", () => {
  it("1 · charless slash /action → the character-gate reroute (join wizard step 1); the handler's own 'yet' copy never paints", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.engine.setCharacter(null);
    const { intr, _acks } = slashInteraction("action-1-charless", "action");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.characterExists).toContain("action-1-charless");
    // The handler never ran: no engine reads from inside makeActionCommand.
    expect(h.engine.calls.getCharacter.length).toBe(0);
    expect(h.engine.calls.startAction.length).toBe(0);
    expect(h.engine.calls.resumeAction.length).toBe(0);
    const methods = _acks.map((a) => a.method);
    expect(methods).toContain("deferReply");
    expect(methods).toContain("editReply");
    expect(methods).not.toContain("reply");
    expect(h.joinWizards.getSession("action-1-charless")!.step).toBe(1);
    const edit = _acks.find((a) => a.method === "editReply")!;
    expect((edit.arg as any).embeds[0].title).toBe("⚔️  Forge Your Hero");
    // Settles DC-M9.10 churn class 1's vacuity: the gate reroute paints the join wizard,
    // never the handler's "You don't have a character yet…" copy at commands/action.ts:60.
    expect(JSON.stringify(edit.arg)).not.toContain("You don't have a character yet");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("2 · with-char, 0 rolls, no description → 🛌 Out of actions, ephemeral reply, no defer, no nav bar, no stamp", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar({ rollsRemaining: 0, lastActionState: null }));
    const { intr, _acks } = slashInteraction("action-2-norolls", "action");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.characterExists).toContain("action-2-norolls");
    const methods = _acks.map((a) => a.method);
    expect(methods).toEqual(["reply"]);
    const reply = _acks[0];
    expect((reply.arg as any).content).toBe(
      "🛌 **Out of actions for today.**\nRest by the Oak (`/sleep`) and try again tomorrow.",
    );
    expect((reply.arg as any).flags).toBe(64); // MessageFlags.Ephemeral
    expect((reply.arg as any).components).toBeUndefined();
    // DC-M9.2.4 class 3 (inverted from M9.0): the router's menu.open flow stamps FIRST on
    // EVERY arm, including this guard rejection — a call-log change the byte gate can't see.
    expect(h.engine.calls.updateLastPlayed).toEqual([1]);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});

describe("action oracle — bare slash /action (day-job menu)", () => {
  it("3 · bare /action with-char, rolls > 0 → the day-job menu (composeActionMenu embed + buttons), fetchReply stash, no stamp", async () => {
    const h = makeHarness();
    h.engine.setMeta("day_number", "1");
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    const { intr, _acks } = slashInteraction("action-3-menu", "action");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const methods = _acks.map((a) => a.method);
    expect(methods).toContain("reply");
    expect(methods).toContain("fetchReply"); // the menu-message stash for the custom-modal delete
    const reply = _acks.find((a) => a.method === "reply")!;
    expect((reply.arg as any).flags).toBe(64); // ephemeral
    const embed = (reply.arg as any).embeds[0];
    expect(embed.title).toContain("Town Guard — Daily Work");
    expect(embed.description).toBe("Pick a task to start:");
    const buttons = (reply.arg as any).components[0].components as Array<{ custom_id: string; label: string }>;
    expect(buttons).toHaveLength(4); // 3 seeded day-job actions + Custom…
    expect(buttons.at(-1)).toMatchObject({ custom_id: "action:dayjob:custom", label: "Custom…" });
    // DC-M9.2.4 class 3 (inverted from M9.0's candidate churn class c): DC-P6's menu.open
    // flow order stamps FIRST, before the menu branch even runs.
    expect(h.engine.calls.updateLastPlayed).toEqual([1]);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("4 · bare /action where menu composition throws → the day-job fallback copy (composeActionMenu forced to throw via a spy on engine.getMeta — no MockWorldEngine widening)", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    // composeActionMenu's first read is engine.getMeta('day_number') — forcing IT to throw
    // reaches action.ts's catch without touching MockWorldEngine or fabricating a canned
    // value (the same vi.spyOn-throws technique the M1 oracle already established for
    // "a throwing engine read on /stats").
    vi.spyOn(h.engine, "getMeta").mockImplementation(() => {
      throw new Error("day_number lookup boom");
    });
    const { intr, _acks } = slashInteraction("action-4-menu-throws", "action");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const methods = _acks.map((a) => a.method);
    expect(methods).toEqual(["reply"]);
    const reply = _acks[0];
    expect((reply.arg as any).content).toContain("**Town Guard**");
    expect((reply.arg as any).content).toContain(
      "Use `/action <what you do>` to start an action.",
    );
    expect((reply.arg as any).flags).toBe(64);
    // DC-M9.2.4 class 3: stampLastPlayed fires first, before the fallback-composing attempt.
    expect(h.engine.calls.updateLastPlayed).toEqual([1]);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});

describe("action oracle — slash /action <text> (new action)", () => {
  it("5 · /action <text> with-char → the interstitial (⏳ Starting…) then the first-decision render; startAction(characterId, text)", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setStartActionResult(DECISION_RESULT as never);
    const { intr, _acks } = slashInteraction("action-5-start", "action", {
      description: "scout the northern ridge",
    });
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.startAction).toHaveLength(1);
    expect(h.engine.calls.startAction[0].characterId).toBe(1);
    expect(h.engine.calls.startAction[0].rawInput).toBe("scout the northern ridge");
    const methods = _acks.map((a) => a.method);
    expect(methods).toEqual(["deferReply", "editReply", "editReply"]);
    const interstitial = _acks[1];
    // DC-M9.2.4 class 1: the router's action.custom beat copy is "Thinking…", not "Starting…".
    expect((interstitial.arg as any).embeds[0].description).toBe(
      "**You:** scout the northern ridge\n\n⏳ **Thinking…**\n_The warden tends the fire._",
    );
    const decisionEdit = _acks[2];
    expect((decisionEdit.arg as any).embeds[0].description).toContain(
      "The trail forks at a mossy stone. Which way?",
    );
    const buttons = rawIds((decisionEdit.arg as any).components);
    expect(buttons).toEqual(["action:choice:0:0", "action:choice:0:1"]);
    expect(h.engine.calls.updateLastPlayed.length).toBe(0); // no-stamp property
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("6 · /action <text> with a >280-char description → the interstitial echoes it UNCLIPPED", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setStartActionResult(DECISION_RESULT as never);
    expect(LONG_DESCRIPTION.length).toBeGreaterThan(280);
    const { intr, _acks } = slashInteraction("action-6-long", "action", {
      description: LONG_DESCRIPTION,
    });
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const interstitial = _acks.find((a) => a.method === "editReply")!;
    // DC-M9.2.4 class 2: the router's action.custom clips the ECHOED interstitial text at
    // 280 chars — the slash arm echoed it uncut before the port. The unclipped text still
    // reaches the engine (asserted below via startAction's own call log).
    const clipped = `${LONG_DESCRIPTION.slice(0, 279).trimEnd()}…`;
    expect((interstitial.arg as any).embeds[0].description).toContain(`**You:** ${clipped}`);
    expect((interstitial.arg as any).embeds[0].description).not.toContain(LONG_DESCRIPTION);
    expect(h.engine.calls.startAction[0].rawInput).toBe(LONG_DESCRIPTION);
    expect(h.engine.calls.updateLastPlayed.length).toBe(0);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("7 · /action <text> → divine intervention → the grey ⚠️ System embed, no buttons, no broadcast/collapse", async () => {
    broadcastOutcomeSpy.mockClear();
    announceCollapseSpy.mockClear();
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setStartActionResult(DIVINE_RESULT as never);
    const { intr, _acks } = slashInteraction("action-7-divine", "action", {
      description: "pray at the shrine",
    });
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const final = _acks.at(-1)!;
    expect(final.method).toBe("editReply");
    expect((final.arg as any).embeds[0]).toMatchObject({
      title: "⚠️ System",
      description: DIVINE_OUTCOME.outcomeText,
      color: 0x95a5a6,
    });
    expect((final.arg as any).components).toEqual([]);
    // DC-M9.3's real gap: nothing else through the seam today renders this branch —
    // the screen this settled call exists to stop M9.2 deleting.
    expect(broadcastOutcomeSpy).not.toHaveBeenCalled();
    expect(announceCollapseSpy).not.toHaveBeenCalled();
    expect(h.engine.calls.updateLastPlayed.length).toBe(0);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("8 · /action <text> → auto-finish (non-divine) → outcome embed + nav buttons + service buttons; broadcastOutcome + announceCollapse each called once", async () => {
    broadcastOutcomeSpy.mockClear();
    announceCollapseSpy.mockClear();
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setStartActionResult(RESOLVED_START_RESULT as never);
    const { intr, _acks } = slashInteraction("action-8-autofinish", "action", {
      description: "scout the northern ridge",
    });
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const editReplies = _acks.filter((a) => a.method === "editReply");
    expect(editReplies).toHaveLength(2); // interstitial, then the outcome
    const outcomeEdit = editReplies[1];
    expect((outcomeEdit.arg as any).embeds[0].title).toContain("Scout");
    expect((outcomeEdit.arg as any).embeds[0].description).toContain(RESOLVED_OUTCOME.outcomeText);
    const navPlusService = rawIds((outcomeEdit.arg as any).components);
    expect(navPlusService).toEqual(["nav:hi", "nav:journal", "nav:action", "outcome:feedback:88", "outcome:bug:88"]);

    expect(broadcastOutcomeSpy).toHaveBeenCalledTimes(1);
    const broadcastArg = broadcastOutcomeSpy.mock.calls[0][0] as {
      payload: { content: string; components: unknown; allowedMentions: unknown };
    };
    expect(broadcastArg.payload.content).toContain("**Aldric** <@action-8-autofinish> — scout");
    expect(rawIds(broadcastArg.payload.components)).toEqual([
      "nav:hi",
      "outcome:feedback:88",
      "outcome:bug:88",
    ]);
    expect(broadcastArg.payload.allowedMentions).toEqual({ users: [] });

    expect(announceCollapseSpy).toHaveBeenCalledTimes(1);
    const [name, prev, next] = announceCollapseSpy.mock.calls[0];
    expect(name).toBe("Aldric");
    expect(prev).toMatchObject({ health: 10, stamina: 10 });
    expect(next).toMatchObject({ health: 10, stamina: 10 });
    expect(h.engine.calls.updateLastPlayed.length).toBe(0);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("9 · auto-finish where broadcastOutcome throws → the isolated inner catch: the private outcome stays painted, NO ❌ Could not act. repaint", async () => {
    broadcastOutcomeSpy.mockClear();
    announceCollapseSpy.mockClear();
    broadcastOutcomeSpy.mockRejectedValueOnce(new Error("recap thread down"));
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    h.engine.setStartActionResult(RESOLVED_START_RESULT as never);
    const { intr, _acks } = slashInteraction("action-9-broadcast-throws", "action", {
      description: "scout the northern ridge",
    });
    await dispatchInteraction(intr as never, h.deps);

    const methods = _acks.map((a) => a.method);
    expect(methods).toEqual(["deferReply", "editReply", "editReply"]);
    const outcomeEdit = _acks.at(-1)!;
    expect((outcomeEdit.arg as any).embeds[0].description).toContain(RESOLVED_OUTCOME.outcomeText);
    expect(JSON.stringify(outcomeEdit.arg)).not.toContain("Could not act");
    expect(broadcastOutcomeSpy).toHaveBeenCalledTimes(1);
    // announceCollapse sits inside the SAME try as broadcastOutcome — a throw skips it too.
    expect(announceCollapseSpy).not.toHaveBeenCalled();
    expect(h.engine.calls.updateLastPlayed.length).toBe(0);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("14 · /action <text> where startAction throws → ❌ Could not act. (the handler's OWN catch, notifyAdmin NOT called)", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    // No setStartActionResult → the mock's natural "no canned result set" throw.
    const { intr, _acks } = slashInteraction("action-14-start-throws", "action", {
      description: "scout the northern ridge",
    });
    await dispatchInteraction(intr as never, h.deps);

    const methods = _acks.map((a) => a.method);
    expect(methods).toEqual(["deferReply", "editReply", "editReply"]);
    const errorEdit = _acks.at(-1)!;
    expect((errorEdit.arg as any).content).toBe(
      "❌ **Could not act.**\nMockWorldEngine.startAction: no canned result set",
    );
    // Distinct from the M1 oracle's adapter-throw funnel transcript (an ADAPTER-side throw,
    // e.g. engine.getCharacter, escapes to dispatchInteraction's own catch). This is the
    // handler's inner try/catch around engine.startAction — it never escapes.
    expect(h.notifyAdmin).not.toHaveBeenCalled();
    expect(h.safeErrorReply).not.toHaveBeenCalled();
    expect(h.engine.calls.updateLastPlayed.length).toBe(0);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("19 · /action <text> with 0 rolls and no pending action → a single plain reply with the bare 🛌 copy (DC-M9.2 fix: the pre-port top guard moves behind beginCustomAction, deferred LAZILY so this guard rejection never pays for a defer), startAction never called, no stamp", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar({ rollsRemaining: 0, lastActionState: null }));
    const { intr, _acks } = slashInteraction("action-19-norolls-text", "action", {
      description: "scout the northern ridge",
    });
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    // The guard rejection returns before any router beat fires, so the lazy-defer never
    // triggers — a single plain ephemeral reply, matching transcript 2's bare-/action
    // ack shape exactly (no ❌ prefix, no defer-then-edit round trip).
    const methods = _acks.map((a) => a.method);
    expect(methods).toEqual(["reply"]);
    const reply = _acks[0];
    expect((reply.arg as any).content).toBe(
      "🛌 **Out of actions for today.**\nRest by the Oak (`/sleep`) and try again tomorrow.",
    );
    expect((reply.arg as any).flags).toBe(64); // MessageFlags.Ephemeral
    expect(h.engine.calls.startAction.length).toBe(0);
    expect(h.engine.calls.updateLastPlayed.length).toBe(0);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("20 · /action <text> while mid-action → resumes: deferReply then editReply, the decision at decisionIdx = state.decisions.length (DC-M9.2 fix: the resume arm has no beat, so the defer rides the late/decision-view branch, not the eager pre-restructure defer)", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(
      oracleChar({
        lastActionState: { rawInput: "scout the northern ridge", decisions: [{}], accumulatedDc: 11 },
      }),
    );
    h.engine.setResumeResult(RESUME_DECISION_RESULT);
    const { intr, _acks } = slashInteraction("action-20-resume-text", "action", {
      description: "keep scouting",
    });
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.resumeAction).toEqual([1]);
    expect(h.engine.calls.startAction.length).toBe(0);
    const methods = _acks.map((a) => a.method);
    expect(methods).toEqual(["deferReply", "editReply"]);
    const edit = _acks.at(-1)!;
    expect((edit.arg as any).embeds[0].description).toContain("A shadow shifts ahead. Press on?");
    expect(rawIds((edit.arg as any).components)).toEqual(["action:choice:1:0", "action:choice:1:1"]);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});

describe("action oracle — slash /action (mid-action resume)", () => {
  it("10 · mid-action → resume: deferReply, resumeAction(characterId), the decision at decisionIdx = state.decisions.length", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(
      oracleChar({
        lastActionState: { rawInput: "scout the northern ridge", decisions: [{}], accumulatedDc: 11 },
      }),
    );
    h.engine.setResumeResult(RESUME_DECISION_RESULT);
    const { intr, _acks } = slashInteraction("action-10-resume", "action");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.resumeAction).toEqual([1]);
    expect(h.engine.calls.startAction.length).toBe(0);
    const methods = _acks.map((a) => a.method);
    expect(methods).toEqual(["deferReply", "editReply"]);
    const edit = _acks.at(-1)!;
    expect((edit.arg as any).embeds[0].description).toContain("A shadow shifts ahead. Press on?");
    // decisionIdx = state.decisions.length (1, from RESUME_DECISION_RESULT's one prior record).
    expect(rawIds((edit.arg as any).components)).toEqual(["action:choice:1:0", "action:choice:1:1"]);
    // DC-M9.2.4 class 3: menu.open stamps first, on this resume arm too.
    expect(h.engine.calls.updateLastPlayed).toEqual([1]);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("11 · mid-action → stale resume (empty options, narration present) → ⏳ Stale Action embed with the withNarration prefix, no buttons", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(
      oracleChar({ lastActionState: { rawInput: "hunt", decisions: [], accumulatedDc: 10 } }),
    );
    h.engine.setResumeResult({
      state: { rawInput: "hunt", decisions: [], accumulatedDc: 10 },
      nextDecision: {
        prompt: "The trail has gone cold. Continue?",
        options: [],
        narration: "You stand over scattered tracks, unsure which lead to trust.",
      },
    });
    const { intr, _acks } = slashInteraction("action-11-stale", "action");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const edit = _acks.at(-1)!;
    expect((edit.arg as any).embeds[0].title).toBe("⏳ Stale Action");
    // The named-literal net for DC-M9.10 churn class 2 — the narration prefix DC-M9.4 drops.
    expect((edit.arg as any).embeds[0].description).toBe(
      "You stand over scattered tracks, unsure which lead to trust.\n\nThe trail has gone cold. Continue?",
    );
    expect((edit.arg as any).components).toEqual([]);
    expect(h.engine.calls.updateLastPlayed).toEqual([1]);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("12 · mid-action → stale resume, empty prompt AND no narration → the 'could not be recovered' fallback", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(
      oracleChar({ lastActionState: { rawInput: "hunt", decisions: [], accumulatedDc: 10 } }),
    );
    h.engine.setResumeResult({
      state: { rawInput: "hunt", decisions: [], accumulatedDc: 10 },
      nextDecision: { prompt: "", options: [] },
    });
    const { intr, _acks } = slashInteraction("action-12-stale-empty", "action");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const edit = _acks.at(-1)!;
    // DC-M9.2.4 class 5 (the M5 watch item, now settled): the handler's own
    // "Your previous action could not be recovered." fallback unifies onto the
    // controller's "Could not recover." — a copy unification on a dead edge.
    expect((edit.arg as any).embeds[0].description).toBe("Could not recover.");
    expect((edit.arg as any).components).toEqual([]);
    expect(h.engine.calls.updateLastPlayed).toEqual([1]);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("13 · mid-action where resumeAction throws → ❌ Could not resume.", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(
      oracleChar({ lastActionState: { rawInput: "hunt", decisions: [], accumulatedDc: 10 } }),
    );
    // No setResumeResult → the mock's natural "no canned result set" throw.
    const { intr, _acks } = slashInteraction("action-13-resume-throws", "action");
    await dispatchInteraction(intr as never, h.deps);

    const edit = _acks.at(-1)!;
    expect((edit.arg as any).content).toBe(
      "❌ **Could not resume.**\nMockWorldEngine.resumeAction: no canned result set",
    );
    expect(h.notifyAdmin).not.toHaveBeenCalled();
    expect(h.safeErrorReply).not.toHaveBeenCalled();
    expect(h.engine.calls.updateLastPlayed).toEqual([1]);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// /feedback + /bug — 4 transcripts. Unlike /action, these return a plain string and let
// the dispatcher's generic post-handler path paint it (buildComponentPayload, V2) —
// the opposite no-stamp property: their handler never calls reply/deferReply itself, so
// interaction.replied stays false and the post-handler stampLastPlayed DOES run.
// ═══════════════════════════════════════════════════════════════════════════

describe("action oracle — /feedback + /bug", () => {
  it("15 · slash /feedback with-char → 🙏 Thanks. The warden listens. + nav bar; submitFeedback(characterId, text); stamped", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    const { intr, _acks } = slashInteraction("feedback-15-withchar", "feedback", {
      text: "loving the atmosphere",
    });
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.submitFeedback).toEqual([
      { characterId: 1, text: "loving the atmosphere", actionId: undefined },
    ]);
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const methods = _acks.map((a) => a.method);
    expect(methods).toEqual(["reply"]);
    const reply = _acks[0];
    expect(payloadText(reply.arg)).toBe("🙏 Thanks. The warden listens.");
    expect((reply.arg as any).flags).toBe(32768 | 64); // Components V2 + ephemeral
    expect(navIds(reply.arg)).toEqual(["nav:hi", "nav:journal", "nav:action"]);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("16 · slash /feedback charless → the 'yet' copy, NO gate reroute (feedback isn't gated), no nav bar, submitFeedback not called", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.engine.setCharacter(null);
    const { intr, _acks } = slashInteraction("feedback-16-charless", "feedback", {
      text: "please add mounts",
    });
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    // feedback is NOT in CHARACTER_GATED_COMMANDS — characterExists never runs.
    expect(h.engine.calls.characterExists.length).toBe(0);
    expect(h.engine.calls.submitFeedback.length).toBe(0);
    expect(h.engine.calls.updateLastPlayed.length).toBe(0);
    const methods = _acks.map((a) => a.method);
    expect(methods).toEqual(["reply"]);
    const reply = _acks[0];
    // Declared churn class 3 (DC-M9.10, live per DC-M9.2.4): unifies onto "first" like
    // every other crossing.
    expect(payloadText(reply.arg)).toBe("You don't have a character. Type `/join` first.");
    expect((reply.arg as any).components.length).toBe(1); // container only — no nav bar
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("17 · slash /bug with-char → 🐛 Bug noted. The warden will investigate. + nav bar; submitBug(characterId, text); stamped", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    const { intr, _acks } = slashInteraction("bug-17-withchar", "bug", {
      text: "the map glitched",
    });
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.submitBug).toEqual([
      { characterId: 1, text: "the map glitched", actionId: undefined },
    ]);
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    expect(payloadText(reply.arg)).toBe("🐛 Bug noted. The warden will investigate.");
    expect(navIds(reply.arg)).toEqual(["nav:hi", "nav:journal", "nav:action"]);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("18 · slash /bug charless → the same 'yet' copy, no nav bar, submitBug not called", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.engine.setCharacter(null);
    const { intr, _acks } = slashInteraction("bug-18-charless", "bug", {
      text: "the map glitched",
    });
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.characterExists.length).toBe(0);
    expect(h.engine.calls.submitBug.length).toBe(0);
    expect(h.engine.calls.updateLastPlayed.length).toBe(0);
    const reply = _acks.find((a) => a.method === "reply")!;
    expect(payloadText(reply.arg)).toBe("You don't have a character. Type `/join` first.");
    expect((reply.arg as any).components.length).toBe(1);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});
