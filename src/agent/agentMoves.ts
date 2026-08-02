/**
 * Bridges the view-state seam to the brain's move vocabulary (JSON-seam M4.2). The controller
 * emits `MenuViewState`/`DecisionViewState`; `viewMoves` enumerates their buttons positionally;
 * these helpers turn those buttons into the `LegalMove[]` the brain picks from — carrying the
 * controller-facing `AgentMove` for each — and add the contextual moves no screen enumerates
 * (`sleep`, and the free-text `custom` slot). All customId parsing is authoritative (not
 * positional), so a bail option sitting mid-list still maps to the right selector.
 */

import type { MenuViewState, DecisionViewState } from '../view/viewState.js';
import type { CharacterData } from '../engine/WorldEngine.js';
import { viewMoves } from './viewToText.js';
import { parseActionCid, CID_BAIL } from '../view/actionViewState.js';
import { CID_DAYJOB, CID_DAYJOB_CUSTOM } from '../controller/dayJob.js';
import type { AgentMove, AgentCharView, LegalMove } from './AgentPlayerGateway.js';

/** The always-available "end the day" move — no screen enumerates it (DA-6). */
export const SLEEP_MOVE: LegalMove = { move: { kind: 'sleep' }, label: 'Go to sleep — end the day' };

/** Project the engine's character row down to the brief state the brain reads each turn. */
export function agentCharView(char: CharacterData): AgentCharView {
  return {
    name: char.name,
    class: char.class,
    health: char.health,
    maxHealth: char.maxHealth,
    stamina: char.stamina,
    maxStamina: char.maxStamina,
    rollsRemaining: char.rollsRemaining,
    wealth: char.wealth,
    location: char.location,
  };
}

/** Legal moves on the day-job menu: each day-job button → `menu-pick` (index = the day-job action
 *  index the button's customId encodes), the `Custom…` button → a `custom` free-text slot, plus
 *  the always-available `sleep`. */
export function menuLegalMoves(view: MenuViewState): LegalMove[] {
  const moves: LegalMove[] = [];
  for (const m of viewMoves(view)) {
    if (m.customId === CID_DAYJOB_CUSTOM) {
      moves.push({ move: { kind: 'custom', text: '' }, label: 'Type your own action' });
    } else if (m.customId.startsWith(CID_DAYJOB)) {
      const idx = Number(m.customId.slice(CID_DAYJOB.length));
      moves.push({ move: { kind: 'menu-pick', index: idx }, label: m.label });
    }
  }
  moves.push(SLEEP_MOVE);
  return moves;
}

/** Legal moves on a decision screen: each choice button → `choice` (index = the OPTION index its
 *  customId encodes, not the button position), the bail button → `bail`. No `sleep` — a beat in
 *  progress must be resolved or bailed, exactly as a Discord player has no sleep button mid-action. */
export function decisionLegalMoves(view: DecisionViewState): LegalMove[] {
  const moves: LegalMove[] = [];
  for (const m of viewMoves(view)) {
    if (m.customId === CID_BAIL) {
      moves.push({ move: { kind: 'bail' }, label: m.label });
      continue;
    }
    const parsed = parseActionCid(m.customId);
    if (parsed) {
      moves.push({
        move: { kind: 'choice', index: parsed.optionIdx },
        label: `${m.label}${m.favoured ? ' (favoured)' : ''}`,
      });
    }
  }
  return moves;
}

/** True when `move` is one the harness offered this turn — the harness logs a mismatch as an
 *  illegal-move QA finding rather than acting on it (M4.4). Compared by kind + index/text so a
 *  scripted or hallucinated move for the wrong screen is caught. */
export function isLegal(move: AgentMove, legal: LegalMove[]): boolean {
  return legal.some((l) => {
    if (l.move.kind !== move.kind) return false;
    if (move.kind === 'menu-pick' || move.kind === 'choice') {
      return (l.move as { index: number }).index === move.index;
    }
    return true; // custom (any text), bail, sleep — kind match is enough
  });
}
