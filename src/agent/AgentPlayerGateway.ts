/**
 * The agent-player brain seam, peer to `PipelineLlmGateway`: one `chooseMove` per turn, real LLM or
 * stub. Imports nothing from `discord.js` or the engine runtime.
 */

/** The recon screens a brain can consult for free. Order is the offer order. */
export const RECON_SCREENS = ['look', 'map', 'stats', 'backpack', 'journal', 'help'] as const;
export type ReconScreen = (typeof RECON_SCREENS)[number];

/**
 * A move the brain can commit to. `menu-pick`/`choice` carry the VIEW's positional button index,
 * not the list position; `recon` is free but still costs a TURN; `custom` is free text.
 */
export type AgentMove =
  | { kind: 'menu-pick'; index: number }
  | { kind: 'custom'; text: string }
  | { kind: 'choice'; index: number }
  | { kind: 'bail' }
  | { kind: 'sleep' }
  | { kind: 'recon'; screen: ReconScreen };

/** How often a player would meet a friction over a campaign. */
export type Recurrence = 'once' | 'periodic' | 'ritual';

/** A friction the brain hit this turn. */
export interface FrictionReport {
  what: string; // short description of the friction
  severity: 1 | 2 | 3 | 4 | 5;
  recurrence: Recurrence;
}

/** The end-of-day note: the two ratings, a one-line summary and the updated arc note. */
export interface DayNote {
  engagement: 1 | 2 | 3 | 4 | 5;
  fulfilment: 1 | 2 | 3 | 4 | 5;
  line: string; // one line on the day
  arcNote: string; // the updated arc note
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
   *  writes the `day-note` event when the day closes. */
  dayNote?: DayNote;
  /** Reasons a malformed note field was dropped. The harness logs each as a warning finding. */
  droppedNotes?: string[];
}

/** A legal move for the current turn, paired with the label the brain reads: the view's buttons plus
 *  the contextual moves no screen enumerates. A `custom` entry's `move.text` is a fillable SLOT. */
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

/** One turn of input to the brain: the rendered screen, the legal moves, the character state and the
 *  working-memory fields below, each optional and omitted at its source. */
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
  /** True when the character has exactly ONE roll left, so this turn's action is the day's last and
   *  the day note rides it. Spread in only when true, so any other turn renders exactly as before. */
  lastRoll?: boolean;
}

export interface AgentPlayerGateway {
  /** Pick one of `input.moves` for the current screen, returning the notes that ride with the pick.
   *  THROWS on an unresolvable MOVE; a malformed NOTE is dropped onto `droppedNotes` instead. */
  chooseMove(input: ChooseMoveInput): Promise<BrainTurn>;
}
