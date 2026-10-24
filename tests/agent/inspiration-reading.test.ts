/**
 * The RA-2 dial's reading (`Transcript.inspiration()`) and its printed form (`formatInspirationDial`).
 * Outcomes come from the real renderer (`buildOutcomeView` → `formatOutcome`) rather than copied by hand,
 * so re-wording the Inspired line fails here instead of leaving `grants` silently at 0 on every real run.
 * `rolls` reads the envelope's roll fact, the way the engine emits it.
 */

import { describe, it, expect } from 'vitest';

import { Transcript, QUOTABLE_ELIGIBLE_FLOOR, formatInspirationDial } from '../../src/agent/transcript.js';
import type { ProtocolDispatchEntry } from '../../src/agent/transcript.js';
import { buildOutcomeView } from '../../src/view/actionViewState.js';
import type { ActionOutcome } from '../../src/engine/WorldEngine.js';
import type { GameEvent } from '../../src/protocol/events.js';
import type { GameResponse } from '../../src/protocol/envelope.js';

const USER = 'agent:test';

/** One engine outcome: a rolled success, an auto-resolved `done` (`playerRolled: null`), or either with
 *  an inspiration grant applied. */
function actionOutcome(opts: {
  rolled?: boolean;
  granted?: number;
  outcome?: ActionOutcome['outcome'];
  outcomeText?: string;
}): ActionOutcome {
  const rolled = opts.rolled !== false;
  return {
    distilledType: 'hunt',
    finalDc: 14,
    playerRolled: rolled ? 16 : null,
    ...(rolled ? { rollBonus: 3 } : {}),
    outcome: opts.outcome ?? (rolled ? 'success' : 'done'),
    outcomeText: opts.outcomeText ?? 'You get on with it.',
    mutations: opts.granted ? [{ type: 'modify_rolls_remaining', amount: opts.granted }] : [],
  };
}

/** The outcome screen the engine builds for an outcome, carrying the roll fact a rolled one emits. */
function outcomeResponse(outcome: ActionOutcome): GameResponse {
  const roll = outcome.playerRolled === null ? undefined : {
    d20: outcome.playerRolled,
    dc: outcome.finalDc,
    ...(outcome.rollBonus !== undefined ? { bonus: outcome.rollBonus } : {}),
  };
  return {
    v: 1,
    ok: true,
    view: buildOutcomeView(outcome, null, null, { rawInput: 'Scout the road', decisions: [] }),
    ...(roll ? { facts: { distilledType: outcome.distilledType, roll } } : {}),
  };
}

function dispatch(seq: number, event: GameEvent, response: GameResponse): ProtocolDispatchEntry {
  return { seq, kind: 'dispatch', event, response };
}

const resolved = (): GameResponse => outcomeResponse(actionOutcome({ rolled: true }));
const granted = (): GameResponse => outcomeResponse(actionOutcome({ rolled: false, granted: 1 }));

/** One day: a granted free action, two rolled day jobs, then the night. */
function day(seq: number): ProtocolDispatchEntry[] {
  return [
    dispatch(seq, { type: 'action.custom', playerId: USER, text: 'Scout the road' }, granted()),
    dispatch(seq + 1, { type: 'dayjob.start', playerId: USER, jobIndex: 0 }, resolved()),
    dispatch(seq + 2, { type: 'dayjob.start', playerId: USER, jobIndex: 1 }, resolved()),
    dispatch(seq + 3, { type: 'rest.begin', playerId: USER }, resolved()),
  ];
}

function transcriptWith(...entries: ProtocolDispatchEntry[]): Transcript {
  const transcript = new Transcript();
  for (const entry of entries) transcript.protocol.push(entry);
  return transcript;
}

