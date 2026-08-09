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
import { resetCache } from "../../src/protocol/profanity.js";
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

/** M9.1 (DC-M9.3): a refunded divine-intervention roll — no mutations, no actionId (the
 *  engine never persists an action row on this path). */
const DIVINE_OUTCOME: ActionOutcome = {
  distilledType: "scout",
  finalDc: 11,
  playerRolled: null,
  outcome: "skipped",
  mutations: [],
  outcomeText: "The warden intervenes — your roll is refunded.",
  isDivineIntervention: true,
};

const DIVINE_START_RESULT: ActionStartResult = {
  state: { rawInput: "scout the northern ridge", decisions: [], accumulatedDc: 11, kind: "quest" },
  firstDecision: { prompt: "", options: [] },
  outcome: DIVINE_OUTCOME,
  actionType: "search",
};

/** As above but for the day-job work flow. */
const DIVINE_WORK_RESULT: ActionStartResult = {
  state: { rawInput: "Keep the gate — Walk the rounds", decisions: [], accumulatedDc: 11, kind: "work", wage: 5 },
  firstDecision: { prompt: "", options: [] },
  outcome: DIVINE_OUTCOME,
  actionType: "other",
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

  // DC-M9.6: `/ping` is the one registered command with no seam event of its own, so it is
  // the one place the nav weld cannot be fed by a router response. Unpinned before M9.3
  // ("ping" appeared exactly once in the whole test tree, in the harness registry), which is
  // how a nav-facts port could have deleted its bar in silence. Pinned here on both sides of
  // the wiring wrapper: with a character the bar is welded, without one it is absent.
  it("/ping renders 'pong' with a nav bar — the wiring-level nav supply, the one command that does not cross the seam", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    const { intr, _acks } = slashInteraction("slash-ping", "ping");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const reply = _acks.find((a) => a.method === "reply")!;
    const rows = (reply.arg as any).components as any[];
    // Container + at least one nav row, and the rows really are nav buttons.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[1].components[0].custom_id).toMatch(/^nav:/);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("/ping with NO character → 'pong' alone, no nav bar (the `if (char)` fallback, unchanged)", async () => {
    const h = makeHarness();
    // characterExists true keeps the gate from rerouting: /ping is not character-gated, and
    // this isolates the nav weld's own null-character fallback.
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(null);
    const { intr, _acks } = slashInteraction("slash-ping-charless", "ping");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const reply = _acks.find((a) => a.method === "reply")!;
    expect((reply.arg as any).components.length).toBe(1);
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

  it("a throwing ADAPTER-side ack (/action's own reply call, unguarded by any try/catch) still routes through notifyAdmin + safeErrorReply", async () => {
    // M9.2: /action's engine reads now cross the seam (menu.open/action.custom), so an
    // engine-level throw is absorbed by the router's own catch and painted inline —
    // exactly like the /stats case above — rather than escaping here. The genuinely
    // adapter-side failure left in this command is a Discord ack itself throwing (the
    // guard reply below is unguarded by any try/catch, same as before the port).
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar({ rollsRemaining: 0, lastActionState: null }));
    const { intr } = slashInteraction("slash-error-action", "action");
    (intr as { reply: unknown }).reply = vi.fn(async () => {
      throw new Error("boom");
    });
    await dispatchInteraction(intr as never, h.deps);

    expect(h.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(h.safeErrorReply).toHaveBeenCalledTimes(1);
    expect(h.safeErrorReply.mock.calls[0][1]).toContain("Something went wrong");
  });

  it("M9.2: an engine-level throw no longer escapes /action's guard — the router's own catch absorbs it and the handler paints it inline (contrast with the ack-throw case above)", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    vi.spyOn(h.engine, "getCharacter").mockImplementation(() => {
      throw new Error("boom");
    });
    const { intr, _acks } = slashInteraction("slash-error-action-2", "action");
    await dispatchInteraction(intr as never, h.deps);

    expect(h.notifyAdmin).not.toHaveBeenCalled();
    expect(h.safeErrorReply).not.toHaveBeenCalled();
    const edit = _acks.find((a) => a.method === "editReply");
    expect(JSON.stringify(edit?.arg)).toContain("boom");
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

    // Exact sequence, not `.some()` (Finding 3, M9.3.2b review): the loose assertion is
    // why a genuine change to this leaf's ack sequence produced zero snapshot churn and
    // slipped past the byte gate.
    expect(_acks.map((a) => a.method)).toEqual(["deferUpdate"]);
    // Nothing to resolve past the malformed id — no step, no outer-funnel reply.
    expect(h.engine.calls.stepAction.length).toBe(0);
    expect(h.notifyAdmin).not.toHaveBeenCalled();
    expect(snapshotAcks(_acks)).toMatchSnapshot();
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
// M9.1 (DC-M9.3) — the divine-intervention arm: a refunded roll is a system fault, not a
// real outcome. The controller's `divine` StartRenderResult arm short-circuits BEFORE the
// outcome branch, so these two direct-consumer sites paint the distinct grey ⚠️ System
// embed and stop — no service buttons, no broadcast, no collapse announce.
// ═══════════════════════════════════════════════════════════════════════════

describe("dispatch oracle — divine intervention (M9.1, DC-M9.3)", () => {
  it("action:custom:modal → divine intervention paints the grey System embed, no broadcast", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar({ lastActionState: null }));
    h.engine.setStartActionResult(DIVINE_START_RESULT as never);
    broadcastOutcomeSpy.mockClear();
    announceCollapseSpy.mockClear();
    const { intr, _acks } = modalInteraction(
      "cid-custom-divine",
      "action:custom:modal",
      "scout the northern ridge",
    );
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const paint = _acks.find(
      (a) => a.method === "editReply" && (a.arg as any)?.embeds?.[0]?.title === "⚠️ System",
    );
    expect(paint).toBeTruthy();
    expect((paint!.arg as any).embeds[0].description).toBe(
      "The warden intervenes — your roll is refunded.",
    );
    expect((paint!.arg as any).embeds[0].color).toBe(0x95a5a6);
    expect((paint!.arg as any).components).toEqual([]);
    expect(hasOutcomeButtons(_acks)).toBe(false);
    expect(broadcastOutcomeSpy).not.toHaveBeenCalled();
    expect(announceCollapseSpy).not.toHaveBeenCalled();
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("action:dayjob:<n> → divine intervention paints the grey System embed, no broadcast", async () => {
    const h = makeHarness();
    h.engine.setMeta("day_number", "1");
    h.engine.setCharacter(oracleChar({ location: "The Warden's Oak" }));
    h.engine.setCommuteResult({ to: "Town Square", stamina: 9 });
    h.engine.setStartActionResult(DIVINE_WORK_RESULT as never);
    broadcastOutcomeSpy.mockClear();
    announceCollapseSpy.mockClear();
    const { intr, _acks } = buttonInteraction("cid-dayjob-divine", "action:dayjob:0");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const paint = _acks.find(
      (a) =>
        a.method === "webhook.editMessage" &&
        (a.arg as any)?.embeds?.[0]?.title === "⚠️ System",
    );
    expect(paint).toBeTruthy();
    expect((paint!.arg as any).embeds[0].description).toBe(
      "The warden intervenes — your roll is refunded.",
    );
    expect((paint!.arg as any).embeds[0].color).toBe(0x95a5a6);
    expect((paint!.arg as any).components).toEqual([]);
    expect(hasOutcomeButtons(_acks)).toBe(false);
    expect(broadcastOutcomeSpy).not.toHaveBeenCalled();
    expect(announceCollapseSpy).not.toHaveBeenCalled();
    expect(snapshotAcks(_acks)).toMatchSnapshot();
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

  it("nav:action where composeActionMenu throws → the day-job fallback notice still reaches the player (DC-M9.2.3's menu-fallback arm, unhandled by this switch before the fix, silently dropped the reply)", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar({ rollsRemaining: 3, lastActionState: null }));
    // composeActionMenu's first read is engine.getMeta('day_number') — forcing IT to throw
    // reaches openActionMenu's own try/catch (the action-oracle transcript 4 technique).
    vi.spyOn(h.engine, "getMeta").mockImplementation(() => {
      throw new Error("day_number lookup boom");
    });
    const { intr, _acks } = buttonInteraction("nav-action-throws", "nav:action");
    await dispatchInteraction(intr as never, h.deps);

    // Non-vacuity: before the fix, the switch had no "menu-fallback" case, so nothing
    // replied — this assertion is what fails against pre-fix code.
    const reply = _acks.find((a) => a.method === "reply");
    expect(reply).toBeDefined();
    expect((reply!.arg as any).content).toContain(
      "Use `/action <what you do>` to start an action.",
    );
    expect((reply!.arg as any).flags).toBe(64); // ephemeral
    expect(h.notifyAdmin).not.toHaveBeenCalled();
  });

  // The first fresh-context M9.3 review's BLOCKER, pinned in both directions. `internal` has
  // two sources: `resumeAction` throwing the player-facing text on the ordinary 30-minute
  // timeout (a normal game event the pre-port leaf paged nobody for) and a genuine backend
  // fault (which it did page for). The router collapses both onto 'internal', so
  // `facts.internalFault` is what tells them apart — without it, a player walking away from
  // a decision screen wakes an operator, which is M9.2's blocker 1 one leaf over.
  it("nav:action where resumeAction throws the D2 timeout → 'Could not resume.' reaches the player and notifyAdmin does NOT fire", async () => {
    const h = makeHarness();
    h.engine.setCharacter(
      oracleChar({ rollsRemaining: 2, lastActionState: { rawInput: "scout the ridge", decisions: [], accumulatedDc: 10 } }),
    );
    // No setResumeResult → MockWorldEngine.resumeAction throws, standing in for the D2
    // timeout, which openActionMenu catches into its `resume-error` arm.
    const { intr, _acks } = buttonInteraction("nav-action-resume-error", "nav:action");
    await dispatchInteraction(intr as never, h.deps);

    const reply = _acks.find((a) => a.method === "reply")!;
    expect((reply.arg as any).content).toContain("❌ **Could not resume.**");
    expect(h.notifyAdmin).not.toHaveBeenCalled();
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("nav:action where openActionMenu itself throws → the SAME copy, but notifyAdmin DOES fire (the fault half)", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar({ rollsRemaining: 3, lastActionState: null }));
    vi.spyOn(h.deps.controller, "openActionMenu").mockImplementation(() => {
      throw new Error("openActionMenu boom");
    });
    const { intr, _acks } = buttonInteraction("nav-action-fault", "nav:action");
    await dispatchInteraction(intr as never, h.deps);

    const reply = _acks.find((a) => a.method === "reply")!;
    expect((reply.arg as any).content).toContain("❌ **Could not resume.**");
    expect(h.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(h.notifyAdmin.mock.calls[0][0]).toBe("Nav (action) failed");
  });

  // DC-M9.3.12: nav:action now stamps inside the router's menu.open branch, so the leaf's
  // own stamp is suppressed. Every other stamp assertion in the four oracles is
  // `.toContain(1)`, which cannot see a double stamp — this one counts.
  it("nav:action stamps last-played EXACTLY once (the router's stamp, not the leaf's as well)", async () => {
    const h = makeHarness();
    h.engine.setMeta("day_number", "1");
    h.engine.setCharacter(oracleChar({ rollsRemaining: 3, lastActionState: null }));
    const { intr } = buttonInteraction("nav-action-stamp", "nav:action");
    await dispatchInteraction(intr as never, h.deps);

    expect(h.engine.calls.updateLastPlayed).toEqual([1]);
  });

  it("nav:<generic> stamps last-played exactly once too (the leaf's own stamp, no router stamp on screen events)", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    const { intr } = buttonInteraction("nav-look-stamp", "nav:look");
    await dispatchInteraction(intr as never, h.deps);

    expect(h.engine.calls.updateLastPlayed).toEqual([1]);
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

  // M9.0 recorded this fallback as unpinned (`resolvedChar === null` → no nav bar);
  // M9.2 deferred the wiring; M9.3.2c settles it (DC-M9.6's own scope-fence closing item).
  // A charless nav click never reaches the character gate (that's slash-only), so this IS
  // reachable — the router's `no-character` arm carries no `nav` fact, and the generic
  // nav leaf's `onNav` closure is never called, reproducing today's `!char` no-nav-bar
  // fallback byte-for-byte (proved here rather than assumed).
  it("nav:<generic> (nav:hi) with NO character → the container renders alone, no nav bar", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.engine.setCharacter(null);
    const { intr, _acks } = buttonInteraction("nav-hi-charless", "nav:hi");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const reply = _acks.find((a) => a.method === "reply")!;
    // Just the V2 container — no nav row appended.
    expect((reply.arg as any).components.length).toBe(1);
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

// ═══════════════════════════════════════════════════════════════════════════
// M9.3.0 — the characterisation net (DC-M9.3.2/.3/.4/.7/.9). Test-only, additive,
// zero `src/` edits. Every transcript below pins CURRENT pre-port behaviour on an
// ack-phase question the M9.3 dispatcher rewrite is about to ask on every converted
// leaf: did a beat fire, and therefore is the interaction acked? M9.2's two review
// blockers both lived on an arm no transcript exercised — this net closes that gap
// before the mechanical port starts, not after.
// ═══════════════════════════════════════════════════════════════════════════

describe("dispatch oracle — M9.3.0 characterisation net", () => {
  // The two DECLARED behaviour changes on the custom-modal leaf, found by the first
  // fresh-context M9.3 review and pinned here rather than left as silent diffs. M9.2 wired
  // the daily-roll guard into the slash arm and recorded that "the day-job Custom… modal
  // button doesn't wire to it yet, left for M9.3" — this is that wiring landing.
  it("action:custom:modal with NO rolls left → the ⛔ out-of-actions rejection, no startAction (pre-M9.3 this leaf had no rolls arm and granted a FREE action)", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar({ rollsRemaining: 0, lastActionState: null }));
    const { intr, _acks } = modalInteraction("cid-modal-no-rolls", "action:custom:modal", "scout the ridge");
    await dispatchInteraction(intr as never, h.deps);

    expect(_acks.map((a) => a.method)).toEqual(["reply"]);
    expect((_acks[0].arg as any).content).toContain("🛌 **Out of actions for today.**");
    // The point of the change: the engine is never asked to start an unpaid action.
    expect(h.engine.calls.startAction.length).toBe(0);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("action:custom:modal with NO character → one plain ephemeral reply (pre-M9.3 the same arm deferred first, then edited)", async () => {
    const h = makeHarness();
    h.engine.setCharacter(null);
    const { intr, _acks } = modalInteraction("cid-modal-charless", "action:custom:modal", "scout the ridge");
    await dispatchInteraction(intr as never, h.deps);

    expect(_acks.map((a) => a.method)).toEqual(["reply"]);
    expect((_acks[0].arg as any).content).toBe("You don't have a character. Type `/join` first.");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  // DC-M9.3.2: two profanity transcripts that are EXPECTED to behave differently once
  // DC-M9.7 moves the guard behind the seam. This one — the modal leaf — must stay
  // byte-identical through the whole M9.3 slice. Its pair, the slash pass-through, lives
  // in action-oracle.test.ts and uses the SAME filter pattern and text on purpose: the
  // two are only meaningful read together. checkProfanity memoises its compiled patterns
  // module-globally, so the filter is armed/reset around the dispatch call and restored
  // in a finally, mirroring profanity.test.ts's own beforeEach discipline.
  it("action:custom:modal with profane text → the profanity guard rejects it with a single plain ephemeral reply, no defer at all (DC-M9.3.2 — must stay byte-identical through the whole M9.3 slice; pairs with action-oracle's slash pass-through transcript, same filter/pattern/text)", async () => {
    const priorFilter = process.env.PROFANITY_FILTER;
    process.env.PROFANITY_FILTER = "\\bfrack\\b";
    resetCache();
    try {
      const h = makeHarness();
      h.engine.setCharacter(oracleChar());
      const { intr, _acks } = modalInteraction(
        "cid-profane-modal",
        "action:custom:modal",
        "go frack around the ridge",
      );
      await dispatchInteraction(intr as never, h.deps);

      expect(_acks.map((a) => a.method)).toEqual(["reply"]);
      expect((_acks[0].arg as any).content).toBe(
        "❌ That action contains language the warden won't tolerate. Try something else.",
      );
      expect((_acks[0].arg as any).flags).toBe(64); // ephemeral
      expect(h.engine.calls.startAction.length).toBe(0);
      expect(snapshotAcks(_acks)).toMatchSnapshot();
    } finally {
      if (priorFilter === undefined) delete process.env.PROFANITY_FILTER;
      else process.env.PROFANITY_FILTER = priorFilter;
      resetCache();
    }
  });

  // DC-M9.3.9 (a second ordering inversion, settled after DC-M9.3.4 was written): the
  // profanity check at :302-311 runs before ANYTHING else on this leaf, including
  // `beginCustomAction`'s own no-character guard. So a charless-plus-profane cross today
  // produces the profanity rejection, not the no-character copy, and `engine.getCharacter`
  // is never reached. After DC-M9.7 moves the guard into the router's `action.custom`
  // branch, the two guards become neighbours in one function and their relative order is
  // a free choice nothing else pins — exactly the malformed-id/no-character swap risk
  // transcript G nets for the choice leaf.
  it("action:custom:modal with profane text AND no character → the profanity guard still wins; engine.getCharacter is never reached (DC-M9.3.9)", async () => {
    const priorFilter = process.env.PROFANITY_FILTER;
    process.env.PROFANITY_FILTER = "\\bfrack\\b";
    resetCache();
    try {
      const h = makeHarness();
      // No setCharacter call — engine.getCharacter would return null if it were ever asked.
      const { intr, _acks } = modalInteraction(
        "cid-profane-modal-charless",
        "action:custom:modal",
        "go frack around the ridge",
      );
      await dispatchInteraction(intr as never, h.deps);

      expect(_acks.map((a) => a.method)).toEqual(["reply"]);
      expect((_acks[0].arg as any).content).toBe(
        "❌ That action contains language the warden won't tolerate. Try something else.",
      );
      expect(h.engine.calls.getCharacter.length).toBe(0);
      expect(snapshotAcks(_acks)).toMatchSnapshot();
    } finally {
      if (priorFilter === undefined) delete process.env.PROFANITY_FILTER;
      else process.env.PROFANITY_FILTER = priorFilter;
      resetCache();
    }
  });

  // DC-M9.3.3: the three `beginDayJob` guard arms (:576-596) — each a plain ephemeral
  // reply today, with no defer ever fired. Any port that turns one of these into an
  // `editReply` on an un-acked interaction reproduces M9.2's blocker 1.
  it("action:dayjob:<n> with no character → plain ephemeral reply, no defer (DC-M9.3.3)", async () => {
    const h = makeHarness();
    // No setCharacter call — beginDayJob's char guard returns 'no-character'.
    const { intr, _acks } = buttonInteraction("cid-dj-nochar", "action:dayjob:0");
    await dispatchInteraction(intr as never, h.deps);

    expect(_acks.map((a) => a.method)).toEqual(["reply"]);
    expect((_acks[0].arg as any).content).toBe(
      "You don't have a character. Type `/join` first.",
    );
    expect((_acks[0].arg as any).flags).toBe(64);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("action:dayjob:<n> with an out-of-range job index → 'Invalid job action.' plain ephemeral reply, no defer (DC-M9.3.3)", async () => {
    const h = makeHarness();
    h.engine.setMeta("day_number", "1");
    h.engine.setCharacter(oracleChar());
    // getDayJobActions only ever surfaces 3 actions — 99 is always out of range.
    const { intr, _acks } = buttonInteraction("cid-dj-invalid", "action:dayjob:99");
    await dispatchInteraction(intr as never, h.deps);

    expect(_acks.map((a) => a.method)).toEqual(["reply"]);
    expect((_acks[0].arg as any).content).toBe("Invalid job action.");
    expect((_acks[0].arg as any).flags).toBe(64);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("action:dayjob:<n> from unsafe ground (not the job's own workplace) → the interpolated unsafe-ground warning, plain ephemeral reply, no defer (DC-M9.3.3)", async () => {
    const h = makeHarness();
    h.engine.setMeta("day_number", "1");
    // Town Guard's workplace (day-jobs.yml) is Town Square — this location is neither
    // the workplace nor safe, so both halves of the guard's condition are exercised.
    h.engine.setCharacter(oracleChar({ location: "Shadowfen Marsh" }));
    h.engine.setLocation({
      name: "Shadowfen Marsh",
      description: "A mock unsafe location.",
      tags: ["mock"],
      isSafe: false,
      emoji: "📍",
    });
    const { intr, _acks } = buttonInteraction("cid-dj-unsafe", "action:dayjob:0");
    await dispatchInteraction(intr as never, h.deps);

    expect(_acks.map((a) => a.method)).toEqual(["reply"]);
    expect((_acks[0].arg as any).content).toBe(
      "⚠️ **It's no place for honest work here.**\nThe Shadowfen Marsh is too dangerous — make for safer ground before you set to your trade.",
    );
    expect((_acks[0].arg as any).flags).toBe(64);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  // DC-M9.3.3: beginChoice's no-character arm (:694-700) — a plain ephemeral reply BEFORE
  // the unconditional deferUpdate a few lines down.
  it("action:<choice> from a user with no character → plain ephemeral reply BEFORE the unconditional deferUpdate (DC-M9.3.3)", async () => {
    const h = makeHarness();
    const { intr, _acks } = buttonInteraction("cid-choice-nochar", "action:choice:0:0");
    await dispatchInteraction(intr as never, h.deps);

    expect(_acks.map((a) => a.method)).toEqual(["reply"]);
    expect((_acks[0].arg as any).content).toBe(
      "You don't have a character. Type `/join` first.",
    );
    expect((_acks[0].arg as any).flags).toBe(64);
    expect(h.engine.calls.resolvePendingChoice.length).toBe(0);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  // DC-M9.3.3 + DC-M9.3.5: the `resolveChoice` null (session-expired) arm. `deferUpdate`
  // has already fired by this point, and the expired copy paints through
  // `interaction.webhook.editMessage`, NOT `editReply` — the split DC-M9.3.5 says the
  // router cannot express and must not try to.
  it("action:<choice> where resolveChoice returns null (session expired) → deferUpdate already fired, expired copy paints via webhook.editMessage, NOT editReply (DC-M9.3.3, DC-M9.3.5)", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    // No setPendingChoiceOptions call → MockWorldEngine.resolvePendingChoice's
    // empty-stash branch returns null for a non-bail selector (mirrors "no
    // last_action_state").
    const { intr, _acks } = buttonInteraction("cid-choice-expired", "action:choice:0:0");
    await dispatchInteraction(intr as never, h.deps);

    expect(_acks.map((a) => a.method)).toEqual(["deferUpdate", "webhook.editMessage"]);
    const paint = _acks[1];
    expect((paint.arg as any).content).toBe(
      "❌ Your action session expired. Try `/action` again.",
    );
    expect((paint.arg as any).components).toEqual([]);
    expect((paint.arg as any).embeds).toEqual([]);
    expect(h.engine.calls.stepAction.length).toBe(0);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  // DC-M9.3.3 (the general form of M9.2's blocker 1): a controller throw before any beat
  // has fired, on both `beginDayJob` and `beginChoice`. Both leaves now reply plainly on
  // this path — M9.3 pinned the day-job one editing an un-acked interaction instead, which
  // is the fault M10.0 repaired (DC-M10.1); the pin below is the repaired behaviour, and
  // the harness's `webhook.editMessage` invariant is what makes the old shape unpinnable.
  // Both still fire notifyAdmin (a begin* throw is a genuine defect, DC-M10.5) and neither
  // touches safeErrorReply, a top-level-slash-only helper.
  it("action:dayjob:<n> where beginDayJob throws before any beat → notifyAdmin fires, the error replies plainly and the interaction IS acked (DC-M10.1)", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    vi.spyOn(h.deps.controller, "beginDayJob").mockImplementation(() => {
      throw new Error("boom (dayjob)");
    });
    const { intr, _acks } = buttonInteraction("cid-dj-throws", "action:dayjob:0");
    await dispatchInteraction(intr as never, h.deps);

    expect(_acks.map((a) => a.method)).toEqual(["reply"]);
    expect((_acks[0].arg as any).content).toContain("boom (dayjob)");
    // The copy is unchanged from the pre-M10.0 webhook paint — this slice moved the channel,
    // not the words (the M10 scope fence).
    expect((_acks[0].arg as any).content).toContain("Could not act.");
    expect((intr as { replied: boolean }).replied).toBe(true);
    expect(h.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(h.safeErrorReply).not.toHaveBeenCalled();
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  // M10.0 review, finding 1 — the case that made the first fix's phase signal the wrong
  // one. `beatPaint` is assigned the instant the loading beat fires, so it is truthy even
  // when the `deferUpdate` inside it REJECTED and the interaction is therefore still
  // un-acked. Branching on it there picked the webhook and reproduced this very slice's
  // fault. This test fails against that first fix (acks come back empty, exactly as the
  // original defect did) and passes once the branch reads the real ack state.
  //
  // Overriding `deferUpdate` here is the pattern M9.2 caught lying in bookend-oracle
  // transcript 18, but inverted and faithful: a rejecting ack leaves `deferred` false in
  // real discord.js too, because the flag is set only after the API call resolves.
  it("action:dayjob:<n> where the loading beat's own deferUpdate rejects → still replies plainly, never through the webhook (M10.0 review)", async () => {
    const h = makeHarness();
    h.engine.setMeta("day_number", "1");
    h.engine.setCharacter(oracleChar({ location: "The Warden's Oak" }));
    const { intr, _acks } = buttonInteraction("cid-dj-defer-fails", "action:dayjob:0");
    (intr as { deferUpdate: unknown }).deferUpdate = vi.fn(async () => {
      throw new Error("Unknown interaction");
    });
    await dispatchInteraction(intr as never, h.deps);

    expect(_acks.map((a) => a.method)).toEqual(["reply"]);
    expect((_acks[0].arg as any).content).toContain("Could not act.");
    expect(_acks.some((a) => a.method === "webhook.editMessage")).toBe(false);
    expect(h.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  // M10.0 review, finding 2 — the day-job leaf's `empty-action` arm paints through the
  // webhook and had no transcript at all, so DC-M10.3's probe never touched it and its
  // clean result said nothing about this call site. Structurally it is post-beat (the
  // router fires the loading beat unconditionally before `runWork`, the only source of the
  // code), and this pins that rather than leaving it inferred.
  it("action:dayjob:<n> resolving to empty-action → paints through the webhook on an acked interaction (M10.0 review)", async () => {
    const h = makeHarness();
    h.engine.setMeta("day_number", "1");
    h.engine.setCharacter(oracleChar({ location: "The Warden's Oak" }));
    h.engine.setStartActionResult({
      state: { rawInput: "Keep the gate", decisions: [], accumulatedDc: 11, kind: "work", wage: 5 },
      firstDecision: { prompt: "Nothing to decide.", options: [] },
      actionType: "other",
    } as never);
    const { intr, _acks } = buttonInteraction("cid-dj-empty", "action:dayjob:0");
    await dispatchInteraction(intr as never, h.deps);

    expect(_acks.map((a) => a.method)).toEqual(["deferUpdate", "editReply", "webhook.editMessage"]);
    expect((_acks[2].arg as any).embeds[0].description).toBe("Nothing to decide.");
    expect(h.notifyAdmin).not.toHaveBeenCalled();
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  // The second un-acked pre-beat source M10's recon found, which the handover did not name:
  // a malformed suffix parses to NaN and the validator rejects it as 'invalid-event', a code
  // the leaf's !response.ok chain had no arm for, so it fell through to the same broken
  // catch and paged an operator. DC-M10.4: guard at the parse instead of dispatching, so no
  // fabricated `jobIndex: NaN` event crosses the seam into the M8.5 corpus.
  it("action:dayjob:<malformed> → deferUpdate and nothing else: no protocol event, no paint, no notifyAdmin (DC-M10.4)", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    // Spied on the ROUTER, not on `beginDayJob` (M10.0 review, finding 3): the validator
    // rejects a NaN jobIndex before any backend call, so a `beginDayJob` assertion holds
    // with or without the guard and proves nothing about "no protocol event". `dispatch` is
    // the seam boundary, so this is the only spy that discriminates.
    const dispatch = vi.spyOn(h.deps.router, "dispatch");
    const { intr, _acks } = buttonInteraction("cid-dj-malformed", "action:dayjob:xyz");
    await dispatchInteraction(intr as never, h.deps);

    expect(_acks.map((a) => a.method)).toEqual(["deferUpdate"]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.notifyAdmin).not.toHaveBeenCalled();
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("action:<choice> where beginChoice throws before any beat → notifyAdmin fires, the generic error paints via a plain reply (DC-M9.3.3)", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    vi.spyOn(h.deps.controller, "beginChoice").mockImplementation(() => {
      throw new Error("boom (choice)");
    });
    const { intr, _acks } = buttonInteraction("cid-choice-throws", "action:choice:0:0");
    await dispatchInteraction(intr as never, h.deps);

    expect(_acks.map((a) => a.method)).toEqual(["reply"]);
    expect((_acks[0].arg as any).content).toBe(
      "Something went wrong with your action. Try `/action` again.",
    );
    expect(h.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(h.safeErrorReply).not.toHaveBeenCalled();
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  // Transcript G (M9.3.0's net). M9.3.2b review fix (Finding 1, blocker) changed this
  // cross: the sentinel-selector approach that dispatched a malformed customId to the
  // router — hitting its character guard before the parse failure ever mattered — is
  // gone. Parsing now happens ahead of any dispatch, so a malformed customId
  // short-circuits on `deferUpdate` + return regardless of character state, matching the
  // WITH-character sibling transcript above byte-for-byte instead of diverging from it.
  // Declared churn, not a regression: today's leaf ran the character guard first and gave
  // this cross the plain no-character reply, but that order is unreachable in practice — a
  // charless player has no action message to click, and the character gate reroutes slash
  // commands before the handler — so protocol honesty (no fabricated `action.choose`
  // selector crossing the seam) wins over preserving it.
  it("a malformed action:-prefixed customId (parseActionCid → null) from a user with NO character → deferUpdate then silence, same as the WITH-character cross above — the parse now runs ahead of the router entirely (Finding 1, M9.3.2b review)", async () => {
    const h = makeHarness();
    const { intr, _acks } = buttonInteraction("cid-malformed-nochar", "action:choice");
    await expect(dispatchInteraction(intr as never, h.deps)).resolves.not.toThrow();

    expect(_acks.map((a) => a.method)).toEqual(["deferUpdate"]);
    expect(h.engine.calls.stepAction.length).toBe(0);
    expect(h.notifyAdmin).not.toHaveBeenCalled();
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  // DC-M9.3.7: `resume-stale` (added in M9.2's review fix, :338-354) has controller-level
  // and slash-level coverage but none at dispatch level. M9.3 deletes the if-chain hosting
  // it, so losing this arm on the port would reproduce blocker 2's exact shape on code
  // that is weeks old.
  it("action:custom:modal where the resume returns zero options hits the resume-stale arm → deferReply then the Stale Action embed, no narration prefix (DC-M9.3.7)", async () => {
    const h = makeHarness();
    h.engine.setCharacter(
      oracleChar({ lastActionState: { rawInput: "scout", decisions: [], accumulatedDc: 10 } }),
    );
    h.engine.setResumeResult({
      state: { rawInput: "scout", decisions: [], accumulatedDc: 10 },
      nextDecision: { prompt: "The trail has gone cold.", options: [] },
    });
    const { intr, _acks } = modalInteraction(
      "cid-resume-stale-modal",
      "action:custom:modal",
      "keep scouting",
    );
    await dispatchInteraction(intr as never, h.deps);

    expect(_acks.map((a) => a.method)).toEqual(["deferReply", "editReply"]);
    const edit = _acks[1];
    expect((edit.arg as any).embeds[0].title).toBe("⏳ Stale Action");
    // Unlike the slash arm's stale embed, this leaf's paint (:341-354) never prepends
    // narration — it renders `begin.prompt` alone even when narration is present.
    expect((edit.arg as any).embeds[0].description).toBe("The trail has gone cold.");
    expect((edit.arg as any).components).toEqual([]);
    expect(h.engine.calls.startAction.length).toBe(0);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  // DC-M9.3.10: no transcript anywhere made recordFeedback throw before this slice, which is
  // exactly why the admin-notification regression was invisible. The router swallows the
  // throw into a `persistFailed` fact rather than surfacing it, so the player still gets the
  // ordinary confirmation reply — this pins that the leaf reads the fact back off and still
  // fires notifyAdmin with its own (per-surface) label, matching pre-port behaviour.
  it("sleep:feedback:modal where the persist throws → the player still gets the normal confirmation reply, and notifyAdmin fires with the sleep-specific label (DC-M9.3.10)", async () => {
    const h = makeHarness();
    h.engine.setCharacter(oracleChar());
    vi.spyOn(h.engine, "submitFeedback").mockImplementation(() => {
      throw new Error("boom (submitFeedback)");
    });
    const { intr, _acks } = modalInteraction(
      "cid-sleepfb-modal-throws",
      "sleep:feedback:modal",
      "loving the atmosphere",
    );
    await dispatchInteraction(intr as never, h.deps);

    // Same player-visible reply as the happy-path sleep:feedback:modal transcript above —
    // the throw is invisible to the player, only the fact riding the envelope tells the
    // adapter to notify.
    expect(_acks.map((a) => a.method)).toEqual(["reply"]);
    expect((_acks[0].arg as any).content).toBe("🙏 Thanks. The warden listens.");
    expect(h.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(h.notifyAdmin.mock.calls[0][0]).toBe("Sleep feedback submission failed");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});
