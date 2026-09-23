/** The harness is a `GameEvent`/`GameResponse` protocol client over `GameRouter`; `createCharacter`
 *  dispatches through `dispatch`, which is what replay re-seeds from, and engine access runs through the `AgentObserver` seam alone — never the play path. */

import type { AgentObserver, CharacterData, CharCreateData } from './observer.js';
import type { MenuViewState, DecisionViewState, ViewState } from '../view/viewState.js';
import type {
  AgentPlayerGateway,
  AgentMove,
  BrainTurn,
  ChooseMoveInput,
  DayNote,
  LegalMove,
  AgentCharView,
  ReconScreen,
} from './AgentPlayerGateway.js';
import { viewToText } from './viewToText.js';
import {
  menuLegalMoves,
  decisionLegalMoves,
  wizardLegalMoves,
  freeActionLegalMoves,
  freeActionMenuView,
  isLegal,
  reconWithheld,
  RECON_PER_DAY_CAP,
  RECON_PER_SCREEN_CAP,
} from './agentMoves.js';
import type { ReconUsage } from './agentMoves.js';
import { summarizeOutcome, buildDayLog, buildRecap } from './turnContext.js';
import type { DayLogEntry } from './turnContext.js';
import { Transcript } from './transcript.js';
import type { GameRouter } from '../protocol/router.js';
import type { GameResponse } from '../protocol/envelope.js';
import type { GameEvent } from '../protocol/events.js';

/** Safety valve on the decision loop: the pipeline's own beat cap is 2, so a run past this many beats
 *  in one action is a machine anomaly (logged as a finding), never normal play. */
const MAX_BEATS = 10;

/** A day ends after this many CONSECUTIVE non-outcome actions (dead-end/illegal/abandoned) — a brain
 *  looping on a screen it can't get past. Any completed action resets the run, so a productive day never trips it. */
const STUCK_LIMIT = 5;

/** Backstop against a brain that keeps producing outcomes without ever depleting rolls or choosing
 *  sleep, which would spin past the roll refill boundary. Far above a real day (3 rolls). */
const MAX_ACTIONS_PER_DAY = 50;

/** Bounds the wizard restart loop (a brain that keeps picking restart on the confirm screen) so the
 *  realism arm cannot hang a live run; a sane walk is 8 steps. */
const MAX_WIZARD_STEPS = 16;

/** The wizard envelope carries NO character facts, so the realism arm hands the brain this all-zeros
 *  placeholder rather than inventing a character for it. */
const WIZARD_PLACEHOLDER_CHAR: AgentCharView = {
  name: '',
  class: '',
  health: 0,
  maxHealth: 0,
  stamina: 0,
  maxStamina: 0,
  rollsRemaining: 0,
  wealth: 0,
  location: '',
};

/** Render an unknown thrown value for a finding detail — the stack when we have one (it localises
 *  the failing call better than the bare message), else a best-effort string. */
