/**
 * The agent-player brain seam (JSON-seam M4.1, see docs/engine/json-seam-build-plans.md, DA-6).
 *
 * `AgentPlayerGateway` is the agent-player's peer to the pipeline's `PipelineLlmGateway`: a single
 * `chooseMove` method the harness calls once per turn. It has a real implementation
 * (`ProdAgentPlayerGateway`, a DeepSeek call) and a deterministic stub
 * (`ScriptedAgentPlayerGateway`) — exactly the split `ProdPipelineLlmGateway` /
 * `PipelineScriptedGateway` established, so the real brain is opt-in on a harness run and CI never
 * touches the network.
 *
 * This module imports NOTHING from `discord.js` or the engine's runtime — only the small value
 * types below — so the seam stays transport-neutral (parent decision 3).
 */

/** The recon screens a brain can consult for free (spec § C). Order is the offer order. */
export const RECON_SCREENS = ['look', 'map', 'stats', 'backpack', 'journal', 'help'] as const;
export type ReconScreen = (typeof RECON_SCREENS)[number];

/**
 * A move the brain can commit to. The discriminated union feeds a controller/engine call directly
 * (DA-6): the harness maps each kind to the right seam call.
 *
 * - `menu-pick` / `choice` carry the VIEW's positional button index (from `viewMoves`), not the
 *   list position in `ChooseMoveInput.moves` — so the harness acts on the real button.
 * - `custom` is a free-text action (no screen enumerates it — the harness offers it as a slot).
 * - `bail` abandons the current decision; `sleep` ends the day.
 * - `recon` consults a read-only screen (spec § C): free, deterministic, no roll and no day
 *   advance, but still a TURN — the rendered screen comes back as the next turn's `lastRecon`.
 */
export type AgentMove =
  | { kind: 'menu-pick'; index: number }
  | { kind: 'custom'; text: string }
  | { kind: 'choice'; index: number }
  | { kind: 'bail' }
  | { kind: 'sleep' }
  | { kind: 'recon'; screen: ReconScreen };

/** How often a player would meet a friction over a campaign (spec § E). */
export type Recurrence = 'once' | 'periodic' | 'ritual';

/** A friction the brain hit this turn. */
export interface FrictionReport {
  what: string; // short description of the friction
  severity: 1 | 2 | 3 | 4 | 5;
  recurrence: Recurrence;
}

/** The end-of-day note (spec § E). It may ride ANY turn: the LAST one captured in a day is the one
 *  that counts, and the harness writes it when the day closes, whatever its disposition. A
 *  `sleep`-only rule loses it on the commonest day end — `menu.open` returns `no-rolls` at zero
 *  rolls, so a day that spends its rolls is never offered a turn it could rate. */
export interface DayNote {
  engagement: 1 | 2 | 3 | 4 | 5;
  fulfilment: 1 | 2 | 3 | 4 | 5;
  line: string; // one line on the day
  arcNote: string; // the updated arc note (spec § B/§ E)
}

/** One turn of brain output. Replaces the old bare `AgentMove` return. */
export interface BrainTurn {
  move: AgentMove;
  /** Rewrites the running intent when the plan changes. Omitted = unchanged. */
  intent?: string;
  /** Rewrites the arc note when what it is building changes. Omitted = unchanged. */
  arcNote?: string;
  friction?: FrictionReport;
  /** The day's rating. May ride ANY turn; the harness keeps the LAST one seen in the day and
   *  writes the `day-note` event when the day closes (see {@link ChooseMoveInput.lastRoll}). */
  dayNote?: DayNote;
  /** Reasons a malformed note field was dropped. The harness logs each as a warning finding. */
  droppedNotes?: string[];
}

/** A legal move for the current turn, paired with the label the brain reads. The harness builds
 *  this list from `viewMoves(view)` (choice/bail/menu buttons) plus the contextual moves a screen
 *  never enumerates (`custom`, `sleep`, `recon`). A `custom` entry is a SLOT: its `move.text` is a
 *  placeholder the brain fills in by returning free text. */
export interface LegalMove {
  move: AgentMove;
  label: string;
}

/** The brief character state the brain sees each turn — enough to reason about resources without
 *  leaking engine internals. Mirrors the fields a Discord player reads off their status line. */
export interface AgentCharView {
  name: string;
  class: string;
  health: number;
  maxHealth: number;
  stamina: number;
  maxStamina: number;
  rollsRemaining: number;
  wealth: number;
  location: string;
}

/** One turn of input to the brain: the rendered screen (from `viewToText`), the legal moves, the
 *  character state, and the working memory a player carries (spec § B). Every working-memory field
 *  is optional and omitted at the source, so a first turn — and every turn of a pre-rework call
 *  site — carries exactly the three keys the seam carried before. */
export interface ChooseMoveInput {
  screenText: string;
  moves: LegalMove[];
  character: AgentCharView;
  /** Day-start block: yesterday's outcome lines in order + the ending disposition. Absent until
   *  the second day has started. */
  recap?: string;
  /** Today's attempts so far, refusals and dead-ends included. Absent on the day's first turn. */
  dayLog?: string;
  /** The brain's own running intent line. Absent until the brain first sets one. */
  intentNote?: string;
  /** The brain's own arc line. Absent until the brain first sets one. */
  arcNote?: string;
  /** The recon screen rendered on the PREVIOUS turn because the brain asked for it. Delivered
   *  for exactly one turn, then cleared (it stays readable in the day log / on re-request). */
  lastRecon?: { screen: ReconScreen; text: string };
  /** True when the character has exactly ONE roll left, so this turn's action is the day's last.
   *  The day note rides this turn because the brain is otherwise never asked again:
   *  `SessionController.openActionMenu` returns `no-rolls` at zero rolls, so a day that spends its
   *  rolls is never offered a turn it could rate. Spread in only when true, so a turn that is not
   *  the day's last renders exactly the message it rendered before this field existed. */
  lastRoll?: boolean;
}

export interface AgentPlayerGateway {
  /** Pick one of `input.moves` for the current screen, plus the notes that ride with the pick.
   *  Returns a {@link BrainTurn} (a `custom` slot is returned with the brain's free text filled
   *  in). Implementations THROW on an unresolvable MOVE (unparseable response, out-of-range
   *  choice, empty custom text) — the harness owns re-prompt-vs-log (M4.4), not the gateway. A
   *  malformed NOTE never throws: it is dropped and reported on `BrainTurn.droppedNotes`, so a lost
   *  data point stays visible without killing a run that has already spent tokens. */
  chooseMove(input: ChooseMoveInput): Promise<BrainTurn>;
}
