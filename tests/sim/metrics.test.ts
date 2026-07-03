/**
 * Sim harness Task 2 — metrics collector. Exercises summarize/toCsv/renderTable against a
 * hand-built SimResult (not a live engine run) so the fixture pins exact expected numbers.
 */
import { describe, it, expect } from 'vitest';
import { summarize, toCsv, renderTable } from '../../src/sim/metrics.js';
import type { SimResult, TurnTrace } from '../../src/sim/types.js';

function trace(overrides: Partial<TurnTrace> & Pick<TurnTrace, 'index'>): TurnTrace {
  return {
    input: 'do a thing',
    distilledType: 'hunt',
    finalDc: 12,
    playerRolled: null,
    rollBonus: null,
    outcome: 'done',
    health: 10,
    stamina: 10,
    wealth: 0,
    rollsRemaining: 3,
    itemCount: 0,
    mutationsApplied: 0,
    ...overrides,
  };
}

const RESULT: SimResult = {
  scenario: 'fixture',
  turns: [
    trace({ index: 0, playerRolled: 15, rollBonus: 3, outcome: 'success', finalDc: 12, health: 10, stamina: 10, wealth: 0, itemCount: 0, mutationsApplied: 1 }),
    trace({ index: 1, playerRolled: 3, rollBonus: 0, outcome: 'failure', finalDc: 16, health: 7, stamina: 8, wealth: 0, itemCount: 0, mutationsApplied: 1 }),
    trace({ index: 2, playerRolled: null, outcome: 'bailed', finalDc: 16, health: 7, stamina: 6, wealth: 0, itemCount: 0, mutationsApplied: 1 }),
    trace({ index: 3, playerRolled: null, outcome: 'done', finalDc: 10, health: 7, stamina: 6, wealth: 5, itemCount: 1, mutationsApplied: 1 }),
  ],
};

describe('sim metrics — summarize', () => {
  it('computes rollSuccessRate over rolled turns only (skips/bails excluded)', () => {
    const summary = summarize(RESULT);
    // 4 turns; only turns 0 and 1 have playerRolled !== null; 1 of those succeeded.
    expect(summary.turnsRun).toBe(4);
    expect(summary.rollsResolved).toBe(2);
    expect(summary.rollSuccessRate).toBe(0.5);
  });

  it('computes net resource deltas as last-turn vs first-turn state', () => {
    const summary = summarize(RESULT);
    expect(summary.netHealth).toBe(-3); // 7 - 10
    expect(summary.netStamina).toBe(-4); // 6 - 10
    expect(summary.netWealth).toBe(5); // 5 - 0
    expect(summary.itemsGained).toBe(1); // 1 - 0
  });

  it('averages finalDc across every turn', () => {
    const summary = summarize(RESULT);
    expect(summary.avgFinalDc).toBeCloseTo((12 + 16 + 16 + 10) / 4);
  });

  it('death is explicitly null — the death track has not landed', () => {
    expect(summarize(RESULT).death).toBeNull();
  });

  it('returns a zeroed summary for an empty result rather than NaN/dividing by zero', () => {
    const empty = summarize({ scenario: 'empty', turns: [] });
    expect(empty).toEqual({
      turnsRun: 0,
      rollsResolved: 0,
      rollSuccessRate: 0,
      netHealth: 0,
      netStamina: 0,
      netWealth: 0,
      itemsGained: 0,
      avgFinalDc: 0,
      death: null,
    });
  });
});

describe('sim metrics — toCsv', () => {
  it('emits a header plus one row per turn', () => {
    const csv = toCsv(RESULT);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(RESULT.turns.length + 1);
    expect(lines[0]).toBe(
      'index,input,distilledType,finalDc,playerRolled,rollBonus,outcome,health,stamina,wealth,rollsRemaining,itemCount,mutationsApplied,day',
    );
  });

  it('quotes a field containing a comma per RFC 4180', () => {
    const result: SimResult = {
      scenario: 'fixture',
      turns: [trace({ index: 0, input: 'say "hello, world"' })],
    };
    const [, row] = toCsv(result).split('\n');
    expect(row).toContain('"say ""hello, world"""');
  });

  it('emits an empty cell for the optional day column when unset', () => {
    const [, row] = toCsv(RESULT).split('\n');
    expect(row.endsWith(',')).toBe(true); // trailing `day` column, unset
  });
});

describe('sim metrics — renderTable', () => {
  it('renders every summary figure as readable text', () => {
    const table = renderTable(summarize(RESULT));
    expect(table).toContain('Turns run:      4');
    expect(table).toContain('Rolls resolved: 2');
    expect(table).toContain('Roll success:   50.0%');
    expect(table).toContain('Net health:     -3');
    expect(table).toContain('Net wealth:     +5');
    expect(table).toContain('Death rate:     N/A');
  });
});
