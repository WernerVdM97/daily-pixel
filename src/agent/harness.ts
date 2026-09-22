/**
 * The agent-player harness (JSON-seam M6, see docs/engine/json-seam-protocol.md § "M6 build
 * plan"). Speaks only `GameEvent`/`GameResponse` through `GameRouter` for the mid-day loop —
 * a true protocol client, exactly what a player sees. No controller imports remain in the
 * action path; `viewToText` reads envelope views; the brain's character snapshot comes from
 * the `characterState` fact (DC-M6.1).
 *
 * Bookends: the nightly rest half of `endDay` crosses the seam as `rest.begin` (M7.1);
 * character creation crossed as the wizard events at M7.3 and, at M8.5 (DC-S7), the walk
 * moved INTO the harness as `createCharacter` (dispatching through the recorded `dispatch`
 * so the creation walk lands in the protocol log — replay re-seeding depends on it).
 *
 * Engine access runs through the `AgentObserver` seam alone (DC-S4, M8.5): the QA-OBSERVER
 * path (invariant checks, the day-line label, the nightly world cron) — never the play
 * path. The observer is imported from './observer.js'; the harness imports zero WorldEngine
 * types and performs zero engine-direct reads.
 *
 * The brain's WORKING MEMORY (spec § B, `docs/engine/agent-player-personas.md`) lives here
 * because it is the play loop's own state: the recap block (yesterday's lines + how the day
 * ended), today's day log (attempts, refusals and dead-ends included), the brain's intent and arc
 * notes, the day note it reported (written when the day closes, spec § E), and the recon screen it
 * asked to read last turn. `turnContext.ts` shapes those blocks as pure functions; this file owns
 * the cells and composes them into every `ChooseMoveInput`.
 */

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

/** Safety valve on the decision loop — the pipeline beat cap is 2, so any run past this many
 *  beats in one action is a machine anomaly (logged as a finding), never normal play. Keeps a QA
 *  run from hanging on a pathological non-terminating machine. */
const MAX_BEATS = 10;

/** A day ends after this many CONSECUTIVE non-outcome actions (dead-end/illegal/abandoned) — a
 *  brain looping on a screen it can't get past. Reset by any completed action, so a productive day
 *  never trips it. Below the roll allowance would be too eager; a handful of stumbles is normal. */
const STUCK_LIMIT = 5;

/** Absolute cap on actions attempted in one day — a backstop against a brain that keeps producing
 *  outcomes without ever depleting rolls or choosing sleep (would otherwise spin to the roll refill
 *  boundary and beyond). Far above a real day (3 rolls), so only a machine anomaly hits it. */
const MAX_ACTIONS_PER_DAY = 50;

/** DC-S3's brain-driven wizard walk step guard: a sane wizard is 8 dispatches (join.open +
 *  name + 6 choices + confirm). 16 bounds the pathological restart-loop (a brain that keeps
 *  picking the restart button on the confirm screen) so the realism arm can't hang a live run. */
const MAX_WIZARD_STEPS = 16;

/** The brain's character snapshot on the wizard walk (DC-S3): the wizard envelope carries NO
 *  character facts — the walk's user has no character (DC-M6.1's null-char rule) — so the
 *  realism arm hands the brain an all-zeros placeholder rather than inventing one. */
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

