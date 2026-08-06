import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// DC-S4's structural pin — the M6 `grep 'SessionController'` pattern made permanent. The
// harness's engine touch is the AgentObserver seam alone: zero `../engine/` imports, zero
// engine-direct member access, the constructor's first param IS the observer. Read as
// source (pinned to this file's location) so a future drift fails the test, not the run.
const HARNESS_SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'agent', 'harness.ts'),
  'utf8',
);

describe('DC-S4 observer boundary — harness source pins (structural)', () => {
  it('imports zero ../engine/ modules (the harness touches the engine only via ./observer.js)', () => {
    const engineImports = HARNESS_SRC.split('\n').filter((line) => /from '\.\.\/engine\//.test(line));
    expect(engineImports).toEqual([]);
  });

  it('performs no engine-direct member access (this.engine is gone — every read goes through the observer)', () => {
    expect(HARNESS_SRC).not.toContain('this.engine');
  });

  it('declares the constructor first param as the observer (AgentObserver)', () => {
    expect(/constructor\(\s*private readonly observer: AgentObserver/.test(HARNESS_SRC)).toBe(true);
  });
});
