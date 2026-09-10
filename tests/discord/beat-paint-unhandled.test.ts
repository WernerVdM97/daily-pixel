import { describe, it, expect, vi } from "vitest";
import { trackPaint } from "../../src/discord/beatPaint.js";
import { dispatchInteraction } from "../../src/discord/dispatchInteraction.js";
import { makeHarness, oracleChar, buttonInteraction } from "./dispatch-harness.js";

/**
 * DC-fix/beat-paint-unhandled: `router.dispatch`'s `onBeat` callback (src/protocol/router.ts
 * `emitBeat`) is never awaited by the router itself — only a SYNCHRONOUS throw from the
 * callback is caught. The four call sites this fixes stash their paint promise in a local
 * `beatPaint` and only await it once `router.dispatch` resolves, which in production spans a
 * real LLM round-trip. A rejecting ack in that window (a 10062 past Discord's 3-second window)
 * used to sit with zero handlers across the whole gap and trip `process.on("unhandledRejection")`
 * in src/index.ts, paging the operator a SECOND time for a failure the later `await beatPaint`
 * already handles. `trackPaint` closes the window by attaching a handler the moment the
 * promise is created, without changing what the later `await` observes.
 */

// Every test registers and tears down its OWN `unhandledRejection` listener via try/finally,
// never relying on vitest's own per-worker handler to double as the assertion surface: Node
// allows multiple listeners (vitest's own runs ALONGSIDE this one, not shadowed by it), and a
// listener left registered past its test would bleed into later, unrelated test files.
function withUnhandledRejectionTap<T>(fn: (seen: unknown[]) => Promise<T>): Promise<T> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  return fn(seen).finally(() => process.off("unhandledRejection", onUnhandled));
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("trackPaint — the property, proven non-vacuous", () => {
  it("guarded: a promise rejecting across a real macrotask gap fires no process-level unhandledRejection, and the later await still observes the rejection", async () => {
    await withUnhandledRejectionTap(async (seen) => {
      const err = new Error("simulated 10062 — Unknown interaction");
      // Mirrors the real shape: the IIFE rejects the instant it's created (the ack call fails
      // immediately), then nothing looks at the promise again until well past a macrotask
      // boundary — the gap a real LLM call (runWork/runCustomAction/stepChoice) opens between
      // the beat firing and `router.dispatch` resolving.
      const tracked = trackPaint(Promise.reject(err));

      await macrotask();
      await macrotask();

      expect(seen).toEqual([]); // trackPaint's synchronous .catch already handled it

      // trackPaint returns the SAME promise reference — the later `if (beatPaint) await
      // beatPaint` in the real call sites still sees and handles the failure.
      await expect(tracked).rejects.toBe(err);
    });
  });

  it("is non-vacuous: the identical scenario WITHOUT trackPaint's guard genuinely produces a process-level unhandledRejection", async () => {
    await withUnhandledRejectionTap(async (seen) => {
      const err = new Error("simulated 10062 — Unknown interaction");
      const unguarded = Promise.reject(err); // no handler attached — the pre-fix shape

      // Same gap as above. Node's unhandledRejection check runs at the next macrotask
      // boundary after a rejection with zero handlers, which is exactly what this crosses.
      await macrotask();
      await macrotask();

      // Attach the "later await" only now, mirroring the real call sites' `if (beatPaint)
      // await beatPaint`, which only runs once the router's backend call has resolved.
      let observed: unknown;
      await unguarded.catch((e) => {
        observed = e;
      });

      // Proves the gap was real: without the guard, Node already fired unhandledRejection
      // before this catch ever attached — the exact failure trackPaint exists to prevent.
      // (Node also emits a harmless `PromiseRejectionHandledWarning` here, since the handler
      // above does attach eventually — expected, not a test failure: confirmed to leave the
      // suite's exit code at 0.)
      expect(seen).toEqual([err]);
      expect(observed).toBe(err);
    });
  });
});

describe("trackPaint — the four real call sites route through it (day-job leaf, sites 1+2)", () => {
  // MockWorldEngine.startAction is declared async but has a fully SYNCHRONOUS body (no
  // macrotask gap), so the standard harness would give a FALSE GREEN here: a rejection handled
  // later in the same uninterrupted microtask chain is retroactively marked handled regardless
  // of whether trackPaint is wired in. An instance-level monkeypatch injects a genuine gap.
  //
  // No commute result is set (stays at the engine's default `null`), so `commuteForWork`
  // reports "already there" and the router never fires the commute beat — `beatPaint` is
  // purely site 1's (the loading IIFE) promise, un-chained. This matters for what the test
  // can actually prove: `.then()`/`.catch()` on a promise counts as "handling" it for Node's
  // unhandled-rejection bookkeeping regardless of whether a rejection handler is supplied, so
  // with a commute in play site 2's `(beatPaint ?? Promise.resolve()).then(...)` would silently
  // absorb an unwrapped site 1 into its own (wrapped) chain — a false pass that would prove
  // nothing about site 1 specifically. Confirmed live: reverting only site 1's `trackPaint(...)`
  // wrap left this exact test green while a commute result was set, which is why it is isolated
  // out here instead.
  it("dayjob.start, no commute: a rejecting deferUpdate across a real startAction delay pages the operator exactly once, with no process-level unhandledRejection", async () => {
    await withUnhandledRejectionTap(async (seen) => {
      const h = makeHarness();
      h.engine.setMeta("day_number", "1");
      h.engine.setCharacter(oracleChar({ location: "The Warden's Oak" }));

      const CANNED = {
        state: { rawInput: "Walk the rounds", decisions: [], accumulatedDc: 10, kind: "work" },
        firstDecision: {
          prompt: "The gate creaks. What do you do?",
          options: [{ label: "Advance carefully", dcModifier: 0, stat: "physical" }],
        },
      };
      vi.spyOn(h.engine, "startAction").mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return CANNED as never;
      });

      const { intr, _acks } = buttonInteraction("cid-beatpaint-dayjob", "action:dayjob:0");
      // Simulate a 10062 "Unknown interaction": the ack call rejects, and — unlike the fake's
      // normal deferUpdate — never flips `intr.deferred`, matching discord.js's real behaviour
      // on a failed ack.
      const ackError = new Error("Unknown interaction");
      (intr as { deferUpdate: unknown }).deferUpdate = vi.fn(async () => {
        throw ackError;
      });

      await expect(dispatchInteraction(intr as never, h.deps)).resolves.toBeUndefined();

      // Give any late unhandled rejection a chance to surface before asserting its absence.
      await macrotask();
      await macrotask();

      expect(seen).toEqual([]);
      // The catch's own paging fired exactly once for this one failure — the defect this
      // fix closes is a SECOND page from the unobserved beatPaint promise, on top of this one.
      expect(h.notifyAdmin).toHaveBeenCalledTimes(1);
      expect(h.notifyAdmin).toHaveBeenCalledWith("Action (day-job) failed", ackError);
      // Un-acked (deferUpdate rejected, `deferred`/`replied` both still false) → the leaf's
      // M10.0 branch replies plainly rather than routing through the followup webhook.
      expect(_acks).toEqual([
        {
          method: "reply",
          arg: {
            content: "❌ **Could not act.**\nUnknown interaction",
            flags: expect.anything(),
          },
        },
      ]);
    });
  });
});
