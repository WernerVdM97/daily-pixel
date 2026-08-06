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
 */

import type { AgentObserver, CharacterData, CharCreateData } from './observer.js';
import type { MenuViewState, DecisionViewState, ViewState } from '../view/viewState.js';
import type { AgentPlayerGateway, AgentMove, LegalMove, AgentCharView } from './AgentPlayerGateway.js';
import { viewToText } from './viewToText.js';
import { menuLegalMoves, decisionLegalMoves, wizardLegalMoves, isLegal } from './agentMoves.js';
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
 *  but the day can continue); `outcome` is a completed action; `crashed` is an uncaught exception
 *  captured as a finding (M4.4) — fatal to the run, but the transcript survives as a repro. */
export type PlayResult =
  | { kind: 'outcome' }
  | { kind: 'decision-abandoned' }
  | { kind: 'dead-end'; reason: string }
  | { kind: 'slept' }
  | { kind: 'no-rolls' }
  | { kind: 'no-character' }
  | { kind: 'illegal-move'; move: AgentMove }
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
    // The protocol-log header (DC-S1): written once at construction so every dispatch entry that
    // follows has the session identity (brain class + backend class) to interpret it against.
    this.transcript.protocolHeader(userId, options.brain ?? 'scripted', options.backend ?? 'real');
  }

  private readonly recordBeats: boolean;

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
   *  consecutive stumbles (or the action cap) ends the day as `stalled` with a logged finding. */
  async playDay(): Promise<DaySummary> {
    const dayNumber = this.currentDay();
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
        case 'slept':
          return { dayNumber, outcomes, ended: 'slept' };
        case 'no-rolls':
          return { dayNumber, outcomes, ended: 'no-rolls' };
        case 'no-character':
          return { dayNumber, outcomes, ended: 'no-character' };
        case 'crashed':
          // The exception is already logged as an error finding; end the run — a crashed seam
          // means the same call would keep throwing, so pressing on burns actions for no signal.
          return { dayNumber, outcomes, ended: 'crashed' };
        default:
          // dead-end / illegal-move / decision-abandoned — the attempt failed but the day can
          // continue. Bail once the brain is clearly stuck so a QA run can't spin on one screen.
          if (++stumbles >= STUCK_LIMIT) {
            this.transcript.finding(
              'warning',
              `day ${dayNumber} stalled: ${stumbles} consecutive non-outcome actions`,
            );
            return { dayNumber, outcomes, ended: 'stalled' };
          }
      }
    }
    this.transcript.finding('warning', `day ${dayNumber} hit the ${MAX_ACTIONS_PER_DAY}-action cap`);
    return { dayNumber, outcomes, ended: 'stalled' };
  }

  /** Play up to `days` game days, bookending each with the nightly rest (through the seam as
   *  `rest.begin`, M7.1) + the nightly world tick through the observer (the cron mechanism
   *  stays engine-owned).
   *  The run stops early on `no-character` (fatal — nothing left to play) OR `stalled` (the brain
   *  wedged): a stalled day leaves whatever pending action wedged it untouched, and the nightly
   *  auto-expiry gates on real wall-clock so it never fires across a harness run's millisecond
   *  "days" — pressing on would just replay the identical frozen state every remaining day (burning
   *  a real LLM run with no progress and no fresh signal). Stopping keeps the stall a single, clear
   *  finding. Returns one summary per day actually played, in order. */
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
      const move = await this.brain.chooseMove({
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
        // brain's index is the view button position (the play-loop convention).
        if (move.kind !== 'menu-pick') {
          throw new Error(`brain-walk: step ${view.step} requires a menu-pick`);
        }
        const button = view.buttons[move.index];
        if (!button) throw new Error(`brain-walk: no button at index ${move.index} on step ${view.step}`);
        if (button.kind !== 'choice') {
          throw new Error(`brain-walk: step ${view.step} has an unexpected ${button.kind} button`);
        }
        response = await this.dispatch({ type: 'wizard.choose', playerId: this.userId, step: view.step, value: button.value });
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

    const moves = menuLegalMoves(view);
    const move = await this.ask(view, charView, moves);
    if (!isLegal(move, moves)) {
      this.transcript.finding('warning', `illegal move on menu screen: ${move.kind}`);
      return { kind: 'illegal-move', move };
    }
    switch (move.kind) {
      case 'sleep':
        return { kind: 'slept' };
      case 'menu-pick':
        return this.doDayJob(move.index);
      case 'custom':
        return this.doCustom(move.text);
      default:
        return { kind: 'illegal-move', move };
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
        this.transcript.outcome(viewToText(view));
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
        this.transcript.outcome(viewToText(view));
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
      const move = await this.ask(current, charView, moves);
      if (!isLegal(move, moves)) {
        this.transcript.finding('warning', `illegal move on decision screen: ${move.kind}`);
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
          return { kind: 'decision-abandoned' };
        }
        return this.mapError(response);
      }

      const view = response.view!;
      if (view.screen === 'outcome') {
        this.transcript.outcome(viewToText(view));
        return { kind: 'outcome' };
      }
      // Next decision screen — loop with its view and facts.
      current = view as DecisionViewState;
      currentFacts = response.facts;
    }
    this.transcript.finding('warning', `decision loop exceeded ${MAX_BEATS} beats`);
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
   *  engine read — the agent never reads the engine in the action path. */
  private async ask(
    view: ViewState,
    charView: AgentCharView,
    moves: LegalMove[],
  ): Promise<AgentMove> {
    const text = viewToText(view);
    const move = await this.brain.chooseMove({ screenText: text, moves, character: charView });
    this.transcript.turn(view.screen === 'decision' ? 'decision' : 'menu', text, moves, move);
    return move;
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
