import { describe, it, expect } from 'vitest';

import {
  DEFAULT_REASONING_EFFORT,
  agentCapturePolicy,
  llmCallsDumpEnabled,
  parseReasoningEffort,
} from '../../src/agent/harnessEnv.js';

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

describe('llmCallsDumpEnabled', () => {
  it('saves the audit unless the operator opts out with a literal false', () => {
    expect(llmCallsDumpEnabled({})).toBe(true);
    expect(llmCallsDumpEnabled({ AGENT_LLM_CALLS_DUMP: 'true' })).toBe(true);
    expect(llmCallsDumpEnabled({ AGENT_LLM_CALLS_DUMP: 'false' })).toBe(false);
  });
});

describe('agentCapturePolicy', () => {
  const successfulCall = { diagnostic: false, reasoningChars: 12 };

  it('captures a successful call, and says so in the process logging contract', () => {
    const env: NodeJS.ProcessEnv = {};

    expect(agentCapturePolicy(env).shouldCapture(successfulCall)).toBe(true);
    expect(env.LLM_LOG_THINKING).toBe('all');
  });

  it('leaves an explicit mode to the operator', () => {
    const env: NodeJS.ProcessEnv = { LLM_LOG_THINKING: 'errors' };

    expect(agentCapturePolicy(env).shouldCapture(successfulCall)).toBe(false);
    expect(env.LLM_LOG_THINKING).toBe('errors');
  });
});
