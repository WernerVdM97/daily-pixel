import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { loadPromptSet, stampFor, PROMPT_SET_VERSION } from '../../src/llm/prompt-builder.js';
import { ACTION_CATEGORIES } from '../../src/llm/LlmGateway.js';

// Raw (un-assembled) recipe files — loadPromptSet's assembled resolve strings are prepended with
// BASE-resolve.md, whose shared MUTATION TYPES menu legitimately mentions `modify_health` as an
// example for other action types. The engine-owned-number guard must check the combat recipe
// files themselves, not the BASE-prefixed assembly.
const V12_COMBAT_RESOLVE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'assets',
  'prompts',
  'decision-prompts',
  'v12',
  'resolve',
  'combat',
);

describe('loadPromptSet — v12 scaffolding (docs/decisions/v12-prompt-set-versioning.md)', () => {
  it('loads all templates from the default (v12) set', () => {
    const set = loadPromptSet();
    expect(set.version).toBe(PROMPT_SET_VERSION);
    expect(set.classify.length).toBeGreaterThan(0);
    for (const category of ACTION_CATEGORIES) {
      expect(set.decide[category].newAction).toBeTruthy();
      expect(set.decide[category].continue).toBeTruthy();
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

  it('the decide map is total over every ActionCategory with both phase variants', () => {
    const set = loadPromptSet('v12');
    expect(Object.keys(set.decide).sort()).toEqual([...ACTION_CATEGORIES].sort());
    for (const category of ACTION_CATEGORIES) {
      expect(set.decide[category]).toHaveProperty('newAction');
      expect(set.decide[category]).toHaveProperty('continue');
    }
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

  it('decide templates are prepended with BASE.md and the correct phase', () => {
    const set = loadPromptSet('v12');
    for (const category of ACTION_CATEGORIES) {
      // Both variants start with BASE
      expect(set.decide[category].newAction).toContain('# BASE — shared rules for all v12 decide templates');
      expect(set.decide[category].continue).toContain('# BASE — shared rules for all v12 decide templates');
      // NEW_ACTION variant contains the phase header
      expect(set.decide[category].newAction).toContain('## PHASE — NEW_ACTION');
      // CONTINUE variant contains its phase header
      expect(set.decide[category].continue).toContain('## PHASE — CONTINUE');
      // Neither contains the opposite phase
      expect(set.decide[category].newAction).not.toContain('## PHASE — CONTINUE');
      expect(set.decide[category].continue).not.toContain('## PHASE — NEW_ACTION');
    }
  });

  it('decide templates are assembled in order: BASE → phase → type-specific', () => {
    const set = loadPromptSet('v12');
    const typeMarkers: Record<string, string> = {
      combat: 'COMBAT-SPECIFIC RULES',
      travel: 'TRAVEL-SPECIFIC RULES',
      social: 'SOCIAL-SPECIFIC RULES',
      skill: 'SKILL-SPECIFIC RULES',
      search: 'SEARCH-SPECIFIC RULES',
      rest: 'REST-SPECIFIC RULES',
      other: 'CATCH-ALL RULES',
    };
    for (const category of ACTION_CATEGORIES) {
      for (const phase of ['newAction', 'continue'] as const) {
        const tpl = set.decide[category][phase];
        const baseIdx = tpl.indexOf('# BASE — shared rules');
        const phaseIdx = tpl.indexOf('## PHASE —');
        const typeIdx = tpl.indexOf(typeMarkers[category]);
        expect(baseIdx).toBeLessThan(phaseIdx);
        expect(phaseIdx).toBeLessThan(typeIdx);
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

describe('v12 combat template content — T4 C-a rules', () => {
  it('decide/combat.md keys danger to location safety and drops the old cadence rule', () => {
    const set = loadPromptSet('v12');
    const decide = set.decide.combat.newAction;
    expect(decide).toMatch(/location/i);
    expect(decide).toMatch(/safe/i);
    expect(decide).not.toMatch(/every 3rd or 4th/i);
  });

  it('decide/combat.md documents the combatEnemy field with both anchor values', () => {
    const set = loadPromptSet('v12');
    const decide = set.decide.combat.newAction;
    expect(decide).toContain('combatEnemy');
    expect(decide).toContain('"npc"');
    expect(decide).toContain('"location"');
  });

  it('resolve combat recipe files never author engine-owned combat numbers', () => {
    for (const ver of ['success', 'failure'] as const) {
      const tpl = readFileSync(path.join(V12_COMBAT_RESOLVE_DIR, `${ver}.md`), 'utf-8');
      expect(tpl).not.toContain('modify_health');
      expect(tpl).not.toContain('enemyHp');
      expect(tpl).not.toContain('set_relation');
    }
  });

  it('success recipe scales reward with difficulty; failure recipe costs are non-health', () => {
    const success = readFileSync(path.join(V12_COMBAT_RESOLVE_DIR, 'success.md'), 'utf-8');
    const failure = readFileSync(path.join(V12_COMBAT_RESOLVE_DIR, 'failure.md'), 'utf-8');
    expect(success).toMatch(/difficulty/i);
    expect(failure).toMatch(/remove_item|modify_wealth/);
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