function formatError(e: unknown): string {
  if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`;
  return String(e);
}

/** The disposition of a single `playOneAction`. `slept`/`no-rolls` end the day, `dead-end`/`illegal-move` are non-fatal, `outcome` is a completed action, and `recon` is a free read of one of the six read-only screens,
 *  bounded by the per-day caps rather than by the roll allowance. `crashed` is fatal to the run, though the transcript survives as a repro. */
export type PlayResult =
  | { kind: 'outcome'; bailed?: boolean }
  | { kind: 'decision-abandoned' }
  | { kind: 'dead-end'; reason: string }
  | { kind: 'slept' }
  | { kind: 'no-rolls' }
  | { kind: 'no-character' }
  | { kind: 'illegal-move'; move: AgentMove }
  | { kind: 'recon'; screen: ReconScreen }
  | { kind: 'crashed'; phase: string; error: string };

export interface AgentHarnessOptions {
  /** Record the router's interstitial beats into the protocol log's dispatch entries. Default off:
   *  beats are advisory transport chrome and the final envelope is the contract. */
  recordBeats?: boolean;
  /** The brain class, for the protocol-log header (replay's interpretation hint). */
  brain?: 'scripted' | 'prod';
  /** The backend class the router was wired to, for the protocol-log header (replay's selector). */
  backend?: 'real' | 'stub';
  /** ISO-8601 wall clock stamped into the protocol-log header; replay pins the process clock to it.
   *  Defaults to now, so a deterministic recording must pass a fixed value or the header alone breaks byte-identity. */
  recordedAt?: string;
  /** `AGENT_FORCE_FREE_ACTIONS`: while the day still owes one, the menu offers the free-text slot ONLY,
   *  because day-job work is `kind: 'work'` and its positive roll grants are inspiration-stripped by design. Off by default: the menu is then exactly `menuLegalMoves`, byte-identical. */
  forceFreeActions?: boolean;
  /** The persona the run played as, stamped into the protocol-log header so a recorded run is
   *  attributable in replay. Absent = the pre-persona header shape, which keeps every earlier recording byte-identical. */
  persona?: string;
  /** The run's pinned clock, when the caller pinned one: it advances one day immediately before each
   *  nightly tick, so the tick that opens day N+1 sees day N+1's date and the COMING day's rolls take the Saturday bonus. Absent = the pre-clock behaviour, byte-identical on every stub/replay corpus entry. */
  pinnedClock?: { advanceDays(n: number): void };
}

/** The disposition of a single game day. `slept`/`no-rolls` are clean ends; `stalled` means the brain
 *  got stuck (STUCK_LIMIT or the action cap, both logged as findings); `no-character` is fatal. */
export interface DaySummary {
  /** The game day this summary covers (`day_number` at the start of the day). */
  dayNumber: number;
  /** Completed actions this day (outcome dispositions). */
  outcomes: number;
  ended: 'slept' | 'no-rolls' | 'stalled' | 'no-character' | 'crashed';
}

export class AgentHarness {
  readonly transcript = new Transcript();

  constructor(
    private readonly observer: AgentObserver,
    private readonly router: GameRouter,
    private readonly brain: AgentPlayerGateway,
    private readonly userId: string,
    options: AgentHarnessOptions = {},
  ) {
    this.recordBeats = options.recordBeats ?? false;
    this.forceFreeActions = options.forceFreeActions ?? false;
    this.pinnedClock = options.pinnedClock;
    this.freeActionPending = this.forceFreeActions;
    // The protocol-log header, written once at construction so every dispatch entry that follows has
    // the session identity (brain class + backend class) to interpret it against.
    this.transcript.protocolHeader(
      userId,
      options.brain ?? 'scripted',
      options.backend ?? 'real',
      options.recordedAt ?? new Date().toISOString(),
      options.persona,
    );
  }

  private readonly recordBeats: boolean;

  /** The caller's pinned clock, when there is one — see {@link AgentHarnessOptions.pinnedClock}. */
  private readonly pinnedClock?: { advanceDays(n: number): void };

  /** `AGENT_FORCE_FREE_ACTIONS` — see {@link AgentHarnessOptions.forceFreeActions}. */
  private readonly forceFreeActions: boolean;

  /** Whether the current day still owes its forced free action. Seeded at construction so a caller
   *  driving `playOneAction` directly gets one too, and reset per day in `beginDay`. */
  private freeActionPending: boolean;

  // ── The brain's working memory — the context a player carries between turns. ──

  /** The brain's own running intent line, rewritten whenever a turn carries `intent`. */
  private intentNote?: string;

  /** The brain's own arc line — what it is building, last written by the closing day note's `arcNote`. */
  private arcNote?: string;

  /** Today's attempts, refusals included, so a refused option cannot come back looking fresh. Reset per day. */
  private dayLog: DayLogEntry[] = [];

  /** Today's completed-action lines (first line of each outcome), promoted to `yesterdayOutcomes`
   *  when the day closes. */
  private todayOutcomes: string[] = [];

  /** Yesterday's completed-action lines, in order — the recap block's body. */
  private yesterdayOutcomes: string[] = [];

  /** The disposition the last closed day ended on (`slept`/`no-rolls`/`stalled`/`crashed`).
   *  Absent until a day has closed, which is what makes the recap absent on day one. */
  private yesterdayEnded?: string;

  /** The game day the player last actually PLAYED, as `closeDay` numbers it. Kept apart from
   *  `currentDay() - 1` because `skipDays` moves the world with no play, which would let a day-start recap call a day the player never played "yesterday". */
  private lastPlayedDay?: number;

  /** The rendered recap block for the day in progress, composed once at day start. */
  private recap?: string;

  /** The result line of the action just completed (see `recordOutcome`) — the day log's outcome
   *  text, kept here so the attempt that produced it can be logged without re-deriving it. */
  private lastOutcomeLine?: string;

  /** How much recon the day in progress has already spent. Reset per day. */
  private reconUsage: ReconUsage = { perScreen: {}, total: 0 };

  /** Whether the day has already warned about a hit recon cap — one finding per day, not one per
   *  turn (a per-turn warning would drown the transcript the critic reads). */
  private reconCapLogged = false;

  /** The recon screen the brain asked for on the PREVIOUS turn, delivered to exactly the next turn's
   *  `ChooseMoveInput.lastRecon` and then cleared (it stays readable in the day log, and on a re-request). */
  private lastRecon?: { screen: ReconScreen; text: string };

  /** The day's note, kept as the brain reports it: the LAST one seen in the day counts. Written when the
   *  day closes, whatever closed it — a day that spends its last roll is never asked another question, so a sleep-only write would lose the rating pair on the commonest day end. */
  private todayDayNote?: DayNote;

  /** How many questions the brain was asked today (wizard steps are not play turns). A day that
   *  closes with no note is only a hole in the series if the brain was actually given the chance. */
  private todayTurns = 0;

  /** Whether the action attempt in progress has already written its own day-log line. The decision
   *  loop logs its own failures, so the enclosing menu branch must not append a second, misleading line. */
  private attemptLogged = false;

  /** The single recording point: every dispatch flows through here, so the protocol log gets exactly one
   *  entry per dispatch. Beats are collected when `recordBeats` is on and `onBeat` is ALWAYS delegated to the router; the returned envelope is exactly what `router.dispatch` returned. */
  private async dispatch(event: GameEvent, onBeat?: (beat: GameResponse) => void): Promise<GameResponse> {
    const beats: GameResponse[] = [];
    const wrapped: ((beat: GameResponse) => void) | undefined =
      onBeat || this.recordBeats
        ? (beat) => {
            if (this.recordBeats) beats.push(beat);
            onBeat?.(beat);
          }
        : undefined;
    const response = await this.router.dispatch(event, wrapped);
    this.transcript.recordDispatch(event, response, this.recordBeats ? beats : undefined);
    return response;
  }

  /** The fresh-spawn bootstrap: the join wizard driven through the seam as a player would, every step
   *  dispatched through `dispatch` so the creation walk lands in the log that replay re-seeds from. `itemSetName` is required (step 7 has no skip) and any `ok: false` throws with the envelope's message. */
  async createCharacter(data: CharCreateData): Promise<void> {
    let response = await this.dispatch({ type: 'join.open', playerId: this.userId });
    if (!response.ok) throw new Error(response.error.message);

    response = await this.dispatch({ type: 'wizard.answer', playerId: this.userId, text: data.name });
    if (!response.ok) throw new Error(response.error.message);

    // Steps 2-6: class, upbringing, race, alignment, dayJob, keyed by def name — except alignment,
    // which the wizard persists lowercase ("lawful good"), so a title-case fixture would be rejected.
    for (const [step, value] of [[2, data.class], [3, data.upbringing], [4, data.race], [5, data.alignment], [6, data.dayJob]] as const) {
      response = await this.dispatch({ type: 'wizard.choose', playerId: this.userId, step, value });
      if (!response.ok) throw new Error(response.error.message);
    }

    // Step 7 (the starting kit) is MANDATORY in the wizard — the walk can only reach the step-8 confirm
    // screen by choosing one, so a kit-less seed is impossible. Fail loudly up front rather than stall at step 7 and surface the confusing "isn't ready to confirm" envelope at character.create.
    if (!data.itemSetName) {
      throw new Error('seed: itemSetName is required — the wizard has no kit-less creation path (step 7 is mandatory)');
    }

    response = await this.dispatch({ type: 'wizard.choose', playerId: this.userId, step: 7, value: data.itemSetName });
    if (!response.ok) throw new Error(response.error.message);

    response = await this.dispatch({ type: 'character.create', playerId: this.userId });
    if (!response.ok) throw new Error(response.error.message);
  }

  /** Drive one action from the action menu to a terminal disposition. The router never throws (every
   *  path returns an envelope), so the catch only covers rendering errors in `ask()` and the error-envelope mapping. */
  async playOneAction(): Promise<PlayResult> {
    this.attemptLogged = false;
    try {
      const result = await this.runAction();
      // The look-after-outcome parity beat: the player looks around the new scene after each completed
      // action (scripted and deterministic, never a brain pick).
      if (result.kind === 'outcome') await this.lookAfterOutcome();
      return result;
    } catch (e) {
      this.transcript.finding('error', `uncaught exception during action loop`, formatError(e));
      return { kind: 'crashed', phase: 'action', error: formatError(e) };
    }
  }

  private async runAction(): Promise<PlayResult> {
    // menu.open: stampLastPlayed + the full menu/resume branch, inside the router.
    const menu = await this.dispatch({ type: 'menu.open', playerId: this.userId });

    // Error branches: every GameErrorCode maps to an existing PlayResult disposition.
    if (!menu.ok) return this.mapError(menu);

    // All ok:true paths carry a view (menu.open never returns ok:true without one).
    const view = menu.view!;

    switch (view.screen) {
      case 'menu':
        return this.playMenu(view, menu.facts);
      case 'decision':
        return this.runDecisionLoop(view, menu.facts);
      default:
        // The router only emits menu/decision from menu.open. A commute/loading/notice/outcome
        // from this event would be an internal invariant breach — log it and press on.
        this.transcript.finding('error', `unexpected screen "${view.screen}" from menu.open`);
        return { kind: 'dead-end', reason: 'unexpected-screen' };
    }
  }

  /** Map a GameErrorCode to the PlayResult disposition the loop reads. Every code the router
   *  can emit from the mid-day events has a designated path. */
  private mapError(response: GameResponse & { ok: false }): PlayResult {
    const code = response.error.code;
    const msg = response.error.message;
    switch (code) {
      case 'no-character':
        this.transcript.deadEnd('no-character');
        return { kind: 'no-character' };
      case 'no-rolls':
        return { kind: 'no-rolls' };
      case 'stale-session':
        this.transcript.deadEnd('resume-stale', msg);
        return { kind: 'dead-end', reason: 'resume-stale' };
      case 'session-expired':
        this.transcript.deadEnd('session-expired');
        return { kind: 'decision-abandoned' };
      case 'illegal-move':
        return { kind: 'dead-end', reason: 'illegal-move' };
      case 'unsafe':
        this.transcript.deadEnd('unsafe-ground', msg);
        return { kind: 'dead-end', reason: 'unsafe' };
      case 'empty-action':
        this.transcript.deadEnd('empty-action', msg);
        return { kind: 'dead-end', reason: 'empty-action' };
      case 'divine-intervention':
        // The roll was refunded and nothing happened — a stumble in playDay's accounting, not a
        // completed action.
        this.transcript.deadEnd('divine-intervention', msg);
        return { kind: 'dead-end', reason: 'divine-intervention' };
      case 'invalid-event':
        this.transcript.deadEnd('invalid-event', msg);
        return { kind: 'dead-end', reason: 'invalid-event' };
      case 'internal':
        this.transcript.deadEnd('internal', msg);
        return { kind: 'dead-end', reason: 'internal' };
    }
  }

  /** Play one game day: drive actions until the day ends. A completed action loops back to the menu, `slept`/`no-rolls` end it cleanly, a fatal `no-character` stops immediately, and everything else is a
   *  non-fatal stumble until STUCK_LIMIT consecutive ones (or the action cap) ends the day as `stalled`. A `recon` neither increments nor resets that run: the per-day caps already bound it. */
  async playDay(): Promise<DaySummary> {
    const dayNumber = this.currentDay();
    this.beginDay();
    // The scripted day-start parity beats — the greeting + the stats screen, once per day and before
    // the action loop (parity argues for scripted beats: the brain never picks chrome). Both are protocol-logged NO-STAMP pure reads (hi.open/stats carry no stamp).
    await this.dayStartBeats();
    let outcomes = 0;
    let stumbles = 0;
    for (let action = 0; action < MAX_ACTIONS_PER_DAY; action++) {
      const result = await this.playOneAction();
      switch (result.kind) {
        case 'outcome':
          outcomes++;
          stumbles = 0;
          this.checkInvariants(`day ${dayNumber} action outcome`);
          break;
        case 'recon':
          break;
        case 'slept':
          return this.closeDay(dayNumber, outcomes, 'slept');
        case 'no-rolls':
          return this.closeDay(dayNumber, outcomes, 'no-rolls');
        case 'no-character':
          return this.closeDay(dayNumber, outcomes, 'no-character');
        case 'crashed':
          // The exception is already logged as an error finding; end the run — a crashed seam
          // means the same call would keep throwing, so pressing on burns actions for no signal.
          return this.closeDay(dayNumber, outcomes, 'crashed');
        default:
          // dead-end / illegal-move / decision-abandoned — the attempt failed but the day can
          // continue. Bail once the brain is clearly stuck so a QA run can't spin on one screen.
          if (++stumbles >= STUCK_LIMIT) {
            this.transcript.finding(
              'warning',
              `day ${dayNumber} stalled: ${stumbles} consecutive non-outcome actions`,
            );
            return this.closeDay(dayNumber, outcomes, 'stalled');
          }
      }
    }
    this.transcript.finding('warning', `day ${dayNumber} hit the ${MAX_ACTIONS_PER_DAY}-action cap`);
    return this.closeDay(dayNumber, outcomes, 'stalled');
  }

  /** Open a day: reset everything the day owns — the forced-free-action debt, the recon budget, the
   *  day log, the day's note and turn count, the one-turn recon delivery — and compose the day-start recap from the day that just closed (absent on the first day). */
  private beginDay(): void {
    this.freeActionPending = this.forceFreeActions;
    this.reconUsage = { perScreen: {}, total: 0 };
    this.reconCapLogged = false;
    this.dayLog = [];
    this.lastRecon = undefined;
    this.lastOutcomeLine = undefined;
    this.todayDayNote = undefined;
    this.todayTurns = 0;
    this.recap =
      this.yesterdayEnded === undefined
        ? undefined
        : buildRecap({
            dayNumber: this.currentDay(),
            yesterdayOutcomes: this.yesterdayOutcomes,
            yesterdayEnded: this.yesterdayEnded,
            lastPlayedDay: this.lastPlayedDay,
          });
  }

  /** Close a day: write the day's note — it is day-level, not sleep-level, so it is written HERE, on
   *  any close — then hand its completed-action lines, its disposition and its own day number to the recap cells and start today's lines over. */
  private closeDay(dayNumber: number, outcomes: number, ended: DaySummary['ended']): DaySummary {
    if (this.todayDayNote !== undefined) {
      // The closing day's number, whatever the disposition: `slept`, `no-rolls`, `stalled` and
      // `crashed` all end a day the brain rated.
      this.transcript.dayNote({ dayNumber, ...this.todayDayNote });
      // Last, so the end-of-day statement of what the brain is building wins over whatever the
      // day's own turns said.
      this.arcNote = this.todayDayNote.arcNote;
    } else if (this.todayTurns > 0) {
      // A hole in the engagement/fulfilment series must never be silent — but a day that asked the
      // brain nothing (a fatal no-character on the first call) had no chance to give a note, so no warning.
      this.transcript.finding(
        'warning',
        `day ${dayNumber} closed as ${ended} with no dayNote captured after ${this.todayTurns} turns`,
      );
    }
    this.todayDayNote = undefined;
    this.todayTurns = 0;

    this.yesterdayOutcomes = this.todayOutcomes;
    this.yesterdayEnded = ended;
    // The recap cells' day: `dayNumber` here is the day that just ended, which is by definition
    // the last day played (and stays so across a `skipDays` gap).
    this.lastPlayedDay = dayNumber;
    this.todayOutcomes = [];
    return { dayNumber, outcomes, ended };
  }

  /** Play up to `days` game days, bookending each with the nightly rest and the observer's world tick. It stops
   *  early on any non-clean day end, which is what keeps `resolveStaleTimeout` off this path: no later day exists. */
  async playDays(days: number): Promise<DaySummary[]> {
    const summaries: DaySummary[] = [];
    for (let day = 0; day < days; day++) {
      const summary = await this.playDay();
      summaries.push(summary);
      // Stop on any non-clean day end: fatal (no-character), wedged (stalled — see above), or
      // crashed (an exception that would keep recurring). Only slept/no-rolls roll into the night.
      if (summary.ended !== 'slept' && summary.ended !== 'no-rolls') break;
      // A throwing nightly tick is itself a captured finding (endDay returns false) — stop rather
      // than march into a day whose world never advanced.
      if (!(await this.endDay())) break;
    }
    return summaries;
  }

  /** The scripted day-start beats: the `hi.open` greeting (recorded as the semantic `greeting` event) and
   *  the `screen.stats` beat. Both are silent on `no-character`; anything else going wrong IS a finding, since the beats are part of the player's reachable surface. */
  private async dayStartBeats(): Promise<void> {
    const hi = await this.dispatch({ type: 'hi.open', playerId: this.userId });
    if (hi.ok && hi.view) {
      // Both arms land here: the greeting, or the resume arm (pending action) whose text is the
      // "⏳ Unfinished Action" notice — defensible parity, only reachable in inherit-after-interruption.
      this.transcript.greeting(viewToText(hi.view));
    } else if (!hi.ok && hi.error.code !== 'no-character') {
      this.transcript.finding('warning', `day-start greeting failed: ${hi.error.code}`);
    }

    const stats = await this.dispatch({ type: 'screen.stats', playerId: this.userId });
    if (!stats.ok && stats.error.code !== 'no-character') {
      this.transcript.finding('warning', `day-start stats beat failed: ${stats.error.code}`);
    }
  }

  /** The scripted look-after-outcome beat — the player looks around the new scene after each completed
   *  action. Silent on `no-character` (the next menu.open reports it anyway); any other failure warns. */
  private async lookAfterOutcome(): Promise<void> {
    const look = await this.dispatch({ type: 'screen.look', playerId: this.userId });
    if (!look.ok && look.error.code !== 'no-character') {
      this.transcript.finding('warning', `look-after-outcome beat failed: ${look.error.code}`);
    }
  }

  /** The realism arm (`AGENT_BRAIN_CHOOSES_CHAR=1`): the brain authors the character through the wizard
   *  like a real user — non-deterministic and token-heavy, so live runs only. The walk is protocol-logged but records NO semantic turn, so the brain call is inlined here rather than routed through `ask()`. Throws on any protocol rejection or brain mispick: a config error, not a recoverable play state. */
  async createCharacterWithBrain(): Promise<void> {
    let response = await this.dispatch({ type: 'join.open', playerId: this.userId });
    if (!response.ok) throw new Error(response.error.message);
    let view = response.view;

    for (let steps = 0; steps < MAX_WIZARD_STEPS; steps++) {
      if (!view || view.screen !== 'wizard') {
        throw new Error(`brain-walk: expected a wizard screen, got ${view?.screen ?? 'none'}`);
      }
      // Inline brain call — no semantic turn recorded (wizard steps are not play turns); the character
      // snapshot is the all-zeros placeholder, since the wizard envelope carries no character facts.
      const { move } = await this.brain.chooseMove({
        screenText: viewToText(view),
        moves: wizardLegalMoves(view),
        character: WIZARD_PLACEHOLDER_CHAR,
      });

      if (view.step === 1) {
        // Step 1 is the free-text name (the Discord modal is NOT a protocol action).
        if (move.kind !== 'custom' || move.text.trim() === '') {
          throw new Error('brain-walk: step 1 requires a non-empty custom name');
        }
        response = await this.dispatch({ type: 'wizard.answer', playerId: this.userId, text: move.text });
      } else if (view.step === 8) {
        // Step 8 is the review screen: confirm creates, restart loops back to step 1 (the
        // step guard bounds the loop).
        if (move.kind !== 'menu-pick') {
          throw new Error('brain-walk: the confirm screen requires a menu-pick');
        }
        const button = view.buttons[move.index];
        if (!button) throw new Error(`brain-walk: no button at index ${move.index} on the confirm screen`);
        if (button.kind === 'confirm') {
          response = await this.dispatch({ type: 'character.create', playerId: this.userId });
          if (!response.ok) throw new Error(response.error.message);
          return;
        }
        if (button.kind === 'restart') {
          response = await this.dispatch({ type: 'wizard.restart', playerId: this.userId });
        } else {
          throw new Error(`brain-walk: unexpected ${button.kind} button on the confirm screen`);
        }
      } else {
        // Steps 2-7: one menu-pick per step, validated against the view's own buttons so the brain's index
        // is the view button position. The trailing restart button is on the legal-move list too, so a mid-walk restart pick loops back to step 1, which the step guard bounds.
        if (move.kind !== 'menu-pick') {
          throw new Error(`brain-walk: step ${view.step} requires a menu-pick`);
        }
        const button = view.buttons[move.index];
        if (!button) throw new Error(`brain-walk: no button at index ${move.index} on step ${view.step}`);
        if (button.kind === 'restart') {
          response = await this.dispatch({ type: 'wizard.restart', playerId: this.userId });
        } else if (button.kind === 'choice') {
          response = await this.dispatch({ type: 'wizard.choose', playerId: this.userId, step: view.step, value: button.value });
        } else {
          throw new Error(`brain-walk: step ${view.step} has an unexpected ${button.kind} button`);
        }
      }

      if (!response.ok) throw new Error(response.error.message);
      view = response.view;
    }
    throw new Error('brain-walk: wizard did not complete within the step guard');
  }

  /** The end-of-day bookend: `rest.begin` across the seam, the controller's guards replacing the harness's own rolls gate (a no-character or illegal-move envelope never aborts it), plus the nightly world tick
   *  through the observer. `rollsRemaining` MUST be read BEFORE the tick, which refills it; a thrown bookend call or an 'internal' rest envelope returns false so the caller stops rather than advance into a day that never ticked. */
  private async endDay(): Promise<boolean> {
    let step = 'nightly rest (read character)';
    try {
      const before = this.observer.getCharacter(this.userId);
      // QA label only — the controller's guards decide who actually rests.
      const rested = before?.rollsRemaining === 0;

      step = 'nightly rest (rest.begin)';
      const response = await this.dispatch({ type: 'rest.begin', playerId: this.userId });
      if (response.ok) {
        const restUnsafe = response.facts?.restUnsafe as
          | { name?: unknown; prev?: unknown; updated?: unknown }
          | undefined;
        if (restUnsafe) {
          this.transcript.finding(
            'warning',
            `unsafe rest: ${typeof restUnsafe.name === 'string' ? restUnsafe.name : 'unknown'} lost 1 HP resting away from the Oak`,
          );
        }
      } else if (response.error.code === 'no-character') {
        this.transcript.deadEnd('no-character');
      } else if (response.error.code === 'internal') {
        // The router never throws: a throwing beginRest/restAtOak becomes an ok:false 'internal' envelope,
        // and a rest-half crash means DB/state trouble the nightly tick would repeat, so stop here.
        this.transcript.finding('error', `nightly rest failed: ${response.error.message}`);
        return false;
      }
      // illegal-move (rolls unspent or mid-action) = idler — no finding, no abort.

      step = 'nightly tick';
      // The calendar moves BEFORE the tick, so the world tick that opens day N+1 runs on day N+1's
      // date — the rolls it refills are the coming day's (a Saturday tick grants Saturday's bonus roll), and the same ordering is what `replay.ts` reproduces one tick marker at a time.
      this.pinnedClock?.advanceDays(1);
      const tick = this.observer.tick(true);
      // The nightly-cron marker, recorded only when the tick succeeds — a throwing tick is caught
      // below and never logged as a marker.
      this.transcript.recordTick(tick.dayNumber);
      this.transcript.day(
        tick.dayNumber,
        rested ? 'nightly tick — rested at the Oak, world advanced' : 'nightly tick — idled with rolls unspent, world advanced',
      );
      this.checkInvariants('nightly tick');
      return true;
    } catch (e) {
      this.transcript.finding('error', `uncaught exception during ${step}`, formatError(e));
      return false;
    }
  }

  /** Advance the world `n` days with NO play dispatches — the player was away and the world moved on without them, so the absence of dispatches is the point. Each skipped day records its nightly tick MARKER, so a
   *  replay re-executes the skipped ticks at the same day numbers. The tick is admin (a non-admin one no-ops once `last_cron_date` matches today, so it could never skip a day) and goes through the observer rather than `src/sim/driver.ts`'s `advanceDays`, which is typed on `WorldEngineImpl`; without `pinnedClock` the world still ticks, the calendar just does not follow. */
  skipDays(n: number): void {
    for (let i = 0; i < n; i++) {
      this.pinnedClock?.advanceDays(1);
      const tick = this.observer.tick(true);
      this.transcript.recordTick(tick.dayNumber);
      this.transcript.day(tick.dayNumber, 'skipped — the world advanced with no play (an absence)');
      this.checkInvariants('skipped day tick');
    }
  }

  /** Cheap post-hoc invariant sweep after each outcome and each tick: assert the character's core numbers are sane and log any breach as an error finding. Read-only and non-fatal — a breach is a QA signal, not a
   *  reason to abort — and self-guarding, since a throwing `getCharacter` here must become a finding rather than an escaped exception that kills the run without a repro (it is called from outside `playOneAction`'s catch). */
  private checkInvariants(phase: string): void {
    let char: CharacterData | null;
    try {
      char = this.observer.getCharacter(this.userId);
    } catch (e) {
      this.transcript.finding('error', `invariant check could not read the character after ${phase}`, formatError(e));
      return;
    }
    if (!char) return;
    const breaches: string[] = [];
    if (char.health < 0) breaches.push(`health ${char.health} < 0`);
    if (char.health > char.maxHealth) breaches.push(`health ${char.health} > max ${char.maxHealth}`);
    if (char.stamina < 0) breaches.push(`stamina ${char.stamina} < 0`);
    if (char.stamina > char.maxStamina) breaches.push(`stamina ${char.stamina} > max ${char.maxStamina}`);
    if (char.wealth < 0) breaches.push(`wealth ${char.wealth} < 0`);
    if (char.rollsRemaining < 0) breaches.push(`rollsRemaining ${char.rollsRemaining} < 0`);
    for (const b of breaches) this.transcript.finding('error', `invariant breach after ${phase}: ${b}`);
  }

  /** Current game day (`day_number` meta, default 1) — read through the observer, the same
   *  source `tick` advances. */
  private currentDay(): number {
    return Number(this.observer.getMeta('day_number') ?? '1');
  }

  // ── Action loop — all through the protocol ──

  private async playMenu(view: MenuViewState, facts?: Record<string, unknown>): Promise<PlayResult> {
    const charView = this.charFromFacts(facts);
    if (!charView) return { kind: 'no-character' };

    // AGENT_FORCE_FREE_ACTIONS: while the day still owes a free action, offer the free-text slot ONLY — no day-job buttons (whose work outcomes are inspiration-stripped) and no `sleep`, which would end the day
    // short of taking one. The VIEW is filtered with the moves, so the screen's `[i]` numbering still addresses exactly the list offered, and a menu with no custom button falls back to the full list.
    const forced = this.freeActionPending ? freeActionLegalMoves(view) : [];
    const offer = forced.length > 0 ? freeActionMenuView(view) : view;
    const moves = forced.length > 0 ? forced : menuLegalMoves(view, this.reconUsage);
    const turn = await this.ask(offer, charView, moves);
    if (turn === null) return this.brainFailed();
    const move = turn.move;
    if (!isLegal(move, moves)) {
      this.transcript.finding('warning', `illegal move on menu screen: ${move.kind}`);
      this.logAttempt(this.illegalPickLabel(move), { kind: 'illegal-move', move });
      return { kind: 'illegal-move', move };
    }
    switch (move.kind) {
      case 'sleep':
        return { kind: 'slept' };
      case 'menu-pick': {
        const result = await this.doDayJob(move.index);
        this.logAttempt(this.attemptLabel(move, moves), result);
        return result;
      }
      case 'custom': {
        const result = await this.doCustom(move.text);
        // Only a COMPLETED free action discharges the day's debt: a dead-end or aborted attempt leaves it
        // standing, and so does a BAIL (the roll is refunded, nothing rolled), which would otherwise pass as the day's measured free action.
        if (result.kind === 'outcome' && !result.bailed) this.freeActionPending = false;
        this.logAttempt(this.attemptLabel(move, moves), result);
        return result;
      }
      case 'recon':
        return this.doRecon(move.screen);
      default:
        return { kind: 'illegal-move', move };
    }
  }

  /** Consult one of the six read-only screens the brain asked for: free, deterministic, no roll and no
   *  day advance, but a real TURN — the rendered screen is recorded and comes back as the next turn's `lastRecon`. The per-day caps bound how many a day can spend, so a recon result needs no stumble accounting. */
  private async doRecon(screen: ReconScreen): Promise<PlayResult> {
    const attempt = `recon: /${screen}`;
    this.reconUsage.perScreen[screen] = (this.reconUsage.perScreen[screen] ?? 0) + 1;
    this.reconUsage.total++;

    const response = await this.dispatch(this.reconEvent(screen));
    if (!response.ok) {
      // The attempt spent its cap whether or not the dispatch resolved, so the caps are checked here too:
      // a FAILED recon can be the one that hits a cap, and without the warning the next menu silently omits screens with nothing in the transcript to say why.
      this.logReconCaps();
      if (response.error.code === 'no-character') {
        this.dayLog.push({ attempt, result: 'refused: no-character', refused: true });
        return { kind: 'no-character' };
      }
      // A failed recon is a warning finding, matching the scripted beats' treatment (the same
      // envelope codes the day-start beats forgive), and a refused attempt in the day log.
      this.transcript.finding('warning', `recon /${screen} failed: ${response.error.code}`);
      this.logAttempt(attempt, { kind: 'dead-end', reason: response.error.code });
      return { kind: 'dead-end', reason: response.error.code };
    }

    const text = viewToText(response.view!);
    this.transcript.recon(screen, text);
    this.lastRecon = { screen, text };
    this.dayLog.push({ attempt, result: summarizeOutcome(text), refused: false });
    this.logReconCaps();
    return { kind: 'recon', screen };
  }

  /** The `screen.*` event for a recon screen. `map` carries no `focus`: a brain asks for the map, not
   *  for a place on it. */
  private reconEvent(screen: ReconScreen): GameEvent {
    switch (screen) {
      case 'look':
        return { type: 'screen.look', playerId: this.userId };
      case 'map':
        return { type: 'screen.map', playerId: this.userId };
      case 'stats':
        return { type: 'screen.stats', playerId: this.userId };
      case 'backpack':
        return { type: 'screen.backpack', playerId: this.userId };
      case 'journal':
        return { type: 'screen.journal', playerId: this.userId };
      case 'help':
        return { type: 'screen.help', playerId: this.userId };
    }
  }

  /** Announce a hit recon cap ONCE per day: `reconWithheld` lists every screen the caps now withhold, so
   *  a screen missing from the offer is visible in the transcript rather than looking like a screen the game forgot. */
  private logReconCaps(): void {
    if (this.reconCapLogged) return;
    const withheld = reconWithheld(this.reconUsage);
    if (withheld.length === 0) return;
    this.reconCapLogged = true;
    this.transcript.finding(
      'warning',
      `recon capped for the day: ${withheld.map((s) => `/${s}`).join(', ')} withheld`,
      `per-screen cap ${RECON_PER_SCREEN_CAP}, per-day cap ${RECON_PER_DAY_CAP}`,
    );
  }

  /** The day log's "what was attempted" label: a free action quotes its own text, a day job names the
   *  button it pressed, a recon names the screen it read. */
  private attemptLabel(move: AgentMove, moves: LegalMove[]): string {
    switch (move.kind) {
      case 'custom':
        return `free action: "${move.text}"`;
      case 'recon':
        return `recon: /${move.screen}`;
      case 'menu-pick': {
        const picked = moves.find((l) => l.move.kind === 'menu-pick' && l.move.index === move.index);
        return `day job: ${picked ? picked.label : move.index}`;
      }
      default:
        return move.kind;
    }
  }

  /** A refused pick, named as precisely as the move allows: an over-cap recon names the SCREEN it asked
   *  for, everything else its kind — `illegal pick: recon` alone cannot say which screen was withheld. */
  private illegalPickLabel(move: AgentMove): string {
    return move.kind === 'recon' ? `illegal pick: recon /${move.screen}` : `illegal pick: ${move.kind}`;
  }

  /** The decision pick named for the day log: the button's own label when the pick was one of the offered
   *  moves, and the move itself when it was not (an illegal pick, or a recon no decision screen offers). */
  private decisionLabel(move: AgentMove, moves: LegalMove[]): string {
    switch (move.kind) {
      case 'choice': {
        const picked = moves.find((l) => l.move.kind === 'choice' && l.move.index === move.index);
        return picked ? picked.label : `choice ${move.index}`;
      }
      case 'bail':
        return moves.find((l) => l.move.kind === 'bail')?.label ?? 'bail';
      case 'recon':
        return `recon /${move.screen}`;
      default:
        return move.kind;
    }
  }

  /** The decision loop's OWN day-log line: the enclosing attempt did not fail (its button was legal), a
   *  decision beat inside it did. `attemptLogged` stops the enclosing arm from adding a second, misleading line. */
  private logDecisionAttempt(attempt: string, result: PlayResult): void {
    this.logAttempt(attempt, result);
    this.attemptLogged = true;
  }

  /** One day-log line per attempted action: what was tried and what came back, refusals included — the
   *  context a blind brain was missing, without which a refused option comes back looking fresh. `recon` logs its own line, and a line the attempt already wrote itself is left alone, so an attempt never appears twice with two stories. */
  private logAttempt(attempt: string, result: PlayResult): void {
    if (this.attemptLogged) return;
    switch (result.kind) {
      case 'outcome':
        this.dayLog.push({ attempt, result: this.lastOutcomeLine ?? '', refused: false });
        break;
      case 'dead-end':
        this.dayLog.push({ attempt, result: `refused: ${result.reason}`, refused: true });
        break;
      case 'illegal-move':
        this.dayLog.push({ attempt, result: 'refused: illegal-move', refused: true });
        break;
      case 'decision-abandoned':
        this.dayLog.push({ attempt, result: 'refused: decision-abandoned', refused: true });
        break;
      default:
        break;
    }
  }

  private async doDayJob(idx: number): Promise<PlayResult> {
    // Beat capture: the onBeat callback records commute beats; loading/thinking beats are absorbed
    // silently as transport chrome for the player's wait.
    const response = await this.dispatch(
      { type: 'dayjob.start', playerId: this.userId, jobIndex: idx },
      (beat) => {
        if (beat.ok && beat.view?.screen === 'commute') {
          this.transcript.commute(beat.view.destination, viewToText(beat.view));
        }
      },
    );

    if (!response.ok) return this.mapError(response);

    const view = response.view!;
    switch (view.screen) {
      case 'outcome': {
        // Outcome: record the private (acting-player) view. The character snapshot is read fresh from
        // the engine on the next menu.open, so no extraction is needed here.
        this.recordOutcome(viewToText(view), response.facts);
        return { kind: 'outcome' };
      }
      case 'decision':
        return this.runDecisionLoop(view, response.facts);
      default:
        this.transcript.finding('error', `unexpected screen "${view.screen}" from dayjob.start`);
        return { kind: 'dead-end', reason: 'unexpected-screen' };
    }
  }

  private async doCustom(text: string): Promise<PlayResult> {
    const response = await this.dispatch({ type: 'action.custom', playerId: this.userId, text });

    if (!response.ok) return this.mapError(response);

    const view = response.view!;
    switch (view.screen) {
      case 'decision':
        return this.runDecisionLoop(view, response.facts);
      case 'outcome':
        this.recordOutcome(viewToText(view), response.facts);
        return { kind: 'outcome' };
      default:
        this.transcript.finding('error', `unexpected screen "${view.screen}" from action.custom`);
        return { kind: 'dead-end', reason: 'unexpected-screen' };
    }
  }

  /** Loop the decision beats until the action resolves, dispatching one `action.choose` per beat.
   *  A `session-expired` error from the router means the button no longer refers to a live decision. */
  private async runDecisionLoop(first: DecisionViewState, firstFacts?: Record<string, unknown>): Promise<PlayResult> {
    let current = first;
    let currentFacts = firstFacts;

    for (let beat = 0; beat < MAX_BEATS; beat++) {
      const charView = this.charFromFacts(currentFacts);
      if (!charView) return { kind: 'no-character' };

      const moves = decisionLegalMoves(current);
      const turn = await this.ask(current, charView, moves);
      if (turn === null) return this.brainFailed();
      const move = turn.move;
      if (!isLegal(move, moves)) {
        this.transcript.finding('warning', `illegal move on decision screen: ${move.kind}`);
        this.logDecisionAttempt(`decision pick: ${this.decisionLabel(move, moves)}`, { kind: 'illegal-move', move });
        return { kind: 'illegal-move', move };
      }

      const selector =
        move.kind === 'bail'
          ? { kind: 'bail' as const }
          : { kind: 'option' as const, index: (move as { kind: 'choice'; index: number }).index };

      // Thinking beats absorbed (transport chrome).
      const response = await this.dispatch(
        { type: 'action.choose', playerId: this.userId, selector },
      );

      if (!response.ok) {
        if (response.error.code === 'session-expired') {
          this.transcript.deadEnd('session-expired');
          this.logDecisionAttempt(`decision pick: ${this.decisionLabel(move, moves)}`, {
            kind: 'decision-abandoned',
          });
          return { kind: 'decision-abandoned' };
        }
        return this.mapError(response);
      }

      const view = response.view!;
      if (view.screen === 'outcome') {
        this.recordOutcome(viewToText(view), response.facts);
        // The bail button resolves the action (`outcome: 'bailed'`, roll refunded) — reported so the
        // menu arm does not read it as a completed free action.
        return move.kind === 'bail' ? { kind: 'outcome', bailed: true } : { kind: 'outcome' };
      }
      // Next decision screen — loop with its view and facts.
      current = view as DecisionViewState;
      currentFacts = response.facts;
    }
    this.transcript.finding('warning', `decision loop exceeded ${MAX_BEATS} beats`);
    this.logDecisionAttempt(`decision loop (${MAX_BEATS} beats)`, { kind: 'dead-end', reason: 'beat-cap' });
    return { kind: 'dead-end', reason: 'beat-cap' };
  }

  /** Build an `AgentCharView` from the envelope's `facts`. Null when the `characterState` fact is absent:
   *  a missing snapshot on a view-bearing response is an internal invariant breach, and the caller treats it as a fatal no-character. */
  private charFromFacts(facts?: Record<string, unknown>): AgentCharView | null {
    if (!facts) return null;
    const cs = facts.characterState as Record<string, unknown> | undefined;
    if (!cs) return null;
    const name = typeof facts.characterName === 'string' ? facts.characterName : 'Unknown';
    const cls = typeof facts.characterClass === 'string' ? facts.characterClass : 'Unknown';
    const nav = facts.nav as Record<string, unknown> | undefined;
    const rollsRemaining = nav && typeof nav.rollsRemaining === 'number' ? nav.rollsRemaining : 0;
    return {
      name,
      class: cls,
      health: typeof cs.health === 'number' ? cs.health : 0,
      maxHealth: typeof cs.maxHealth === 'number' ? cs.maxHealth : 0,
      stamina: typeof cs.stamina === 'number' ? cs.stamina : 0,
      maxStamina: typeof cs.maxStamina === 'number' ? cs.maxStamina : 0,
      rollsRemaining,
      wealth: typeof cs.wealth === 'number' ? cs.wealth : 0,
      location: typeof cs.location === 'string' ? cs.location : 'unknown',
    };
  }

  /** Render the screen, ask the brain, log the turn, and fold the reply back into working memory. ONE retry on a failed call: a reply the gateway cannot resolve (unparseable JSON, an absent or out-of-range `choice`,
   *  an empty free-text action) is a stochastic model slip rather than an infrastructure failure, and losing one turn to it is cheap next to a crash losing the rest of a run that cost roughly 750k tokens. A transport or HTTP failure gets the same single retry; each attempt records its own `llm_calls` row. Returns null when both fail, which callers treat as a non-fatal dead-end. */
  private async ask(
    view: ViewState,
    charView: AgentCharView,
    moves: LegalMove[],
  ): Promise<BrainTurn | null> {
    const text = viewToText(view);
    // The recon screen the brain asked for last turn is delivered for exactly ONE turn: it is cleared
    // here, and stays readable in the day log / on a re-request.
    const lastRecon = this.lastRecon;
    this.lastRecon = undefined;
    const dayLog = buildDayLog(this.dayLog);
    // The day's last turn is the one the day note has to ride: at zero rolls `menu.open` returns
    // `no-rolls` and the brain is never asked again. Spread in only when true, so any other turn renders exactly the message it rendered before.
    const lastRoll = charView.rollsRemaining === 1;
    // One TURN however many attempts answer it — the day-note and day-log accounting counts turns.
    this.todayTurns++;
    const input: ChooseMoveInput = {
      screenText: text,
      moves,
      character: charView,
      ...(this.recap !== undefined ? { recap: this.recap } : {}),
      ...(dayLog !== '' ? { dayLog } : {}),
      ...(this.intentNote !== undefined ? { intentNote: this.intentNote } : {}),
      ...(this.arcNote !== undefined ? { arcNote: this.arcNote } : {}),
      ...(lastRecon !== undefined ? { lastRecon } : {}),
      ...(lastRoll ? { lastRoll: true } : {}),
    };

    for (const attempt of [1, 2] as const) {
      try {
        const turn = await this.brain.chooseMove(input);
        this.transcript.turn(view.screen === 'decision' ? 'decision' : 'menu', text, moves, turn.move);
        this.absorbTurn(turn);
        return turn;
      } catch (e) {
        const detail = formatError(e);
        if (attempt === 2) {
          this.transcript.finding('error', 'brain call failed on both attempts; abandoning the turn', detail);
          return null;
        }
        this.transcript.finding('warning', 'brain call failed; re-asking once', detail);
      }
    }
    return null;
  }

  /** A turn the brain could not answer even after a retry. Non-fatal: the attempt is a stumble the day
   *  survives, and no day-log line is written because no move was attempted. */
  private brainFailed(): PlayResult {
    return { kind: 'dead-end', reason: 'brain-failed' };
  }

  /** Record a completed action: the transcript's outcome event plus the day's own first line, which the
   *  next day's recap carries. The envelope's `distilledType` (model-authored, open-vocabulary) becomes the outcome's `verb`, so the histogram reports what the model called the action rather than a guess. */
  private recordOutcome(text: string, facts?: Record<string, unknown>): void {
    const verb = typeof facts?.distilledType === 'string' ? facts.distilledType : undefined;
    this.transcript.outcome(text, verb);
    const line = summarizeOutcome(text);
    this.lastOutcomeLine = line;
    this.todayOutcomes.push(line);
  }

  /** Fold the brain's own notes back into harness state: intent and arc note persist across turns and
   *  days, a friction becomes its own transcript event against the day in progress (so the panel can rank it by projected exposure), and a note the gateway dropped is a warning finding rather than a stall. The day note is CAPTURED here only — it is written when the day closes, because the day is what it rates. */
  private absorbTurn(turn: BrainTurn): void {
    if (turn.intent !== undefined) this.intentNote = turn.intent;
    if (turn.arcNote !== undefined) this.arcNote = turn.arcNote;
    if (turn.dayNote !== undefined) this.todayDayNote = turn.dayNote;
    if (turn.friction !== undefined) {
      this.transcript.friction({
        dayNumber: this.currentDay(),
        what: turn.friction.what,
        severity: turn.friction.severity,
        recurrence: turn.friction.recurrence,
      });
    }
    for (const reason of turn.droppedNotes ?? []) {
      this.transcript.finding('warning', `dropped note: ${reason}`);
    }
  }
}

/** Wire a harness over a `GameRouter` + the world's observer surface. The engine satisfies the
 *  `AgentObserver` seam STRUCTURALLY — verified at the src-side call sites (e.g. `play.ts` passing `agentEngine.engine`) at typecheck time, not by an import. The action path goes through the router; the observer is the QA path (reads + the nightly cron), never play. */
export function createAgentHarness(
  observer: AgentObserver,
  router: GameRouter,
  brain: AgentPlayerGateway,
  userId: string,
  options?: AgentHarnessOptions,
): AgentHarness {
  return new AgentHarness(observer, router, brain, userId, options);
}
