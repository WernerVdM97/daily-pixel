/**
 * The authored-DC reading (`Transcript.difficultyBands()`) and its printed form. Outcomes come from the
 * real renderer, so re-wording the roll header fails here instead of leaving the reading silently empty.
 */

import { describe, it, expect } from 'vitest';

import {
  DAUNTING_FLOOR,
  Transcript,
  dcBand,
  formatDifficultyBands,
} from '../../src/agent/transcript.js';
import type { ProtocolDispatchEntry } from '../../src/agent/transcript.js';
import { buildOutcomeView } from '../../src/view/actionViewState.js';
import type { ActionOutcome } from '../../src/engine/WorldEngine.js';
import type { GameEvent } from '../../src/protocol/events.js';
import type { GameResponse } from '../../src/protocol/envelope.js';

const USER = 'agent:test';

/** One engine outcome rolled against `finalDc`; `playerRolled: null` is the auto-resolved arm (no DC). */
function outcomeResponse(finalDc: number, rolled = true): GameResponse {
  const outcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc,
    playerRolled: rolled ? 16 : null,
    ...(rolled ? { rollBonus: 3 } : {}),
    outcome: rolled ? 'success' : 'done',
    outcomeText: 'You get on with it.',
    mutations: [],
  };
  return {
    v: 1,
    ok: true,
    view: buildOutcomeView(outcome, null, null, { rawInput: 'Scout the road', decisions: [] }),
  };
}

function dispatch(seq: number, event: GameEvent, response: GameResponse): ProtocolDispatchEntry {
  return { seq, kind: 'dispatch', event, response };
}

/** A free action resolving at `dc`, written as the start dispatch plus its choose beat. */
function free(seq: number, dc: number): ProtocolDispatchEntry[] {
  return [
    dispatch(seq, { type: 'action.custom', playerId: USER, text: 'Climb the tower' }, { v: 1, ok: true }),
    dispatch(seq + 1, { type: 'action.choose', playerId: USER, selector: { kind: 'option', index: 0 } }, outcomeResponse(dc)),
  ];
}

/** A day job resolving at `dc`. */
function work(seq: number, dc: number): ProtocolDispatchEntry[] {
  return [dispatch(seq, { type: 'dayjob.start', playerId: USER, jobIndex: 0 }, outcomeResponse(dc))];
}

function transcriptWith(...entries: ProtocolDispatchEntry[]): Transcript {
  const transcript = new Transcript();
  for (const entry of entries) {
    transcript.protocol.push(entry);
  }
  return transcript;
}

describe('dcBand — the v13 ladder', () => {
  it('names each band and leaves the gaps and tails off-ladder', () => {
    expect(dcBand(11)).toBe('routine');
    expect(dcBand(13)).toBe('routine');
    expect(dcBand(16)).toBe('hard');
    expect(dcBand(18)).toBe('hard');
    expect(dcBand(DAUNTING_FLOOR)).toBe('daunting');
    expect(dcBand(24)).toBe('daunting');
    for (const dc of [10, 14, 15, 19, 25]) expect(dcBand(dc)).toBeNull();
  });
});

describe('Transcript.difficultyBands — the authored-DC distribution', () => {
  it('bands every rolled DC and splits the day-job work out of it', () => {
    const transcript = transcriptWith(
      ...free(1, 12),
      ...free(3, 17),
      ...free(5, 21),
      ...work(7, 11),
    );

    const reading = transcript.difficultyBands();

    expect(reading.resolutions).toBe(4);
    expect(reading.rolled).toBe(4);
    expect(reading.work).toBe(1);
    expect(reading.byBand).toEqual({ routine: 2, hard: 1, daunting: 1 });
    expect(reading.offLadder).toBe(0);
  });

  it('counts the gaps as off-ladder rather than folding them into a band', () => {
    const transcript = transcriptWith(...free(1, 14), ...free(3, 19));

    expect(transcript.difficultyBands()).toMatchObject({
      byBand: { routine: 0, hard: 0, daunting: 0 },
      offLadder: 2,
    });
  });

  it('reports the highest DC with its band, and the distribution ascending', () => {
    const transcript = transcriptWith(
      ...free(1, 21),
      ...free(3, 17),
      ...free(5, 12),
      ...work(7, 17),
    );

    const reading = transcript.difficultyBands();

    expect(reading.max).toEqual({ dc: 21, band: 'daunting' });
    expect(reading.distribution).toEqual([
      { dc: 12, count: 1 },
      { dc: 17, count: 2 },
      { dc: 21, count: 1 },
    ]);
  });

  it('counts an auto-resolved action as a resolution but bands nothing for it', () => {
    const transcript = transcriptWith(
      dispatch(1, { type: 'dayjob.start', playerId: USER, jobIndex: 0 }, outcomeResponse(13, false)),
    );

    expect(transcript.difficultyBands()).toMatchObject({ resolutions: 1, rolled: 0, max: null });
  });

  it('reads an empty run as nothing to band', () => {
    expect(transcriptWith().difficultyBands()).toMatchObject({ resolutions: 0, rolled: 0, max: null });
  });
});

describe('formatDifficultyBands', () => {
  const reading = transcriptWith(...free(1, 21), ...free(3, 14), ...work(5, 11)).difficultyBands();

  it('prints the work/free split beside the bands, so a forced arm cannot read as a clean one', () => {
    expect(formatDifficultyBands(reading)).toContain('3 of 3 resolution(s) — 1 work, 2 free');
  });

  it('states the ladder, the off-ladder count and the distribution', () => {
    const text = formatDifficultyBands(reading);
    expect(text).toContain('routine 11-13: 1  hard 16-18: 0  daunting 20-24: 1  off-ladder: 1');
    expect(text).toContain('distribution: 11×1, 14×1, 21×1');
  });

  it('reads the daunting band against its floor in both directions', () => {
    expect(formatDifficultyBands(reading)).toContain('max: 21 (daunting) — daunting band reached');

    const short = transcriptWith(...free(1, 18)).difficultyBands();
    expect(formatDifficultyBands(short)).toContain('daunting band NOT reached (floor 20)');
  });

  it('says so plainly when nothing rolled', () => {
    const empty = transcriptWith(
      dispatch(1, { type: 'dayjob.start', playerId: USER, jobIndex: 0 }, outcomeResponse(13, false)),
    ).difficultyBands();
    expect(formatDifficultyBands(empty)).toContain('no rolled DC — nothing to band');
  });
});
