import { describe, it, expect } from 'vitest';
import { envFlag, envInt, readLoggingEnv, staleLoggingEnv } from '../../src/config/env.js';

describe('envFlag', () => {
  it('is true for "true" and "1", case-insensitive and trimmed', () => {
    expect(envFlag('true')).toBe(true);
    expect(envFlag('TRUE')).toBe(true);
    expect(envFlag(' true ')).toBe(true);
    expect(envFlag('1')).toBe(true);
    expect(envFlag(' 1 ')).toBe(true);
  });

  it('is false for anything else, including unset', () => {
    expect(envFlag(undefined)).toBe(false);
    expect(envFlag('')).toBe(false);
    expect(envFlag('false')).toBe(false);
    expect(envFlag('0')).toBe(false);
    expect(envFlag('yes')).toBe(false);
  });
});

describe('envInt', () => {
  it('parses a positive integer', () => {
    expect(envInt('6000')).toBe(6000);
    expect(envInt(' 42 ')).toBe(42);
  });

  it('returns undefined for unset, empty, NaN, zero, or negative', () => {
    expect(envInt(undefined)).toBeUndefined();
    expect(envInt('')).toBeUndefined();
    expect(envInt('   ')).toBeUndefined();
    expect(envInt('not-a-number')).toBeUndefined();
    expect(envInt('0')).toBeUndefined();
    expect(envInt('-5')).toBeUndefined();
  });
});

describe('readLoggingEnv', () => {
  it('defaults to verbose/verboseLlm off, mode spiral, 6000 chars when nothing is set', () => {
    const result = readLoggingEnv({});
    expect(result).toEqual({
      verbose: false,
      verboseLlm: false,
      llmLogThinking: 'spiral',
      llmSpiralChars: 6000,
    });
  });

  it('reads VERBOSE, VERBOSE_LLM, LLM_LOG_THINKING, LLM_SPIRAL_CHARS', () => {
    const result = readLoggingEnv({
      VERBOSE: 'true',
      VERBOSE_LLM: '1',
      LLM_LOG_THINKING: 'all',
      LLM_SPIRAL_CHARS: '3000',
    });
    expect(result).toEqual({
      verbose: true,
      verboseLlm: true,
      llmLogThinking: 'all',
      llmSpiralChars: 3000,
    });
  });

  it('accepts all three thinking modes', () => {
    expect(readLoggingEnv({ LLM_LOG_THINKING: 'errors' }).llmLogThinking).toBe('errors');
    expect(readLoggingEnv({ LLM_LOG_THINKING: 'spiral' }).llmLogThinking).toBe('spiral');
    expect(readLoggingEnv({ LLM_LOG_THINKING: 'all' }).llmLogThinking).toBe('all');
  });

  it('falls back to spiral on an invalid LLM_LOG_THINKING value', () => {
    expect(readLoggingEnv({ LLM_LOG_THINKING: 'bogus' }).llmLogThinking).toBe('spiral');
  });

  it('falls back to the default spiral char count on an invalid LLM_SPIRAL_CHARS value', () => {
    expect(readLoggingEnv({ LLM_SPIRAL_CHARS: '-100' }).llmSpiralChars).toBe(6000);
    expect(readLoggingEnv({ LLM_SPIRAL_CHARS: 'nope' }).llmSpiralChars).toBe(6000);
  });
});

describe('staleLoggingEnv', () => {
  it('returns an empty array when no removed var is set', () => {
    expect(staleLoggingEnv({})).toEqual([]);
  });

  it('reports each stale var with its migration hint', () => {
    const result = staleLoggingEnv({
      LOG_LLM_THINKING_ALL: 'true',
      LLM_LOG_ALL_PROMPTS: '1',
      REASONING_SPIRAL_CHARS: '6000',
    });
    expect(result).toEqual([
      'LOG_LLM_THINKING_ALL is removed — use LLM_LOG_THINKING=all',
      'LLM_LOG_ALL_PROMPTS is removed — use LLM_LOG_THINKING=all',
      'REASONING_SPIRAL_CHARS is removed — use LLM_SPIRAL_CHARS',
    ]);
  });

  it('only reports vars that are actually present', () => {
    expect(staleLoggingEnv({ LOG_LLM_THINKING_ALL: 'false' })).toEqual([
      'LOG_LLM_THINKING_ALL is removed — use LLM_LOG_THINKING=all',
    ]);
  });
});
