import { describe, it, expect } from 'vitest';
import {
  buildDecisionView,
  buildOutcomeView,
  buildDecisionMessage,
  buildOutcomeEmbed,
} from '../../src/discord/commands/action.js';
import { decisionViewToDiscord, outcomeViewToDiscord } from '../../src/discord/viewToDiscord.js';
import { distilledActionEmoji } from '../../src/engine/OutcomeRenderer.js';
import type { ActionOutcome } from '../../src/engine/WorldEngine.js';
import type { CombatBeatLog } from '../../src/engine/action/combat-dc.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── M2.2 — pins the view-state seam independently of the Discord snapshots:
// buildXView must return the expected semantic shape, and the medium step must
// reproduce buildXMessage's output exactly (round-trip) on the same inputs. ──

describe('buildDecisionView — semantic shape', () => {
  // Mirrors action-decision.test.ts's passive-insight fixture: easy path DC 10, hard
  // path DC 16 (running 12 ± modifier) — a clear gap, so the hint fires on 'Easy path'.
  const decision = {
    prompt: 'A fork in the road.',
    options: [
      { label: 'Easy path', dcModifier: -2 },
      { label: 'Hard path', dcModifier: 4 },
      { label: 'Step back', dcModifier: null },
    ],
  };
  const state = { rawInput: 'go east', decisions: [], accumulatedDc: 12 };
  const char = { stats: { physical: 0, wisdom: 2, intelligence: 0, charisma: 0 } };

  it('returns the expected semantic shape for a decision with options and a favoured (passive-insight) hint', () => {
    const view = buildDecisionView(decision, 0, state, char);

    expect(view.screen).toBe('decision');
    expect(view.title).toEqual({ emoji: '🤔', text: 'Decision' });
    expect(view.colorIntent).toBe('decision');
    expect(view.storyThread).toEqual({
      full: expect.stringContaining('🧭 **Quest:** go east'),
      collapsed: expect.stringContaining('🧭 **Quest:** go east'),
    });
    expect(view.narration).toBeUndefined();
    expect(view.combatStatus).toBeUndefined();
    expect(view.prompt).toBe('> A fork in the road.');
    expect(view.optionLines).toEqual(['**A.** Easy path ⬇️', '**B.** Hard path ⬆️']);
    expect(view.buttons).toEqual([
      { kind: 'choice', letter: 'A', customId: 'action:choice:0:0', favoured: true },
      { kind: 'choice', letter: 'B', customId: 'action:choice:0:1', favoured: false },
      { kind: 'bail', label: 'Step back', customId: 'action:bail' },
    ]);
    expect(view.footer).toBe('a safer path catches your eye');
    expect(view.openingFrame).toBeUndefined();
  });

  it('carries the rendered opening-frame ANSI string only on the first decision when actionType is given', () => {
    const withFrame = buildDecisionView(decision, 0, state, char, 'travel');
    expect(withFrame.openingFrame).toContain('```ansi');

    const continueBeat = buildDecisionView(decision, 1, state, char, 'travel');
    expect(continueBeat.openingFrame).toBeUndefined();
  });

  it('omits storyThread when no state is given (no story to thread)', () => {
    const view = buildDecisionView({ prompt: 'x', options: [{ label: 'Go', dcModifier: 0 }] }, 0);
    expect(view.storyThread).toBeUndefined();
  });
});

describe('buildOutcomeView — semantic shape', () => {
  const state = { rawInput: 'attack the stag', decisions: [] };

  describe('non-combat outcome', () => {
    const outcome: ActionOutcome = {
      distilledType: 'hunt',
      finalDc: 14,
      playerRolled: 16,
      outcome: 'success',
      outcomeText: 'The stag falls.',
      mutations: [],
    };
    const char = {
      name: 'Aldric', health: 12, maxHealth: 12, stamina: 10, maxStamina: 10,
      rollsRemaining: 1, wealth: 5, location: 'Oakhollow',
    } as any;

    it('returns the expected semantic shape, scene block populated, no combat block', () => {
      const view = buildOutcomeView(outcome, char, '🌲 Forest scene art', state);

      expect(view.screen).toBe('outcome');
      expect(view.title).toEqual({ emoji: distilledActionEmoji('hunt'), text: 'Hunt' });
      expect(view.colorIntent).toBe('success');
      expect(view.locationLine).toBe('📍 Oakhollow');
      expect(view.isCombat).toBe(false);
      expect(view.sceneBlock).toBe('```\n🌲 Forest scene art\n```');
      expect(view.combatSceneBlock).toBeUndefined();
      expect(view.storyThread).toEqual({
        full: expect.stringContaining('🧭 **Quest:** attack the stag'),
        collapsed: expect.stringContaining('🧭 **Quest:** attack the stag'),
      });
      expect(view.outcomeBlock).toContain('The stag falls.');
    });

    it('omits storyThread when opts.compact is set', () => {
      const view = buildOutcomeView(outcome, char, null, state, { compact: true });
      expect(view.storyThread).toBeUndefined();
    });
  });

  describe('combat outcome', () => {
    const combatBeat: CombatBeatLog = {
      round: 2, band: 'clean', enemyHpBefore: 6, enemyHpAfter: 0, playerHpDelta: 0,
      playerD20: 18, playerBonus: 5, dc: 10, enemyD20: 7, enemyBonus: 0, margin: 16,
      materialMutationFired: true, ops: ['set_relation'], marker: 'combat_round',
    };
    const combatOutcome: ActionOutcome = {
      distilledType: 'skirmish',
      finalDc: 10,
      playerRolled: 18,
      rollBonus: 5,
      rollStat: 'physical',
      outcome: 'success',
      outcomeText: 'Your blade finds its mark — the creature crumples.',
      mutations: [],
      combatBeat,
      combatFrame: { enemyName: 'Shadow Stag', enemyMaxHp: 24, margin: 16 },
      combatRounds: [combatBeat],
    };
    const char = {
      name: 'Aldric', health: 12, maxHealth: 12, stamina: 10, maxStamina: 10,
      rollsRemaining: 1, wealth: 5,
    } as any;

    it('selects the combat scene block over the plain scene block, and reflects isCombat', () => {
      const view = buildOutcomeView(combatOutcome, char, null, state);

      expect(view.isCombat).toBe(true);
      expect(view.sceneBlock).toBeUndefined();
      expect(view.combatSceneBlock).toContain('```ansi');
      expect(view.combatSceneBlock).toContain('Shadow Stag');
      expect(view.outcomeBlock).toContain('COMBAT RESOLVED');
      expect(view.outcomeBlock).toContain('margin +16');
    });
  });
});

