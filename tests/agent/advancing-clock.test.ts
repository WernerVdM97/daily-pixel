/**
 * The advancing clock (spec § G "the time axis", contract §10) — the machinery T8's
 * interrupted panel and the arc panel both ride on, proven before either spends a token.
 *
 * Three things are pinned here, in the order the contract states them:
 *
 * 1. `pinAdvancingClock` is a FIXED instant plus whole days, and covers exactly what
 *    `pinClock` covers (`new Date()` / `Date.now()`, never timers or `new Date(x)`).
 * 2. A multi-day scripted run crosses calendar days in step with its nightly ticks, and a
 *    multi-day protocol log replays byte-green — the same-weekday-class caveat discharged for
 *    multi-day streams, with the Saturday tick (day 5 from 2026-09-15T12:00:00Z) as the
 *    non-vacuous part: a replay that did not step its clock would re-tick day 5 on a weekday
 *    and mismatch the recorded 4-roll allowance.
 * 3. The audit's decisions (contract §10's blast-radius gate) where a test is cheap: the
 *    wizard TTL stays inert, and the sharp case — an action pending across a night — resolves
 *    as a server-side timeout, deliberately.
 *
 * The start date is the arc panel's: 2026-09-15T12:00:00Z is a UTC Tuesday, so days 1-5 are
 * Tue..Sat and the Saturday bonus roll belongs to day 5. Noon UTC keeps the LOCAL weekday
 * (which `hiScreen.isWeekend()` reads) equal to the UTC one in every plausible test timezone.
 */

import { describe, it, expect } from 'vitest';

import { pinAdvancingClock } from '../../src/agent/clock.js';
import { buildAgentEngine } from '../../src/agent/engineHarness.js';
import { createAgentHarness, type AgentHarness } from '../../src/agent/harness.js';
import { ScriptedAgentPlayerGateway } from '../../src/agent/ScriptedAgentPlayerGateway.js';
import {
  buildDeterministicRouter,
  deterministicPipelineScript,
  recordDeterministicRealSession,
  REAL_DAY_MOVES,
  REAL_RECORDED_AT,
  SEED,
} from '../../src/agent/deterministicSession.js';
import { establishBootParity } from '../../src/agent/bootParity.js';
import { replayLog } from '../../src/agent/replay.js';
import { viewToText } from '../../src/agent/viewToText.js';
import { PipelineScriptedGateway } from '../../src/sim/PipelineScriptedGateway.js';
import { WizardSession } from '../../src/controller/WizardSession.js';
import { DAILY_ROLL_ALLOWANCE, SATURDAY_BONUS_ROLLS } from '../../src/engine/WorldEngineImpl.js';
import type { AgentObserver, CharacterData } from '../../src/agent/observer.js';
import type { AgentMove } from '../../src/agent/AgentPlayerGateway.js';
import type { ProtocolEntry, ProtocolTickEntry } from '../../src/agent/transcript.js';
import type { GameResponse } from '../../src/protocol/envelope.js';
import type { ViewState } from '../../src/view/viewState.js';

/** The arc panel's start instant (contract §10): day 1 = UTC Tuesday, day 5 = UTC Saturday. */
const START = '2026-09-15T12:00:00Z';
const USER_ID = 'agent:advancing-clock';

/**
 * The observer seam, wrapped to record what the world saw at tick time. Two things only this can
 * see: the calendar date the tick itself ran on (which is what the harness's "advance BEFORE the
 * tick" ordering is for) and the rolls the tick refilled — the Saturday bonus is observable there
 * and nowhere later, because the next play day spends one of them.
 */
class TickRecordingObserver implements AgentObserver {
  readonly tickDates: string[] = [];
  readonly tickRolls: number[] = [];
  readonly tickResults: { dayNumber: number; absentWarnings: string[] }[] = [];

  constructor(private readonly inner: AgentObserver, private readonly userId: string) {}

  getCharacter(userId: string): CharacterData | null {
    return this.inner.getCharacter(userId);
  }

  getMeta(key: 'day_number'): string | null {
    return this.inner.getMeta(key);
  }

