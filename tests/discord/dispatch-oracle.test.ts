/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// ── Determinism: pin the idle-message RNG before the module graph loads ──
// randomIdleMessage feeds the "Thinking…"/"Starting…" loading beats in the custom
// modal, day-job work flow and nav:sleep branches. Fixed → stable snapshots.
vi.mock("../../src/engine/IdleMessageSelector.js", () => ({
  randomIdleMessage: () => "The warden tends the fire.",
}));

// ── Determinism: neutralise the public broadcast + collapse notice ──
// The resolved/outcome render path fires broadcastOutcome (a Discord round-trip to the
// recap thread) and announceCollapse. Replace both with deterministic no-op spies so the
// golden snapshots capture only the PRIVATE outcome render (the M3-extraction target) and
// never depend on a Discord round-trip. Real siblings (META_RECAP_THREAD_ID, collapseNotice,
// …) are preserved via importActual. The decision-path transcripts never reach either
// function, so their existing snapshots are unaffected.
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
import type {
  ActionOutcome,
  ActionStartResult,
  ActionStepResult,
} from "../../src/engine/WorldEngine.js";
import {
  makeHarness,
  oracleChar,
  slashInteraction,
  buttonInteraction,
  modalInteraction,
  snapshotAcks,
  type Recorded,
} from "./dispatch-harness.js";

/**
 * M1.2 — behavioural oracle (golden-transcript characterisation).
 *
 * Drives the REAL `dispatchInteraction` and snapshots its output per leaf branch.
 * This is a characterisation baseline: it captures CURRENT behaviour verbatim —
 * it does not judge or fix any branch. The M3 controller extraction diffs against
 * these snapshots. Every transcript uses a UNIQUE userId (the four action/join
 * flow maps have no clear-all) and a fresh harness (fresh engine + registry +
 * WizardSession) so state never bleeds.
 */

// ── Determinism: freeze the clock (isWeekend() reads new Date().getDay()) ──
// 2026-07-15 is a Wednesday → /hi and nav:hi render day-job actions, not weekend hooks.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
});
afterAll(() => vi.useRealTimers());

/** A canned action result that stops on a first decision (no outcome → no broadcast). */
const DECISION_RESULT = {
  state: { rawInput: "Walk the rounds", decisions: [], accumulatedDc: 10, kind: "work" },
  firstDecision: {
    prompt: "The gate creaks. What do you do?",
    options: [
      { label: "Advance carefully", dcModifier: 0, stat: "physical" },
      { label: "Charge ahead", dcModifier: 2 },
    ],
  },
  // actionType intentionally omitted → buildDecisionMessage renders no OPENING frame
  // (the frame's renderer is out of this oracle's determinism scope).
};

const NEXT_DECISION_STEP = {
  resolved: false as const,
  state: { rawInput: "Advance carefully", decisions: [], accumulatedDc: 11 },
  nextDecision: {
    prompt: "A shadow shifts ahead. Press on?",
    options: [
      { label: "Push forward", dcModifier: 1 },
      { label: "Fall back", dcModifier: null },
    ],
  },
};

/**
 * A fully-resolved outcome. Every field is FIXED/literal so the outcome embed snapshots
 * deterministically; shape matches `ActionOutcome` (src/engine/WorldEngine.ts) as consumed by
 * buildOutcomeEmbed / formatOutcome (src/engine/OutcomeRenderer.ts). Mutations stay off the
 * vitals-to-0 path so no collapse notice fires.
 */
const RESOLVED_OUTCOME: ActionOutcome = {
  distilledType: "scout",
  finalDc: 11,
  playerRolled: 14,
  outcome: "success",
  rollBonus: 3,
  rollStat: "physical",
  mutations: [
    { type: "modify_stamina", amount: -1 },
    { type: "add_item", emoji: "🗺️", name: "Ridge Map" },
  ],
  outcomeText: "You crest the ridge and chart the valley below.",
  actionId: 77,
};

/** A resolved `ActionStartResult` (LLM auto-finished at start): `outcome` populated, so the
 *  dispatcher's `if (result.outcome)` branch renders the outcome embed. `firstDecision` is the
 *  auto-finish placeholder — never read once `outcome` is present. */
