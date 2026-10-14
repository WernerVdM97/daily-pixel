/**
 * The favoured-option rule, in one place. The decision screen renders the tell (green button plus
 * "a safer path catches your eye") and the engine hands the same flag to RESOLVE, so the promise
 * the player acted on and the one the narrator is told about are computed from identical inputs.
 */

/** How much easier the safest option must be than the next-best before passive insight flags it —
 *  keeps the tell rare and earned rather than a DC readout. */
export const INSIGHT_MARGIN = 2;

/** Passive insight: 10 + WIS. An option is only ever spotted at or under this effective DC. */
export function passiveInsight(wisdom: number): number {
  return 10 + wisdom;
}

/**
 * Index of the one option passive insight flags as the safest route, or -1 when none qualifies:
 * the lowest effective DC, within passive insight, and at least `INSIGHT_MARGIN` clearer than the
 * next-best. Two or more real (non-bail) options are required — the tell is comparative, and a
 * lone option is not a choice.
 */
export function favouredOptionIndex(
  options: ReadonlyArray<{ dcModifier: number | null }>,
  effectiveDc: number,
  insight: number,
): number {
  const real = options
    .map((opt, i) => ({ i, effDc: effectiveDc + (opt.dcModifier ?? 0), bail: opt.dcModifier === null }))
    .filter(o => !o.bail)
    .sort((a, b) => a.effDc - b.effDc);
  if (real.length < 2) return -1;
  const [best, second] = real;
  return insight >= best.effDc && second.effDc - best.effDc >= INSIGHT_MARGIN ? best.i : -1;
}
