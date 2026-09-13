/**
 * The brain's working memory, shaped (spec § B, T1). `turnContext.ts` is deliberately pure so the
 * three blocks the harness feeds back — the recap, the day log and the outcome digest — can be
 * pinned here rather than through a run.
 *
 * The shaping rules are the contract's, not free choices: the day log is the fix for the
 * baseline's five-identical-picks stall (so a REFUSAL must survive the line cap, and a long day
 * must say how much it dropped), and the recap carries yesterday's lines plus how the day ended.
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
    expect(capped[1]).toBe('1. attempt 3 → result 3');
    expect(capped[12]).toBe('12. attempt 14 → result 14');
  });

  it('never drops a refusal — the entire point of the log', () => {
    // 15 attempts, only #2 refused: the refusal is at the START of the day and the cap keeps the
    // most recent attempts, so it would be the first casualty of a naive tail. One slot goes to the
    // refusal, the other eleven to the newest attempts (4..14) — so 3 older attempts are dropped.
    const entries = Array.from({ length: 15 }, (_, i) => entry(`attempt ${i}`, `result ${i}`, i === 2));
    const lines = buildDayLog(entries).split('\n');

    expect(lines[0]).toBe('(3 earlier attempts omitted)');
    expect(lines).toContain('1. attempt 2 → result 2');
    expect(lines).toContain('2. attempt 4 → result 4');
    expect(lines).toContain('12. attempt 14 → result 14');
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
});