describe('Transcript.inspiration — the RA-2 dial reading', () => {
  it('counts a free action as eligible and a day-job action as work, over the whole run', () => {
    const transcript = transcriptWith(...day(1), ...day(5), ...day(9));

    const dial = transcript.inspiration();

    expect(dial.resolutions).toBe(9);
    expect(dial.rolls).toBe(6);
    expect(dial.eligible).toBe(3);
    expect(dial.work).toBe(6);
    expect(dial.byDay).toHaveLength(3);
  });

  it('splits the reading per played day, in play order', () => {
    const transcript = transcriptWith(...day(1), ...day(5));

    expect(transcript.inspiration().byDay).toEqual([
      { day: 1, resolutions: 3, rolls: 2, eligible: 1, grants: 1 },
      { day: 2, resolutions: 3, rolls: 2, eligible: 1, grants: 1 },
    ]);
    // The free-action count and the dial read the same slices, so the two can never disagree.
    expect(transcript.freeActionsByDay()).toEqual([1, 1]);
  });

  it("reads a grant off the engine's own named-reward line, not off prose that mentions one", () => {
    const transcript = transcriptWith(
      dispatch(
        1,
        { type: 'action.custom', playerId: USER, text: 'Scout the road' },
        outcomeResponse(actionOutcome({ rolled: true, outcomeText: 'The road lifts your spirits.' })),
      ),
    );

    expect(transcript.inspiration().grants).toBe(0);
  });

  it('reads the roll verdict off the envelope, so a re-worded header cannot read as zero rolls', () => {
    const transcript = transcriptWith(
      dispatch(1, { type: 'action.custom', playerId: USER, text: 'Scout the road' }, resolved()),
    );

    expect(transcript.inspiration().rolls).toBe(1);
  });

  it('carries no grant through the work path, where stripWorkInspiration drops it', () => {
    // The strip runs before the outcome is rendered, so a work outcome can never carry the line —
    // this pins the reading's denominator, not the engine.
    const work = transcriptWith(
      dispatch(1, { type: 'dayjob.start', playerId: USER, jobIndex: 0 }, resolved()),
      dispatch(2, { type: 'dayjob.start', playerId: USER, jobIndex: 1 }, resolved()),
    );
    const dial = work.inspiration();

    expect(dial.eligible).toBe(0);
    expect(dial.grants).toBe(0);
  });

  it('counts a free action only once its decision loop resolved it', () => {
    const transcript = transcriptWith(
      dispatch(1, { type: 'action.custom', playerId: USER, text: 'Scout the road' }, {
        v: 1,
        ok: true,
        view: { screen: 'loading', body: 'Thinking…' },
      }),
      dispatch(2, { type: 'action.choose', playerId: USER, selector: { kind: 'option', index: 0 } }, granted()),
    );

    const dial = transcript.inspiration();

    expect(dial.eligible).toBe(1);
    expect(dial.grants).toBe(1);
    expect(dial.work).toBe(0);
  });

  it('leaves a bailed action and a refused one out of both denominators', () => {
    const transcript = transcriptWith(
      dispatch(
        1,
        { type: 'action.custom', playerId: USER, text: 'Scout the road' },
        outcomeResponse(actionOutcome({ rolled: true, outcome: 'bailed' })),
      ),
      dispatch(2, { type: 'dayjob.start', playerId: USER, jobIndex: 0 }, {
        v: 1,
        ok: false,
        error: { code: 'unsafe', message: 'Not here.' },
      }),
    );

    expect(transcript.inspiration()).toMatchObject({ resolutions: 0, eligible: 0, work: 0 });
  });

  it('names the sample a rate needs before it can be quoted', () => {
    expect(QUOTABLE_ELIGIBLE_FLOOR).toBe(50);
  });
});

describe('formatInspirationDial — the printed block', () => {
  it('prints a line per played day, then both denominators and the rate', () => {
    const block = formatInspirationDial(transcriptWith(...day(1), ...day(5)).inspiration());

    expect(block).toContain('── RA-2 inspiration dial ──');
    expect(block).toContain('day 1: 3 resolution(s), 2 rolled, 1 eligible, 1 grant(s)');
    expect(block).toContain('day 2: 3 resolution(s), 2 rolled, 1 eligible, 1 grant(s)');
    expect(block).toContain('total: 6 resolution(s), 4 rolled, 2 eligible (non-work), 4 work, 2 grant(s)');
    expect(block).toContain('grant rate: 100.0% (2/2) of eligible, 33.3% (2/6) of all resolutions');
    expect(block).toContain('rolls per played day: 2.00');
    expect(block).toContain('NOT quotable — 2 eligible resolution(s), floor is 50');
  });

  it('calls the sample quotable once the eligible count reaches the floor', () => {
    const days = Array.from({ length: QUOTABLE_ELIGIBLE_FLOOR }, (_, i) => day(i * 4 + 1)).flat();

    const block = formatInspirationDial(transcriptWith(...days).inspiration());

    expect(block).toContain('quotable');
    expect(block).not.toContain('NOT quotable');
  });

  it('prints n/a rather than dividing by nothing on a run that played no day', () => {
    const block = formatInspirationDial(new Transcript().inspiration());

    expect(block).toContain('grant rate: n/a of eligible, n/a of all resolutions');
    expect(block).toContain('rolls per played day: n/a');
  });
});
