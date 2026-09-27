/**
 * The router does not await `onBeat`, so without `trackPaint` a rejecting paint would sit unobserved
 * until the caller's later `await` — one failure, two pages.
 */

/**
 * Marks the promise handled at creation; the caller's own `await` still receives the rejection.
 */
export function trackPaint(p: Promise<void>): Promise<void> {
  p.catch(() => {});
  return p;
}
