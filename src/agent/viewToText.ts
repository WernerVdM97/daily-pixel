/**
 * The agent-player's peer to `src/discord/viewToDiscord.ts`: renders a `ViewState` as plain text an LLM
 * brain can read, with no embed-length ladder — there is no Discord embed cap to degrade for.
 */

import type {
  ViewState,
  DecisionViewState,
  OutcomeViewState,
  MenuViewState,
  WizardViewState,
} from '../view/viewState.js';

/** A discrete actionable button on a view — the machine-readable companion to the prose `viewToText`
 *  emits. View-derived button data ONLY: the brain's move vocabulary is a superset the harness adds. */
export interface ViewMove {
  index: number;
  label: string;
  customId: string;
  kind: 'choice' | 'bail' | 'menu';
  /** The engine's passive-insight hint (the route it senses is safest), rendered to the agent as a
   *  `(favoured)` marker in place of Discord's green button. Choice moves only. */
  favoured?: boolean;
}

/** The discrete actionable buttons on a view, in button order, so `index` maps to the button the
 *  harness will act on. Non-interactive screens offer none and return `[]`. */
export function viewMoves(view: ViewState): ViewMove[] {
  switch (view.screen) {
    case 'decision': {
      // `buildDecisionView` appends choices and option lines in lockstep, and a bail adds a button
      // but no option line, so the k-th choice button pairs the k-th option line wherever bail falls.
      let choiceIdx = 0;
      return view.buttons.map((b, index) =>
        b.kind === 'bail'
          ? { index, label: b.label, customId: b.customId, kind: 'bail' as const }
          : { index, label: view.optionLines[choiceIdx++] ?? b.letter, customId: b.customId, kind: 'choice' as const, favoured: b.favoured },
      );
    }
    case 'menu':
      return view.buttons.map((b, index) => ({ index, label: b.label, customId: b.customId, kind: 'menu' as const }));
    default:
      return [];
  }
}

/** Renders any `ViewState` to agent-readable plain text. Decision/menu screens append a bracketed,
 *  index-labelled move list so the brain names its pick by the same index `viewMoves` exposes. */
export function viewToText(view: ViewState): string {
  switch (view.screen) {
    case 'decision':
      return decisionToText(view);
    case 'outcome':
      return outcomeToText(view);
    case 'notice':
      return view.text;
    case 'menu':
      return menuToText(view);
    case 'loading':
      return view.body;
    case 'commute':
      return `You head to the ${view.destination}. (-1 stamina)\nSetting to work… ${view.idle}`;
    case 'wizard':
      return wizardToText(view);
  }
}

/** The character-creation wizard screen, reached only by the brain-driven realism walk; the default
 *  creation arm crosses the seam as events rather than as a rendered screen. */
function wizardToText(view: WizardViewState): string {
  return [view.ledger, view.body].join('\n\n');
}

function movesBlock(view: ViewState): string | null {
  const moves = viewMoves(view);
  if (moves.length === 0) return null;
  return moves.map(m => `[${m.index}] ${m.label}${m.favoured ? ' (favoured)' : ''}`).join('\n');
}

function decisionToText(view: DecisionViewState): string {
  const blocks: string[] = [`${view.title.emoji} ${view.title.text}`];
  if (view.openingFrame) blocks.push(view.openingFrame);
  if (view.storyThread) blocks.push(view.storyThread.full);
  if (view.narration) blocks.push(view.narration);
  if (view.combatStatus) blocks.push(view.combatStatus);
  blocks.push(view.prompt);
  const moves = movesBlock(view);
  if (moves) blocks.push(moves);
  blocks.push(view.footer);
  return blocks.join('\n\n');
}

function outcomeToText(view: OutcomeViewState): string {
  const parts: string[] = [`${view.title.emoji} ${view.title.text}`];
  if (view.locationLine) parts.push(view.locationLine);
  if (view.breadcrumb) parts.push(view.breadcrumb);
  // Combat outcomes carry the combat scene block; the auto-resolved arm carries its opening
  // frame ahead of the plain scene (mirrors the selection in `outcomeViewToDiscord`).
  if (view.isCombat) {
    if (view.combatSceneBlock) parts.push(view.combatSceneBlock);
  } else {
    if (view.openingFrame) parts.push(view.openingFrame);
    if (view.sceneBlock) parts.push(view.sceneBlock);
  }
  if (view.storyThread) parts.push(view.storyThread.full);
  parts.push(view.outcomeBlock);
  return parts.join('\n\n');
}

function menuToText(view: MenuViewState): string {
  const blocks: string[] = [`${view.title.emoji} ${view.title.text}`, view.description];
  const moves = movesBlock(view);
  if (moves) blocks.push(moves);
  return blocks.join('\n\n');
}
