import { describe, it, expect } from 'vitest';

import { viewToText, viewMoves } from '../../src/agent/viewToText.js';
import type {
  DecisionViewState,
  OutcomeViewState,
  MenuViewState,
  NoticeViewState,
  LoadingViewState,
  CommuteViewState,
} from '../../src/view/viewState.js';

// ── M4.0 — pins the agent medium step: `viewToText` renders every ViewState variant to
// agent-readable text (full, no degradation ladder), and `viewMoves` enumerates the discrete
// actionable buttons positionally so the harness maps the brain's pick back to a button. ──

const decision: DecisionViewState = {
  screen: 'decision',
  title: { emoji: '⚔️', text: 'Action' },
  colorIntent: 'decision',
  storyThread: { full: 'FULL THREAD', collapsed: 'short thread' },
  narration: 'The wind stirs.',
  combatStatus: undefined,
  prompt: 'What do you do?',
  optionLines: ['**A.** Advance carefully', '**B.** Hold position'],
  buttons: [
    { kind: 'choice', letter: 'A', customId: 'action:choice:0:0', favoured: true },
    { kind: 'choice', letter: 'B', customId: 'action:choice:0:1', favoured: false },
    { kind: 'bail', label: 'Retreat', customId: 'action:bail' },
  ],
  footer: 'Insight favours A.',
};

describe('viewMoves', () => {
  it('enumerates decision choices then bail, pairing each choice with its option line and carrying favoured', () => {
    expect(viewMoves(decision)).toEqual([
      { index: 0, label: '**A.** Advance carefully', customId: 'action:choice:0:0', kind: 'choice', favoured: true },
      { index: 1, label: '**B.** Hold position', customId: 'action:choice:0:1', kind: 'choice', favoured: false },
      { index: 2, label: 'Retreat', customId: 'action:bail', kind: 'bail' },
    ]);
  });

  it('handles a bail-only decision (no real choices)', () => {
    const bailOnly: DecisionViewState = {
      ...decision,
      optionLines: [],
      buttons: [{ kind: 'bail', label: 'Flee', customId: 'action:bail' }],
    };
    expect(viewMoves(bailOnly)).toEqual([
      { index: 0, label: 'Flee', customId: 'action:bail', kind: 'bail' },
    ]);
  });

  it('returns no moves for an empty menu', () => {
    const emptyMenu: MenuViewState = {
      screen: 'menu', title: { emoji: '🛠️', text: 'Choose' }, description: 'Nothing here.', buttons: [],
    };
    expect(viewMoves(emptyMenu)).toEqual([]);
  });

  it('pairs choices with option lines even when bail is not last', () => {
    const bailFirst: DecisionViewState = {
      ...decision,
      buttons: [
        { kind: 'bail', label: 'Flee', customId: 'action:bail' },
        { kind: 'choice', letter: 'A', customId: 'action:choice:0:0', favoured: false },
        { kind: 'choice', letter: 'B', customId: 'action:choice:0:1', favoured: false },
      ],
    };
    expect(viewMoves(bailFirst)).toEqual([
      { index: 0, label: 'Flee', customId: 'action:bail', kind: 'bail' },
      { index: 1, label: '**A.** Advance carefully', customId: 'action:choice:0:0', kind: 'choice', favoured: false },
      { index: 2, label: '**B.** Hold position', customId: 'action:choice:0:1', kind: 'choice', favoured: false },
    ]);
  });

  it('falls back to the letter when an option line is missing', () => {
    const noLines: DecisionViewState = { ...decision, optionLines: [] };
    expect(viewMoves(noLines).map(m => m.label)).toEqual(['A', 'B', 'Retreat']);
  });

  it('enumerates menu buttons positionally', () => {
    const menu: MenuViewState = {
      screen: 'menu',
      title: { emoji: '🛠️', text: 'Choose an action' },
      description: 'Your day-job options.',
      buttons: [
        { label: 'Walk the rounds', customId: 'action:dayjob:0', style: 'secondary' },
        { label: 'Custom…', customId: 'action:dayjob:custom', style: 'primary' },
      ],
    };
    expect(viewMoves(menu)).toEqual([
      { index: 0, label: 'Walk the rounds', customId: 'action:dayjob:0', kind: 'menu' },
      { index: 1, label: 'Custom…', customId: 'action:dayjob:custom', kind: 'menu' },
    ]);
  });

  it('returns no moves for non-interactive screens', () => {
    const outcome: OutcomeViewState = {
      screen: 'outcome', title: { emoji: '✅', text: 'Success' }, colorIntent: 'success',
      isCombat: false, outcomeBlock: 'You did it.',
    };
    const notice: NoticeViewState = { screen: 'notice', text: 'ok', ephemeral: true };
    const loading: LoadingViewState = { screen: 'loading', body: 'Starting…' };
    const commute: CommuteViewState = { screen: 'commute', destination: 'Barracks', idle: 'boots on stone' };
    expect(viewMoves(outcome)).toEqual([]);
    expect(viewMoves(notice)).toEqual([]);
    expect(viewMoves(loading)).toEqual([]);
    expect(viewMoves(commute)).toEqual([]);
  });
});