  tick(admin: true): { dayNumber: number } {
    this.tickDates.push(new Date().toISOString().slice(0, 10));
    // The seam declares `{ dayNumber }` only (harness.ts reads nothing else), but the real engine's
    // TickResult carries the absence warnings — the interruption's actual measurement.
    const result = this.inner.tick(admin) as { dayNumber: number; absentWarnings?: string[] };
    this.tickRolls.push(this.inner.getCharacter(this.userId)?.rollsRemaining ?? -1);
    this.tickResults.push({ dayNumber: result.dayNumber, absentWarnings: result.absentWarnings ?? [] });
    return result;
  }
}

/** N scripted days (one day's moves repeated, exactly as `stubRun` does it) — the arc panel's
 *  shape at its cheapest. The scripted brain cannot repeat itself: a run handed one day's moves and
 *  asked for two days ends the second as `crashed` (script exhausted) and never reaches its night
 *  tick, which is why every multi-day arm here passes the right number of days. */
const daysOfMoves = (days: number): AgentMove[] => Array.from({ length: days }, () => REAL_DAY_MOVES).flat();
const TWO_DAYS: AgentMove[] = daysOfMoves(2);
const FIVE_DAYS: AgentMove[] = daysOfMoves(5);

/** A deterministic real-backend harness on a pinned ADVANCING clock. `pin: false` gives the same
 *  run without the harness handle — the pre-clock behaviour the two control arms measure. */
function buildClockHarness(
  moves: AgentMove[] = REAL_DAY_MOVES,
  opts: { pin?: boolean; startIso?: string } = {},
): {
  agentEngine: ReturnType<typeof buildAgentEngine>;
  engine: ReturnType<typeof buildAgentEngine>['engine'];
  harness: AgentHarness;
  brain: ScriptedAgentPlayerGateway;
  observer: TickRecordingObserver;
  clock: ReturnType<typeof pinAdvancingClock>;
} {
  const startIso = opts.startIso ?? START;
  const agentEngine = buildAgentEngine({
    pipelineLlmGateway: new PipelineScriptedGateway(deterministicPipelineScript),
    rollD20: () => 20,
  });
  establishBootParity(agentEngine.db);
  const observer = new TickRecordingObserver(agentEngine.engine, USER_ID);
  const clock = pinAdvancingClock(startIso);
  const brain = new ScriptedAgentPlayerGateway(moves);
  const harness = createAgentHarness(observer, buildDeterministicRouter(agentEngine), brain, USER_ID, {
    recordedAt: startIso,
    backend: 'real',
    ...(opts.pin === false ? {} : { pinnedClock: clock }),
  });
  return { agentEngine, engine: agentEngine.engine, harness, brain, observer, clock };
}

/** The envelope's view, asserting the call succeeded — the union makes `view` unreachable
 *  otherwise, and a silent `ok:false` would let an assertion pass on the wrong arm. */
function viewOf(response: GameResponse): ViewState {
  if (!response.ok) throw new Error(`expected ok, got ${response.error.code}: ${response.error.message}`);
  if (!response.view) throw new Error('expected a view on an ok envelope');
  return response.view;
}

const ticks = (harness: AgentHarness): ProtocolTickEntry[] =>
  harness.transcript.protocol.filter((e): e is ProtocolTickEntry => e.kind === 'tick');

const dispatches = (harness: AgentHarness): ProtocolEntry[] =>
  harness.transcript.protocol.filter((e) => e.kind === 'dispatch');

