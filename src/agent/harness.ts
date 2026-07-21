/**
 * The agent-player harness (JSON-seam M4.2). Stands a real `SessionController` up over a
 * Discord-free `WorldEngineImpl` and drives play with an `AgentPlayerGateway` brain, entering at
 * the SAME controller methods the Discord adapter calls (parent decision 3 — the M3 methods ARE
 * the seam). It is the "whole game, shorter horizon" QA/playtest harness (decision 6).
 *
 * Character creation and the nightly rest+tick are Discord-only bookends with no controller seam
 * (DA-4), so those go engine-direct (`seedCharacter` here; the rest+tick lands in M4.3). The
 * interesting mid-day action loop — menu → work/custom → decision beats → outcome — goes entirely
 * through the controller, which is the seam this harness exists to exercise.
 *
 * M4.2 drove ONE action end-to-end. M4.3 wraps `playOneAction` in a full-day/multi-day loop:
 * `playDay` runs actions until the day ends (slept / out of rolls / stalled), then `playDays`
 * bookends each day with the engine-direct rest+nightly-tick (DA-4) and moves to the next.
 */

import type { WorldEngine, CharacterData, CharCreateData, PendingChoiceSelector } from '../engine/WorldEngine.js';
import type { SessionController, StartRenderResult } from '../controller/SessionController.js';
import type { MenuViewState, DecisionViewState } from '../view/viewState.js';
import type { AgentPlayerGateway, AgentMove, LegalMove } from './AgentPlayerGateway.js';
import { viewToText } from './viewToText.js';
import { agentCharView, menuLegalMoves, decisionLegalMoves, isLegal } from './agentMoves.js';
import { Transcript } from './transcript.js';
import type { AgentEngine } from './engineHarness.js';
import { SessionController as SessionControllerImpl } from '../controller/SessionController.js';

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

/** The disposition of a single `playOneAction` — loop control for M4.3 and a QA signal. `slept`
 *  and `no-rolls` end the day; `dead-end`/`illegal-move` are non-fatal (the action attempt failed
 *  but the day can continue); `outcome` is a completed action. */
export type PlayResult =
  | { kind: 'outcome' }
  | { kind: 'decision-abandoned' }
  | { kind: 'dead-end'; reason: string }
  | { kind: 'slept' }
  | { kind: 'no-rolls' }
  | { kind: 'no-character' }
  | { kind: 'illegal-move'; move: AgentMove };

/** The disposition of a single game day — the QA/loop signal `playDays` reads. `slept`/`no-rolls`
 *  are clean day ends; `stalled` means the brain got stuck (STUCK_LIMIT or the action cap, both
 *  logged as findings); `no-character` is fatal (the character vanished — `playDays` stops). */
export interface DaySummary {
  /** The game day this summary covers (`day_number` at the start of the day). */
  dayNumber: number;
  /** Completed actions this day (outcome dispositions). */
  outcomes: number;
  ended: 'slept' | 'no-rolls' | 'stalled' | 'no-character';
}

export class AgentHarness {
  readonly transcript = new Transcript();

  constructor(
    private readonly engine: WorldEngine,
    private readonly controller: SessionController,
    private readonly brain: AgentPlayerGateway,
    private readonly userId: string,
  ) {}

  /** Create the character engine-direct — the `join` wizard is a Discord-only bookend with no
   *  controller seam (DA-4), so the harness seeds it straight on the engine, like `sim/` does. */
  seedCharacter(data: CharCreateData): CharacterData {
    return this.engine.createCharacter(this.userId, data);
  }

  /** Drive one action from the action menu to a terminal disposition. Opens the menu, lets the
   *  brain pick, runs the day-job/custom flow, then loops the decision beats to an outcome. */
  async playOneAction(): Promise<PlayResult> {
    // The Discord `nav:action` click stamps last-played before opening the menu (M3.6 DC-N); mirror
    // it so a multi-day agent run doesn't accrue a stale last_played_at and trip the absence nudge.
    this.controller.stampLastPlayed(this.userId);
    const menu = this.controller.openActionMenu(this.userId);
    switch (menu.kind) {
      case 'no-character':
        this.transcript.deadEnd('no-character');
        return { kind: 'no-character' };
      case 'no-rolls':
        return { kind: 'no-rolls' };
      case 'resume-stale':
        this.transcript.deadEnd('resume-stale', menu.prompt);
        return { kind: 'dead-end', reason: 'resume-stale' };
      case 'resume-error':
        this.transcript.deadEnd('resume-error', menu.message);
        return { kind: 'dead-end', reason: 'resume-error' };
      case 'resume-decision':
        return this.runDecisionLoop(menu.view);
      case 'menu':
        return this.playMenu(menu.view);
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
          break;
        case 'slept':
          return { dayNumber, outcomes, ended: 'slept' };
        case 'no-rolls':
          return { dayNumber, outcomes, ended: 'no-rolls' };
        case 'no-character':
          return { dayNumber, outcomes, ended: 'no-character' };
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
      if (summary.ended === 'no-character' || summary.ended === 'stalled') break;
      this.endDay();
    }
    return summaries;
  }

  /** DA-4 end-of-day bookend, engine-direct (no controller seam): rest the character back at the
   *  Oak, then run the nightly tick (advances `day_number`, refills rolls, regen, day-job income).
   *  `tick(true)` = admin, bypassing the wall-clock cron-idempotency guard so the day always
   *  advances. Records the new day boundary on the transcript. */
  private endDay(): void {
    this.engine.restAtOak(this.userId);
    const tick = this.engine.tick(true);
    this.transcript.day(tick.dayNumber, 'nightly tick — rested at the Oak, world advanced');
  }