describe('viewToText', () => {
  it('renders a decision: title, thread, narration, prompt, indexed moves, footer', () => {
    expect(viewToText(decision)).toBe(
      [
        '⚔️ Action',
        'FULL THREAD',
        'The wind stirs.',
        'What do you do?',
        '[0] **A.** Advance carefully (favoured)\n[1] **B.** Hold position\n[2] Retreat',
        'Insight favours A.',
      ].join('\n\n'),
    );
  });

  it('uses the full (not collapsed) story thread', () => {
    expect(viewToText(decision)).toContain('FULL THREAD');
    expect(viewToText(decision)).not.toContain('short thread');
  });

  it('includes the opening frame and combat status when present', () => {
    const combat: DecisionViewState = {
      ...decision, openingFrame: 'FRAME-ART', combatStatus: 'HP 8/10', storyThread: undefined, narration: undefined,
    };
    const text = viewToText(combat);
    expect(text).toContain('FRAME-ART');
    expect(text).toContain('HP 8/10');
  });

  it('renders a non-combat outcome with scene and thread, dropping the combat scene', () => {
    const outcome: OutcomeViewState = {
      screen: 'outcome', title: { emoji: '✅', text: 'Success' }, colorIntent: 'success',
      locationLine: 'The Barracks', breadcrumb: 'Day 3', sceneBlock: 'SCENE', combatSceneBlock: 'COMBAT-SCENE',
      isCombat: false, storyThread: { full: 'THREAD', collapsed: 'c' }, outcomeBlock: 'You succeed.',
    };
    expect(viewToText(outcome)).toBe(
      ['✅ Success', 'The Barracks', 'Day 3', 'SCENE', 'THREAD', 'You succeed.'].join('\n\n'),
    );
  });

  it('renders a minimal outcome (all optional fields absent) as title + outcome block', () => {
    const bare: OutcomeViewState = {
      screen: 'outcome', title: { emoji: '✅', text: 'Success' }, colorIntent: 'success',
      isCombat: false, outcomeBlock: 'You did it.',
    };
    expect(viewToText(bare)).toBe('✅ Success\n\nYou did it.');
  });

  it('selects the combat scene block for a combat outcome', () => {
    const outcome: OutcomeViewState = {
      screen: 'outcome', title: { emoji: '⚔️', text: 'Victory' }, colorIntent: 'success',
      sceneBlock: 'SCENE', combatSceneBlock: 'COMBAT-SCENE', isCombat: true, outcomeBlock: 'The foe falls.',
    };
    const text = viewToText(outcome);
    expect(text).toContain('COMBAT-SCENE');
    expect(text).not.toContain('\nSCENE');
  });

  it('renders notice / loading / commute as their plain text', () => {
    expect(viewToText({ screen: 'notice', text: 'Noted.', ephemeral: true })).toBe('Noted.');
    expect(viewToText({ screen: 'loading', body: 'Starting…' })).toBe('Starting…');
    expect(viewToText({ screen: 'commute', destination: 'Barracks', idle: 'boots on stone' }))
      .toBe('You head to the Barracks. (-1 stamina)\nSetting to work… boots on stone');
  });

  it('renders a menu with indexed move list', () => {
    const menu: MenuViewState = {
      screen: 'menu', title: { emoji: '🛠️', text: 'Choose an action' }, description: 'Your options.',
      buttons: [
        { label: 'Walk the rounds', customId: 'action:dayjob:0', style: 'secondary' },
        { label: 'Custom…', customId: 'action:dayjob:custom', style: 'primary' },
      ],
    };
    expect(viewToText(menu)).toBe(
      ['🛠️ Choose an action', 'Your options.', '[0] Walk the rounds\n[1] Custom…'].join('\n\n'),
    );
  });
});