/** The disposition of a single `playOneAction` — loop control for M4.3 and a QA signal. `slept`
 *  and `no-rolls` end the day; `dead-end`/`illegal-move` are non-fatal (the action attempt failed
 *  but the day can continue); `outcome` is a completed action; `recon` is a read of one of the six
 *  read-only screens (spec § C) — free, no roll, no day advance, and bounded by the per-day caps
 *  rather than by the roll allowance; `crashed` is an uncaught exception captured as a finding
 *  (M4.4) — fatal to the run, but the transcript survives as a repro. */
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
  /** Record the router's interstitial beats into the protocol log's dispatch entries (DC-S1's
   *  knob, default off — beats are advisory transport chrome, the final envelope is the contract).
   *  The caller opts in; `play.ts` maps the AGENT_PROTOCOL_BEATS=1 env to this in task 2 (the
   *  library stays env-free). */
  recordBeats?: boolean;
  /** The brain class, for the protocol-log header (replay's interpretation hint). */
  brain?: 'scripted' | 'prod';
  /** The backend class the router was wired to, for the protocol-log header (replay's backend
   *  selector, DC-S2). */
  backend?: 'real' | 'stub';
  /** ISO-8601 wall clock stamped into the protocol-log header (DC-M10.6); replay pins the
   *  process clock to it. Defaults to now. A deterministic recording must pass a fixed value,
   *  or the header alone makes the transcript differ byte-wise on every run — the corpus
   *  regen command and the transcript smoke test both supply one. */
  recordedAt?: string;
  /** `AGENT_FORCE_FREE_ACTIONS` (RA-2 measurement aid). When true, each day's first menu offers
   *  the free-text slot ONLY until the day holds one completed non-work action, so the brain must
   *  take a free action before it can pick day-job work. Why: day-job work is `kind: 'work'`, whose
   *  positive roll grants `stripWorkInspiration` removes by design, so a run without this switch
   *  cannot observe the inspiration dial at all (see issue #95: the unverified ~10% RA-2 target).
   *  Off by default —
   *  the menu the brain sees is then exactly `menuLegalMoves`, byte-identical to before this
   *  option existed. */
  forceFreeActions?: boolean;
  /** The persona the run played as (spec § A/§ H), stamped into the protocol-log header so a
   *  recorded run is attributable in replay. Absent = the pre-persona header shape, which is what
   *  keeps every recording made before personas existed byte-identical. Read from `AGENT_PERSONA`
   *  in `play.ts`, so the library stays env-free (DC-S1). */
  persona?: string;
  /** The run's pinned clock, when the caller pinned one (spec § G "the time axis", contract §10).
   *  The harness advances it one day immediately before each nightly tick, so the tick that opens
   *  day N+1 sees day N+1's calendar date: the tick refills the COMING day's rolls, so the Saturday
   *  bonus belongs to the coming day, not the one that just ended. Absent = nothing changes at all
   *  (the pre-clock behaviour, which is what keeps every stub/replay corpus entry byte-identical).
   *  Prefer `pinAdvancingClock(...)` in the caller — the harness deliberately knows nothing about
   *  how the clock is implemented, only that it can step. */
  pinnedClock?: { advanceDays(n: number): void };
}

