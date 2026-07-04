import { describe, it, expect } from 'vitest';
import { loadPromptSet, stampFor, PROMPT_SET_VERSION } from '../../src/llm/prompt-builder.js';
import { ACTION_CATEGORIES } from '../../src/llm/LlmGateway.js';

describe('loadPromptSet — v12 scaffolding (docs/decisions/v12-prompt-set-versioning.md)', () => {
  it('loads all templates from the default (v12) set', () => {
    const set = loadPromptSet();
    expect(set.version).toBe(PROMPT_SET_VERSION);
    expect(set.classify.length).toBeGreaterThan(0);
    for (const category of ACTION_CATEGORIES) {
      expect(set.decide[category]).toBeTruthy();
      expect(set.resolve[category]).toBeTruthy();
    }
  });

  it('the resolve map is total with success/failure per ActionCategory', () => {
    const set = loadPromptSet('v12');
    for (const category of ACTION_CATEGORIES) {
      expect(set.resolve[category].success).toBeTruthy();
      expect(set.resolve[category].failure).toBeTruthy();
    }
  });

  it('the decide map is total over every ActionCategory', () => {
    const set = loadPromptSet('v12');
    expect(Object.keys(set.decide).sort()).toEqual([...ACTION_CATEGORIES].sort());
  });

  it('throws naming a missing template and the version dir for a set that does not exist', () => {
    expect(() => loadPromptSet('v999-does-not-exist')).toThrow(/missing template '.+\.md'/);
    expect(() => loadPromptSet('v999-does-not-exist')).toThrow(/v999/);
  });

  it('classify is NOT prepended with BASE.md or BASE-resolve.md', () => {
    const set = loadPromptSet('v12');
    expect(set.classify).not.toContain('# BASE — shared rules');
    expect(set.classify).not.toContain('# BASE-RESOLVE — shared rules');
  });

  it('resolve templates are prepended with BASE-resolve.md, not BASE.md', () => {
    const set = loadPromptSet('v12');
    for (const category of ACTION_CATEGORIES) {
      for (const ver of ['success', 'failure'] as const) {
        expect(set.resolve[category][ver]).toContain('# BASE-RESOLVE — shared rules for all v12 resolve templates');
        expect(set.resolve[category][ver]).not.toContain('# BASE — shared rules for all v12 decide templates');
      }
    }
  });

  it('per-type resolve recipes appear after BASE-resolve.md', () => {
    const set = loadPromptSet('v12');
    const resolveMarkers: Record<string, { success: string; failure: string }> = {
      combat: { success: 'COMBAT SUCCESS', failure: 'COMBAT FAILURE' },
      travel: { success: 'TRAVEL SUCCESS', failure: 'TRAVEL FAILURE' },
      social: { success: 'SOCIAL SUCCESS', failure: 'SOCIAL FAILURE' },
      skill: { success: 'SKILL SUCCESS', failure: 'SKILL FAILURE' },
      search: { success: 'SEARCH SUCCESS', failure: 'SEARCH FAILURE' },
      rest: { success: 'REST SUCCESS', failure: 'REST FAILURE' },
      other: { success: 'OTHER SUCCESS', failure: 'OTHER FAILURE' },
    };
    for (const category of ACTION_CATEGORIES) {
      for (const ver of ['success', 'failure'] as const) {
        const baseIdx = set.resolve[category][ver].indexOf('# BASE-RESOLVE — shared rules');
        const markerIdx = set.resolve[category][ver].indexOf(resolveMarkers[category][ver]);
        expect(baseIdx).toBeLessThan(markerIdx);
      }
    }
  });

  it('throws naming the specific missing template for a set that exists but is incomplete', () => {
    // Fixture: assets/prompts/decision-prompts/__test-partial__/ has every template EXCEPT
    // decide/rest.md and resolve/rest/*.md. The loader encounters decide/rest.md first in
    // iteration order (combat→…→rest→other) and throws there.
    expect(() => loadPromptSet('__test-partial__')).toThrow(/missing template 'decide\/rest\.md'/);
  });
});

describe('stampFor — derived per-stage telemetry stamp', () => {
  it('derives v12/classify, v12/combat, v12/resolve-combat', () => {
    expect(stampFor('classify')).toBe('v12/classify');
    expect(stampFor('combat')).toBe('v12/combat');
    expect(stampFor('resolve-combat')).toBe('v12/resolve-combat');
  });

  it('accepts an explicit version override', () => {
    expect(stampFor('travel', 'v13')).toBe('v13/travel');
  });
});
