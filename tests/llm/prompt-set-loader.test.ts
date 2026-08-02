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
const COMBAT_RESOLVE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'assets',
  'prompts',
  'decision-prompts',
  PROMPT_SET_VERSION,
  'resolve',
  'combat',
);

const DECIDE_COMBAT_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'assets',
  'prompts',
  'decision-prompts',
  PROMPT_SET_VERSION,
  'decide',
  'combat.md',
);

describe(`loadPromptSet — ${PROMPT_SET_VERSION} scaffolding (docs/decisions/v12-prompt-set-versioning.md)`, () => {
  it(`loads all templates from the default (${PROMPT_SET_VERSION}) set`, () => {
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
    const set = loadPromptSet();
    for (const category of ACTION_CATEGORIES) {
      expect(set.resolve[category].success).toBeTruthy();
      expect(set.resolve[category].failure).toBeTruthy();
    }
  });

  it('the decide map is total over every ActionCategory with both phase variants', () => {
    const set = loadPromptSet();
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
    const set = loadPromptSet();
    expect(set.classify).not.toContain('# BASE — shared rules');
    expect(set.classify).not.toContain('# BASE-RESOLVE — shared rules');
  });

  it('classify is a real routing prompt (not the Stage-1 stub): names all seven ActionTypes, the flags, and carries the SECURITY RULE', () => {
    const set = loadPromptSet();
    // Not the stub — the stub is a 3-line placeholder with no routing contract.
    expect(set.classify).not.toContain('(STUB)');
    // Names every routable ActionType so the model can pick exactly one (T3 acceptance).
    for (const category of ACTION_CATEGORIES) {
      expect(set.classify).toContain(`\`${category}\``);
    }
    // The three routing flags the gateway parses back (ProdPipelineGateway.classify).
    for (const flag of ['unsafe_location', 'needs_roll', 'target_present']) {
      expect(set.classify).toContain(flag);
    }
    // Carry-forward: the SECURITY RULE must survive into the classify template.
    expect(set.classify).toContain('SECURITY RULE');
    // Tiny-output contract: the JSON shape the parser expects.
    expect(set.classify).toContain('"actionType"');
  });

  it('resolve templates are prepended with BASE-resolve.md, not BASE.md', () => {
    const set = loadPromptSet();
    for (const category of ACTION_CATEGORIES) {
      for (const ver of ['success', 'failure'] as const) {
        expect(set.resolve[category][ver]).toContain(`# BASE-RESOLVE — shared rules for all ${PROMPT_SET_VERSION} resolve templates`);
        expect(set.resolve[category][ver]).not.toContain(`# BASE — shared rules for all ${PROMPT_SET_VERSION} decide templates`);
      }
    }
  });

  it('per-type resolve recipes appear after BASE-resolve.md', () => {
    const set = loadPromptSet();
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
    const set = loadPromptSet();
    for (const category of ACTION_CATEGORIES) {
      // Both variants start with BASE
      expect(set.decide[category].newAction).toContain(`# BASE — shared rules for all ${PROMPT_SET_VERSION} decide templates`);
      expect(set.decide[category].continue).toContain(`# BASE — shared rules for all ${PROMPT_SET_VERSION} decide templates`);
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
    const set = loadPromptSet();
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

  // Deliberate: historical `actions`/`llm_calls` rows stamped `v12/...` must stay attributable
  // to the prompt that produced them, so the v12 directory is never allowed to rot even after
  // the active set moves on — this pins that it keeps loading correctly.
  it("loadPromptSet('v12') still loads and reports version 'v12', even though it is no longer the active set", () => {
    const set = loadPromptSet('v12');
    expect(set.version).toBe('v12');
    expect(set.classify.length).toBeGreaterThan(0);
  });
});

describe(`${PROMPT_SET_VERSION} combat template content — T4 C-a rules`, () => {
  it('decide/combat.md keys danger to location safety and drops the old cadence rule', () => {
    // Reads the raw file, not the assembled prompt set — BASE.md is generic enough that
    // /location/i or /safe/i would pass even without combat.md's own danger rule present.
    const tpl = readFileSync(DECIDE_COMBAT_FILE, 'utf-8');
    expect(tpl).toMatch(/danger follows location/i);
    expect(tpl).not.toMatch(/every 3rd or 4th/i);
  });

  it('decide/combat.md documents the combatEnemy field with both anchor values', () => {
    const set = loadPromptSet();
    const decide = set.decide.combat.newAction;
    expect(decide).toContain('combatEnemy');
    expect(decide).toContain('"npc"');
    expect(decide).toContain('"location"');
  });

  it('resolve combat recipe files name the engine-owned ops without authoring a health mutation', () => {
    for (const ver of ['success', 'failure'] as const) {
      const tpl = readFileSync(path.join(COMBAT_RESOLVE_DIR, `${ver}.md`), 'utf-8');
      // Guard exists: the prohibition names the engine-owned ops literally (Fix 2), so a
      // plain `not.toContain('modify_health')` would now be a false failure — assert presence
      // of the guard instead.
      expect(tpl).toMatch(/engine-owned/i);
      expect(tpl).toMatch(/modify_health/);
      // Regression guard: the recipe itself must never author a negative modify_health amount
      // (the old "modify_health -1 to -3" double-damage-authoring bug pattern).
      expect(tpl).not.toMatch(/modify_health[^\n]{0,12}-\s?\d/);
      expect(tpl).not.toContain('set_relation');
      expect(tpl).not.toContain('update_relation');
    }
  });

  it('success recipe scales reward with difficulty; failure recipe costs are non-health', () => {
    const success = readFileSync(path.join(COMBAT_RESOLVE_DIR, 'success.md'), 'utf-8');
    const failure = readFileSync(path.join(COMBAT_RESOLVE_DIR, 'failure.md'), 'utf-8');
    expect(success).toMatch(/difficulty/i);
    expect(failure).toMatch(/remove_item|modify_wealth/);
  });
});

describe('stampFor — derived per-stage telemetry stamp', () => {
  it(`derives ${PROMPT_SET_VERSION}/classify, ${PROMPT_SET_VERSION}/combat, ${PROMPT_SET_VERSION}/resolve-combat`, () => {
    expect(stampFor('classify')).toBe(`${PROMPT_SET_VERSION}/classify`);
    expect(stampFor('combat')).toBe(`${PROMPT_SET_VERSION}/combat`);
    expect(stampFor('resolve-combat')).toBe(`${PROMPT_SET_VERSION}/resolve-combat`);
  });

  it('accepts an explicit version override', () => {
    // 'v12' rather than the (now bumped) PROMPT_SET_VERSION, so this genuinely proves the
    // override differs from the default — using the active version here would be a no-op check.
    expect(stampFor('travel', 'v12')).toBe('v12/travel');
  });
});

describe(`Carry-forward checklist (v8–v11 rules that must survive into ${PROMPT_SET_VERSION})`, () => {
  it('rule 1 — refunds (no-op/timeout free roll, once per day) are ENGINE-owned, not a prompt rule (T6 must preserve the refund calls on the pipeline path)', () => {
    const typesFile = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'src',
        'db',
        'repositories',
        'types.ts',
      ),
      'utf-8',
    );
    // This rule was never a prompt rule — it lives entirely in DB state, so there is no
    // template anchor to assert. Lock the columns that carry it instead.
    expect(typesFile).toContain('last_noop_refund_day');
    expect(typesFile).toContain('last_timeout_refund_day');
  });

  it('rule 2 — KNOWN LOCATIONS reuse/lazy-create (move_to vs cross_frontier) is owned by resolve/BASE.md and reaches every category', () => {
    const set = loadPromptSet();
    for (const category of ACTION_CATEGORIES) {
      for (const ver of ['success', 'failure'] as const) {
        const tpl = set.resolve[category][ver];
        expect(tpl).toContain('move_to');
        expect(tpl).toContain('cross_frontier');
        expect(tpl).toContain('Never invent a name for `move_to`');
      }
    }
  });

  it('rule 3 — no dead turns is owned by decide/BASE.md and reaches every category in both phases', () => {
    const set = loadPromptSet();
    for (const category of ACTION_CATEGORIES) {
      for (const phase of ['newAction', 'continue'] as const) {
        const tpl = set.decide[category][phase];
        expect(tpl).toContain('no dead turns');
        expect(tpl).toContain('pure travel/rest');
      }
    }
  });

  it('rule 4 — SECURITY RULE carries into every assembled decide string, every assembled resolve string, and classify', () => {
    const set = loadPromptSet();
    expect(set.classify).toContain('SECURITY RULE');
    for (const category of ACTION_CATEGORIES) {
      for (const phase of ['newAction', 'continue'] as const) {
        expect(set.decide[category][phase]).toContain('SECURITY RULE');
      }
      for (const ver of ['success', 'failure'] as const) {
        expect(set.resolve[category][ver]).toContain('SECURITY RULE');
      }
    }
  });

  it('rule 5 — markdown framing survives: "markdown briefing" in every decide/resolve string, "No markdown fences" in classify', () => {
    const set = loadPromptSet();
    expect(set.classify).toContain('No markdown fences');
    for (const category of ACTION_CATEGORIES) {
      for (const phase of ['newAction', 'continue'] as const) {
        expect(set.decide[category][phase]).toContain('markdown briefing');
      }
      for (const ver of ['success', 'failure'] as const) {
        expect(set.resolve[category][ver]).toContain('markdown briefing');
      }
    }
  });

  it('rule 6 — per-option stat & ability check is owned by decide/BASE.md and reaches every category in both phases', () => {
    const set = loadPromptSet();
    for (const category of ACTION_CATEGORIES) {
      for (const phase of ['newAction', 'continue'] as const) {
        const tpl = set.decide[category][phase];
        expect(tpl).toContain('ability check');
        // Anchor the per-option half on the enforcement bullet itself, not the bare `stat`
        // field name — the JSON contract / field-reference docs mention `stat` regardless of
        // whether the per-option variety rule survives, so a bare `stat` check is false comfort.
        expect(tpl).toContain('Each option SHOULD declare its own');
      }
    }
  });
});

// Stage 4 steps 1-5's prose landed with no test coverage — these anchor the content on stable,
// load-bearing prose rather than the BASE-prefixed assembly (whose shared menu would make the
// non-stamina-cost assertion pass vacuously) so a future prose edit that drops the rule fails loud.
describe(`${PROMPT_SET_VERSION} content assertions — stage 4 acceptance`, () => {
  it('every resolve/*/failure.md mandates a non-stamina cost (an "Always:" line naming remove_item / modify_wealth / modify_health)', () => {
    for (const category of ACTION_CATEGORIES) {
      const tpl = readFileSync(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '..',
          '..',
          'assets',
          'prompts',
          'decision-prompts',
          PROMPT_SET_VERSION,
          'resolve',
          category,
          'failure.md',
        ),
        'utf-8',
      );
      // Anchor on an "Always:" line that itself names a non-stamina op — a bare op name
      // anywhere in the file (e.g. inside an engine-owned-mutation prohibition sentence,
      // as in combat/failure.md) would match vacuously without guarding the mandatory rule.
      // travel/failure.md has two "Always:" lines, one stamina-only, so check all of them.
      const alwaysLines = tpl.split('\n').filter((line) => line.includes('Always:'));
      const mandatesNonStaminaCost = alwaysLines.some((line) =>
        /remove_item|modify_wealth|modify_health/.test(line),
      );
      expect(mandatesNonStaminaCost).toBe(true);
    }
  });

  it('resolve/combat/success.md carries the spare branch and forbids a corpse/loot narration on it', () => {
    const tpl = readFileSync(path.join(COMBAT_RESOLVE_DIR, 'success.md'), 'utf-8');
    expect(tpl).toContain('fatal blow: spare');
    expect(tpl).toMatch(/never narrate a kill, a corpse, or a death/i);
  });

  it('resolve/BASE.md documents the fatal blow token under its "### What was decided" INPUT CONTEXT bullet, naming both spare and finish', () => {
    const tpl = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'assets',
        'prompts',
        'decision-prompts',
        PROMPT_SET_VERSION,
        'resolve',
        'BASE.md',
      ),
      'utf-8',
    );
    const bulletLine = tpl.split('\n').find((line) => line.includes('### What was decided'));
    expect(bulletLine).toBeTruthy();
    expect(bulletLine).toContain('fatal blow: spare');
    expect(bulletLine).toContain('fatal blow: finish');
  });

  it("resolve/BASE.md documents add_npc's optional health field", () => {
    const tpl = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'assets',
        'prompts',
        'decision-prompts',
        PROMPT_SET_VERSION,
        'resolve',
        'BASE.md',
      ),
      'utf-8',
    );
    const addNpcLine = tpl.split('\n').find((line) => line.includes('`add_npc` — introduce a new NPC'));
    expect(addNpcLine).toBeTruthy();
    expect(addNpcLine).toContain('`health` (optional');
  });

  it('decide/BASE.md restates the DC ladder on the final per-option DC, not baseDc alone, and states the anchor instruction (stage 4 finding 5)', () => {
    const tpl = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'assets',
        'prompts',
        'decision-prompts',
        PROMPT_SET_VERSION,
        'decide',
        'BASE.md',
      ),
      'utf-8',
    );
    // Anchor on EVERY line stating the ladder bands, not just the first: the file states the
    // ladder twice (the rule bullet and the pre-flight check), and a regression that reverts only
    // one of them (e.g. the pre-flight check back to a bare `baseDc` claim) must not pass
    // undetected because `.find()` only ever checked the first match. Require there to be more
    // than one such line, so the test itself fails loudly if the file is ever restructured to
    // carry the band string in only one place, and require every one of them to name the
    // composed final DC (dcModifier) rather than passing vacuously on a bare band mention.
    const ladderLines = tpl
      .split('\n')
      .filter((line) => line.includes('11-13 routine, 16-18 hard, 20-24 daunting'));
    expect(ladderLines.length).toBeGreaterThan(1);
    for (const line of ladderLines) {
      expect(line).toContain('dcModifier');
    }
    // The anchor half: baseDc must be instructed to sit mid-spread, with the ±5 cap named as the
    // reason, not just described as "base difficulty".
    expect(tpl).toContain('anchor of the spread');
    expect(tpl).toMatch(/capped at ±5/);
  });
});
