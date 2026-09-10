import { describe, it, expect } from 'vitest';
import {
  isAnomalousDecide,
  criticShouldFire,
  parseCriticGateMode,
  BASE_DC_ANOMALY_MIN,
  BASE_DC_ANOMALY_MAX,
} from '../../src/engine/action/critic-gate.js';

describe('isAnomalousDecide — RA-4c trigger predicate', () => {
  it('a clean, in-band, non-empty non-combat decide is NOT anomalous', () => {
    expect(
      isAnomalousDecide({ baseDc: 12, decisionLength: 2, actionType: 'skill' }),
    ).toBe(false);
  });

  it('baseDc below the band is anomalous', () => {
    expect(
      isAnomalousDecide({ baseDc: BASE_DC_ANOMALY_MIN - 1, decisionLength: 2, actionType: 'skill' }),
    ).toBe(true);
  });

  it('baseDc at the band floor is NOT anomalous (inclusive)', () => {
    expect(
      isAnomalousDecide({ baseDc: BASE_DC_ANOMALY_MIN, decisionLength: 2, actionType: 'skill' }),
    ).toBe(false);
  });

  it('baseDc above the band is anomalous', () => {
    expect(
      isAnomalousDecide({ baseDc: BASE_DC_ANOMALY_MAX + 1, decisionLength: 2, actionType: 'skill' }),
    ).toBe(true);
  });

  it('baseDc at the band ceiling is NOT anomalous (inclusive)', () => {
    expect(
      isAnomalousDecide({ baseDc: BASE_DC_ANOMALY_MAX, decisionLength: 2, actionType: 'skill' }),
    ).toBe(false);
  });

  // Regression: NaN fails both band comparisons, so a missing `Number.isFinite` guard made the
  // most malformed beat possible read as clean and skip the critic. `Number('hard')` is exactly
  // what `ProdPipelineGateway`'s unvalidated `Number(raw.baseDc)` produces for a non-numeric
  // authored DC, so this is a reachable LLM output, not a synthetic edge case.
  it('a non-finite baseDc is anomalous (NaN must not slip through the band check)', () => {
    expect(
      isAnomalousDecide({ baseDc: Number('hard'), decisionLength: 2, actionType: 'skill' }),
    ).toBe(true);
    expect(
      isAnomalousDecide({ baseDc: Number.NaN, decisionLength: 2, actionType: 'skill' }),
    ).toBe(true);
    expect(
      isAnomalousDecide({ baseDc: Number.POSITIVE_INFINITY, decisionLength: 2, actionType: 'skill' }),
    ).toBe(true);
  });

  it('empty decision[] on a non-combat beat is anomalous', () => {
    expect(
      isAnomalousDecide({ baseDc: 12, decisionLength: 0, actionType: 'skill' }),
    ).toBe(true);
  });

  it('empty decision[] on a combat beat is NOT anomalous (combat is exempt)', () => {
    expect(
      isAnomalousDecide({ baseDc: 12, decisionLength: 0, actionType: 'combat' }),
    ).toBe(false);
  });

  it('a single-option decision (non-empty) is NOT anomalous — validateSingleOption owns that case', () => {
    expect(
      isAnomalousDecide({ baseDc: 12, decisionLength: 1, actionType: 'skill' }),
    ).toBe(false);
  });
});

describe('criticShouldFire — mode × beat policy (SL-3)', () => {
  const clean = { baseDc: 12, decisionLength: 2, actionType: 'skill' as const };
  const anomalous = { baseDc: 99, decisionLength: 2, actionType: 'skill' as const };

  it("'always' fires on both beats regardless of anomaly — the pre-RA-4 baseline arm", () => {
    expect(criticShouldFire('always', 'decision', clean)).toBe(true);
    expect(criticShouldFire('always', 'resolution', clean)).toBe(true);
  });

  // The whole point of the default: the two beats must behave DIFFERENTLY on the same clean input.
  it("'narrate-gated' (default) always fires on decide but gates narrate", () => {
    expect(criticShouldFire('narrate-gated', 'decision', clean)).toBe(true);
    expect(criticShouldFire('narrate-gated', 'resolution', clean)).toBe(false);
  });

  it("'narrate-gated' still fires on a narrate beat whose decide result was anomalous", () => {
    expect(criticShouldFire('narrate-gated', 'resolution', anomalous)).toBe(true);
  });

  it("'anomaly' gates both beats", () => {
    expect(criticShouldFire('anomaly', 'decision', clean)).toBe(false);
    expect(criticShouldFire('anomaly', 'resolution', clean)).toBe(false);
    expect(criticShouldFire('anomaly', 'decision', anomalous)).toBe(true);
    expect(criticShouldFire('anomaly', 'resolution', anomalous)).toBe(true);
  });
});

describe('parseCriticGateMode', () => {
  it('accepts each valid mode verbatim', () => {
    expect(parseCriticGateMode('always')).toBe('always');
    expect(parseCriticGateMode('anomaly')).toBe('anomaly');
    expect(parseCriticGateMode('narrate-gated')).toBe('narrate-gated');
  });

  // A typo'd env var must not take the bot down at boot, and must not silently land on a
  // more-expensive-than-intended arm either — it falls back to the SL-3 default.
  it('falls back to the SL-3 default on undefined or an unrecognised value', () => {
    expect(parseCriticGateMode(undefined)).toBe('narrate-gated');
    expect(parseCriticGateMode('')).toBe('narrate-gated');
    expect(parseCriticGateMode('ALWAYS')).toBe('narrate-gated');
    expect(parseCriticGateMode('nonsense')).toBe('narrate-gated');
  });
});
