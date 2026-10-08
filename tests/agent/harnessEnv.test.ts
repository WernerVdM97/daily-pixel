import { describe, it, expect } from 'vitest';

import { DEFAULT_REASONING_EFFORT, parseReasoningEffort } from '../../src/agent/harnessEnv.js';

describe('parseReasoningEffort', () => {
  it('pins low when the knob is absent, empty or blank', () => {
    expect(DEFAULT_REASONING_EFFORT).toBe('low');

    for (const raw of [undefined, '', '   ']) {
      expect(parseReasoningEffort(raw)).toBe('low');
    }
  });

  it('accepts the tiers the model serves, however they are cased or padded', () => {
    expect(parseReasoningEffort('low')).toBe('low');
    expect(parseReasoningEffort(' HIGH ')).toBe('high');
    expect(parseReasoningEffort('Max')).toBe('max');
  });

  it('refuses a tier the model does not serve, rather than let the provider choose the nearest', () => {
    // medium, minimal and xhigh are real OpenRouter tiers that this model does not offer.
    for (const raw of ['medium', 'minimal', 'xhigh', 'none', 'bogus']) {
      expect(parseReasoningEffort(raw)).toBeNull();
    }
  });
});
