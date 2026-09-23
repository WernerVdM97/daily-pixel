/**
 * Bridges the view-state seam to the brain's move vocabulary: the controller emits view-states and
 * these helpers turn their buttons into the brain's `LegalMove[]`, matched by the customId a screen encodes rather than by position (the wizard step screens enumerate positionally).
 */

import type { MenuViewState, DecisionViewState, WizardViewState } from '../view/viewState.js';
import type { CharacterData } from '../engine/WorldEngine.js';
import { viewMoves } from './viewToText.js';
import { parseActionCid, CID_BAIL } from '../view/actionViewState.js';
import { CID_DAYJOB, CID_DAYJOB_CUSTOM } from '../controller/dayJob.js';
import { RECON_SCREENS } from './AgentPlayerGateway.js';
import type { AgentMove, AgentCharView, LegalMove, ReconScreen } from './AgentPlayerGateway.js';

/** The always-available "end the day" move — no screen enumerates it. */
export const SLEEP_MOVE: LegalMove = { move: { kind: 'sleep' }, label: 'Go to sleep — end the day' };

/** How many times one recon screen may be consulted in a day. */
export const RECON_PER_SCREEN_CAP = 2;

/** How many recon turns a day may spend in total. */
export const RECON_PER_DAY_CAP = 6;

/** How much recon the day has already spent. The harness owns this; it is reset per day. */
export interface ReconUsage {
  perScreen: Partial<Record<ReconScreen, number>>;
  total: number;
}

/** The label the brain reads for each recon screen, in the offer order `RECON_SCREENS` fixes. */
const RECON_LABELS: Record<ReconScreen, string> = {
  look: '/look — look around',
  map: '/map — the world map',
  stats: '/stats — your sheet',
  backpack: '/backpack — your kit',
  journal: '/journal — your journal',
  help: '/help — commands',
};

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

/** Legal moves on the day-job menu: each day-job button → `menu-pick`, `Custom…` → a `custom` slot,
 *  plus `sleep`. With `reconUsage`, recon entries are appended before `sleep`, under both caps. */
export function menuLegalMoves(view: MenuViewState, reconUsage?: ReconUsage): LegalMove[] {
  const moves: LegalMove[] = [];
  for (const m of viewMoves(view)) {
    if (m.customId === CID_DAYJOB_CUSTOM) {
      moves.push({ move: { kind: 'custom', text: '' }, label: 'Type your own action' });
    } else if (m.customId.startsWith(CID_DAYJOB)) {
      const idx = Number(m.customId.slice(CID_DAYJOB.length));
      moves.push({ move: { kind: 'menu-pick', index: idx }, label: m.label });
    }
  }
  if (reconUsage) {
    const withheld = new Set(reconWithheld(reconUsage));
    for (const screen of RECON_SCREENS) {
      if (withheld.has(screen)) continue;
      moves.push({ move: { kind: 'recon', screen }, label: RECON_LABELS[screen] });
    }
  }
  moves.push(SLEEP_MOVE);
  return moves;
}

/** The screens the caps are withholding right now. The harness reads this to log ONE warning finding
 *  per day when a cap is first hit, rather than letting a capped screen vanish from the offer. */
export function reconWithheld(usage: ReconUsage): ReconScreen[] {
  return RECON_SCREENS.filter(
    (screen) => (usage.perScreen[screen] ?? 0) >= RECON_PER_SCREEN_CAP || usage.total >= RECON_PER_DAY_CAP,
  );
}

/** Legal moves on the day-job menu with the day-job buttons withheld: the free-text slot only, no
 *  `sleep`, so a forced day cannot take day-job work. Empty → the caller falls back to the full menu. */
export function freeActionLegalMoves(view: MenuViewState): LegalMove[] {
  return menuLegalMoves(view).filter((m) => m.move.kind === 'custom');
}

/** The menu the brain is SHOWN while the free action is owed: the same view minus the day-job buttons.
 *  Withholding the moves alone would desync `viewToText`'s positional numbering from `MOVES`. */
export function freeActionMenuView(view: MenuViewState): MenuViewState {
  return { ...view, buttons: view.buttons.filter((b) => b.customId === CID_DAYJOB_CUSTOM) };
}

/** Legal moves on the character-creation wizard: step 1 is the name slot only (the modal is not a
 *  protocol action); steps 2-8 enumerate `view.buttons` positionally, restart picks included. */
export function wizardLegalMoves(view: WizardViewState): LegalMove[] {
  if (view.step === 1) {
    return [{ move: { kind: 'custom', text: '' }, label: '✏️ Name your character' }];
  }
  return view.buttons.map((b, i) => ({
    move: { kind: 'menu-pick', index: i },
    label: `${b.emoji ?? ''} ${b.label}`.trim(),
  }));
}

/** Legal moves on a decision screen: each choice button → `choice` (index = the OPTION index its
 *  customId encodes), the bail button → `bail`. No `sleep` — a beat must be resolved or bailed. */
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

/** True when `move` is one the harness offered this turn — a mismatch is logged as an illegal-move QA
 *  finding rather than acted on. Compared by kind + index/screen, so a wrong-screen move is caught. */
export function isLegal(move: AgentMove, legal: LegalMove[]): boolean {
  return legal.some((l) => {
    if (l.move.kind !== move.kind) return false;
    if (move.kind === 'menu-pick' || move.kind === 'choice') {
      return (l.move as { index: number }).index === move.index;
    }
    if (move.kind === 'recon') {
      // Recon entries are per screen, so a `recon` for a screen this turn did not offer (a capped
      // one, or one asked for on a decision screen) is an illegal move, not a kind match.
      return (l.move as { screen: ReconScreen }).screen === move.screen;
    }
    return true; // custom (any text), bail, sleep — kind match is enough
  });
}
