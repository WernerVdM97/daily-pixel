/**
 * The brain's working memory, shaped (spec § B, T1). `turnContext.ts` is deliberately pure so the
 * three blocks the harness feeds back — the recap, the day log and the outcome digest — can be
 * pinned here rather than through a run.
 *
 * The shaping rules are the contract's, not free choices: the day log is the fix for the
 * baseline's five-identical-picks stall (so a REFUSAL must survive the line cap, the most recent
 * attempts must survive whatever their kind, and a long day must say how much it dropped), the
 * numbering is the attempt's ordinal IN THE DAY (an omitted attempt has to leave a visible gap),
 * and the recap carries yesterday's lines plus how the day ended.
 */

import { describe, it, expect } from 'vitest';

import { buildDayLog, buildRecap, summarizeOutcome } from '../../src/agent/turnContext.js';
import type { DayLogEntry } from '../../src/agent/turnContext.js';

const entry = (attempt: string, result: string, refused = false): DayLogEntry => ({ attempt, result, refused });

describe('summarizeOutcome', () => {
  it('takes the first non-empty line, whitespace-collapsed', () => {
    expect(summarizeOutcome('\n\n  You finish the chore   and pocket the coin.\nsecond line')).toBe(
      'You finish the chore and pocket the coin.',
    );
    expect(summarizeOutcome('one\t\ttwo\nthree')).toBe('one two');
  });

  it('summarises empty text to nothing rather than throwing', () => {
    expect(summarizeOutcome('')).toBe('');
    expect(summarizeOutcome('\n   \n')).toBe('');
  });

  it('skips opening chrome and falls through to the first line that says something', () => {
    // /look's render opens with a bare ``` fence; without the skip its day-log line reads
    // `recon: /look → ``` ` and tells the brain nothing.
    expect(summarizeOutcome("```\n🌳 The Warden's Oak\n```")).toBe("🌳 The Warden's Oak");
    // A language-tagged fence, and heading marks with no text, are chrome too — stacked chrome
    // keeps falling through.
    expect(summarizeOutcome('```ansi\n🛡️ Safe here\n```')).toBe('🛡️ Safe here');
    expect(summarizeOutcome('##\n\n# \nA real line')).toBe('A real line');
    // A heading WITH text is content, not chrome.
    expect(summarizeOutcome('# The Bog\nsecond')).toBe('# The Bog');
    // Nothing but chrome has no first line at all.
    expect(summarizeOutcome('```\n```')).toBe('');
  });

  it('caps the line and marks the cut with a trailing ellipsis', () => {
    expect(summarizeOutcome('x'.repeat(150))).toBe(`${'x'.repeat(100)}…`);
    expect(summarizeOutcome('abcdef', 3)).toBe('abc…');
    // Under the cap nothing is marked — a 3-char line at maxLen 3 is not "cut".
    expect(summarizeOutcome('abc', 3)).toBe('abc');
  });
});

