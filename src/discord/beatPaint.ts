/**
 * Shared by dispatchInteraction.ts and commands/action.ts: both stash the router's advisory
 * beat-paint promise in a local `beatPaint` for a later `await`, but the router's `emitBeat`
 * (src/protocol/router.ts) does not await `onBeat` itself — only its own try/catch guards a
 * SYNCHRONOUS throw from the callback. That leaves the assignment's promise unobserved from
 * the moment it is created until the caller reaches the later `await beatPaint`, a window that
 * spans the router's own backend call (a real LLM round-trip in production). A rejection inside
 * that window — the M10.0 10062 case, an ack landing past Discord's 3-second window — fires
 * Node's process-level `unhandledRejection` (src/index.ts) and pages the operator, even though
 * the later `await beatPaint` goes on to handle the SAME rejection properly. One failure, two
 * pages.
 */

/**
 * Marks the paint promise handled the moment it is created: the router does not await onBeat,
 * so a rejecting ack sits unhandled across the whole LLM call and trips the process-level
 * unhandledRejection net in index.ts, paging the operator a second time for a failure the
 * awaited site below already handles. The `await` still sees the rejection.
 */
export function trackPaint(p: Promise<void>): Promise<void> {
  p.catch(() => {});
  return p;
}
