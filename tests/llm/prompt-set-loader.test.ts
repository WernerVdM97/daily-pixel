import { describe, it, expect } from 'vitest';
import { loadPromptSet, stampFor, PROMPT_SET_VERSION } from '../../src/llm/prompt-builder.js';
import type { ActionCategory } from '../../src/llm/LlmGateway.js';

const ACTION_CATEGORIES: ActionCategory[] = ['combat', 'travel', 'social', 'skill', 'search', 'rest', 'other'];

describe('loadPromptSet — v12 scaffolding (docs/decisions/v12-prompt-set-versioning.md)', () => {
  it('loads all nine templates from the default (v12) set', () => {
    const set = loadPromptSet();
    expect(set.version).toBe(PROMPT_SET_VERSION);
    expect(set.classify.length).toBeGreaterThan(0);
    expect(set.resolve.length).toBeGreaterThan(0);
    for (const category of ACTION_CATEGORIES) {
      expect(set.decide[category]).toBeTruthy();
    }
  });

  it('the decide map is total over every ActionCategory', () => {
    const set = loadPromptSet('v12');
    expect(Object.keys(set.decide).sort()).toEqual([...ACTION_CATEGORIES].sort());
  });

  it('throws an error naming the missing file for a set that does not exist', () => {
    expect(() => loadPromptSet('v999-does-not-exist')).toThrow(/classify\.md/);
  });
});

describe('stampFor — derived per-stage telemetry stamp', () => {
  it('derives v12/classify, v12/combat, v12/resolve', () => {
    expect(stampFor('classify')).toBe('v12/classify');
    expect(stampFor('combat')).toBe('v12/combat');
    expect(stampFor('resolve')).toBe('v12/resolve');
  });

  it('accepts an explicit version override', () => {
    expect(stampFor('travel', 'v13')).toBe('v13/travel');
  });
});
