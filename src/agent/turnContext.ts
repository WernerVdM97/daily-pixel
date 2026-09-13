/**
 * The brain's working memory, as text (spec § B, `docs/engine/agent-player-personas.md`).
 *
 * The harness owns the cells (today's lines, yesterday's lines, the disposition it ended on);
 * this module owns the shaping — pure functions over plain data, so the recap block, the day log
 * and the outcome digest can be unit-tested without a run. Deliberately no harness state and no
 * clock: the same inputs always render the same bytes.
 */

/** One line of the day log: what was attempted, what came back, and whether it was refused. */
export interface DayLogEntry {
  /** Human label of what was attempted, e.g. `free action: "search the cart"`, `day job: Stand the
   *  gate`, `recon: /map`. */
  attempt: string;
  /** Outcome summary, or the refusal reason (`refused: unsafe ground`). */
  result: string;
  /** True for a refusal/dead-end/illegal pick. Refusals are never dropped by the line cap. */
  refused: boolean;
}

/** Lines `buildDayLog` will spend on a day before it starts dropping the older attempts. */
const DAY_LOG_MAX_LINES = 12;

/** Default cap on a single outcome digest — enough to identify the action, not a data dump. */
const OUTCOME_MAX_LEN = 100;

/** The first line of an outcome, whitespace-collapsed, truncated with a trailing `…` when it is
 *  longer than `maxLen`. Empty text has no first line and summarises to ''. */
export function summarizeOutcome(text: string, maxLen = OUTCOME_MAX_LEN): string {
  const first = text.split('\n').find((line) => line.trim() !== '');
  if (first === undefined) return '';
  const collapsed = first.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen).trimEnd()}…`;
}

/** Today's attempts as a numbered block — the context that stops the brain repeating a rejected
 *  option (the baseline's five-identical-picks stall). '' when nothing has been attempted yet, so
 *  the caller can omit the whole section. */
export function buildDayLog(entries: DayLogEntry[]): string {
  if (entries.length === 0) return '';
  const kept = entries.length <= DAY_LOG_MAX_LINES ? entries : withinLineCap(entries);
  const omitted = entries.length - kept.length;
  const lines = kept.map((entry, i) => `${i + 1}. ${entry.attempt} → ${entry.result}`);
  if (omitted > 0) lines.unshift(`(${omitted} earlier attempts omitted)`);
  return lines.join('\n');
}

/** Over the cap: EVERY refusal survives (they are the whole point — a refused option is what the
 *  brain must not pick again) and the most recent non-refusals fill whatever budget is left.
 *  Original order is preserved. */
function withinLineCap(entries: DayLogEntry[]): DayLogEntry[] {
  const refused = entries.filter((entry) => entry.refused).length;
  let budget = Math.max(0, DAY_LOG_MAX_LINES - refused);
  const keep = new Set<number>();
  for (let i = entries.length - 1; i >= 0 && budget > 0; i--) {
    if (entries[i].refused) continue;
    keep.add(i);
    budget--;
  }
  return entries.filter((entry, i) => entry.refused || keep.has(i));
}

/** The day-start block: yesterday's outcome lines in order, then the disposition the day ended on.
 *  Never mentions the arc note or the intent — those ride every turn instead (spec § B), so a
 *  recap cannot go stale against them. */
export function buildRecap(input: {
  dayNumber: number; // the day now starting
  yesterdayOutcomes: string[]; // first lines, in order
  yesterdayEnded?: string; // 'slept' | 'no-rolls' | 'stalled' | 'crashed'
}): string {
  const lines = [`YESTERDAY (day ${input.dayNumber - 1}):`];
  input.yesterdayOutcomes.forEach((outcome, i) => lines.push(`${i + 1}. ${outcome}`));
  if (input.yesterdayEnded !== undefined) lines.push(`ended: ${input.yesterdayEnded}`);
  return lines.join('\n');
}
