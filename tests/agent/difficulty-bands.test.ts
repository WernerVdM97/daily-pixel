/**
 * The authored-DC reading (`Transcript.difficultyBands()`) and its printed form. Outcomes are built by the
 * real renderer and carry the envelope's roll fact, so the reading tracks what a run actually records.
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
import type { ActionOutcome, CharacterData } from '../../src/engine/WorldEngine.js';
import type { CombatBeatLog } from '../../src/engine/action/combat-dc.js';
import type { GameEvent } from '../../src/protocol/events.js';
import type { GameResponse } from '../../src/protocol/envelope.js';

const USER = 'agent:test';

/** The outcome envelope's roll fact — the source the reading bands, not the rendered header. */
const rollFact = (finalDc: number, d20 = 16, bonus = 3) => ({ distilledType: 'hunt', roll: { d20, dc: finalDc, bonus } });

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
    ...(rolled ? { facts: rollFact(finalDc) } : {}),
  };
}

const COMBAT_BEAT: CombatBeatLog = {
  round: 2, band: 'clean', enemyHpBefore: 6, enemyHpAfter: 0, playerHpDelta: 0,
  playerD20: 18, playerBonus: 5, dc: 10, enemyD20: 7, enemyBonus: 0, margin: 16,
  materialMutationFired: true, ops: ['set_relation'], marker: 'combat_round',
};

/** A non-null character is what makes the renderer take the combat-card branch over the roll header. */
const COMBAT_CHAR = {
  name: 'Aldric', health: 12, maxHealth: 12, stamina: 10, maxStamina: 10, rollsRemaining: 1, wealth: 5,
} as unknown as CharacterData;

/** A fight's terminal outcome: the card replaces the text roll header, so only the envelope carries the DC. */
function combatResponse(finalDc: number): GameResponse {
  const outcome: ActionOutcome = {
    distilledType: 'combat',
    finalDc,
    playerRolled: 18,
    rollBonus: 5,
    outcome: 'success',
    outcomeText: 'You defeat the goblin.',
    mutations: [],
    combatBeat: COMBAT_BEAT,
    combatRounds: [COMBAT_BEAT],
  };
  return {
    v: 1,
    ok: true,
    view: buildOutcomeView(outcome, COMBAT_CHAR, null, { rawInput: 'Fight the goblin', decisions: [] }),
    facts: rollFact(finalDc, 18, 5),
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

/** A free action that ended in a fight, written as the start dispatch plus its terminal choose beat. */
function freeFight(seq: number, dc: number): ProtocolDispatchEntry[] {
  return [
    dispatch(seq, { type: 'action.custom', playerId: USER, text: 'Fight the goblin' }, { v: 1, ok: true }),
    dispatch(seq + 1, { type: 'action.choose', playerId: USER, selector: { kind: 'option', index: 0 } }, combatResponse(dc)),
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
    expect(reading.gaps).toBe(0);
    expect(reading.outside).toBe(0);
  });

  it('bands a combat outcome, whose terminal card renders no roll header', () => {
    const transcript = transcriptWith(...freeFight(1, 21));

    // The reason a prose reading missed every fight: no `  vs  21  →  ` line is rendered at all.
    const view = transcript.protocol[1].kind === 'dispatch' ? transcript.protocol[1].response : null;
    expect(view?.ok && view.view?.screen === 'outcome' ? view.view.outcomeBlock : '').not.toContain('vs 21');

    expect(transcript.difficultyBands()).toMatchObject({
      resolutions: 1,
      rolled: 1,
      byBand: { routine: 0, hard: 0, daunting: 1 },
      max: { dc: 21, band: 'daunting' },
    });
  });

  it("counts the ladder's own gaps separately from the DCs outside its ends", () => {
    const inGaps = transcriptWith(...free(1, 14), ...free(3, 19));

    expect(inGaps.difficultyBands()).toMatchObject({
      byBand: { routine: 0, hard: 0, daunting: 0 },
      gaps: 2,
      outside: 0,
    });

    const pastEnds = transcriptWith(...free(1, 10), ...free(3, 25));

    expect(pastEnds.difficultyBands()).toMatchObject({ gaps: 0, outside: 2 });
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

  it('states the ladder, the unbanded counts and the distribution', () => {
    const text = formatDifficultyBands(reading);
    expect(text).toContain('routine 11-13: 1  hard 16-18: 0  daunting 20-24: 1');
    expect(text).toContain("unbanded: 1 in the ladder's gaps, 0 outside it");
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
