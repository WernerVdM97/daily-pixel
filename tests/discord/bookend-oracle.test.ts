/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// ── Determinism: pin the idle-message RNG before the module graph loads ──
// (M1.2 pattern — the nav:sleep "Bedding down…" beat reads randomIdleMessage.
// Fixed → stable snapshots even though no M7.0 transcript fires that leaf.)
vi.mock("../../src/engine/IdleMessageSelector.js", () => ({
  randomIdleMessage: () => "The warden tends the fire.",
}));

// ── Determinism: neutralise the public broadcast + collapse notice ──
// The unsafe-rest transcript reaches announceCollapse (a Discord round-trip).
// Spy it so the golden snapshots never depend on a live broadcast; the spy's
// call count/args are asserted explicitly where the path fires it.
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
import type { WizardSession } from "../../src/controller/WizardSession.js";
import {
  makeHarness,
  oracleChar,
  slashInteraction,
  buttonInteraction,
  modalInteraction,
  snapshotAcks,
  CHAR_DEFS,
  type Recorded,
} from "./dispatch-harness.js";

/**
 * M7.0 — bookend oracle (golden-transcript characterisation).
 *
 * Dispatch-level golden transcripts for every join/hi/sleep path the M7.1–M7.3
 * migrations will touch, so each migration diffs against a pinned baseline and
 * M9's byte-identical gate has a net over the bookends. Same pattern as the
 * M1.2 oracle: the REAL `dispatchInteraction`, hoisted mocks, fake Date pinned to
 * Wednesday 2026-07-15, a UNIQUE userId per transcript, and a fresh
 * `makeHarness()` per transcript (the join `_userInFlight`/`_defs` maps have no
 * clear-all).
 *
 * "Characterise, don't judge": snapshots capture CURRENT behaviour verbatim —
 * including anything that looks off — and never fix it (a fix here would poison
 * the M9 baseline). Known oddities are flagged in the transcript comments.
 */

// ── Determinism: freeze the clock (isWeekend() reads new Date().getDay()) ──
// 2026-07-15 is a Wednesday → /hi renders day-job actions, not weekend hooks.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
});
afterAll(() => vi.useRealTimers());

// ── Choice values from the REAL char-creation YAML (the harness's loads) ──
// The wizard buttons are built from these, so the transcripts must fire the same
// values the rendered buttons would carry.
const CLASS = CHAR_DEFS.classes[0].name; // Warrior
const UPBRINGING = CHAR_DEFS.backgrounds[0].name; // Soldier
const RACE = CHAR_DEFS.races[0].name; // Human
// Alignment is persisted lowercase ("lawful good") — the value the choice button carries.
const ALIGNMENT = CHAR_DEFS.alignments[0].name.toLowerCase();
const DAYJOB = CHAR_DEFS.dayJobs[0].name; // Town Guard
const ITEMSET = CHAR_DEFS.itemSets.find((k) => k.for_classes.includes(CLASS))!.name; // Soldier's Kit

/** Drive a wizard session up to (but not past) the given step via direct session calls. */
function wizardAtStep(wizards: WizardSession, userId: string, step: number): void {
  wizards.start(userId);
  wizards.setName(userId, "Rowan");
  if (step > 2) wizards.choose(userId, 2, "class", CLASS);
  if (step > 3) wizards.choose(userId, 3, "upbringing", UPBRINGING);
  if (step > 4) wizards.choose(userId, 4, "race", RACE);
  if (step > 5) wizards.choose(userId, 5, "alignment", ALIGNMENT);
  if (step > 6) wizards.choose(userId, 6, "dayJob", DAYJOB);
  if (step > 7) wizards.choose(userId, 7, "itemSet", ITEMSET);
}

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
// join — 8 transcripts (the M7.3 character-creation migration's net)
// ═══════════════════════════════════════════════════════════════════════════

