/**
 * The brain's working memory, as text (`docs/engine/agent-player-personas.md`). The harness owns the
 * cells; this module owns the shaping — pure functions, no harness state and no clock.
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

/** The most recent attempts the day log keeps REGARDLESS of kind. The block is the brain's only
 *  per-attempt memory, so it must always carry what just happened even on a day of pure refusals. */
const DAY_LOG_RECENT_WINDOW = 4;

/** Default cap on a single outcome digest — enough to identify the action, not a data dump. */
const OUTCOME_MAX_LEN = 100;

/** A render's opening chrome: a markdown code fence (bare or language-tagged) or heading marks with no
 *  text. A first line matching either says nothing about what happened. */
const OPENING_CHROME = [/^`{3,}[\sA-Za-z]*$/, /^#{1,6}\s*$/];

/** The first line of an outcome that actually says something, whitespace-collapsed and truncated with
 *  a trailing `…` past `maxLen`; empty text summarises to ''. Opening chrome is skipped, not summarised. */
export function summarizeOutcome(text: string, maxLen = OUTCOME_MAX_LEN): string {
  const first = text.split('\n').find((line) => isContent(line));
  if (first === undefined) return '';
  const collapsed = first.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen).trimEnd()}…`;
}

/** True when a line carries content rather than being empty or opening chrome. */
function isContent(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return !OPENING_CHROME.some((chrome) => chrome.test(trimmed));
}

/** Today's attempts as a numbered block — the context that stops the brain repeating a rejected option.
 *  '' when nothing has been attempted yet, so the caller can omit the section. */
export function buildDayLog(entries: DayLogEntry[]): string {
  if (entries.length === 0) return '';
  const kept = keptIndices(entries);
  const lines: string[] = [];
  entries.forEach((entry, i) => {
    // N is the attempt's ORDINAL in the day, not its position in the kept set: an omitted attempt
    // has to leave a visible gap, or the brain reads a shorter day than it actually played.
    if (kept.has(i)) lines.push(`${i + 1}. ${entry.attempt} → ${entry.result}`);
  });
  const omitted = entries.length - kept.size;
  if (omitted > 0) lines.unshift(`(${omitted} earlier attempts omitted)`);
  return lines.join('\n');
}

/** The attempts that survive the line cap, as indices into `entries`: EVERY refusal, then the most
 *  recent `DAY_LOG_RECENT_WINDOW`, then non-refusals up to `DAY_LOG_MAX_LINES`. */
function keptIndices(entries: DayLogEntry[]): Set<number> {
  const keep = new Set<number>();
  entries.forEach((entry, i) => {
    if (entry.refused) keep.add(i);
  });
  for (let i = Math.max(0, entries.length - DAY_LOG_RECENT_WINDOW); i < entries.length; i++) keep.add(i);
  for (let i = entries.length - 1; i >= 0 && keep.size < DAY_LOG_MAX_LINES; i--) {
    if (!entries[i].refused) keep.add(i);
  }
  return keep;
}

/** The day-start block: yesterday's outcome lines in order, then the disposition the day ended on.
 *  Deliberately silent on the intent and arc note — those ride every turn, so it cannot go stale. */
export function buildRecap(input: {
  dayNumber: number; // the day now starting
  yesterdayOutcomes: string[]; // first lines, in order
  yesterdayEnded?: string; // 'slept' | 'no-rolls' | 'stalled' | 'crashed'
  lastPlayedDay?: number; // the last day actually played; absent = the caller does not know
}): string {
  // `lastPlayedDay` is not always the day before this one: a panel-interrupted run resumes after days
  // of world it never saw. Absent (or the day before) means no days passed without a player.
  const lastPlayedDay = input.lastPlayedDay ?? input.dayNumber - 1;
  const missed = input.dayNumber - lastPlayedDay - 1;
  const lines = [
    missed > 0 ? `LAST PLAYED (day ${lastPlayedDay}):` : `YESTERDAY (day ${lastPlayedDay}):`,
  ];
  // The gap is named, not apologised for, and it is one line — the recap is a day-start block.
  if (missed > 0) lines.push(`${missed} ${missed === 1 ? 'day' : 'days'} passed without you.`);
  input.yesterdayOutcomes.forEach((outcome, i) => {
    lines.push(`${i + 1}. ${outcome}`);
  });
  if (input.yesterdayEnded !== undefined) lines.push(`ended: ${input.yesterdayEnded}`);
  return lines.join('\n');
}
