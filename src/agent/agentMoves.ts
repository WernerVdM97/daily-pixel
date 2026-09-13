/**
 * Bridges the view-state seam to the brain's move vocabulary (JSON-seam M4.2). The controller
 * emits `MenuViewState`/`DecisionViewState`; `viewMoves` enumerates their buttons positionally;
 * these helpers turn those buttons into the `LegalMove[]` the brain picks from — carrying the
 * controller-facing `AgentMove` for each — and add the contextual moves no screen enumerates
 * (`sleep`, and the free-text `custom` slot). All customId parsing is authoritative (not
 * positional), so a bail option sitting mid-list still maps to the right selector.
 */

import type { MenuViewState, DecisionViewState, WizardViewState } from '../view/viewState.js';
import type { CharacterData } from '../engine/WorldEngine.js';
import { viewMoves } from './viewToText.js';
import { parseActionCid, CID_BAIL } from '../view/actionViewState.js';
import { CID_DAYJOB, CID_DAYJOB_CUSTOM } from '../controller/dayJob.js';
import { RECON_SCREENS } from './AgentPlayerGateway.js';
import type { AgentMove, AgentCharView, LegalMove, ReconScreen } from './AgentPlayerGateway.js';

/** The always-available "end the day" move — no screen enumerates it (DA-6). */
export const SLEEP_MOVE: LegalMove = { move: { kind: 'sleep' }, label: 'Go to sleep — end the day' };

/** How many times one recon screen may be consulted in a day (spec § C's per-screen cap). */
export const RECON_PER_SCREEN_CAP = 2;

/** How many recon turns a day may spend in total (spec § C's per-day cap). */
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

/** Legal moves on the day-job menu: each day-job button → `menu-pick` (index = the day-job action
 *  index the button's customId encodes), the `Custom…` button → a `custom` free-text slot, plus
 *  the always-available `sleep`. When `reconUsage` is supplied, one `recon` entry per screen still
 *  under BOTH caps is appended after the day-job/custom buttons and before `sleep` (spec § C) — no
 *  screen enumerates them, so they are contextual moves like `sleep`, not view buttons. */
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

/** The screens the caps are withholding right now — the complement of the recon entries
 *  `menuLegalMoves` appends. The harness reads it to log ONE warning finding per day when a cap is
 *  first hit, so a screen the day has spent its budget on is visible in the transcript rather than
 *  silently missing from the offer. */
export function reconWithheld(usage: ReconUsage): ReconScreen[] {
  return RECON_SCREENS.filter(
    (screen) => (usage.perScreen[screen] ?? 0) >= RECON_PER_SCREEN_CAP || usage.total >= RECON_PER_DAY_CAP,
  );
}

/** Legal moves on the day-job menu with the day-job buttons withheld — the free-text slot only,
 *  no `sleep`. `AGENT_FORCE_FREE_ACTIONS` (RA-2) offers this list until the day holds a completed
 *  free action, so the brain cannot take day-job work (whose outcome `stripWorkInspiration`
 *  strips of any inspiration grant) or end the day instead. Empty when the menu carries no custom
 *  button — the caller falls back to `menuLegalMoves` rather than offering zero moves. Recon
 *  entries are filtered out too (it builds without a `ReconUsage`): the forced menu is the
 *  free-text slot ONLY, and its screened view is filtered in lockstep. */
export function freeActionLegalMoves(view: MenuViewState): LegalMove[] {
  return menuLegalMoves(view).filter((m) => m.move.kind === 'custom');
}

/** The menu the brain is SHOWN while the free action is still owed: the same view with the day-job
 *  buttons removed. Withholding the moves alone is not enough — `viewToText` numbers the screen's
 *  OWN buttons positionally, so the brain would read `[0] Run the day job` while `MOVES[0]` was the
 *  free-text slot; a brain answering the screen's numbers (the prod gateway range-checks the index
 *  before the harness sees it) crashed the run instead of stumbling. Filtering the view keeps the
 *  screen numbering and the offered move list in lockstep. */
export function freeActionMenuView(view: MenuViewState): MenuViewState {
  return { ...view, buttons: view.buttons.filter((b) => b.customId === CID_DAYJOB_CUSTOM) };
}

/** Legal moves on the character-creation wizard (M8.5, DC-S3): step 1 offers the free-text name
 *  slot only — the Discord modal is NOT a protocol action, so the brain fills the custom text;
 *  steps 2-8 enumerate the view's semantic buttons POSITIONALLY (the brain's index IS the view
 *  button position, the play-loop convention — restart included: a restart pick just loops the
 *  walk, bounded by the wizard step guard). Aligned with `view.buttons`, never filtered. */
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
 *  illegal-move QA finding rather than acting on it (M4.4). Compared by kind + index/text/screen
 *  so a scripted or hallucinated move for the wrong screen is caught. */
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