/** The disposition of a single game day — the QA/loop signal `playDays` reads. `slept`/`no-rolls`
 *  are clean day ends; `stalled` means the brain got stuck (STUCK_LIMIT or the action cap, both
 *  logged as findings); `no-character` is fatal (the character vanished — `playDays` stops). */
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
    // The protocol-log header (DC-S1): written once at construction so every dispatch entry that
    // follows has the session identity (brain class + backend class) to interpret it against.
    // `persona` is spread onto the entry only when set (see `protocolHeader`).
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

  /** Whether the current day still owes its forced free action. Seeded at construction (so a
   *  caller driving `playOneAction` directly gets one too) and reset per day in `beginDay`; always
   *  false when `forceFreeActions` is off. */
  private freeActionPending: boolean;

  // ── The brain's working memory (spec § B) — the context a player carries between turns. ──

  /** The brain's own running intent line, rewritten whenever a turn carries `intent`. Survives
   *  days: consistency across a run is exactly what the stateless brain could not do. */
  private intentNote?: string;

  /** The brain's own arc line — what it is building. Rewritten by a turn's `arcNote`, and last by
   *  the day note's `arcNote` when the day closes. */
  private arcNote?: string;

  /** Today's attempts, refusals included — the block that tells a brain an option was rejected
   *  instead of letting it pick it again. Reset per day. */
  private dayLog: DayLogEntry[] = [];

  /** Today's completed-action lines (first line of each outcome), promoted to `yesterdayOutcomes`
   *  when the day closes. */
  private todayOutcomes: string[] = [];

  /** Yesterday's completed-action lines, in order — the recap block's body. */
  private yesterdayOutcomes: string[] = [];

  /** The disposition the last closed day ended on (`slept`/`no-rolls`/`stalled`/`crashed`).
   *  Absent until a day has closed, which is what makes the recap absent on day one. */
  private yesterdayEnded?: string;

  /** The game day the player last actually PLAYED, as `closeDay` numbers it. Kept separately from
   *  `currentDay() - 1` because `skipDays` moves the world with no play: without this the day-start
   *  recap would call a day the player never played "yesterday", and the gap that the interrupted
   *  panel exists to measure would be invisible to the brain. */
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

  /** The recon screen the brain asked for on the PREVIOUS turn, delivered to exactly the next
   *  turn's `ChooseMoveInput.lastRecon` and then cleared (it stays readable in the day log, and
   *  again in full if the brain re-requests it). */
  private lastRecon?: { screen: ReconScreen; text: string };

  /** The day's note (spec § E), kept as the brain reports it: the LAST one seen in the day is the
   *  one that counts. Written when the day closes, whatever closed it — a day that spends its last
   *  roll is never asked another question (`menu.open` returns `no-rolls` at zero rolls), so a
   *  sleep-only write would lose the rating pair on the commonest day end of all. */
  private todayDayNote?: DayNote;

  /** How many questions the brain was asked today (wizard steps are not play turns). A day that
   *  closes with no note is only a hole in the series if the brain was actually given the chance. */
  private todayTurns = 0;

  /** Whether the action attempt in progress has already written its own day-log line. The
   *  decision loop logs its own failures (an illegal pick inside it is not the day job's refusal),
   *  so the enclosing menu branch must not append a second, misleading line. */
  private attemptLogged = false;

  /** DC-S1's single recording point — every dispatch in the harness flows through here so the
   *  protocol log gets exactly one `{ seq, event, response, beats? }` entry per dispatch, at one
   *  place in the code. Collects the router's interstitial beats when `recordBeats` is on, and
   *  ALWAYS delegates `onBeat` through to the router (doDayJob's commute capture must keep
   *  working regardless of the knob). Purely additive — the returned envelope is exactly what
   *  `router.dispatch` returned; only the log grows. */
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

  /** M8.5 (DC-S7) — the FRESH spawn bootstrap: drives the join wizard through the seam exactly
   *  as a player would (the walk that lived in `src/agent/seedCharacter.ts` until M8.5, absorbed
   *  into the harness), dispatching through the harness's recorded `dispatch` so the creation walk
   *  lands in the protocol log (stage 7's replay re-seeding depends on it). Walk: `join.open` →
   *  `wizard.answer` (the free-text name) → `wizard.choose` × steps 2–7
   *  (class/upbringing/race/alignment/dayJob + the mandatory starting kit) → `character.create`.
   *  `itemSetName` is required (the wizard's step 7 has no skip — a kit-less seed is impossible
   *  through the protocol). Any `ok:false` throws with the envelope's message (the router never
   *  throws — a rejection here is a real protocol failure the run should surface). */
  async createCharacter(data: CharCreateData): Promise<void> {
    let response = await this.dispatch({ type: 'join.open', playerId: this.userId });
    if (!response.ok) throw new Error(response.error.message);

    response = await this.dispatch({ type: 'wizard.answer', playerId: this.userId, text: data.name });
    if (!response.ok) throw new Error(response.error.message);

    // Steps 2-6: class, upbringing, race, alignment, dayJob. The persisted keys are the def
    // names — except alignment, which the wizard persists lowercase ("lawful good"), so the
    // caller's fixture must carry the lowercase value (the controller validates against the
    // defs, so a title-case fixture would now be rejected).
    for (const [step, value] of [[2, data.class], [3, data.upbringing], [4, data.race], [5, data.alignment], [6, data.dayJob]] as const) {
      response = await this.dispatch({ type: 'wizard.choose', playerId: this.userId, step, value });
      if (!response.ok) throw new Error(response.error.message);
    }

    // Step 7 (Starting Kit) is MANDATORY in the wizard — the walk can only reach the step-8
    // confirm screen by choosing a kit, so a kit-less seed is impossible through the protocol
    // (old createCharacter had no such constraint). Fail loudly up front rather than stall at
    // step 7 and surface the confusing "isn't ready to confirm" envelope at character.create.
    if (!data.itemSetName) {
      throw new Error('seed: itemSetName is required — the wizard has no kit-less creation path (step 7 is mandatory)');
    }

    response = await this.dispatch({ type: 'wizard.choose', playerId: this.userId, step: 7, value: data.itemSetName });
    if (!response.ok) throw new Error(response.error.message);

    response = await this.dispatch({ type: 'character.create', playerId: this.userId });
    if (!response.ok) throw new Error(response.error.message);
  }

  /** Drive one action from the action menu to a terminal disposition. The router never throws
   *  (every path through `dispatch` returns a `GameResponse` envelope), so the outer try/catch
   *  only catches rendering errors in `ask()` and the error envelope → PlayResult mapping —
   *  the action path itself is throw-safe by construction. */
  async playOneAction(): Promise<PlayResult> {
    this.attemptLogged = false;
    try {
      const result = await this.runAction();
      // DC-S3: the look-after-outcome parity beat — the player looks around the new scene
      // after each completed action (scripted + deterministic, never a brain pick).
      if (result.kind === 'outcome') await this.lookAfterOutcome();
      return result;
    } catch (e) {
      this.transcript.finding('error', `uncaught exception during action loop`, formatError(e));
      return { kind: 'crashed', phase: 'action', error: formatError(e) };
    }
  }

  private async runAction(): Promise<PlayResult> {
    // menu.open: stampLastPlayed + the full menu/resume branch, inside the router (DC-P6).
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
        // DC-M9.3: the roll was refunded and nothing happened — a stumble in playDay's
        // accounting, not a completed action.
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

  /** Play one game day: drive actions until the day ends. A completed action loops back to the
   *  menu; `slept`/`no-rolls` end the day cleanly; a fatal `no-character` stops immediately;
   *  everything else (dead-end/illegal/abandoned) is a non-fatal stumble — a run of STUCK_LIMIT
   *  consecutive stumbles (or the action cap) ends the day as `stalled` with a logged finding.
   *  A `recon` result neither increments nor resets that run: a recon turn is not progress and not
   *  a stumble, and the per-day caps already bound how many a day can spend (so it cannot loop),
   *  which is what keeps a day of recon after a refusal able to trip STUCK_LIMIT. */
  async playDay(): Promise<DaySummary> {
    const dayNumber = this.currentDay();
    this.beginDay();
    // DC-S3: the scripted day-start parity beats — the greeting + the stats screen, once per
    // day, before the action loop (the brain never picks chrome; parity argues for scripted
    // beats). Both protocol-logged, both NO-STAMP pure reads (hi.open/stats carry no stamp).
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

  /** Open a day (spec § B): reset everything the day owns — the forced-free-action debt, the recon
   *  budget, the day log, the day's note and turn count, and the one-turn recon delivery — and
   *  compose the day-start recap from the day that just closed (absent on the first day, when no
   *  day has closed yet). */
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

  /** Close a day: write the day's note (spec § E) — it is day-level, not sleep-level, so it is
   *  written HERE, when the day closes, whatever closed it — then hand its completed-action lines,
   *  its disposition and its own day number (the recap's `lastPlayedDay`) to the recap cells (the
   *  next day's day-start block), and start today's lines over. */
  private closeDay(dayNumber: number, outcomes: number, ended: DaySummary['ended']): DaySummary {
    if (this.todayDayNote !== undefined) {
      // The closing day's number, whatever the disposition: `slept`, `no-rolls`, `stalled` and
      // `crashed` all end a day the brain rated.
      this.transcript.dayNote({ dayNumber, ...this.todayDayNote });
      // Last, so the end-of-day statement of what the brain is building wins over whatever the
      // day's own turns said.
      this.arcNote = this.todayDayNote.arcNote;
    } else if (this.todayTurns > 0) {
      // A hole in the engagement/fulfilment series must never be silent. A day that asked the
      // brain nothing (a fatal no-character on the first call) had no chance to give one, so that
      // is not a warning.
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

  /** Play up to `days` game days, bookending each with the nightly rest (through the seam as
   *  `rest.begin`, M7.1) + the nightly world tick through the observer (the cron mechanism
   *  stays engine-owned).
   *  The run stops early on `no-character` (fatal — nothing left to play) OR `stalled` (the brain
   *  wedged): a stalled day leaves whatever pending action wedged it untouched, and pressing on
   *  would just replay the identical frozen state every remaining day (burning a real LLM run with
   *  no progress and no fresh signal). Stopping keeps the stall a single, clear finding.
   *  The auto-expiry reasoning that used to sit on that sentence was wrong under the pinned clock:
   *  `Date.now()` is not real wall-clock any more, it steps a day at every nightly tick, so a
   *  pending action that survives a day boundary DOES read as stale and `resolveStaleTimeout`
   *  (WorldEngineImpl.ts — its audit note names this the sharpest site on the live path) resolves it
   *  as a server-side timeout rather than leaving the frozen state intact. What keeps that off THIS
   *  path is the early stop, not the clock: a day that ends non-clean breaks the loop below before
   *  `endDay` (the thing that advances the clock), so no next day exists in which the expiry could
   *  fire, and the old claim is vacuously true here rather than generally true. Do not reuse it
   *  elsewhere.
   *  Returns one summary per day actually played, in order. */
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

  /** DC-S3's scripted day-start beats: the `hi.open` greeting (recorded as the semantic
   *  `greeting` event — the transcript's day-start chrome the critic sees) + the `screen.stats`
   *  beat. Both dispatched through the seam; both silent on `no-character` (the day ends
   *  no-character at the first menu.open anyway — a finding there would be noise). Anything
   *  else going wrong IS a finding: the beats are part of the player's reachable surface. */
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

  /** DC-S3's scripted look-after-outcome beat — the player looks around the new scene after
   *  each completed action. Silent on `no-character` (the next menu.open reports it anyway);
   *  any other failure is a warning finding. */
  private async lookAfterOutcome(): Promise<void> {
    const look = await this.dispatch({ type: 'screen.look', playerId: this.userId });
    if (!look.ok && look.error.code !== 'no-character') {
      this.transcript.finding('warning', `look-after-outcome beat failed: ${look.error.code}`);
    }
  }

  /** DC-S3's realism arm (`AGENT_BRAIN_CHOOSES_CHAR=1`): the brain authors the character
   *  through the wizard like a real user — the free-text name (step 1) + one pick per step
   *  2-7 + the step-8 confirm. Non-deterministic + token-heavy, live runs only; the standard
   *  fleet keeps the deterministic scripted `createCharacter`. The walk is protocol-logged
   *  but records NO semantic turn: the wizard steps are not play turns (the critic reviews
   *  play, not creation), so the brain call is inlined here rather than routed through
   *  `ask()`'s transcript.turn.
   *  Throws on any protocol rejection or brain mispick (a live-run config error, not a
   *  recoverable play state). */
  async createCharacterWithBrain(): Promise<void> {
    let response = await this.dispatch({ type: 'join.open', playerId: this.userId });
    if (!response.ok) throw new Error(response.error.message);
    let view = response.view;

    for (let steps = 0; steps < MAX_WIZARD_STEPS; steps++) {
      if (!view || view.screen !== 'wizard') {
        throw new Error(`brain-walk: expected a wizard screen, got ${view?.screen ?? 'none'}`);
      }
      // Inline brain call — no semantic turn recorded (wizard steps are not play turns).
      // The character snapshot is the all-zeros placeholder (the wizard envelope carries no
      // character facts — DC-M6.1's null-char rule).
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
        // Steps 2-7: one menu-pick per step, validated against the view's own buttons so the
        // brain's index is the view button position (the play-loop convention). The trailing
        // restart button is on the legal-move list too (wizardLegalMoves maps ALL buttons
        // positionally), so a mid-walk restart pick loops back to step 1 — the step guard
        // bounds the loop.
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

  /** M7.1 (DC-M7.1.6) end-of-day bookend: the rest half dispatches `rest.begin` through the
   *  router — the controller's guards (no-character → mid-action → rolls-remaining) replace the
   *  harness's own rolls gate, so a character with rolls unspent or a pending action is an idler
   *  (an `illegal-move` envelope, non-aborting) rather than being teleported home. The unsafe-rest
   *  −1 HP now surfaces for the first time as a `warning` finding from the `restUnsafe` fact (closes
   *  M4.5 fidelity caveat 2). The nightly world tick goes through the observer (the QA-OBSERVER
   *  path — the cron advances the world for everyone, so an idler still takes its unsafe-ground
   *  stamina drain). The day-line
   *  label still reads `before.rollsRemaining` (a QA label, not a rule). No-character and
   *  illegal-move error envelopes never abort; a THROWN bookend call or an 'internal' rest
   *  envelope (the router converting a thrown beginRest/restAtOak) stops the run. `rollsRemaining`
   *  MUST be read before the tick (which refills it). Returns false if a bookend call throws or
   *  the rest half returns 'internal' (both captured as a finding naming the step) so the caller
   *  stops rather than advancing into a day that never ticked. */
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
        // The router never throws: a throwing beginRest/restAtOak becomes an ok:false 'internal'
        // envelope. A rest-half crash means DB/state trouble the nightly tick would likely repeat,
        // so capture it as an error finding and stop — the pre-M7.1 restAtOak throw contract.
        this.transcript.finding('error', `nightly rest failed: ${response.error.message}`);
        return false;
      }
      // illegal-move (rolls unspent or mid-action) = idler — no finding, no abort.

      step = 'nightly tick';
      // The calendar moves BEFORE the tick, so the world tick that opens day N+1 runs on day N+1's
      // date — the rolls it refills are the coming day's (a Saturday tick grants Saturday's bonus
      // roll), and the same ordering is what `replay.ts` reproduces one tick marker at a time.
      this.pinnedClock?.advanceDays(1);
      const tick = this.observer.tick(true);
      // DC-S1: the nightly-cron marker — recorded only when the tick succeeds (matching the
      // existing flow; a throwing tick is caught below and never logged as a marker).
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

  /** The interruption (spec § G "Interrupted panel", contract §10): advance the world `n` days
   *  with NO play dispatches — the player was away, and the world moved on without them. Reuses
   *  the two pieces `src/sim/driver.ts` already establishes between days: the daily admin-style
   *  tick (`advanceDays`, `src/sim/time.ts` — a non-admin `tick(false)` no-ops once
   *  `last_cron_date` matches today, so it could never skip a day) and one calendar day of clock
   *  movement per tick. The harness drives the tick through the observer seam rather than calling
   *  `advanceDays` itself: that helper is typed on `WorldEngineImpl`, and importing it here would
   *  put an engine type on the harness's QA-OBSERVER seam (DC-S4). Same mechanism, one seam.
   *
   *  Each skipped day records its nightly tick MARKER (so a replayed recording re-executes the
   *  skipped ticks and keeps day-number-seeded RNG aligned) and a `day` line naming the skip — a
   *  run whose world advanced must say so in its own transcript. No dispatch is recorded, which is
   *  the whole point: the absence is an absence of play. Calling this without `pinnedClock` still
   *  ticks the world; the calendar just will not follow. */
  skipDays(n: number): void {
    for (let i = 0; i < n; i++) {
      this.pinnedClock?.advanceDays(1);
      const tick = this.observer.tick(true);
      this.transcript.recordTick(tick.dayNumber);
      this.transcript.day(tick.dayNumber, 'skipped — the world advanced with no play (an absence)');
      this.checkInvariants('skipped day tick');
    }
  }

  /** Cheap post-hoc invariant sweep (M4.4). The engine clamps most state, but a bad mutation or a
   *  roll double-spend could slip a value out of band — so after each outcome and each tick, assert
   *  the character's core numbers are sane and log any breach as an `error` finding. Read-only and
   *  non-fatal: a breach is a QA signal to surface, not a reason to abort (the run keeps hunting).
   *  Self-guarding — called from `playDay` OUTSIDE `playOneAction`'s catch, so a throwing
   *  `getCharacter` here must become a finding, never an escaped exception that kills the run
   *  without a repro (goal a). */
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

    // AGENT_FORCE_FREE_ACTIONS: while the day still owes a free action, offer the free-text slot
    // ONLY — no day-job buttons (work outcomes are inspiration-stripped) and no `sleep` (which
    // would end the day short of taking one). The VIEW the brain reads is filtered along with the
    // moves, so the screen's `[i]` numbering still addresses exactly the MOVES list offered. A menu
    // with no custom button falls back to the full list: zero moves would make the brain throw,
    // not take a free action.
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
        // Only a COMPLETED free action discharges the day's debt: a dead-end or aborted attempt
        // leaves it standing, so the next menu offers the free slot again while the run still has
        // day left. A BAIL resolves the action too (the roll is refunded, nothing rolled), so it
        // leaves the debt standing as well — otherwise a bailed pick would pass as the day's
        // measured free action. A stalled day then reports the stall rather than silently playing
        // work-only.
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

  /** Consult one of the six read-only screens the brain asked for (spec § C): free, deterministic,
   *  no roll and no day advance — but a real TURN, so the rendered screen is recorded and comes back
   *  as the next turn's `lastRecon`. The per-day caps bound how many a day can spend, so a recon
   *  result needs no stumble accounting of its own. */
  private async doRecon(screen: ReconScreen): Promise<PlayResult> {
    const attempt = `recon: /${screen}`;
    this.reconUsage.perScreen[screen] = (this.reconUsage.perScreen[screen] ?? 0) + 1;
    this.reconUsage.total++;

    const response = await this.dispatch(this.reconEvent(screen));
    if (!response.ok) {
      // The attempt spent its cap whether or not the dispatch resolved, so the caps are checked on
      // this path too: a FAILED recon can be the one that hits a cap, and without the warning the
      // next menu silently omits screens with nothing in the transcript to say why.
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

  /** The `screen.*` event for a recon screen (DC-M8.1's flat read-only vocabulary). `map` carries
   *  no `focus`: a brain asks for the map, not for a place on it. */
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

  /** Announce a hit recon cap ONCE per day: `reconWithheld` lists every screen the caps are now
   *  withholding, so a screen missing from the offer is visible in the transcript instead of
   *  looking like a screen the game forgot to offer. */
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

  /** The day log's "what was attempted" label (spec § B): a free action quotes its own text, a day
   *  job names the button it pressed, a recon names the screen it read. */
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

  /** A refused pick, named as precisely as the move allows: an over-cap recon names the SCREEN it
   *  asked for, everything else names its kind. `illegal pick: recon` alone left the transcript
   *  unable to say which screen the caps had withheld. */
  private illegalPickLabel(move: AgentMove): string {
    return move.kind === 'recon' ? `illegal pick: recon /${move.screen}` : `illegal pick: ${move.kind}`;
  }

  /** The decision pick named for the day log: the button's own label when the pick was one of the
   *  offered moves, and the move itself when it was not (an illegal pick, or a recon no decision
   *  screen offers). */
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

  /** The decision loop's OWN day-log line: the enclosing day-job/free-action attempt did not fail
   *  (its button was legal), a decision beat inside it did. Recording that against the day job told
   *  the brain a legal button was refused; `attemptLogged` stops the enclosing arm from adding a
   *  second, misleading line for the same attempt. */
  private logDecisionAttempt(attempt: string, result: PlayResult): void {
    this.logAttempt(attempt, result);
    this.attemptLogged = true;
  }

  /** One day-log line per attempted action: what was tried and what came back, refusals included.
   *  This is the context the blind brain was missing — with it, a refused option cannot come back
   *  looking like a fresh one. `recon` logs its own line; the day-ending dispositions have nothing
   *  to hand back. A line the attempt already wrote itself (see `logDecisionAttempt`) is left
   *  alone, so an attempt never appears twice with two different stories. */
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
    // Beat capture: the onBeat callback records commute beats into the transcript (DC-M6.3).
    // Loading/thinking beats are absorbed silently — they're transport chrome for the player's wait.
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
        // Outcome: record the private (acting-player) view. The character snapshot is
        // read fresh from the engine on the next menu.open, so no char extraction needed here.
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

  /** Loop the decision beats until the action resolves. Each beat dispatches an `action.choose`
   *  event — the router handles beginChoice/resolveChoice/stepChoice internally. A `session-expired`
   *  error from the router means the button no longer refers to a live decision (already resolved). */
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

      // Thinking beats absorbed (transport chrome, DC-M6.3).
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
        // The bail button resolves the action (`outcome: 'bailed'`, roll refunded) — reported so
        // the menu arm does not read it as a completed free action (RA-2).
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

  /** Build an `AgentCharView` from the envelope's `facts` (DC-M6.1). Returns null when the
   *  `characterState` fact is absent or malformed — a missing snapshot on a view-bearing
   *  response is an internal invariant breach; the caller treats it as a fatal no-character. */
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

  /** Render the screen, ask the brain, and log the turn. The character snapshot comes from
   *  `charView` (already extracted from the envelope facts by the caller), not from a direct
   *  engine read — the agent never reads the engine in the action path. The working-memory blocks
   *  (spec § B) are composed from harness state here, at the one place every turn passes through.
   *
   *  ONE retry on a failed call, which is the re-prompt the seam's own contract always said lived
   *  here. A reply the gateway cannot resolve (unparseable JSON, an absent or out-of-range `choice`,
   *  an empty free-text action) is a stochastic model slip, not an infrastructure failure: losing
   *  one turn to it is cheap, but letting it reach `playOneAction` as a crash loses the rest of the
   *  run, and a five-day arc panel costs roughly 750k tokens. A transport or HTTP failure gets the
   *  same single retry, which is also the cheapest correct answer to a provider timeout. Each
   *  attempt records its own `llm_calls` row through the gateway, so both stay auditable.
   *
   *  Returns null when both attempts fail. Callers treat that as a non-fatal dead-end, so a
   *  transient slip costs one turn while a persistent fault still trips the stuck counter and ends
   *  the day rather than killing the run outright. */
  private async ask(
    view: ViewState,
    charView: AgentCharView,
    moves: LegalMove[],
  ): Promise<BrainTurn | null> {
    const text = viewToText(view);
    // The recon screen the brain asked for last turn is delivered for exactly ONE turn: it is
    // cleared here, and stays readable in the day log / on a re-request.
    const lastRecon = this.lastRecon;
    this.lastRecon = undefined;
    const dayLog = buildDayLog(this.dayLog);
    // The day's last turn is the one the day note has to ride: at zero rolls `menu.open` returns
    // `no-rolls` and the brain is never asked another question. Spread in only when true, so a
    // turn that is not the day's last renders exactly the message it rendered before.
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

  /** A turn the brain could not answer even after a retry. Non-fatal on purpose: the attempt is a
   *  stumble the day survives, and a persistent fault trips STUCK_LIMIT instead of voiding a
   *  multi-day run. No day-log line — the day log records moves that were attempted, and none was. */
  private brainFailed(): PlayResult {
    return { kind: 'dead-end', reason: 'brain-failed' };
  }

  /** Record a completed action: the transcript's outcome event plus the day's own line (its first
   *  line), which is what the next day's recap block carries. The outcome envelope's facts carry the
   *  action model's own label for the action (`distilledType`, model-authored and open-vocabulary),
   *  recorded as the outcome's `verb` so the histogram reports what the model called it rather than a
   *  guess from free text (spec § A, contract §9). */
  private recordOutcome(text: string, facts?: Record<string, unknown>): void {
    const verb = typeof facts?.distilledType === 'string' ? facts.distilledType : undefined;
    this.transcript.outcome(text, verb);
    const line = summarizeOutcome(text);
    this.lastOutcomeLine = line;
    this.todayOutcomes.push(line);
  }

  /** Fold the brain's own notes back into harness state (spec § B): the running intent and the arc
   *  note persist across turns AND days; a friction is recorded as its own transcript event against
   *  the day in progress (so the panel can rank it by projected exposure, spec § E); a note the
   *  gateway had to drop is a warning finding, never a stall (a lost data point must be visible, but
   *  must not kill a run that has spent tokens). The day note is only CAPTURED here — it is written
   *  when the day closes (see `closeDay`), because the day, not the turn, is what it rates. */
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

/** Wire a harness over a `GameRouter` + the world's observer surface (DC-S4, M8.5). The
 *  first parameter is the `AgentObserver` seam: the engine satisfies it STRUCTURALLY
 *  (WorldEngineImpl → AgentObserver — verified at the src-side call sites, e.g. play.ts
 *  passing `agentEngine.engine`, at typecheck time). The action path goes through the
 *  router; the observer is the QA-OBSERVER path (reads + the nightly cron), never play.
 *  No controller imports — the harness is a pure protocol client (M6 gate). */
export function createAgentHarness(
  observer: AgentObserver,
  router: GameRouter,
  brain: AgentPlayerGateway,
  userId: string,
  options?: AgentHarnessOptions,
): AgentHarness {
  return new AgentHarness(observer, router, brain, userId, options);
}