describe('pinAdvancingClock — a fixed instant plus whole days (contract §10)', () => {
  it('returns parse(iso) + daysAdvanced * 86_400_000, and nothing wider', () => {
    const clock = pinAdvancingClock(START);
    try {
      expect(Date.now()).toBe(Date.parse(START));
      expect(new Date().toISOString()).toBe('2026-09-15T12:00:00.000Z');

      clock.advanceDays(1);
      expect(Date.now()).toBe(Date.parse('2026-09-16T12:00:00Z'));

      clock.advanceDays(3);
      expect(Date.now()).toBe(Date.parse('2026-09-19T12:00:00Z'));

      // Not a general fake-timer: an explicitly-argumented Date is untouched, and the inherited
      // statics still parse what they always did.
      expect(new Date('2026-01-01T00:00:00Z').toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(new Date(0).toISOString()).toBe('1970-01-01T00:00:00.000Z');
      expect(Date.parse('2026-09-19T12:00:00Z')).not.toBeNaN();
      // A whole-day step, not a wall-clock offset: the time of day never moves.
      expect(new Date().getUTCHours()).toBe(12);
      expect(new Date().getUTCDay()).toBe(6);
    } finally {
      clock.restore();
    }
  });

  it('restores the real clock', () => {
    const before = Date.now();
    const clock = pinAdvancingClock(REAL_RECORDED_AT);
    expect(Date.now()).toBe(Date.parse(REAL_RECORDED_AT));
    clock.advanceDays(2);
    clock.restore();

    // Back to the real wall clock — not the pinned instant, not the advanced one.
    expect(Math.abs(Date.now() - before)).toBeLessThan(1000);
  });
});

describe('the advancing clock on a live-shaped run (contract §10 acceptance)', () => {
  it('(a) the tick into day 2 sees day 2, so the days cross dates in step', async () => {
    const { harness, observer, clock } = buildClockHarness(TWO_DAYS);
    try {
      await harness.createCharacter(SEED);
      const summaries = await harness.playDays(2);

      expect(summaries.map((s) => s.dayNumber)).toEqual([1, 2]);
      // Both days closed cleanly: a crashed day would break the run before its night tick and let
      // the date assertions below pass vacuously (one tick instead of two).
      expect(summaries.map((s) => s.ended)).toEqual(['slept', 'slept']);
      // The date read INSIDE each nightly tick — after the harness's advanceDays(1), before the
      // world moved. A tick that ran on the ending day's date would read the 15th both times.
      expect(observer.tickDates).toEqual(['2026-09-16', '2026-09-17']);
      expect(observer.tickResults.map((t) => t.dayNumber)).toEqual([2, 3]);
      expect(new Date().toISOString().slice(0, 10)).toBe('2026-09-17');
    } finally {
      clock.restore();
    }
  });

  it('(a-control) without the harness handle the same two days never move the calendar', async () => {
    const { harness, observer, clock } = buildClockHarness(TWO_DAYS, { pin: false });
    try {
      await harness.createCharacter(SEED);
      await harness.playDays(2);
    } finally {
      clock.restore();
    }

    // Non-vacuity for (a): the ticks really did run, on the pinned instant both times.
    expect(observer.tickResults.map((t) => t.dayNumber)).toEqual([2, 3]);
    expect(observer.tickDates).toEqual(['2026-09-15', '2026-09-15']);
  });

  it('(c) the Saturday bonus roll fires on the day the clock says is Saturday, and only there', async () => {
    const { harness, observer, clock } = buildClockHarness(FIVE_DAYS);
    try {
      await harness.createCharacter(SEED);
      const summaries = await harness.playDays(5);
      expect(summaries.map((s) => s.dayNumber)).toEqual([1, 2, 3, 4, 5]);
      expect(summaries.map((s) => s.ended)).toEqual(['slept', 'slept', 'slept', 'slept', 'slept']);

      // Tue..Sun, refilled one day ahead at each nightly tick.
      expect(observer.tickDates).toEqual([
        '2026-09-16',
        '2026-09-17',
        '2026-09-18',
        '2026-09-19',
        '2026-09-20',
      ]);
      expect(observer.tickRolls).toEqual([
        DAILY_ROLL_ALLOWANCE,
        DAILY_ROLL_ALLOWANCE,
        DAILY_ROLL_ALLOWANCE,
        DAILY_ROLL_ALLOWANCE + SATURDAY_BONUS_ROLLS, // Fri night's tick opens Sat 19
        DAILY_ROLL_ALLOWANCE,
      ]);
    } finally {
      clock.restore();
    }
  });

  it('(c-control) the same five days on a fixed clock never see a Saturday', async () => {
    const { harness, observer, clock } = buildClockHarness(FIVE_DAYS, { pin: false });
    try {
      await harness.createCharacter(SEED);
      await harness.playDays(5);
    } finally {
      clock.restore();
    }

    // The bonus is a consequence of the ADVANCING pin, not of running five days: five ticks on one
    // instant never land on a Saturday, so every refill is the weekday allowance.
    expect(observer.tickDates).toEqual(Array.from({ length: 5 }, () => '2026-09-15'));
    expect(observer.tickRolls).toEqual(Array.from({ length: 5 }, () => DAILY_ROLL_ALLOWANCE));
  });

  it('(b) a five-day protocol log replays byte-green, including the Saturday tick', async () => {
    const protocol = await recordDeterministicRealSession({ days: 5, recordedAt: START, userId: USER_ID });
    // Non-vacuity: five nightly ticks, day numbers 2..6, so the replay's per-tick advance is
    // load-bearing rather than decorative.
    expect(protocol.filter((e) => e.kind === 'tick').map((e) => (e as ProtocolTickEntry).dayNumber)).toEqual([
      2, 3, 4, 5, 6,
    ]);

    const result = await replayLog(protocol, { backend: 'real' });

    expect(result.fatal).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.entries.every((e) => e.ok)).toBe(true);
    expect(result.entries.filter((e) => e.kind === 'tick').every((e) => e.ok)).toBe(true);
  });
});

