/**
 * The agent-player harness (JSON-seam M6, see docs/engine/json-seam-protocol.md § "M6 build
 * plan"). Speaks only `GameEvent`/`GameResponse` through `GameRouter` for the mid-day loop —
 * a true protocol client, exactly what a player sees. No controller imports remain in the
 * action path; `viewToText` reads envelope views; the brain's character snapshot comes from
 * the `characterState` fact (DC-M6.1).
 *
 * Bookends (character creation, nightly rest+tick) stay engine-direct until M7 (DA-4).
 */

import type { WorldEngine, CharacterData, CharCreateData } from '../engine/WorldEngine.js';
import type { MenuViewState, DecisionViewState, ViewState } from '../view/viewState.js';
import type { AgentPlayerGateway, AgentMove, LegalMove, AgentCharView } from './AgentPlayerGateway.js';
import { viewToText } from './viewToText.js';
import { menuLegalMoves, decisionLegalMoves, isLegal } from './agentMoves.js';
import { Transcript } from './transcript.js';
import type { GameRouter } from '../protocol/router.js';
import type { GameResponse } from '../protocol/envelope.js';

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
    private readonly engine: WorldEngine,
    private readonly router: GameRouter,
    private readonly brain: AgentPlayerGateway,
    private readonly userId: string,
  ) {}

  /** Create the character engine-direct — the `join` wizard is a Discord-only bookend with no
   *  controller seam (DA-4), so the harness seeds it straight on the engine, like `sim/` does. */
  seedCharacter(data: CharCreateData): CharacterData {
    return this.engine.createCharacter(this.userId, data);
  }

  /** Drive one action from the action menu to a terminal disposition. The router never throws
   *  (every path through `dispatch` returns a `GameResponse` envelope), so the outer try/catch
   *  only catches rendering errors in `ask()` and the error envelope → PlayResult mapping —
   *  the action path itself is throw-safe by construction. */
  async playOneAction(): Promise<PlayResult> {
    try {
      return await this.runAction();
    } catch (e) {
      this.transcript.finding('error', `uncaught exception during action loop`, formatError(e));
      return { kind: 'crashed', phase: 'action', error: formatError(e) };
    }
  }

  private async runAction(): Promise<PlayResult> {
    // menu.open: stampLastPlayed + the full menu/resume branch, inside the router (DC-P6).
    const menu = await this.router.dispatch({ type: 'menu.open', playerId: this.userId });

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

  /** Play up to `days` game days, bookending each with the engine-direct rest+nightly-tick (DA-4).
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
      if (!this.endDay()) break;
    }
    return summaries;
  }

  /** DA-4 end-of-day bookend, engine-direct (no controller seam). The rolls-gate is faithful to
   *  real play (M4.4 decision): a player can only `/sleep`-rest once their rolls are spent, so
   *  `restAtOak` runs ONLY when `rollsRemaining === 0` — with rolls left the real player would just
   *  idle where they are, not be teleported home. The nightly tick runs regardless (the cron
   *  advances the world for everyone), so an idler still takes its unsafe-ground stamina drain.
   *  `rollsRemaining` MUST be read before the tick (which refills it). This does NOT reproduce the
   *  `/sleep` command's unsafe-rest -1 HP penalty (that lives in the Discord command, not
   *  `restAtOak`) — noted for M4.5. `tick(true)` = admin, bypassing the wall-clock cron-idempotency
   *  guard so the day always advances. Returns false if a bookend call throws (captured as a
   *  finding naming the step) so the caller stops rather than advancing into a day that never
   *  ticked. */
  private endDay(): boolean {
    let step = 'nightly rest (read character)';
    try {
      const before = this.engine.getCharacter(this.userId);
      const rested = before?.rollsRemaining === 0;
      if (rested) {
        step = 'nightly rest (restAtOak)';
        this.engine.restAtOak(this.userId);
      }
      step = 'nightly tick';
      const tick = this.engine.tick(true);
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
      char = this.engine.getCharacter(this.userId);
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

  /** Current game day (`day_number` meta, default 1) — read straight off the engine, the same
   *  source `tick` advances. */
  private currentDay(): number {
    return Number(this.engine.getMeta('day_number') ?? '1');
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
    const response = await this.router.dispatch(
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
    const response = await this.router.dispatch(
      { type: 'action.custom', playerId: this.userId, text },
      // Thinking beats are absorbed (transport chrome, DC-M6.3).
      undefined,
    );

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
      const response = await this.router.dispatch(
        { type: 'action.choose', playerId: this.userId, selector },
        undefined,
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

/** Wire a harness over a `GameRouter` + `WorldEngine` (the engine is for bookends only; the
 *  action path goes through the router). No controller imports — the harness is a pure
 *  protocol client (M6 gate). The router has already been wired to a real `SessionController`
 *  or a stub `RouterBackend` by the caller. */
export function createAgentHarness(
  engine: WorldEngine,
  router: GameRouter,
  brain: AgentPlayerGateway,
  userId: string,
): AgentHarness {
  return new AgentHarness(engine, router, brain, userId);
}
