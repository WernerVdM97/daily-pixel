import { describe, it, expect } from 'vitest';
import { ButtonStyle, MessageFlags } from 'discord.js';
import {
  buildDecisionView,
  buildOutcomeView,
} from '../../src/discord/commands/action.js';
import { decisionViewToDiscord, noticeViewToDiscord, outcomeViewToDiscord } from '../../src/discord/viewToDiscord.js';
import { distilledActionEmoji } from '../../src/engine/OutcomeRenderer.js';
import type { ActionOutcome } from '../../src/engine/WorldEngine.js';
import type { CombatBeatLog } from '../../src/engine/action/combat-dc.js';
import type { DecisionViewState, OutcomeViewState } from '../../src/view/viewState.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── M2.2 — pins the view-state seam independently of the Discord snapshots:
// buildXView must return the expected semantic shape (first half), and the medium step
// (decisionViewToDiscord/outcomeViewToDiscord) is pinned directly on hand-built DTOs
// (second half) — not via a round-trip through buildXView, since buildXMessage/buildXEmbed
// are now themselves defined as viewToDiscord(buildXView(...)) and a round-trip would just
// run the same call graph twice. ──

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

// ── Medium step, pinned directly: hand-built DTOs exercise decisionViewToDiscord/
// outcomeViewToDiscord in isolation from the view-builders and the Discord snapshots. ──

describe('decisionViewToDiscord — medium step', () => {
  const baseView: DecisionViewState = {
    screen: 'decision',
    title: { emoji: '🤔', text: 'Decision' },
    colorIntent: 'decision',
    storyThread: { full: 'FULL-THREAD', collapsed: 'COLL-THREAD' },
    narration: 'The wind shifts.',
    prompt: '> A fork in the road.',
    optionLines: ['**A.** Easy path ⬇️', '**B.** Hard path ⬆️'],
    buttons: [
      { kind: 'choice', letter: 'A', customId: 'action:choice:0:0', favoured: true },
      { kind: 'choice', letter: 'B', customId: 'action:choice:0:1', favoured: false },
      { kind: 'bail', label: 'Step back', customId: 'action:bail' },
    ],
    footer: 'a safer path catches your eye',
    openingFrame: undefined,
  };

  it('assembles the embed and buttons from the view fields', () => {
    const result = decisionViewToDiscord(baseView);

    expect(result.embeds.length).toBe(1);
    expect(result.embeds[0].title).toBe('🤔 Decision');
    expect(result.embeds[0].color).toBe(0xdaa520);
    expect(result.embeds[0].footer?.text).toBe(baseView.footer);

    const expectedDescription = [baseView.storyThread!.full, baseView.narration, baseView.prompt].join('\n\n')
      + '\n\n' + baseView.optionLines.join('\n');
    expect(result.embeds[0].description).toBe(expectedDescription);

    const buttons = result.components[0].components as any[];
    expect(buttons[0]).toMatchObject({ custom_id: 'action:choice:0:0', label: 'A', style: ButtonStyle.Success });
    expect(buttons[1]).toMatchObject({ custom_id: 'action:choice:0:1', label: 'B', style: ButtonStyle.Secondary });
    expect(buttons[2]).toMatchObject({ custom_id: 'action:bail', label: 'Step back', style: ButtonStyle.Danger });
  });

  it('degrades the description: full → collapsed → hard clip, as the joined length exceeds the embed cap', () => {
    const longFull = 'x'.repeat(5000);
    const collapseView: DecisionViewState = {
      ...baseView,
      narration: undefined,
      storyThread: { full: longFull, collapsed: 'COLLAPSED' },
    };
    const collapsed = decisionViewToDiscord(collapseView);
    expect(collapsed.embeds[0].description).toMatch(/^COLLAPSED/);

    const stillTooLong = 'y'.repeat(4090);
    const clipView: DecisionViewState = {
      ...baseView,
      narration: undefined,
      storyThread: { full: longFull, collapsed: stillTooLong },
    };
    const clipped = decisionViewToDiscord(clipView);
    expect(clipped.embeds[0].description!.length).toBeLessThanOrEqual(4096);
    expect(clipped.embeds[0].description!.endsWith('…')).toBe(true);
  });

  it('prepends an opening-frame embed when the view carries one', () => {
    const withFrame: DecisionViewState = { ...baseView, openingFrame: '```ansi\nFRAME\n```' };
    const result = decisionViewToDiscord(withFrame);

    expect(result.embeds.length).toBe(2);
    expect(result.embeds[0].description).toContain('FRAME');
    expect(result.embeds[0].color).toBe(0x2c2f33);
    expect(result.embeds[1].title).toBe('🤔 Decision');
  });
});

describe('outcomeViewToDiscord — medium step', () => {
  const baseView: OutcomeViewState = {
    screen: 'outcome',
    title: { emoji: distilledActionEmoji('hunt'), text: 'Hunt' },
    colorIntent: 'success',
    locationLine: '📍 Oakhollow',
    breadcrumb: '🧵 Hunt → Track it',
    sceneBlock: '```\n🌲 Forest scene art\n```',
    isCombat: false,
    storyThread: { full: 'FULL-THREAD', collapsed: 'COLL-THREAD' },
    outcomeBlock: 'The stag falls.',
  };

  it('assembles title, colour, and description in assemble(false, true) order', () => {
    const result = outcomeViewToDiscord(baseView);

    expect(result.title).toBe(`${distilledActionEmoji('hunt')} Hunt`);
    expect(result.color).toBe(0x2ecc71);
    expect(result.description).toBe(
      [baseView.locationLine, baseView.breadcrumb, baseView.sceneBlock, baseView.storyThread!.full, baseView.outcomeBlock].join('\n\n'),
    );
  });

  it('maps colorIntent to the outcome hex, including the unknown-intent fallback', () => {
    expect(outcomeViewToDiscord({ ...baseView, colorIntent: 'failure' }).color).toBe(0xe74c3c);
    expect(outcomeViewToDiscord({ ...baseView, colorIntent: 'default' }).color).toBe(0x3498db);
  });

  it('shows the combat scene block instead of the plain scene block when isCombat is true', () => {
    const combatView: OutcomeViewState = {
      ...baseView,
      isCombat: true,
      combatSceneBlock: '```ansi\nCOMBAT FRAME\n```',
    };
    const result = outcomeViewToDiscord(combatView);

    expect(result.description).toContain('COMBAT FRAME');
    expect(result.description).not.toContain('🌲 Forest scene art');
  });

  it('degrades to the collapsed story thread when the full thread exceeds the embed cap', () => {
    const longView: OutcomeViewState = {
      ...baseView,
      storyThread: { full: 'x'.repeat(5000), collapsed: 'COLLAPSED-MARKER' },
    };
    const result = outcomeViewToDiscord(longView);

    expect(result.description).toContain('COLLAPSED-MARKER');
    expect(result.description).not.toContain('x'.repeat(5000));
  });
});

// ── M3.1 — pins noticeViewToDiscord's reply-payload shape: ephemeral carries the
// Discord flag, non-ephemeral omits it entirely (matching the pre-M3.1 inline replies). ──

describe('noticeViewToDiscord — medium step', () => {
  it('adds the ephemeral flag when ephemeral is true', () => {
    expect(noticeViewToDiscord({ screen: 'notice', text: 'x', ephemeral: true })).toEqual({
      content: 'x',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('omits flags entirely when ephemeral is false', () => {
    expect(noticeViewToDiscord({ screen: 'notice', text: 'x', ephemeral: false })).toEqual({
      content: 'x',
    });
  });
});
