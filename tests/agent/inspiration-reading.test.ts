/**
 * The RA-2 inspiration dial's reading (`Transcript.inspiration()`), built from a hand-written protocol
 * log rather than a live run: the reading exists so the dial's numbers are mechanical instead of
 * hand-derived, and the arithmetic is what this file pins. Each day below is the forced arm's shape —
 * one free-text action, then day-job work — with the outcome blocks copied from what the engine
 * renders (`OutcomeRenderer`): a rolled beat opens on the roll header, an auto-resolved one does not,
 * and a positive `modify_rolls_remaining` adds the `✨ Inspired:` line last.
 */

import { describe, it, expect } from 'vitest';

import { Transcript, QUOTABLE_ELIGIBLE_FLOOR } from '../../src/agent/transcript.js';
import type { ProtocolDispatchEntry } from '../../src/agent/transcript.js';
import type { GameEvent } from '../../src/protocol/events.js';
import type { GameResponse } from '../../src/protocol/envelope.js';

const USER = 'agent:test';

/** An engine-rendered outcome block. Mirrors `formatOutcome`'s assembly: header line, body, changes
 *  line, stats footer. */
function outcomeBlock(opts: { rolled?: boolean; granted?: number; dc?: number }): string {
  const header = opts.rolled === false ? '🌟 **DONE**' : `💪 🎲 12 + 3 = **15**  vs  ${opts.dc ?? 14}  →  ✅ **SUCCESS**`;
  const lines = [header, '', 'You get on with it.', ''];
  if (opts.granted) {
    lines.push(`→ The East Road  ✨ Inspired: +${opts.granted} ${opts.granted === 1 ? 'roll' : 'rolls'}`);
  }
  lines.push('`⚡ 9/10  ┃  🎲 2 (-1)`');
  return lines.join('\n');
}

function outcomeResponse(block: string, intent: 'success' | 'bailed' = 'success'): GameResponse {
  return {
    v: 1,
    ok: true,
    view: {
      screen: 'outcome',
      title: { emoji: '⚔️', text: 'Success' },
      colorIntent: intent,
      isCombat: false,
      outcomeBlock: block,
    },
  };
}

function dispatch(seq: number, event: GameEvent, response: GameResponse): ProtocolDispatchEntry {
  return { seq, kind: 'dispatch', event, response };
}

const resolved = (): GameResponse => outcomeResponse(outcomeBlock({ rolled: true }));
const granted = (): GameResponse => outcomeResponse(outcomeBlock({ rolled: false, granted: 1 }));

/** One day: a granted free action, two rolled day jobs, then the night. */
function day(seq: number): ProtocolDispatchEntry[] {
  return [
    dispatch(seq, { type: 'action.custom', playerId: USER, text: 'Scout the road' }, granted()),
    dispatch(seq + 1, { type: 'dayjob.start', playerId: USER, jobIndex: 0 }, resolved()),
    dispatch(seq + 2, { type: 'dayjob.start', playerId: USER, jobIndex: 1 }, resolved()),
    dispatch(seq + 3, { type: 'rest.begin', playerId: USER }, outcomeResponse(outcomeBlock({ rolled: true }))),
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

  it('reads a grant off the engine\'s own named-reward line, not off the model\'s prose', () => {
    // Prose claiming an inspiration, with no grant in the outcome: still not a grant.
    const prose = outcomeResponse(outcomeBlock({ rolled: true }).replace('You get on with it.', 'You feel inspired by the road.'));
    const transcript = transcriptWith(
      dispatch(1, { type: 'action.custom', playerId: USER, text: 'Scout the road' }, prose),
    );

    expect(transcript.inspiration().grants).toBe(0);
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
      dispatch(1, { type: 'action.custom', playerId: USER, text: 'Scout the road' }, outcomeResponse(outcomeBlock({ rolled: true }), 'bailed')),
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