describe('skipDays — the interruption (spec § G, contract §10)', () => {
  it('advances the world and the clock with no play dispatches, and the run resumes on the right day', async () => {
    const { harness, observer, clock, engine } = buildClockHarness(TWO_DAYS);
    try {
      await harness.createCharacter(SEED);
      expect((await harness.playDays(1)).map((s) => s.dayNumber)).toEqual([1]);
      // Day 1 played: one tick marker, and the world is on the 16th.
      expect(ticks(harness).map((t) => t.dayNumber)).toEqual([2]);
      expect(observer.tickDates).toEqual(['2026-09-16']);
      const dispatchesBefore = dispatches(harness).length;
      const turnsBefore = harness.transcript.events.filter((e) => e.type === 'turn').length;

      harness.skipDays(4);

      // The absence: four more days of world and four more tick markers, and NOT ONE dispatch or
      // turn — which is what makes it an absence rather than a quiet stretch of play.
      expect(ticks(harness).map((t) => t.dayNumber)).toEqual([2, 3, 4, 5, 6]);
      expect(dispatches(harness).length).toBe(dispatchesBefore);
      expect(harness.transcript.events.filter((e) => e.type === 'turn').length).toBe(turnsBefore);
      expect(engine.getMeta('day_number')).toBe('6');
      expect(observer.tickDates.at(-1)).toBe('2026-09-20');
      expect(new Date().toISOString().slice(0, 10)).toBe('2026-09-20');

      // Every skipped day says so in the transcript, so a reader — and T8's panel — can tell a day
      // the world moved without the player from a day the player played.
      const skippedLines = harness.transcript.events.filter(
        (e) => e.type === 'day' && e.note.includes('skipped'),
      );
      expect(skippedLines).toHaveLength(4);

      // The absence is measurable, not merely simulated: five days after last playing, the tick
      // collects the absence warning (the retention nudge spec § G exists to make fire). It fires
      // ONCE, on the crossing.
      expect(observer.tickResults.filter((t) => t.absentWarnings.includes(USER_ID)).map((t) => t.dayNumber)).toEqual([6]);

      // The resume: the day after the gap, numbered as the WORLD numbers it, not as a count of days
      // played — so the series the panel reads carries the real gap.
      expect((await harness.playDays(1)).map((s) => s.dayNumber)).toEqual([6]);
      expect(observer.tickDates.at(-1)).toBe('2026-09-21');
    } finally {
      clock.restore();
    }
  });

  it('is a no-op at n = 0, and still ticks the world when no clock is pinned', async () => {
    const { harness, engine, clock } = buildClockHarness(TWO_DAYS, { pin: false });
    try {
      await harness.createCharacter(SEED);
      harness.skipDays(0);
      expect(ticks(harness)).toHaveLength(0);

      harness.skipDays(2);
      // Without the harness handle the world still advances (the observer seam is what ticks); only
      // the calendar stands still. Documented rather than defended: `play.ts` always pins.
      expect(ticks(harness).map((t) => t.dayNumber)).toEqual([2, 3]);
      expect(engine.getMeta('day_number')).toBe('3');
    } finally {
      clock.restore();
    }
  });

  it('the resumed day tells the brain it was away, instead of calling a day it never played yesterday', async () => {
    // The interrupted panel's one measurement (spec § G): the absence has to reach the brain, and
    // the day-start recap is the only block that can carry it. Without this the run resumes on day 7
    // wearing a day-6 recap the player never earned.
    const { harness, brain, clock } = buildClockHarness(TWO_DAYS);
    try {
      await harness.createCharacter(SEED);
      await harness.playDays(1);
      // Day 1 has nothing behind it: no recap on any of its turns.
      expect(brain.calls[0].recap).toBeUndefined();

      harness.skipDays(5);
      const callsBefore = brain.calls.length;

      // The resume: day 7, five days after the last day actually played.
      expect((await harness.playDays(1)).map((s) => s.dayNumber)).toEqual([7]);
      const recap = brain.calls[callsBefore].recap;
      const lines = (recap ?? '').split('\n');

      expect(lines[0]).toBe('LAST PLAYED (day 1):');
      expect(lines[1]).toBe('5 days passed without you.');
      // Day 1's own outcome lines still ride the recap, and it still ends with its disposition.
      expect(lines.length).toBeGreaterThan(3);
      expect(lines.at(-1)).toBe('ended: slept');

      // Non-vacuity for the gap itself: those five days were ticks and `day` lines, never turns.
      expect(harness.transcript.events.filter((e) => e.type === 'day' && e.note.includes('skipped'))).toHaveLength(5);
    } finally {
      clock.restore();
    }
  });
});

