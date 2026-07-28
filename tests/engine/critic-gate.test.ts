import { describe, it, expect } from 'vitest';
import {
  isAnomalousDecide,
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
