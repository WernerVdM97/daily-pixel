/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// ── Determinism: pin the idle-message RNG before the module graph loads ──
// randomIdleMessage feeds the "Thinking…"/"Starting…" loading beats in the custom
// modal, day-job work flow and nav:sleep branches. Fixed → stable snapshots.
vi.mock("../../src/engine/IdleMessageSelector.js", () => ({
  randomIdleMessage: () => "The warden tends the fire.",
}));

import { dispatchInteraction } from "../../src/discord/dispatchInteraction.js";
import { setPendingDecision } from "../../src/discord/commands/action.js";
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

  it("a throwing handler routes through notifyAdmin + safeErrorReply", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    // makeStatsCommand calls engine.getItems — make it throw to hit the slash catch.
    vi.spyOn(h.engine, "getItems").mockImplementation(() => {
      throw new Error("boom");
    });
    const { intr } = slashInteraction("slash-error", "stats");
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
    // Seed a pending decision so the click resolves option 0's label.
    setPendingDecision("cid-action-choice", DECISION_RESULT.firstDecision as never);
    const { intr, _acks } = buttonInteraction("cid-action-choice", "action:choice:0:0");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    // Choice path signature: stepAction (not startAction), deferUpdate ack.
    expect(h.engine.calls.stepAction[0].choice).toBe("Advance carefully");
    expect(h.engine.calls.startAction.length).toBe(0);
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