const RESOLVED_START_RESULT: ActionStartResult = {
  state: { rawInput: "scout the northern ridge", decisions: [], accumulatedDc: 11, kind: "quest" },
  firstDecision: { prompt: "", options: [] },
  outcome: RESOLVED_OUTCOME,
  actionType: "search",
};

/** As above but for the day-job work flow: `kind: 'work'` + a fixed `wage`. */
const RESOLVED_WORK_RESULT: ActionStartResult = {
  state: { rawInput: "Keep the gate — Walk the rounds", decisions: [], accumulatedDc: 11, kind: "work", wage: 5 },
  firstDecision: { prompt: "", options: [] },
  outcome: RESOLVED_OUTCOME,
  actionType: "other",
};

/** A resolved `ActionStepResult` (`resolved: true` + `outcome`) → applyActionResult's outcome branch. */
const RESOLVED_STEP_RESULT: ActionStepResult = {
  resolved: true,
  state: {
    rawInput: "Walk the rounds",
    decisions: [
      {
        prompt: "The gate creaks. What do you do?",
        options: [],
        chosen: "Advance carefully",
        dcModifier: 0,
        distilledType: "scout",
      },
    ],
    accumulatedDc: 11,
  },
  outcome: RESOLVED_OUTCOME,
};

/** True when any ack carried the outcome service buttons (`outcome:feedback`/`outcome:bug`),
 *  the tell that the resolved/outcome path rendered rather than a decision prompt. */
function hasOutcomeButtons(acks: Recorded[]): boolean {
  return acks.some((a) => {
    const comps = (a.arg as { components?: unknown } | null)?.components;
    if (!Array.isArray(comps)) return false;
    return comps.some(
      (row: unknown) =>
        Array.isArray((row as { components?: unknown }).components) &&
        (row as { components: unknown[] }).components.some(
          (b) =>
            typeof (b as { custom_id?: unknown }).custom_id === "string" &&
            ((b as { custom_id: string }).custom_id).startsWith("outcome:"),
        ),
    );
  });
}

