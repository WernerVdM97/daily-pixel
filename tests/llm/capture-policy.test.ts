import { describe, it, expect } from 'vitest';
import { DeepCapturePolicy, SPIRAL_CHARS_DEFAULT } from '../../src/llm/capture-policy.js';

describe('DeepCapturePolicy', () => {
  it('always captures a diagnostic call, regardless of mode', () => {
    for (const mode of ['errors', 'spiral', 'all'] as const) {
      const policy = new DeepCapturePolicy(mode);
      expect(policy.shouldCapture({ diagnostic: true, reasoningChars: 0 })).toBe(true);
    }
  });

  it('always captures a flagged call, regardless of mode', () => {
    for (const mode of ['errors', 'spiral', 'all'] as const) {
      const policy = new DeepCapturePolicy(mode);
      expect(policy.shouldCapture({ diagnostic: false, reasoningChars: 0, flagged: true })).toBe(true);
    }
  });

  describe('mode "errors"', () => {
    const policy = new DeepCapturePolicy('errors');

    it('does not capture a clean, plain call', () => {
      expect(policy.shouldCapture({ diagnostic: false, reasoningChars: 100 })).toBe(false);
    });

    it('does not capture even a long reasoning chain — spiral is not honoured in this mode', () => {
      expect(policy.shouldCapture({ diagnostic: false, reasoningChars: SPIRAL_CHARS_DEFAULT + 1 })).toBe(false);
    });
  });

  describe('mode "spiral" (default)', () => {
    const policy = new DeepCapturePolicy('spiral');

    it('does not capture a clean, plain call under the threshold', () => {
      expect(policy.shouldCapture({ diagnostic: false, reasoningChars: SPIRAL_CHARS_DEFAULT })).toBe(false);
    });

    it('captures a clean call whose reasoning exceeds the threshold', () => {
      expect(policy.shouldCapture({ diagnostic: false, reasoningChars: SPIRAL_CHARS_DEFAULT + 1 })).toBe(true);
    });

    it('treats a null reasoningChars as 0 (not a spiral)', () => {
      expect(policy.shouldCapture({ diagnostic: false, reasoningChars: null })).toBe(false);
    });

    it('honours a custom spiral threshold', () => {
      const custom = new DeepCapturePolicy('spiral', 10);
      expect(custom.shouldCapture({ diagnostic: false, reasoningChars: 11 })).toBe(true);
      expect(custom.shouldCapture({ diagnostic: false, reasoningChars: 10 })).toBe(false);
    });
  });

  describe('mode "all"', () => {
    const policy = new DeepCapturePolicy('all');

    it('captures every well-formed call regardless of reasoning length', () => {
      expect(policy.shouldCapture({ diagnostic: false, reasoningChars: 0 })).toBe(true);
      expect(policy.shouldCapture({ diagnostic: false, reasoningChars: null })).toBe(true);
      expect(policy.shouldCapture({ diagnostic: false, reasoningChars: SPIRAL_CHARS_DEFAULT + 1 })).toBe(true);
    });
  });

  it('defaults to mode "spiral" and the default threshold when constructed with no args', () => {
    const policy = new DeepCapturePolicy();
    expect(policy.shouldCapture({ diagnostic: false, reasoningChars: SPIRAL_CHARS_DEFAULT })).toBe(false);
    expect(policy.shouldCapture({ diagnostic: false, reasoningChars: SPIRAL_CHARS_DEFAULT + 1 })).toBe(true);
  });
});