describe("bookend oracle — join", () => {
  it("1 · slash /join start → ephemeral defer + step-1 screen (name button, step footer, Oak files); session at step 1", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.engine.setCharacter(null);
    const { intr, _acks } = slashInteraction("bookend-join-start", "join");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const methods = _acks.map((a) => a.method);
    expect(methods).toContain("deferReply");
    expect(methods).toContain("editReply");
    expect((_acks[0].arg as any).flags).toBe(64); // MessageFlags.Ephemeral
    const edit = _acks.find((a) => a.method === "editReply")!;
    // VERBATIM baseline — the shipped title carries a double space after ⚔️; pinned
    // as-is (characterise, don't judge) so the M7.3 migration must preserve it.
    expect((edit.arg as any).embeds[0].title).toBe("⚔️  Forge Your Hero");
    expect((edit.arg as any).embeds[0].footer.text).toBe("Step 1 of 7 — 2-30 characters, no @ or #");
    expect((edit.arg as any).components[0].components[0].custom_id).toBe("join:name");
    expect(h.joinWizards.getSession("bookend-join-start")!.step).toBe(1);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("2 · slash /join with an existing character → 'already have a character' editReply; no session started", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());
    const { intr, _acks } = slashInteraction("bookend-join-exists", "join");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.characterExists).toContain("bookend-join-exists");
    const edit = _acks.find((a) => a.method === "editReply")!;
    expect((edit.arg as any).content).toBe("You already have a character. Type `/stats` to see it.");
    expect(h.joinWizards.getSession("bookend-join-exists")).toBeUndefined();
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("3 · join:name button → the name modal (join:name:modal)", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.joinWizards.start("bookend-join-namebtn");
    const { intr, _acks } = buttonInteraction("bookend-join-namebtn", "join:name");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const modal = _acks.find((a) => a.method === "showModal")!;
    expect((modal.arg as any).toJSON().custom_id).toBe("join:name:modal");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("4 · name modal with an invalid name (Bad@Name) → ephemeral ❌ safeNotify; session stays at step 1", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.joinWizards.start("bookend-join-namebad");
    const { intr, _acks } = modalInteraction("bookend-join-namebad", "join:name:modal", "Bad@Name");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.joinWizards.getSession("bookend-join-namebad")!.step).toBe(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    expect((reply.arg as any).flags).toBe(64); // ephemeral safeNotify
    expect((reply.arg as any).content).toContain("Name must not contain @ or #");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("5 · choice walk steps 2→7 — one button-fire per step, screens 3→8 snapshot each (itemSet lands the confirm screen)", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    const userId = "bookend-join-walk";
    h.joinWizards.start(userId);
    h.joinWizards.setName(userId, "Rowan");

    const steps: Array<{ step: number; value: string; next: number; heading?: string }> = [
      { step: 2, value: CLASS, next: 3, heading: "Upbringing" },
      { step: 3, value: UPBRINGING, next: 4, heading: "Race" },
      { step: 4, value: RACE, next: 5, heading: "Alignment" },
      { step: 5, value: ALIGNMENT, next: 6, heading: "Day Job" },
      { step: 6, value: DAYJOB, next: 7, heading: "Starting Kit" },
      { step: 7, value: ITEMSET, next: 8 },
    ];

    for (const s of steps) {
      const { intr, _acks } = buttonInteraction(userId, `join:choice:${s.step}:${s.value}`);
      await dispatchInteraction(intr as never, h.deps);

      nonEmpty(_acks);
      expect(h.joinWizards.getSession(userId)!.step).toBe(s.next);
      expect(_acks.some((a) => a.method === "deferUpdate")).toBe(true);
      const edit = _acks.find((a) => a.method === "editReply")!;
      if (s.next === 8) {
        expect((edit.arg as any).embeds[0].description).toContain("__**Ready**__");
        expect((edit.arg as any).embeds[0].footer.text).toBe("Review your choices and confirm");
        const buttons = ((edit.arg as any).components[0].components as Array<{ custom_id: string }>).map(
          (b) => b.custom_id,
        );
        expect(buttons).toEqual(["join:confirm", "join:restart"]);
      } else {
        expect((edit.arg as any).embeds[0].description).toContain(`__**${s.heading}**__`);
      }
      expect(snapshotAcks(_acks)).toMatchSnapshot();
    }
  });

  it("6 · join:confirm → createCharacter with the full CharCreateData, ✨ public announcement followUp, deleteReply + /hi followUp", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    // Canned char drives the post-confirm /hi render (the mock does not persist
    // createCharacter into getCharacter — characterise as-is).
    h.engine.setCharacter(oracleChar());
    h.engine.setMeta("day_number", "1");
    const userId = "bookend-join-confirm";
    wizardAtStep(h.joinWizards, userId, 8);
    const { intr, _acks } = buttonInteraction(userId, "join:confirm");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.createCharacter).toHaveLength(1);
    expect(h.engine.calls.createCharacter[0]).toMatchObject({
      discordUserId: userId,
      data: {
        name: "Rowan",
        class: CLASS,
        upbringing: UPBRINGING,
        race: RACE,
        alignment: ALIGNMENT,
        dayJob: DAYJOB,
        itemSetName: ITEMSET,
      },
    });
    expect(h.joinWizards.getSession(userId)).toBeUndefined();
    // Public ✨ announcement followUp carries the created-hero embed.
    const announcement = _acks.find(
      (a) =>
        a.method === "followUp" &&
        (a.arg as any)?.embeds?.[0]?.title === "✨ A new hero joins the Oak",
    );
    expect(announcement).toBeTruthy();
    // Wizard dropped, ephemeral /hi followUp painted via the dispatcher's renderHiScreen.
    const methods = _acks.map((a) => a.method);
    expect(methods).toContain("deleteReply");
    expect(methods.filter((m) => m === "followUp").length).toBe(2);
    const hiFollowUp = _acks.filter((a) => a.method === "followUp")[1];
    expect(navIds(hiFollowUp.arg)).toEqual(["nav:journal", "nav:action", "nav:look", "nav:map"]);
    expect(payloadText(hiFollowUp.arg)).toContain("Town Guard — Town Square — Daily Work");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("7 · join:restart → session reset to step 1; step-1 screen repainted", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    const userId = "bookend-join-restart";
    wizardAtStep(h.joinWizards, userId, 3); // mid-walk
    const { intr, _acks } = buttonInteraction(userId, "join:restart");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.joinWizards.getSession(userId)!.step).toBe(1);
    expect(_acks.some((a) => a.method === "deferUpdate")).toBe(true);
    const edit = _acks.find((a) => a.method === "editReply")!;
    expect((edit.arg as any).components[0].components[0].custom_id).toBe("join:name");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("8 · re-/join mid-wizard (session at step 3) → resumes the existing session, not step 1", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.engine.setCharacter(null);
    const userId = "bookend-join-resume";
    wizardAtStep(h.joinWizards, userId, 3);
    const { intr, _acks } = slashInteraction(userId, "join");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.joinWizards.getSession(userId)!.step).toBe(3);
    const edit = _acks.find((a) => a.method === "editReply")!;
    expect((edit.arg as any).embeds[0].description).toContain("__**Upbringing**__");
    expect((edit.arg as any).embeds[0].footer.text).toBe("Step 3 of 7 — Upbringing");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("17 · wizard TTL expiry → ephemeral 'session expired' safeNotify, session cleared", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    const userId = "bookend-join-ttl";
    wizardAtStep(h.joinWizards, userId, 2);
    // Advance the fake clock past the 10-min TTL (the transcript-10 local-clock pattern).
    vi.setSystemTime(new Date("2026-07-15T12:11:00Z"));
    try {
      const { intr, _acks } = buttonInteraction(userId, `join:choice:2:${CLASS}`);
      await dispatchInteraction(intr as never, h.deps);

      nonEmpty(_acks);
      const reply = _acks.find((a) => a.method === "reply")!;
      expect((reply.arg as any).flags).toBe(64); // ephemeral safeNotify
      expect((reply.arg as any).content).toBe(
        "❌ Your character creation session expired. Type `/join` to start over.",
      );
      // The expiry clears the draft (the old getOrThrow's delete-on-expiry semantics).
      expect(h.joinWizards.getSession(userId)).toBeUndefined();
      expect(snapshotAcks(_acks)).toMatchSnapshot();
    } finally {
      vi.setSystemTime(new Date("2026-07-15T12:00:00Z")); // back to the file-level Wednesday
    }
  });

  it("18 · _userInFlight double-click guard → a second click while the first hangs produces ZERO acks", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    const userId = "bookend-join-inflight";
    wizardAtStep(h.joinWizards, userId, 2); // at step 2 → the choice path's first ack is deferUpdate

    // Gate A's deferUpdate (the first interaction ack on the choice path) on a test-held
    // promise so A is provably in flight when B arrives.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const a = buttonInteraction(userId, `join:choice:2:${CLASS}`);
    // Must flip `deferred` before awaiting the gate: the harness's own deferUpdate now
    // does the same, and join.ts's subsequent editReply asserts on that flag.
    (a.intr as any).deferUpdate = vi.fn(async () => {
      a._acks.push({ method: "deferUpdate", arg: null });
      (a.intr as any).deferred = true;
      await gate;
    });
    const b = buttonInteraction(userId, `join:choice:2:${CLASS}`);

    const promiseA = dispatchInteraction(a.intr as never, h.deps);
    await vi.waitFor(() => expect((a.intr as any).deferUpdate).toHaveBeenCalled());
    await dispatchInteraction(b.intr as never, h.deps);

    // B dropped silently — no acks at all.
    expect(b._acks).toEqual([]);

    releaseGate();
    await promiseA;
    expect(a._acks.map((x) => x.method)).toEqual(["deferUpdate", "editReply"]);
    expect(snapshotAcks(a._acks)).toMatchSnapshot();
  });

  it("19 · illegal-choice (wrong step) → ephemeral 'That option is no longer available' safeNotify; session still at step 2", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    const userId = "bookend-join-illegal";
    wizardAtStep(h.joinWizards, userId, 2); // at step 2 — a step-3 click is illegal
    const { intr, _acks } = buttonInteraction(userId, `join:choice:3:${UPBRINGING}`);
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const reply = _acks.find((a) => a.method === "reply")!;
    expect((reply.arg as any).flags).toBe(64); // ephemeral safeNotify
    expect((reply.arg as any).content).toBe(
      "❌ That option is no longer available. Type `/join` to start over.",
    );
    expect(h.joinWizards.getSession(userId)!.step).toBe(2);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// hi — 3 transcripts (the M7.2 migration's net)
// ═══════════════════════════════════════════════════════════════════════════

describe("bookend oracle — hi", () => {
  it("9 · slash /hi weekday → day-job greeting (location line, header, seeded actions) + nav bar", async () => {
    const h = makeHarness();
    h.engine.setMeta("day_number", "1");
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar({ lastActionState: null }));
    const { intr, _acks } = slashInteraction("bookend-hi-weekday", "hi");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.updateLastPlayed).toContain(1);
    const reply = _acks.find((a) => a.method === "reply")!;
    expect((reply.arg as any).flags).toBe(32768 | 64); // Components V2 + ephemeral
    const text = payloadText(reply.arg);
    expect(text).toContain("📍 🛡️ **The Warden's Oak** — Use `look` for the full scene.");
    expect(text).toContain("⚔️  **Aldric** — Warrior");
    expect(text).toContain("Town Guard — Town Square — Daily Work");
    // The seeded (charId=1, day=1 → seed 1001) action sample — the M7.2 migration
    // must keep this output byte-identical.
    expect(text).toContain("Drill with the watch");
    expect(text).toContain("Inspect the lockup");
    expect(text).toContain("Stand the gate");
    expect(text).not.toContain("Weekend");
    expect(navIds(reply.arg)).toEqual(["nav:journal", "nav:action", "nav:look", "nav:map"]);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("10 · slash /hi weekend → adventure hooks (clock locally set to Saturday 2026-07-18, restored after)", async () => {
    vi.setSystemTime(new Date("2026-07-18T12:00:00Z")); // Saturday
    try {
      const h = makeHarness();
      h.engine.setMeta("day_number", "1");
      h.engine.setCharacterExists(true);
      h.engine.setCharacter(oracleChar({ lastActionState: null }));
      const { intr, _acks } = slashInteraction("bookend-hi-weekend", "hi");
      await dispatchInteraction(intr as never, h.deps);

      nonEmpty(_acks);
      const reply = _acks.find((a) => a.method === "reply")!;
      const text = payloadText(reply.arg);
      expect(text).toContain("🌅 **Weekend — The world is yours.**");
      expect(text).toContain("Adventure hooks:");
      expect(text).toContain("**Travel**");
      expect(text).not.toContain("Daily Work");
      expect(snapshotAcks(_acks)).toMatchSnapshot();
    } finally {
      vi.setSystemTime(new Date("2026-07-15T12:00:00Z")); // back to the file-level Wednesday
    }
  });

  it("11 · slash /hi with a pending action → ⏳ Unfinished Action screen (prompt + narration), no startAction", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(
      oracleChar({ lastActionState: { rawInput: "scout the ridge", decisions: [], accumulatedDc: 10 } }),
    );
    h.engine.setResumeResult({
      state: { rawInput: "scout the ridge", decisions: [], accumulatedDc: 10 },
      nextDecision: {
        prompt: "The trail forks. Continue?",
        options: [],
        narration: "You stand at the ridgeline, wind pulling at your cloak.",
      },
    } as never);
    const { intr, _acks } = slashInteraction("bookend-hi-resume", "hi");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.resumeAction).toContain(1);
    expect(h.engine.calls.startAction.length).toBe(0);
    const reply = _acks.find((a) => a.method === "reply")!;
    const text = payloadText(reply.arg);
    expect(text).toContain("⏳ **Unfinished Action**");
    expect(text).toContain("You stand at the ridgeline");
    expect(text).toContain("The trail forks. Continue?");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  // D2 (carried since M7.2, settled here per M9.3's scope fence): a stale pending action
  // makes hi.open's resume throw. composeHiScreen's `engine.resumeAction` read is untried
  // (hiScreen.ts:109), so the throw crosses the router's never-throws boundary into
  // ok:false 'internal', and commands/hi.ts's `!response.ok` branch returns the bare
  // `error.message` — no ❌ wrap, no notifyAdmin (hi.ts never calls it). Pinned as today's
  // actual behaviour, not fixed here.
  it("12 · slash /hi with a pending action resumeAction can't recover → the raw internal-error message reaches the player, no friendly wrap, no notifyAdmin (D2)", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(
      oracleChar({ lastActionState: { rawInput: "scout the ridge", decisions: [], accumulatedDc: 10 } }),
    );
    // No setResumeResult → MockWorldEngine.resumeAction throws "no canned result set",
    // standing in for a genuinely stale/corrupted pending action.
    const { intr, _acks } = slashInteraction("bookend-hi-resume-throws", "hi");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.resumeAction).toContain(1);
    expect(h.notifyAdmin).not.toHaveBeenCalled();
    const reply = _acks.find((a) => a.method === "reply")!;
    const text = payloadText(reply.arg);
    expect(text).toContain("no canned result set");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// sleep — 5 transcripts (the M7.1 rest+tick migration's net)
// ═══════════════════════════════════════════════════════════════════════════

describe("bookend oracle — sleep", () => {
  it("12 · unsafe rest (THE M7.1 pin) → restAtOak + modifyHealth(−1), ⚠️ penalty section, announceCollapse once", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(
      oracleChar({ rollsRemaining: 0, lastActionState: null, location: "The Broken Keep" }),
    );
    h.engine.setLocation({
      name: "The Broken Keep",
      description: "Ruins.",
      tags: ["ruins"],
      isSafe: false,
      emoji: "🏚️",
    });
    announceCollapseSpy.mockClear();
    const { intr, _acks } = slashInteraction("bookend-sleep-unsafe", "sleep");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    // The penalty path: rest, then −1 HP.
    expect(h.engine.calls.restAtOak).toEqual(["bookend-sleep-unsafe"]);
    expect(h.engine.calls.modifyHealth).toEqual([
      { discordUserId: "bookend-sleep-unsafe", amount: -1 },
    ]);
    // Collapse announced publicly with prev/new vitals (10 ❤️ → 9 ❤️).
    expect(announceCollapseSpy).toHaveBeenCalledTimes(1);
    expect(announceCollapseSpy).toHaveBeenCalledWith(
      "Aldric",
      { health: 10, stamina: 10 },
      { health: 9, stamina: 10 },
    );
    const reply = _acks.find((a) => a.method === "reply")!;
    // /sleep is NOT ephemeral (not in the slash arm's ephemeral list) — V2 only.
    expect((reply.arg as any).flags).toBe(32768);
    const text = payloadText(reply.arg);
    expect(text).toContain("⚠️ **Resting on unsafe ground costs 1 HP.**");
    expect(text).toContain("You bedded down at **The Broken Keep**");
    expect(text).toContain("you lost **1 HP**. (9/10 ❤️)");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("13 · workplace exemption (H1) → rest at the Town Guard's workplace proceeds with NO penalty", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(
      oracleChar({ rollsRemaining: 0, lastActionState: null, location: "Town Square" }),
    );
    // isSafe: false, but the char is AT its resolved workplace → exemption.
    h.engine.setLocation({
      name: "Town Square",
      description: "The market square.",
      tags: ["town"],
      isSafe: false,
      emoji: "🏛️",
    });
    const { intr, _acks } = slashInteraction("bookend-sleep-workplace", "sleep");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.restAtOak).toEqual(["bookend-sleep-workplace"]);
    expect(h.engine.calls.modifyHealth.length).toBe(0);
    const text = payloadText(_acks.find((a) => a.method === "reply")!.arg);
    expect(text).toContain("You bank the fire and bed down beneath the Oak.");
    expect(text).not.toContain("costs 1 HP");
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });

  it("14 · guards → ⛔ 'day is still young' (rolls remain) and ⛔ 'Cannot rest now' (mid-action); no restAtOak either way", async () => {
    // Guard (a): rollsRemaining > 0.
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar({ rollsRemaining: 1, lastActionState: null }));
    const { intr, _acks } = slashInteraction("bookend-sleep-guard-rolls", "sleep");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    expect(h.engine.calls.restAtOak.length).toBe(0);
    const textA = payloadText(_acks.find((a) => a.method === "reply")!.arg);
    expect(textA).toContain("⛔ **Cannot rest now**");
    expect(textA).toContain("The day is still young — you have actions left to take.");
    expect(snapshotAcks(_acks)).toMatchSnapshot();

    // Guard (b): pending action.
    const h2 = makeHarness();
    h2.engine.setCharacterExists(true);
    h2.engine.setCharacter(
      oracleChar({ rollsRemaining: 0, lastActionState: { rawInput: "hunt", decisions: [], accumulatedDc: 10 } }),
    );
    const { intr: intr2, _acks: _acks2 } = slashInteraction("bookend-sleep-guard-midaction", "sleep");
    await dispatchInteraction(intr2 as never, h2.deps);

    nonEmpty(_acks2);
    expect(h2.engine.calls.restAtOak.length).toBe(0);
    const textB = payloadText(_acks2.find((a) => a.method === "reply")!.arg);
    expect(textB).toContain("⛔ **Cannot rest now**");
    expect(textB).toContain("You are mid-action — finish what you started before bedding down.");
    expect(snapshotAcks(_acks2)).toMatchSnapshot();
  });

  it("15 · admin tick → tick(true), morning announcement with banner files, NO nav bar / sleep:feedback row", async () => {
    const prevAdmin = process.env.ADMIN_USER_ID;
    const prevTick = process.env.SLEEP_ADMIN_TICK;
    // The sleep factory reads ADMIN_USER_ID at construction — set BEFORE makeHarness().
    process.env.ADMIN_USER_ID = "admin-000";
    process.env.SLEEP_ADMIN_TICK = "true";
    try {
      const h = makeHarness();
      // The admin has a character in production — without this, the character gate
      // would reroute admin-000 to the join wizard before the sleep handler runs.
      h.engine.setCharacterExists(true);
      h.engine.setCharacter(oracleChar());
      h.engine.setTickResult({
        dayNumber: 2,
        playersAffected: 1,
        npcMovements: [{ npcId: 5, npcName: "Merchant", fromLocation: "Oak", toLocation: "Town" }],
        absentWarnings: [],
        collapsedNames: [],
      });
      const { intr, _acks } = slashInteraction("admin-000", "sleep");
      await dispatchInteraction(intr as never, h.deps);

      nonEmpty(_acks);
      expect(h.engine.calls.tick).toEqual([true]);
      const reply = _acks.find((a) => a.method === "reply")!;
      // Single container — no nav rows, no appended sleep:feedback row.
      expect((reply.arg as any).components.length).toBe(1);
      expect(JSON.stringify(reply.arg)).not.toContain("sleep:feedback");
      // Banner media gallery + attachment.
      expect(JSON.stringify(reply.arg)).toContain("attachment://daily-pixel-banner.png");
      expect((reply.arg as any).files).toBeTruthy();
      const text = payloadText(reply.arg);
      expect(text).toContain("🌅 **Day 2 begins.**");
      expect(text).toContain("─ 1 soul(s) stirred, 1 NPC(s) on the move.");
      expect(snapshotAcks(_acks)).toMatchSnapshot();
    } finally {
      if (prevAdmin === undefined) delete process.env.ADMIN_USER_ID;
      else process.env.ADMIN_USER_ID = prevAdmin;
      if (prevTick === undefined) delete process.env.SLEEP_ADMIN_TICK;
      else process.env.SLEEP_ADMIN_TICK = prevTick;
    }
  });

  it("16 · no-character /sleep → reroutes through the character gate to the join wizard (step-1 screen, no reply)", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(false);
    h.engine.setCharacter(null);
    const { intr, _acks } = slashInteraction("bookend-sleep-norechar", "sleep");
    await dispatchInteraction(intr as never, h.deps);

    nonEmpty(_acks);
    const methods = _acks.map((a) => a.method);
    expect(methods).toContain("deferReply");
    expect(methods).toContain("editReply");
    expect(methods).not.toContain("reply");
    expect(h.engine.calls.characterExists).toContain("bookend-sleep-norechar");
    // The gate handed the interaction to the join wizard — a fresh session at step 1.
    expect(h.joinWizards.getSession("bookend-sleep-norechar")!.step).toBe(1);
    expect(snapshotAcks(_acks)).toMatchSnapshot();
  });
});
