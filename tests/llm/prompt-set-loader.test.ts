import { describe, it, expect } from 'vitest';
import { loadPromptSet, stampFor, PROMPT_SET_VERSION } from '../../src/llm/prompt-builder.js';
import { ACTION_CATEGORIES } from '../../src/llm/LlmGateway.js';

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

  it('throws naming a missing template and the version dir for a set that does not exist', () => {
    // Asserts the CONTRACT, not an implementation detail: the message names *some* missing
    // .md file plus the requested version. Previously this pinned `classify.md` specifically,
    // which only held because classify happens to load first — a harmless loader reorder
    // would have broken a test whose real contract still held.
    expect(() => loadPromptSet('v999-does-not-exist')).toThrow(/missing template '.+\.md'/);
    expect(() => loadPromptSet('v999-does-not-exist')).toThrow(/v999/);
  });

  it('throws naming the specific missing template for a set that exists but is incomplete', () => {
    // Regression for the realistic failure mode: a set directory that exists (so the classify/
    // resolve bookends load fine) but is missing exactly one decide template — the gap most
    // likely to slip through review, since "the directory exists" alone gives false confidence.
    // Fixture: assets/prompts/decision-prompts/__test-partial__/ has every template EXCEPT
    // rest.md. It's a real directory under the loader's assets root (not a temp dir) because
    // loadPromptSet takes only a version string and resolves paths relative to the compiled
    // module's assets/prompts/ root — a temp dir outside that root isn't reachable without
    // changing the function's signature, which is out of scope here. The `__test-partial__`
    // name (double underscores, non-version-like) keeps it unambiguously test-only and away
    // from any real version directory.
    expect(() => loadPromptSet('__test-partial__')).toThrow(/missing template 'rest\.md'/);
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