// ── Round-trip: the medium step reproduces buildXMessage's exact output on the
// same inputs — this is the byte-identical gate the DTO seam must not drift. ──

describe('decisionViewToDiscord(buildDecisionView(x)) round-trips buildDecisionMessage(x)', () => {
  it('matches for a decision with options, a favoured hint, and story-thread history', () => {
    const decision = {
      prompt: 'A fork in the road.',
      options: [
        { label: 'Easy path', dcModifier: -2 },
        { label: 'Hard path', dcModifier: 4 },
        { label: 'Step back', dcModifier: null },
      ],
    };
    const state = {
      rawInput: 'go east',
      decisions: [{ prompt: 'Hunt', chosen: 'Track it', dcModifier: -1, narration: 'The stag freezes.' }],
      accumulatedDc: 12,
    };
    const char = {
      stats: { physical: 0, wisdom: 2, intelligence: 0, charisma: 0 },
      name: 'Aldric', health: 24, maxHealth: 30, location: 'Oakhollow',
    };

    const viaView = decisionViewToDiscord(buildDecisionView(decision, 1, state, char, 'travel'));
    const direct = buildDecisionMessage(decision, 1, state, char, 'travel');
    expect(viaView).toEqual(direct);
  });

  it('matches for the bare no-frame, no-state case', () => {
    const decision = { prompt: 'Scout — what do you do?', options: [{ label: 'Track the wolf quietly', dcModifier: -2 }] };
    expect(decisionViewToDiscord(buildDecisionView(decision, 0))).toEqual(buildDecisionMessage(decision, 0));
  });
});

describe('outcomeViewToDiscord(buildOutcomeView(x)) round-trips buildOutcomeEmbed(x)', () => {
  const state = {
    rawInput: 'hunt the stag',
    decisions: [{ prompt: 'Hunt — what do you do?', chosen: 'Track it', dcModifier: -1, distilledType: 'hunt' }],
  };

  it('matches for a non-combat outcome', () => {
    const outcome: ActionOutcome = {
      distilledType: 'hunt', finalDc: 14, playerRolled: 16, outcome: 'success',
      outcomeText: 'The stag falls.', mutations: [],
    };
    const char = { name: 'Aldric', health: 12, maxHealth: 12, stamina: 10, maxStamina: 10, rollsRemaining: 1, wealth: 5 } as any;

    const viaView = outcomeViewToDiscord(buildOutcomeView(outcome, char, '🌲 Forest scene art', state));
    const direct = buildOutcomeEmbed(outcome, char, '🌲 Forest scene art', state);
    expect(viaView).toEqual(direct);
  });

  it('matches for a combat outcome', () => {
    const combatBeat: CombatBeatLog = {
      round: 2, band: 'clean', enemyHpBefore: 6, enemyHpAfter: 0, playerHpDelta: 0,
      playerD20: 18, playerBonus: 5, dc: 10, enemyD20: 7, enemyBonus: 0, margin: 16,
      materialMutationFired: true, ops: ['set_relation'], marker: 'combat_round',
    };
    const combatOutcome: ActionOutcome = {
      distilledType: 'skirmish', finalDc: 10, playerRolled: 18, rollBonus: 5, rollStat: 'physical',
      outcome: 'success', outcomeText: 'Your blade finds its mark — the creature crumples.',
      mutations: [], combatBeat, combatFrame: { enemyName: 'Shadow Stag', enemyMaxHp: 24, margin: 16 },
      combatRounds: [combatBeat],
    };
    const char = { name: 'Aldric', health: 12, maxHealth: 12, stamina: 10, maxStamina: 10, rollsRemaining: 1, wealth: 5 } as any;

    const viaView = outcomeViewToDiscord(buildOutcomeView(combatOutcome, char, null, state));
    const direct = buildOutcomeEmbed(combatOutcome, char, null, state);
    expect(viaView).toEqual(direct);
  });

  it('matches with opts.compact set (storyThread suppressed)', () => {
    const outcome: ActionOutcome = {
      distilledType: 'hunt', finalDc: 14, playerRolled: 16, outcome: 'success',
      outcomeText: 'The stag falls.', mutations: [],
    };
    const char = { name: 'Aldric', health: 12, maxHealth: 12, stamina: 10, maxStamina: 10, rollsRemaining: 1, wealth: 5 } as any;

    const viaView = outcomeViewToDiscord(buildOutcomeView(outcome, char, null, state, { compact: true }));
    const direct = buildOutcomeEmbed(outcome, char, null, state, { compact: true });
    expect(viaView).toEqual(direct);
  });
});