describe("the audit's decisions (contract §10's blast-radius gate)", () => {
  it('the sharp case: an action pending across a night resolves as a server-side timeout', async () => {
    const { agentEngine, harness, engine, clock } = buildClockHarness();
    try {
      await harness.createCharacter(SEED);
      // A second router over the SAME engine: the harness keeps its own private, and the pending
      // state under test lives in the engine (`last_action_state`), not in a controller.
      const router = buildDeterministicRouter(agentEngine);

      // Control arm, on day 1: a fresh action resolves normally through the two decision beats.
      const fresh = await router.dispatch({ type: 'dayjob.start', playerId: USER_ID, jobIndex: 0 });
      expect(viewOf(fresh).screen).toBe('decision');
      const beat1 = await router.dispatch({ type: 'action.choose', playerId: USER_ID, selector: { kind: 'option', index: 0 } });
      expect(viewOf(beat1).screen).toBe('decision');
      const done = await router.dispatch({ type: 'action.choose', playerId: USER_ID, selector: { kind: 'option', index: 0 } });
      expect(viewOf(done).screen).toBe('outcome');
      expect(viewToText(viewOf(done))).toContain('goblin falls');

      // The sharp case: a second action left pending when the night advances the clock.
      const pending = await router.dispatch({ type: 'dayjob.start', playerId: USER_ID, jobIndex: 0 });
      expect(viewOf(pending).screen).toBe('decision');
      const rollsBefore = engine.getCharacter(USER_ID)!.rollsRemaining;

      clock.advanceDays(1); // by hand — the same step the harness's nightly tick makes

      const timedOut = await router.dispatch({ type: 'action.choose', playerId: USER_ID, selector: { kind: 'option', index: 0 } });
      expect(viewOf(timedOut).screen).toBe('outcome');
      // The in-voice server-side timeout card, not the scripted narration: 24 pinned hours of
      // staleness is what the engine's ACTION_TIMEOUT_MS check reads, and the decision (leave it —
      // see resolveStaleTimeout's AUDIT note) is that this is the right behaviour, not a bug the
      // clock work introduced.
      expect(viewToText(viewOf(timedOut))).toContain('slipped away');
      expect(viewToText(viewOf(timedOut))).not.toContain('goblin falls');
      // ...and the first timeout of the day refunds the roll (capped at the day's allowance).
      expect(engine.getCharacter(USER_ID)!.rollsRemaining).toBe(Math.min(DAILY_ROLL_ALLOWANCE, rollsBefore + 1));
    } finally {
      clock.restore();
    }
  });

  it('the wizard TTL is clock-relative, and the harness ordering is what keeps it unreachable', async () => {
    const clock = pinAdvancingClock(START);
    try {
      const wizard = new WizardSession();
      wizard.start('wizard-user');
      expect(wizard.isExpired('wizard-user')).toBe(false);

      // A day of game time IS a day of TTL, so a wizard session that straddled a nightly tick would
      // expire. That is the decision's boundary: the TTL answers "has this human walked away from a
      // half-finished wizard", and the harness's ordering — the creation walk completes before the
      // first `endDay` → `advanceDays` — is what keeps the case unreachable. The multi-day runs
      // above pin the other half of that claim: they walk the wizard, then advance a day (or five)
      // without the walk expiring.
      clock.advanceDays(1);
      expect(wizard.isExpired('wizard-user')).toBe(true);
    } finally {
      clock.restore();
    }
  });
});