function nonEmpty(acks: Recorded[]): void {
  expect(acks.length).toBeGreaterThan(0);
  // At least one ack carried real content (an embed, components, a modal, or text).
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

// ═══════════════════════════════════════════════════════════════════════════
// Leaf 1 — the slash-command arm (gate / reroute / nav-button assembly / error)
// ═══════════════════════════════════════════════════════════════════════════

describe("dispatch oracle — slash arm", () => {
  it("unknown command → ephemeral 'Unknown command'", async () => {
    const h = makeHarness();
    const { intr, _acks } = slashInteraction("slash-unknown", "frobnicate");
    await dispatchInteraction(intr as never, h.deps);

    expect(_acks[0].method).toBe("reply");
    expect((_acks[0].arg as any).content).toContain("Unknown command");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("/stats renders the stats view with a nav bar and stamps last-played", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    const { intr, _acks } = slashInteraction("slash-stats", "stats");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    // Components V2 container + at least one nav action row.
    expect((reply.arg as any).components.length).toBeGreaterThan(1);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("gated /stats with no character reroutes to the join wizard", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false); // no character → reroute
    h.engine.setCharacter(null);
    const { intr, _acks } = slashInteraction("slash-reroute", "stats");
    await dispatchInteraction(intr as never, h.deps);

    // The join handler owns defer+editReply; the stats sheet is never sent.
    const methods = _acks.map((a) => a.method);
    expect(methods).toContain("deferReply");
    expect(methods).toContain("editReply");
    expect(h.engine.calls.characterExists).toContain("slash-reroute");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("/sleep (non-admin goodnight) appends a Feedback button below the nav bar", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar({ rollsRemaining: 0, lastActionState: null }));
    const { intr, _acks } = slashInteraction("slash-sleep", "sleep");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const reply = _acks.find((a) => a.method === "reply")!;
    const rows = (reply.arg as any).components as any[];
    // Last row is the appended sleep:feedback button.
    const lastRow = rows[rows.length - 1];
    expect(lastRow.components[0].custom_id).toBe("sleep:feedback");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  // M8.1 (recorded drift, the M7.2 D2 pattern now pinned for /stats): /stats crosses the
  // seam as screen.stats, and the router NEVER throws — a throwing engine read is absorbed
  // into ok:false 'internal' and the handler paints the bare message as content, so the
  // dispatcher's catch (notifyAdmin + safeErrorReply) does NOT fire. The dispatcher catch
  // remains reachable for ADAPTER-side throws (the /action test right below).
  it("a throwing engine read on /stats surfaces as internal-error content through the seam (no notifyAdmin)", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    // openStats → composeStatsScreen calls engine.getItems — make it throw.
    vi.spyOn(h.engine, "getItems").mockImplementation(() => {
      throw new Error("boom");
    });
    const { intr, _acks } = slashInteraction("slash-error", "stats");
    await dispatchInteraction(intr as never, h.deps);

    expect(h.notifyAdmin).not.toHaveBeenCalled();
    expect(h.safeErrorReply).not.toHaveBeenCalled();
    const reply = _acks.find((a) => a.method === "reply")!;
    expect(JSON.stringify(reply.arg)).toContain("boom"); // the router's internal-error message IS the painted content
  });

  it("a throwing ADAPTER-side read (the engine-direct /action command) still routes through notifyAdmin + safeErrorReply", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    // /action is not through the seam until M9 — makeActionCommand reads the engine
    // directly, so a throw propagates to the dispatcher's slash catch.
    vi.spyOn(h.engine, "getCharacter").mockImplementation(() => {
      throw new Error("boom");
    });
    const { intr } = slashInteraction("slash-error-action", "action");
    await dispatchInteraction(intr as never, h.deps);

    expect(h.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(h.safeErrorReply).toHaveBeenCalledTimes(1);
    expect(h.safeErrorReply.mock.calls[0][1]).toContain("Something went wrong");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Leaves 2–14 — the customId branches (minus nav:, which has its own describe)
// ═══════════════════════════════════════════════════════════════════════════

describe("dispatch oracle — customId branches", () => {
  it("join: routes to the wizard (name step renders the class picker)", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.joinWizards.start("cid-join");
    const { intr, _acks } = modalInteraction("cid-join", "join:name:modal", "Rowan");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    // The wizard advanced to step 2 and edited in the next screen.
    expect(h.joinWizards.getSession("cid-join")!.step).toBe(2);
    expect(_acks.some((a) => a.method === "editReply")).toBe(true);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("action:dayjob:custom → opens the custom-action modal", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    const { intr, _acks } = buttonInteraction("cid-dj-custom", "action:dayjob:custom");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const modal = _acks.find((a) => a.method === "showModal")!;
    expect((modal.arg as any).toJSON().custom_id).toBe("action:custom:modal");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("action:custom:modal → thinking screen then a decision", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar({ lastActionState: null }));
    h.engine.setStartActionResult(DECISION_RESULT as never);
    const { intr, _acks } = modalInteraction(
      "cid-custom-modal",
      "action:custom:modal",
      "scout the northern ridge",
    );
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.startAction[0].rawInput).toBe("scout the northern ridge");
    const methods = _acks.map((a) => a.method);
    expect(methods).toContain("deferReply");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("sleep:feedback → opens the feedback modal", async () => {
    const h = makeHarness();
    const { intr, _acks } = buttonInteraction("cid-sleepfb", "sleep:feedback");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const modal = _acks.find((a) => a.method === "showModal")!;
    expect((modal.arg as any).toJSON().custom_id).toBe("sleep:feedback:modal");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("sleep:feedback:modal → thanks reply + submitFeedback", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    const { intr, _acks } = modalInteraction(
      "cid-sleepfb-modal",
      "sleep:feedback:modal",
      "loving the atmosphere",
    );
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.submitFeedback[0]).toMatchObject({
      characterId: 1,
      text: "loving the atmosphere",
    });
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("release:feedback → opens the request/feedback modal", async () => {
    const h = makeHarness();
    const { intr, _acks } = buttonInteraction("cid-relfb", "release:feedback");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const modal = _acks.find((a) => a.method === "showModal")!;
    expect((modal.arg as any).toJSON().custom_id).toBe("release:feedback:modal");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("release:feedback:modal → thanks reply + submitFeedback", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    const { intr, _acks } = modalInteraction(
      "cid-relfb-modal",
      "release:feedback:modal",
      "please add mounts",
    );
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.submitFeedback[0].text).toBe("please add mounts");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("outcome:feedback:<id> → opens the feedback modal carrying the action id", async () => {
    const h = makeHarness();
    const { intr, _acks } = buttonInteraction("cid-ofb", "outcome:feedback:42");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const modal = _acks.find((a) => a.method === "showModal")!;
    expect((modal.arg as any).toJSON().custom_id).toBe("outcome:feedback:modal:42");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("outcome:feedback:modal:<id> → thanks reply + submitFeedback(actionId)", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    const { intr, _acks } = modalInteraction(
      "cid-ofb-modal",
      "outcome:feedback:modal:42",
      "great fight",
    );
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.submitFeedback[0]).toMatchObject({
      characterId: 1,
      text: "great fight",
      actionId: 42,
    });
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("outcome:bug:<id> → opens the bug-report modal carrying the action id", async () => {
    const h = makeHarness();
    const { intr, _acks } = buttonInteraction("cid-obug", "outcome:bug:42");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const modal = _acks.find((a) => a.method === "showModal")!;
    expect((modal.arg as any).toJSON().custom_id).toBe("outcome:bug:modal:42");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("outcome:bug:modal:<id> → bug noted reply + submitBug(actionId)", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    const { intr, _acks } = modalInteraction(
      "cid-obug-modal",
      "outcome:bug:modal:42",
      "the map glitched",
    );
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.submitBug[0]).toMatchObject({
      characterId: 1,
      text: "the map glitched",
      actionId: 42,
    });
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("action:dayjob:<n> → the day-job work flow (commute + work decision)", async () => {
    const h = makeHarness();
    h.engine.setMeta("day_number", "1");
    h.engine.setCharacter(oracleChar({ location: "The Warden's Oak" }));
    h.engine.setCommuteResult({ to: "Town Square", stamina: 9 });
    h.engine.setStartActionResult(DECISION_RESULT as never);
    const { intr, _acks } = buttonInteraction("cid-dayjob-work", "action:dayjob:0");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    // Work flow signature: startAction with kind 'work', commute resolved, no stepAction.
    expect(h.engine.calls.startAction[0].opts).toMatchObject({ kind: "work" });
    expect(h.engine.calls.commuteToWorkplace.length).toBe(1);
    expect(h.engine.calls.stepAction.length).toBe(0);
    // Final render went out via webhook.editMessage (the day-job path's editor).
    expect(_acks.some((a) => a.method === "webhook.editMessage")).toBe(true);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("action:<choice> → handleActionChoice steps the action machine", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    h.engine.setStepActionResult(NEXT_DECISION_STEP as never);
    // Seed the engine's pending-decision options so the click resolves option 0's label.
    h.engine.setPendingChoiceOptions(DECISION_RESULT.firstDecision.options as never);
    const { intr, _acks } = buttonInteraction("cid-action-choice", "action:choice:0:0");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    // Choice path signature: stepAction (not startAction), deferUpdate ack.
    expect(h.engine.calls.stepAction[0].choice).toBe("Advance carefully");
    expect(h.engine.calls.startAction.length).toBe(0);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  // Regression (M3.2c FIX 2): the old `handleActionChoice` deferred UNCONDITIONALLY,
  // right after the getCharacter guard, THEN parsed the customId — a malformed
  // `action:`-prefixed id still got acked even though it resolves to nothing. An
  // extraction cut that builds the selector (parse included) before deferring would
  // leave a malformed id with no ack at all — Discord then shows "interaction failed".
  it("action: with a malformed customId (parseActionCid → null) still acks via deferUpdate", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    const { intr, _acks } = buttonInteraction("cid-action-malformed", "action:choice");
    await expect(dispatchInteraction(intr as never, h.deps)).resolves.not.toThrow();

    expect(_acks.some((a) => a.method === "deferUpdate")).toBe(true);
    // Nothing to resolve past the malformed id — no step, no outer-funnel reply.
    expect(h.engine.calls.stepAction.length).toBe(0);
    expect(h.notifyAdmin).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Resolved / outcome render path — the `if (result.outcome)` / `if (result.resolved)`
// region (M3-extraction target): outcome embed + service buttons, broadcast + collapse.
// Only these three transcripts reach it; the decision-path transcripts above stop short.
// ═══════════════════════════════════════════════════════════════════════════

describe("dispatch oracle — resolved / outcome render path", () => {
  it("action:custom:modal → auto-finishes straight to an outcome render", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar({ lastActionState: null }));
    h.engine.setStartActionResult(RESOLVED_START_RESULT as never);
    broadcastOutcomeSpy.mockClear();
    announceCollapseSpy.mockClear();
    const { intr, _acks } = modalInteraction(
      "cid-custom-outcome",
      "action:custom:modal",
      "scout the northern ridge",
    );
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    // Outcome path proof: the service buttons rendered (not a decision prompt).
    expect(hasOutcomeButtons(_acks)).toBe(true);
    // Broadcast + collapse were routed through the neutralised collaborators — no round-trip.
    expect(broadcastOutcomeSpy).toHaveBeenCalledTimes(1);
    expect(announceCollapseSpy).toHaveBeenCalledTimes(1);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("action:dayjob:<n> → the work flow resolves straight to an outcome render", async () => {
    const h = makeHarness();
    h.engine.setMeta("day_number", "1");
    h.engine.setCharacter(oracleChar({ location: "The Warden's Oak" }));
    h.engine.setCommuteResult({ to: "Town Square", stamina: 9 });
    h.engine.setStartActionResult(RESOLVED_WORK_RESULT as never);
    broadcastOutcomeSpy.mockClear();
    announceCollapseSpy.mockClear();
    const { intr, _acks } = buttonInteraction("cid-dayjob-outcome", "action:dayjob:0");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.startAction[0].opts).toMatchObject({ kind: "work" });
    // The day-job path renders its final outcome via webhook.editMessage.
    expect(_acks.some((a) => a.method === "webhook.editMessage")).toBe(true);
    expect(hasOutcomeButtons(_acks)).toBe(true);
    expect(broadcastOutcomeSpy).toHaveBeenCalledTimes(1);
    expect(announceCollapseSpy).toHaveBeenCalledTimes(1);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("action:<choice> → a step that resolves renders the outcome", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    h.engine.setStepActionResult(RESOLVED_STEP_RESULT as never);
    // Seed the engine's pending-decision options so the click resolves option 0's label.
    h.engine.setPendingChoiceOptions(DECISION_RESULT.firstDecision.options as never);
    broadcastOutcomeSpy.mockClear();
    announceCollapseSpy.mockClear();
    const { intr, _acks } = buttonInteraction("cid-choice-outcome", "action:choice:0:0");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.stepAction[0].choice).toBe("Advance carefully");
    expect(hasOutcomeButtons(_acks)).toBe(true);
    expect(broadcastOutcomeSpy).toHaveBeenCalledTimes(1);
    expect(announceCollapseSpy).toHaveBeenCalledTimes(1);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  // Regression (M3.2c FIX 1): the old `handleActionChoice` had ONE inner try wrapping
  // stepAction AND applyActionResult (paint + broadcastOutcome + announceCollapse) — a
  // throw anywhere in there repainted "⚔️ Action Failed" rather than escaping to the
  // outer funnel (notifyAdmin + generic reply). An extraction cut that moved
  // broadcast/announceCollapse outside that inner boundary would let this kind of
  // throw escape to the wrong catch.
  it("action:<choice> resolved → broadcastOutcome throwing repaints Action Failed, not the outer funnel", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    h.engine.setStepActionResult(RESOLVED_STEP_RESULT as never);
    h.engine.setPendingChoiceOptions(DECISION_RESULT.firstDecision.options as never);
    broadcastOutcomeSpy.mockClear();
    announceCollapseSpy.mockClear();
    broadcastOutcomeSpy.mockRejectedValueOnce(new Error("boom"));
    const { intr, _acks } = buttonInteraction("cid-choice-broadcast-throws", "action:choice:0:0");
    await dispatchInteraction(intr as never, h.deps);
    // The one-shot rejection is consumed by the single call this leaf makes — no
    // restoration needed for later tests' default (resolving) behaviour.

    const failedEdit = _acks.find(
      (a) =>
        a.method === "webhook.editMessage" &&
        (a.arg as { embeds?: Array<{ title?: string }> } | undefined)?.embeds?.[0]?.title ===
          "⚔️ Action Failed",
    );
    expect(failedEdit).toBeTruthy();
    // The OUTER funnel (notifyAdmin + generic ephemeral reply) must NOT have fired —
    // the inner catch handled it.
    expect(h.notifyAdmin).not.toHaveBeenCalled();
    expect(_acks.some((a) => a.method === "reply")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Leaves 15–17 — the three nav: sub-branches
// ═══════════════════════════════════════════════════════════════════════════

describe("dispatch oracle — nav: sub-branches", () => {
  it("nav:action → shows the day-job menu and stashes it", async () => {
    const h = makeHarness();
    h.engine.setMeta("day_number", "1");
    h.engine.setCharacter(oracleChar({ rollsRemaining: 3, lastActionState: null }));
    const { intr, _acks } = buttonInteraction("nav-action", "nav:action");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const reply = _acks.find((a) => a.method === "reply")!;
    // A day-job menu embed with buttons (the Custom… button + one per action).
    expect((reply.arg as any).components.length).toBeGreaterThan(0);
    expect(_acks.some((a) => a.method === "fetchReply")).toBe(true);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("nav:sleep → a loading beat then the sleep result", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar({ rollsRemaining: 0, lastActionState: null }));
    const { intr, _acks } = buttonInteraction("nav-sleep", "nav:sleep");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    // Loading beat via reply (source not V2-ephemeral), result via editReply.
    const methods = _acks.map((a) => a.method);
    expect(methods).toContain("reply");
    expect(methods).toContain("editReply");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("nav:<generic> (nav:hi) → renders the target screen with a nav bar", async () => {
    const h = makeHarness();
    h.engine.setMeta("day_number", "1");
    h.engine.setCharacter(oracleChar({ lastActionState: null }));
    const { intr, _acks } = buttonInteraction("nav-hi", "nav:hi");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    expect((reply.arg as any).components.length).toBeGreaterThan(1);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cascade ORDER — specific-before-broad (explicit assertions, not just snapshots)
// ═══════════════════════════════════════════════════════════════════════════

describe("dispatch oracle — cascade order (specific before broad)", () => {
  it("action:dayjob:custom hits the modal branch, NOT the day-job work flow", async () => {
    const h = makeHarness();
    h.engine.setMeta("day_number", "1");
    h.engine.setCharacter(oracleChar());
    const { intr, _acks } = buttonInteraction("order-djcustom", "action:dayjob:custom");
    await dispatchInteraction(intr as never, h.deps);

    // Branch #2 proof: a modal opened and no work ever started.
    expect(_acks.some((a) => a.method === "showModal")).toBe(true);
    expect(h.engine.calls.startAction.length).toBe(0);
    expect(h.engine.calls.commuteToWorkplace.length).toBe(0);
  });

  it("action:custom:modal hits the modal-submit branch, NOT the broad action: branch", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar({ lastActionState: null }));
    h.engine.setStartActionResult(DECISION_RESULT as never);
    const { intr, _acks } = modalInteraction(
      "order-custommodal",
      "action:custom:modal",
      "climb the tower",
    );
    await dispatchInteraction(intr as never, h.deps);

    // Branch #3 proof: startAction with the TYPED text (handleActionChoice would
    // have called stepAction with a resolved choice label instead).
    expect(h.engine.calls.startAction[0].rawInput).toBe("climb the tower");
    expect(h.engine.calls.stepAction.length).toBe(0);
    // #3 defers a reply; the broad action: branch (handleActionChoice) defers an update.
    expect(_acks.some((a) => a.method === "deferReply")).toBe(true);
    expect(_acks.some((a) => a.method === "deferUpdate")).toBe(false);
  });

  it("action:dayjob:<n> hits the work flow, NOT the broad action: branch", async () => {
    const h = makeHarness();
    h.engine.setMeta("day_number", "1");
    h.engine.setCharacter(oracleChar({ location: "The Warden's Oak" }));
    h.engine.setCommuteResult(null);
    h.engine.setStartActionResult(DECISION_RESULT as never);
    const { intr } = buttonInteraction("order-dayjob", "action:dayjob:2");
    await dispatchInteraction(intr as never, h.deps);

    // Branch #12 proof: startAction with kind 'work'; the broad branch would step, not start.
    expect(h.engine.calls.startAction[0].opts).toMatchObject({ kind: "work" });
    expect(h.engine.calls.stepAction.length).toBe(0);
  });
});