describe('buildDayLog', () => {
  it('is empty when nothing has been attempted yet (the caller omits the section)', () => {
    expect(buildDayLog([])).toBe('');
  });

  it('numbers the day in order, outcome summaries and refusals alike', () => {
    expect(
      buildDayLog([
        entry('day job: Stand the gate', 'You finish the chore and pocket the coin.'),
        entry('free action: "search the cart"', 'refused: unsafe', true),
        entry('recon: /map', '🗺️ The World Map'),
      ]),
    ).toBe(
      '1. day job: Stand the gate → You finish the chore and pocket the coin.\n' +
        '2. free action: "search the cart" → refused: unsafe\n' +
        '3. recon: /map → 🗺️ The World Map',
    );
  });

  it('keeps the block whole at the cap and drops the OLDEST attempts beyond it', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => entry(`attempt ${i}`, `result ${i}`));
    const block = buildDayLog(twelve);
    expect(block.split('\n')).toHaveLength(12);
    expect(block).not.toContain('omitted');

    const fifteen = Array.from({ length: 15 }, (_, i) => entry(`attempt ${i}`, `result ${i}`));
    const capped = buildDayLog(fifteen).split('\n');
    expect(capped[0]).toBe('(3 earlier attempts omitted)');
    // Numbered by the attempt's ordinal IN THE DAY: the omitted 1-3 leave the visible gap 3 → 4.
    expect(capped[1]).toBe('4. attempt 3 → result 3');
    expect(capped[12]).toBe('15. attempt 14 → result 14');
  });

  it('keeps the most recent attempts even when refusals alone would spend the whole budget', () => {
    // The repro the budget rule fixes: 12 refusals then 3 completed actions. The old rule spent
    // every line on refusals, so the brain read an all-refusal day after completing three actions
    // — and the three it dropped were the MOST RECENT, which the marker called "earlier".
    const entries = [
      ...Array.from({ length: 12 }, (_, i) => entry(`refused attempt ${i}`, 'refused: unsafe', true)),
      ...Array.from({ length: 3 }, (_, i) => entry(`day job: job ${i}`, `outcome ${i}`)),
    ];
    const lines = buildDayLog(entries).split('\n');

    expect(lines.some((l) => l.startsWith('('))).toBe(false);
    // All three completed actions survive, and the day's most recent attempts are all present.
    expect(lines).toContain('13. day job: job 0 → outcome 0');
    expect(lines).toContain('14. day job: job 1 → outcome 1');
    expect(lines).toContain('15. day job: job 2 → outcome 2');
    expect(lines.filter((l) => l.includes('refused: unsafe'))).toHaveLength(12);
  });

  it('spends the rest of the budget on the most recent non-refusals', () => {
    // 16 attempts, one early refusal: the refusal (#2) + the 4-entry recent window (12-15) leaves 7
    // slots, which go to the most recent remaining attempts (#6-12), so #1, #3, #4 and #5 are the
    // ones dropped — and the marker counts 4, all of them older than the kept window.
    const entries = Array.from({ length: 16 }, (_, i) => entry(`attempt ${i}`, `result ${i}`, i === 1));
    const lines = buildDayLog(entries).split('\n');

    expect(lines[0]).toBe('(4 earlier attempts omitted)');
    expect(lines).toContain('2. attempt 1 → result 1');
    expect(lines).toContain('6. attempt 5 → result 5');
    expect(lines).toContain('16. attempt 15 → result 15');
    expect(lines.some((l) => l.includes('attempt 4 →'))).toBe(false);
    expect(lines.filter((l) => !l.startsWith('('))).toHaveLength(12);
  });

  it('never drops a refusal — the entire point of the log', () => {
    // 15 attempts, only #3 refused: the refusal sits at the START of the day and the cap keeps the
    // most recent attempts, so it would be the first casualty of a naive tail. One slot goes to the
    // refusal, the other eleven to the newest attempts (5..14), so the marker counts the 3 omitted.
    const entries = Array.from({ length: 15 }, (_, i) => entry(`attempt ${i}`, `result ${i}`, i === 2));
    const lines = buildDayLog(entries).split('\n');

    expect(lines[0]).toBe('(3 earlier attempts omitted)');
    expect(lines).toContain('3. attempt 2 → result 2');
    expect(lines).toContain('5. attempt 4 → result 4');
    expect(lines).toContain('15. attempt 14 → result 14');
    expect(lines.some((l) => l.includes('attempt 3 → result 3'))).toBe(false);
    expect(lines.filter((l) => !l.startsWith('('))).toHaveLength(12);
  });

  it('keeps EVERY refusal even when they alone exceed the cap', () => {
    // A day of nothing but refusals is the baseline's stall made visible: dropping the tenth
    // refusal would hide the exact shape the day log exists to report.
    const entries = Array.from({ length: 16 }, (_, i) => entry(`attempt ${i}`, 'refused: unsafe', true));
    const lines = buildDayLog(entries).split('\n');

    expect(lines).toHaveLength(16);
    expect(lines[0]).toBe('1. attempt 0 → refused: unsafe');
    expect(lines.some((l) => l.startsWith('('))).toBe(false);
  });
});

describe('buildRecap', () => {
  it('names the day that ended, lists its lines in order, then its disposition', () => {
    expect(
      buildRecap({
        dayNumber: 2,
        yesterdayOutcomes: ['You finish the chore and pocket the coin.', 'The goblin falls.'],
        yesterdayEnded: 'no-rolls',
      }),
    ).toBe(
      'YESTERDAY (day 1):\n1. You finish the chore and pocket the coin.\n2. The goblin falls.\nended: no-rolls',
    );
  });

  it('renders a day with no completed actions as the disposition alone', () => {
    expect(buildRecap({ dayNumber: 3, yesterdayOutcomes: [], yesterdayEnded: 'stalled' })).toBe(
      'YESTERDAY (day 2):\nended: stalled',
    );
  });

  it('omits the disposition line when the caller has none', () => {
    expect(buildRecap({ dayNumber: 2, yesterdayOutcomes: ['A quiet day.'] })).toBe(
      'YESTERDAY (day 1):\n1. A quiet day.',
    );
  });

  it('is byte-identical for a consecutive day whether or not the caller names it', () => {
    // The `dayNumber - 1` boundary: the ordinary run's shape must not move because the harness now
    // always tells the recap which day it played. Pinned against a literal, both ways.
    const input = { dayNumber: 4, yesterdayOutcomes: ['The gate held.'], yesterdayEnded: 'slept' };
    expect(buildRecap(input)).toBe(
      'YESTERDAY (day 3):\n1. The gate held.\nended: slept',
    );
    expect(buildRecap({ ...input, lastPlayedDay: 3 })).toBe(buildRecap(input));
  });

  it('names the absent day and the gap when the player was away', () => {
    // Five days missed (day 2..6), so the heading cannot say "yesterday" — day 6 was never played.
    expect(
      buildRecap({
        dayNumber: 7,
        yesterdayOutcomes: ['You finish the chore and pocket the coin.'],
        yesterdayEnded: 'slept',
        lastPlayedDay: 1,
      }),
    ).toBe(
      'LAST PLAYED (day 1):\n5 days passed without you.\n1. You finish the chore and pocket the coin.\nended: slept',
    );

    // A different skip size, so the count is arithmetic and not a constant: day 1 → day 4 is two
    // days gone (the 2nd and the 3rd).
    expect(
      buildRecap({ dayNumber: 4, yesterdayOutcomes: [], yesterdayEnded: 'slept', lastPlayedDay: 1 }),
    ).toBe('LAST PLAYED (day 1):\n2 days passed without you.\nended: slept');
  });

  it('counts a single missing day in the singular', () => {
    expect(
      buildRecap({ dayNumber: 4, yesterdayOutcomes: ['A quiet day.'], lastPlayedDay: 2 }),
    ).toBe('LAST PLAYED (day 2):\n1 day passed without you.\n1. A quiet day.');
  });
});