  /** Current game day (`day_number` meta, default 1) — read straight off the engine, the same
   *  source `tick` advances. */
  private currentDay(): number {
    return Number(this.engine.getMeta('day_number') ?? '1');
  }

  private async playMenu(view: MenuViewState): Promise<PlayResult> {
    const moves = menuLegalMoves(view);
    const move = await this.ask('menu', view, moves);
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
        // choice/bail are not legal on a menu; isLegal already rejected them, so this is
        // unreachable — kept exhaustive for the compiler.
        return { kind: 'illegal-move', move };
    }
  }

  private async doDayJob(idx: number): Promise<PlayResult> {
    const begin = this.controller.beginDayJob(this.userId, idx);
    switch (begin.kind) {
      case 'no-character':
        this.transcript.deadEnd('no-character');
        return { kind: 'no-character' };
      case 'invalid-job':
        this.transcript.finding('error', `beginDayJob returned invalid-job for menu index ${idx}`);
        return { kind: 'dead-end', reason: 'invalid-job' };
      case 'unsafe':
        this.transcript.deadEnd('unsafe-ground', begin.location);
        return { kind: 'dead-end', reason: 'unsafe' };
      case 'ok': {
        this.controller.commuteForWork(this.userId, begin.workplace);
        const result = await this.controller.runWork(this.userId, begin.workPrompt, begin.wage);
        return this.handleStartResult(result);
      }
    }
  }

  private async doCustom(text: string): Promise<PlayResult> {
    const begin = this.controller.beginCustomAction(this.userId);
    if (begin.kind === 'no-character') {
      this.transcript.deadEnd('no-character');
      return { kind: 'no-character' };
    }
    if (begin.kind === 'resume') return this.runDecisionLoop(begin.view);
    const result = await this.controller.runCustomAction(this.userId, text);
    return this.handleStartResult(result);
  }

  private async handleStartResult(result: StartRenderResult): Promise<PlayResult> {
    switch (result.kind) {
      case 'outcome':
        // The acting player's OWN screen is the compact private view (viewPublic is the recap-thread
        // broadcast copy for observers). Decision 2: the agent sees what the acting player sees.
        this.transcript.outcome(viewToText(result.viewPrivate));
        return { kind: 'outcome' };
      case 'empty-action':
        this.transcript.deadEnd('empty-action', result.prompt);
        return { kind: 'dead-end', reason: 'empty-action' };
      case 'decision':
        return this.runDecisionLoop(result.view);
    }
  }

  /** Loop the decision beats until the action resolves. A `bail` resolves to a bailed outcome via
   *  the engine (not a special exit); only a null `resolveChoice` (the button's action already
   *  resolved — "session expired") abandons the beat. */
  private async runDecisionLoop(first: DecisionViewState): Promise<PlayResult> {
    let current = first;
    for (let beat = 0; beat < MAX_BEATS; beat++) {
      const moves = decisionLegalMoves(current);
      const move = await this.ask('decision', current, moves);
      if (!isLegal(move, moves)) {
        this.transcript.finding('warning', `illegal move on decision screen: ${move.kind}`);
        return { kind: 'illegal-move', move };
      }
      const selector: PendingChoiceSelector =
        move.kind === 'bail' ? { kind: 'bail' } : { kind: 'option', index: (move as { index: number }).index };

      const begin = this.controller.beginChoice(this.userId);
      if (begin.kind === 'no-character') {
        this.transcript.deadEnd('no-character');
        return { kind: 'no-character' };
      }
      const label = this.controller.resolveChoice(begin.character, selector);
      if (label === null) {
        this.transcript.deadEnd('session-expired');
        return { kind: 'decision-abandoned' };
      }
      const step = await this.controller.stepChoice(this.userId, label, begin.character);
      if (step.kind === 'outcome') {
        this.transcript.outcome(viewToText(step.view));
        return { kind: 'outcome' };
      }
      current = step.view;
    }
    this.transcript.finding('warning', `decision loop exceeded ${MAX_BEATS} beats`);
    return { kind: 'dead-end', reason: 'beat-cap' };
  }

  /** Render the screen, ask the brain, and log the turn. Throws only if the character vanished
   *  mid-turn (a real invariant break, not normal flow). */
  private async ask(
    screen: 'menu' | 'decision',
    view: MenuViewState | DecisionViewState,
    moves: LegalMove[],
  ): Promise<AgentMove> {
    const char = this.engine.getCharacter(this.userId);
    if (!char) throw new Error(`AgentHarness.ask: no character for ${this.userId} mid-turn`);
    const text = viewToText(view);
    const move = await this.brain.chooseMove({ screenText: text, moves, character: agentCharView(char) });
    this.transcript.turn(screen, text, moves, move);
    return move;
  }
}

/** Wire a harness over a built `AgentEngine` (a fresh `SessionController`, no character-gate set —
 *  the agent doesn't route slash commands). The character is seeded by the caller via
 *  `harness.seedCharacter`. */
export function createAgentHarness(agentEngine: AgentEngine, brain: AgentPlayerGateway, userId: string): AgentHarness {
  const controller = new SessionControllerImpl(agentEngine.engine, agentEngine.getCurrentScene, agentEngine.dayJobs);
  return new AgentHarness(agentEngine.engine, controller, brain, userId);
}
