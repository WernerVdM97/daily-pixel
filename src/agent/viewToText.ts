/**
 * Agent medium step (JSON-seam M4.0, see docs/engine/json-seam-build-plans.md) — the
 * agent-player's peer to `src/discord/viewToDiscord.ts`. Takes a semantic `ViewState` and
 * renders it as plain text an LLM brain can read, plus enumerates the discrete actionable
 * buttons so the harness can map the brain's pick to a controller call. Imports only the
 * transport-neutral view-state types — never `discord.js` — so the agent adapter reuses the
 * exact same view-states a Discord player sees (parent decision 2).
 *
 * Unlike `viewToDiscord`, there is no embed-length degradation ladder: an LLM context has no
 * 4096-char cap, so the full (uncollapsed) variant is always emitted for maximum context.
 * ANSI-decorated fields (`openingFrame`, `combatStatus`, `sceneBlock`, `combatSceneBlock`) are
 * passed through verbatim — this step is a structural join, not a content transformer; an
 * ANSI strip for token economy is a later refinement, not a rendering decision made here.
 */

import type {
  ViewState,
  DecisionViewState,
  OutcomeViewState,
  MenuViewState,
} from '../view/viewState.js';

/** A discrete actionable button on a view — the machine-readable companion to the prose
 *  `viewToText` emits. The brain picks one by `index`; the harness maps `kind`+`index` to the
 *  right controller/engine call. This is view-derived button data ONLY: the brain's full move
 *  vocabulary (free-text custom actions, ending the day) is a superset the harness supplies
 *  contextually (M4.1 `AgentMove`), not something a screen enumerates. */
export interface ViewMove {
  index: number;
  label: string;
  customId: string;
  kind: 'choice' | 'bail' | 'menu';
  /** The engine's passive-insight hint (the route it senses is clearly safest). A Discord
   *  player sees this as a green button; the agent gets it here + as a `(favoured)` marker in
   *  `viewToText`, so it reads the same signal (parent decision 2). Choice moves only. */
  favoured?: boolean;
}

/** The discrete actionable buttons on a view, in button order (so `index` maps positionally
 *  to the underlying button the harness will act on). Non-interactive screens (outcome,
 *  notice, loading, commute) offer no buttons and return `[]`. */
export function viewMoves(view: ViewState): ViewMove[] {
  switch (view.screen) {
    case 'decision': {
      // Choices and option lines are appended in lockstep in `buildDecisionView` (a bail adds
      // a button but no option line), so the k-th choice button pairs with the k-th option
      // line regardless of where bail falls in the button order.
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

/** Renders any `ViewState` to agent-readable plain text. Decision/menu screens append a
 *  bracketed, index-labelled move list (`[0] …`) so the brain names its pick by the same
 *  index `viewMoves` exposes — no letter/customId parsing on the brain side. */
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
  }
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
  // Combat outcomes carry the combat scene block; non-combat carry the plain scene (mirrors
  // the `isCombat` selection in `outcomeViewToDiscord`).
  if (view.isCombat) {
    if (view.combatSceneBlock) parts.push(view.combatSceneBlock);
  } else if (view.sceneBlock) {
    parts.push(view.sceneBlock);
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
