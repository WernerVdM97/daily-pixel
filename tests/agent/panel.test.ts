/**
 * T6 — the panel aggregation (spec § G/§ H, contract §9, `src/agent/panel.ts`). The panel is the
 * instrument the whole rework exists to produce, and it is an OFFLINE reader: nothing here touches a
 * live run or the network. Most of these tests call the pure aggregation functions directly, which is
 * the point of splitting them out of the CLI (T9 depends on that).
 *
 * The rules that would go wrong silently, and so are pinned hardest:
 *
 * - `unobserved` is excluded from a rubric mean and counted as coverage's absence, and a criterion
 *   NOBODY could score reports coverage 0 with no mean at all — not 0, not NaN (spec § Risks);
 * - friction dedupe collapses one grievance repeated by many personas into one theme WITH a persona
 *   count, and the exposure weights are what make a single daily ritual outrank a panel of once-ons;
 * - `verbs` (move kinds) is the exact table the anti-theatre check reads, and `actionVerbs` is
 *   reported as an observed, model-authored label table — never as a vocabulary comparison.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACTION_VERB_NOTE,
  EXPOSURE_NOTE,
  PANEL_FILE_VERSION,
  PanelInputError,
  RECURRENCE_WEIGHT,
  SPARK_GLYPHS,
  aggregateActionVerbs,
  aggregateComposition,
  aggregateCost,
  aggregateDistinctiveness,
  aggregateFrictions,
  aggregateFulfilment,
  aggregateHistogram,
  aggregatePanel,
  aggregateRubric,
  aggregateScores,
  aggregateSeries,
  isNothingAnswer,
  normalizePhrase,
  parseReviewFile,
  partitionFrictions,
  readReviewDirectory,
  renderPanelMarkdown,
  sparkline,
} from '../../src/agent/panel.js';
import { REVIEW_FILE_VERSION, type ReviewFile } from '../../src/agent/reviewFile.js';
import { PROTOCOL_VERSION } from '../../src/protocol/envelope.js';
import type { PersonaReview, PersonaScores, PersonaRubric } from '../../src/agent/PlaytestCriticGateway.js';
import type { Recurrence } from '../../src/agent/AgentPlayerGateway.js';
import type { LlmCostSummary } from '../../src/agent/llmCostSummary.js';
import type { DayNoteEvent, FrictionEvent } from '../../src/agent/transcript.js';

// ── Fixtures: a synthetic review file, built the way T5's `buildReviewFile` builds one ──

interface ReviewFileOptions {
  persona: string;
  /** One entry per day note; `arcNote` defaults to a persona-specific line. */
  days?: Array<{ day: number; engagement: number; fulfilment: number; arcNote?: string }>;
  rubric?: Partial<PersonaRubric>;
  scores?: Partial<PersonaScores>;
  building?: string;
  quitHorizon?: string;
  quitTrigger?: string;
  verdict?: PersonaReview['verdict'];
  returnTomorrow?: PersonaReview['returnTomorrow'];
  frictions?: Array<{ dayNumber: number; what: string; severity: number; recurrence: Recurrence }>;
  verbs?: Record<string, number>;
  actionVerbs?: Record<string, number>;
  cost?: Record<string, [calls: number, tokens: number]>;
}

export function reviewFile(options: ReviewFileOptions): ReviewFile {
  const days = options.days ?? [{ day: 1, engagement: 4, fulfilment: 3 }];
  const dayNotes: DayNoteEvent[] = days.map((d) => ({
    type: 'day-note',
    dayNumber: d.day,
    engagement: d.engagement,
    fulfilment: d.fulfilment,
    line: `day ${d.day} on the road`,
    arcNote: d.arcNote ?? `${options.persona} is chasing its own thread`,
  }));
  const frictions: FrictionEvent[] = (options.frictions ?? []).map((f) => ({ type: 'friction', ...f }));
  return {
    v: REVIEW_FILE_VERSION,
    persona: options.persona,
    header: {
      seq: 0,
      kind: 'header',
      v: PROTOCOL_VERSION,
      userId: `agent:play-${options.persona}`,
      brain: 'scripted',
      backend: 'stub',
      recordedAt: '2026-09-13T10:00:00.000Z',
      persona: options.persona,
    },
    summary: {
      turns: 10,
      outcomes: 4,
      deadEnds: 1,
      commutes: 1,
      dayBoundaries: days.length,
      greetings: days.length,
      recons: 2,
      frictions: frictions.length,
      findings: { error: 0, warning: 1 },
    },
    review: {
      persona: options.persona,
      rubric: {
        ritualPull: 4,
        visibleStakes: 3,
        somethingToBuild: 3,
        aliveness: 'unobserved',
        memory: 'unobserved',
        ...options.rubric,
      },
      scores: { engagement: 4, fulfilment: 3, clarity: 3, challenge: 3, variety: 3, ...options.scores },
      returnTomorrow: options.returnTomorrow ?? 'probably',
      hook: 'the Oath thread',
      building: options.building ?? `a ${options.persona} thread`,
      quitTrigger: options.quitTrigger ?? `${options.persona} leaves when the night never changes`,
      quitHorizon: options.quitHorizon ?? 'week 2',
      engaging: ['the first patrol'],
      boring: ['the walk back'],
      clunky: ['the menu'],
      best: 'the first patrol',
      worst: 'the fourth identical menu',
      verdict: options.verdict ?? 'would play again tomorrow',
      review: 'A short review in the persona voice.',
    },
    dayNotes,
    frictions,
    verbs: options.verbs ?? { 'menu-pick': 3, custom: 1 },
    actionVerbs: options.actionVerbs ?? { chore: 2, patrol: 1 },
    arcNotes: dayNotes.map((d) => d.arcNote),
    cost: cost(options.cost ?? { brain: [10, 1000], critic: [2, 500] }),
  };
}

function cost(parts: Record<string, [calls: number, tokens: number]>): LlmCostSummary {
  const totalCalls = Object.values(parts).reduce((sum, [calls]) => sum + calls, 0);
  const totalTokens = Object.values(parts).reduce((sum, [, tokens]) => sum + tokens, 0);
  return {
    totalCalls,
    totalTokens,
    byCallKind: Object.entries(parts).map(([callKind, [calls, tokens]]) => ({
      callKind,
      calls,
      tokens,
      callShare: totalCalls > 0 ? calls / totalCalls : 0,
      tokenShare: totalTokens > 0 ? tokens / totalTokens : 0,
    })),
    criticVerdicts: [],
    criticByBeat: [],
    actionableCritic: 0,
    actionableCriticLegacyCount: 0,
    actionableCriticNote: '',
  };
}

const criterionOf = (reviews: ReviewFile[], criterion: string) =>
  aggregateRubric(reviews).criteria.find((c) => c.criterion === criterion)!;

// ── The rubric matrix: `unobserved` excluded from the mean, counted as coverage's absence ──

describe('rubric aggregation (spec § Risks: `unobserved` is load-bearing)', () => {
  it('excludes `unobserved` from the mean while coverage counts only what was scored', () => {
    const reviews = [
      reviewFile({ persona: 'explorer', rubric: { aliveness: 4, memory: 'unobserved' } }),
      reviewFile({ persona: 'socialite', rubric: { aliveness: 2, memory: 'unobserved' } }),
      reviewFile({ persona: 'tourist', rubric: { aliveness: 'unobserved', memory: 'unobserved' } }),
    ];
    const aliveness = criterionOf(reviews, 'aliveness');
    // 3 personas, only 2 could score it: the mean is over 3.0 only because (4+2)/2, not (4+2+0)/3.
    expect(aliveness).toEqual({ criterion: 'aliveness', coverage: 2, unobserved: 1, mean: 3 });
    const memory = criterionOf(reviews, 'memory');
    expect(memory.coverage).toBe(0);
    expect(memory.unobserved).toBe(3);
  });

  it('reports coverage 0 and NO mean for a criterion nobody could score — not 0, not NaN', () => {
    const reviews = [
      reviewFile({ persona: 'explorer', rubric: { aliveness: 'unobserved' } }),
      reviewFile({ persona: 'socialite', rubric: { aliveness: 'unobserved' } }),
    ];
    const aliveness = criterionOf(reviews, 'aliveness');
    expect(aliveness.coverage).toBe(0);
    expect(aliveness.mean).toBeNull();
    expect(Number.isNaN(aliveness.mean as unknown as number)).toBe(false);

    // ...and the report says so in words, so a reader cannot take a blank for a zero.
    const markdown = renderPanelMarkdown(aggregatePanel(reviews));
    expect(markdown).toContain('| aliveness | — (nobody could score it) | 0/2 | 2 |');
    expect(markdown).not.toContain('NaN');
  });

  it('carries every persona x criterion cell plus the per-criterion means', () => {
    const reviews = [
      reviewFile({ persona: 'grinder', rubric: { ritualPull: 5, somethingToBuild: 4 } }),
      reviewFile({ persona: 'casual', rubric: { ritualPull: 1, somethingToBuild: 2 } }),
    ];
    const { rows, criteria } = aggregateRubric(reviews);
    expect(rows).toEqual([
      {
        persona: 'grinder',
        values: {
          ritualPull: 5,
          visibleStakes: 3,
          somethingToBuild: 4,
          aliveness: 'unobserved',
          memory: 'unobserved',
        },
      },
      {
        persona: 'casual',
        values: {
          ritualPull: 1,
          visibleStakes: 3,
          somethingToBuild: 2,
          aliveness: 'unobserved',
          memory: 'unobserved',
        },
      },
    ]);
    expect(criteria.find((c) => c.criterion === 'ritualPull')?.mean).toBe(3);
    expect(criteria.find((c) => c.criterion === 'visibleStakes')).toEqual({
      criterion: 'visibleStakes',
      coverage: 2,
      unobserved: 0,
      mean: 3,
    });
  });
});

// ── The score matrix ──

describe('score matrix (spec § H)', () => {
  it('reports all five scores, the verdict and the parsed quit horizon per persona', () => {
    const rows = aggregateScores([
      reviewFile({
        persona: 'soldier',
        scores: { engagement: 5, fulfilment: 4, clarity: 3, challenge: 5, variety: 2 },
        verdict: 'would play again tomorrow',
        quitHorizon: 'in about week 2',
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].scores).toEqual({ engagement: 5, fulfilment: 4, clarity: 3, challenge: 5, variety: 2 });
    expect(rows[0].verdict).toBe('would play again tomorrow');
    expect(rows[0].quitHorizon).toMatchObject({ kind: 'week', n: 2, days: 14, raw: 'in about week 2' });
  });

  it('orders personas by churn horizon, soonest first, via T5\'s parser', () => {
    const rows = aggregateScores([
      reviewFile({ persona: 'lapsed-returner', quitHorizon: 'never on this evidence' }),
      reviewFile({ persona: 'casual', quitHorizon: 'day 3' }),
      reviewFile({ persona: 'storyteller', quitHorizon: 'month 3' }),
      reviewFile({ persona: 'tourist', quitHorizon: 'it depends, honestly' }),
      reviewFile({ persona: 'collector', quitHorizon: 'week 1' }),
    ]);
    expect(rows.map((r) => r.persona)).toEqual([
      'casual',
      'collector',
      'storyteller',
      'lapsed-returner',
      // Unreadable phrasing sorts LAST: unread evidence is not a long horizon.
      'tourist',
    ]);
    expect(rows.map((r) => r.quitHorizon.kind)).toEqual(['day', 'week', 'month', 'never', 'unknown']);
  });
});

// ── The series and the sparkline ──

describe('engagement / fulfilment series (spec § G)', () => {
  it('renders a sparkline over the 1-5 scale, single day and flat series included', () => {
    expect(sparkline([])).toBe('');
    expect(sparkline([4])).toBe(SPARK_GLYPHS[Math.round((3 / 4) * 7)]);
    expect(sparkline([4])).toHaveLength(1);
    // A flat series is a flat line of one glyph — the run that never moved.
    expect(new Set(sparkline([4, 4, 4, 4]))).toEqual(new Set([sparkline([4])[0]]));
    // A full sweep uses the whole ramp, monotonically.
    const ramp = sparkline([1, 2, 3, 4, 5]);
    expect(ramp[0]).toBe(SPARK_GLYPHS[0]);
    expect(ramp[4]).toBe(SPARK_GLYPHS[SPARK_GLYPHS.length - 1]);
    expect([...ramp].sort()).toEqual([...ramp]); // non-decreasing
    // Out-of-range input is clamped, never indexing off the ramp.
    expect(sparkline([0, 9])).toBe(SPARK_GLYPHS[0] + SPARK_GLYPHS[SPARK_GLYPHS.length - 1]);
  });

  it('carries the numbers as well as the glyphs, in day order, for each persona', () => {
    const rows = aggregateSeries([
      reviewFile({
        persona: 'homesteader',
        days: [
          { day: 1, engagement: 4, fulfilment: 4 },
          { day: 2, engagement: 4, fulfilment: 3 },
          { day: 3, engagement: 4, fulfilment: 2 },
        ],
      }),
    ]);
    expect(rows[0].days).toEqual([1, 2, 3]);
    expect(rows[0].engagement).toEqual([4, 4, 4]);
    expect(rows[0].fulfilment).toEqual([4, 3, 2]);
    // The shape that predicts churn: engagement holds while fulfilment slides, and it is legible
    // from the digits alone.
    expect(new Set(rows[0].engagementSpark).size).toBe(1);
    expect(new Set(rows[0].fulfilmentSpark).size).toBeGreaterThan(1);
    expect(rows[0].fulfilmentSpark[0]).not.toBe(rows[0].fulfilmentSpark[2]);
  });

  it('leaves a run with no day notes visibly empty rather than fabricating a series', () => {
    const rows = aggregateSeries([reviewFile({ persona: 'casual', days: [] })]);
    expect(rows[0].engagement).toEqual([]);
    expect(rows[0].engagementSpark).toBe('');
    expect(renderPanelMarkdown(aggregatePanel([reviewFile({ persona: 'casual', days: [] })]))).toContain(
      '| casual | — | — | — |',
    );
  });

  it('lists the days when the series has a hole rather than printing a range that hides it', () => {
    const gap = reviewFile({
      persona: 'storyteller',
      days: [
        { day: 1, engagement: 4, fulfilment: 3 },
        { day: 3, engagement: 3, fulfilment: 2 },
      ],
    });
    expect(renderPanelMarkdown(aggregatePanel([gap]))).toContain('| storyteller | days 1, 3 |');
    const whole = reviewFile({
      persona: 'storyteller',
      days: [
        { day: 1, engagement: 4, fulfilment: 3 },
        { day: 2, engagement: 3, fulfilment: 2 },
      ],
    });
    expect(renderPanelMarkdown(aggregatePanel([whole]))).toContain('| storyteller | days 1-2 |');
  });
});

// ── Friction: dedupe, exposure, and the ritual split ──

describe('friction themes by exposure (contract §9)', () => {
  it('collapses the same grievance from several personas into ONE theme with a persona count', () => {
    const themes = aggregateFrictions([
      reviewFile({
        persona: 'explorer',
        frictions: [{ dayNumber: 1, what: 'The menu re-offers the same three jobs!', severity: 2, recurrence: 'periodic' }],
      }),
      reviewFile({
        persona: 'soldier',
        frictions: [{ dayNumber: 1, what: 'the menu  re offers the same three jobs', severity: 3, recurrence: 'once' }],
      }),
      reviewFile({
        persona: 'grinder',
        frictions: [
          { dayNumber: 1, what: 'The menu re-offers the same three jobs.', severity: 4, recurrence: 'once' },
          // The same persona reporting it twice counts twice in `count`, once in `personaCount`.
          { dayNumber: 2, what: 'THE MENU RE-OFFERS THE SAME THREE JOBS', severity: 4, recurrence: 'once' },
        ],
      }),
    ]);
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({
      label: 'The menu re-offers the same three jobs!',
      personaCount: 3,
      count: 4,
      worstSeverity: 4,
      recurrences: ['once', 'periodic'],
      personas: ['explorer', 'soldier', 'grinder'],
      ritual: false,
    });
    expect(themes[0].theme).toBe('the menu re offers the same three jobs');
  });

  it('separates anything tagged `ritual` by anyone from the rest', () => {
    const themes = aggregateFrictions([
      reviewFile({
        persona: 'homesteader',
        frictions: [{ dayNumber: 1, what: 'Cosy play has nowhere to go', severity: 2, recurrence: 'once' }],
      }),
      reviewFile({
        persona: 'lapsed-returner',
        frictions: [{ dayNumber: 1, what: 'Catching up gives me nothing to catch up on', severity: 2, recurrence: 'ritual' }],
      }),
    ]);
    const { ritual, other } = partitionFrictions(themes);
    expect(ritual.map((t) => t.label)).toEqual(['Catching up gives me nothing to catch up on']);
    expect(other.map((t) => t.label)).toEqual(['Cosy play has nowhere to go']);
    expect(ritual[0].ritual).toBe(true);
    expect(other[0].ritual).toBe(false);
    // Both lists stay exposure-ranked.
    expect(ritual[0].exposure).toBeGreaterThan(other[0].exposure);

    // ONE ritual tag is enough to move a theme the whole panel reported, because the ritual reading
    // is about that one player meeting it every session.
    const mixed = partitionFrictions(
      aggregateFrictions([
        reviewFile({
          persona: 'explorer',
          frictions: [{ dayNumber: 1, what: 'Nothing at the Oak changes', severity: 2, recurrence: 'once' }],
        }),
        reviewFile({
          persona: 'homesteader',
          frictions: [{ dayNumber: 1, what: 'nothing at the Oak changes!', severity: 3, recurrence: 'ritual' }],
        }),
      ]),
    );
    expect(mixed.ritual).toHaveLength(1);
    expect(mixed.other).toEqual([]);
    expect(mixed.ritual[0]).toMatchObject({ personaCount: 2, worstSeverity: 3, recurrences: ['once', 'ritual'] });
  });

  it('ranks by exposure, so one persona meeting a defect daily outranks many meeting it once', () => {
    const once = (persona: string) =>
      reviewFile({
        persona,
        frictions: [{ dayNumber: 1, what: 'The unsafe-ground copy doubles an article', severity: 5, recurrence: 'once' }],
      });
    const themes = aggregateFrictions([
      once('explorer'),
      once('socialite'),
      once('soldier'),
      once('grinder'),
      once('collector'),
      reviewFile({
        persona: 'casual',
        frictions: [{ dayNumber: 1, what: 'Two minutes pays nothing', severity: 1, recurrence: 'ritual' }],
      }),
    ]);
    expect(themes.map((t) => t.label)).toEqual([
      'Two minutes pays nothing',
      'The unsafe-ground copy doubles an article',
    ]);
    // Severity 5 x once x 5 personas = 25; severity 1 x ritual x 1 persona = 180.
    expect(themes[0].exposure).toBe(1 * RECURRENCE_WEIGHT.ritual * 1);
    expect(themes[1].exposure).toBe(5 * RECURRENCE_WEIGHT.once * 5);
    expect(themes[0].exposure).toBeGreaterThan(themes[1].exposure);

    // And the periodic band sits between the two, which is what "a watch item" means.
    const periodic = aggregateFrictions([
      reviewFile({
        persona: 'casual',
        frictions: [{ dayNumber: 1, what: 'A periodic clunk', severity: 2, recurrence: 'periodic' }],
      }),
      once('explorer'),
    ]);
    expect(periodic.map((t) => t.exposure)).toEqual([2 * RECURRENCE_WEIGHT.periodic, 5]);
    expect(periodic[0].exposure).toBeGreaterThan(periodic[1].exposure);
  });

  it('ignores an empty/whitespace `what` rather than ranking an unlabelled theme', () => {
    const themes = aggregateFrictions([
      reviewFile({ persona: 'explorer', frictions: [{ dayNumber: 1, what: '   ', severity: 5, recurrence: 'ritual' }] }),
    ]);
    expect(themes).toEqual([]);
  });

  it('normalises phrases by case, punctuation and whitespace only', () => {
    expect(normalizePhrase('The menu "re-offers" the same  3 jobs!')).toBe('the menu re offers the same 3 jobs');
    // A different grievance stays different — the panel does not invent a linguistic merge.
    expect(normalizePhrase('the menu repeats itself')).not.toBe(normalizePhrase('the menu re offers the same 3 jobs'));
  });
});

// ── The fulfilment signal ──

describe('fulfilment signal (spec § F/§ G)', () => {
  it('counts the personas who named something and the personas who answered nothing', () => {
    const signal = aggregateFulfilment([
      reviewFile({ persona: 'explorer', building: 'the Shrine of the First Flame thread' }),
      reviewFile({ persona: 'collector', building: 'a complete map of the eleven locations' }),
      reviewFile({ persona: 'casual', building: 'Nothing.' }),
      reviewFile({ persona: 'tourist', building: 'none' }),
    ]);
    expect(signal.namedCount).toBe(2);
    expect(signal.nothingCount).toBe(2);
    expect(signal.nothing).toEqual(['casual', 'tourist']);
    expect(signal.named.map((n) => n.persona)).toEqual(['explorer', 'collector']);
  });

  it('does not read a hedged but real answer as nothing', () => {
    expect(isNothingAnswer('nothing')).toBe(true);
    expect(isNothingAnswer('Nothing at all — I could stop tomorrow')).toBe(true);
    expect(isNothingAnswer('')).toBe(true);
    // A real thread that opens with a negation is NOT nothing: inflating this count would turn a
    // panel of eight threads into the long-arc verdict it is not.
    expect(isNothingAnswer('no thread yet, but the Warden\u2019s charge nags at me')).toBe(false);
    expect(isNothingAnswer('nothing much beyond the patrol, which I would miss')).toBe(true);
  });

  it('promotes the nothing-count into the panel header', () => {
    const reviews = [1, 2, 3].map((i) => reviewFile({ persona: `p${i}`, building: 'nothing' }));
    const markdown = renderPanelMarkdown(aggregatePanel(reviews));
    expect(markdown).toContain('0 of 3 persona(s) could name something they were building; 3 answered with nothing');
  });
});

// ── The anti-theatre check ──

describe('anti-theatre check (spec § A, contract §9)', () => {
  it('reports an exact move-kind histogram with a column per kind, free-text share included', () => {
    const { kinds, rows } = aggregateHistogram([
      reviewFile({ persona: 'explorer', verbs: { 'menu-pick': 3, custom: 5, recon: 2 } }),
      reviewFile({ persona: 'casual', verbs: { 'menu-pick': 4, sleep: 1 } }),
    ]);
    expect(kinds).toEqual(['menu-pick', 'custom', 'choice', 'bail', 'sleep', 'recon']);
    expect(rows[0].total).toBe(10);
    expect(rows[0].kinds.choice).toBe(0);
    expect(rows[0].freeTextShare).toBeCloseTo(0.5);
    // The baseline arm's headline: the free-text slot used zero times.
    expect(rows[1].freeTextShare).toBe(0);
  });

  it('carries a kind it has never heard of instead of dropping the run\'s turn', () => {
    const { kinds, rows } = aggregateHistogram([reviewFile({ persona: 'zebra', verbs: { 'menu-pick': 1, wander: 2 } })]);
    expect(kinds).toContain('wander');
    expect(rows[0].total).toBe(3);
  });

  it('reports `actionVerbs` as an observed label table, most frequent first', () => {
    const rows = aggregateActionVerbs([
      reviewFile({ persona: 'grinder', actionVerbs: { chore: 4, patrol: 2, haggle: 2 } }),
    ]);
    expect(rows[0].total).toBe(8);
    expect(rows[0].labels).toEqual([
      { label: 'chore', count: 4 },
      { label: 'haggle', count: 2 },
      { label: 'patrol', count: 2 },
    ]);
    // The caveat is IN the output: these labels are the model's words, not a vocabulary.
    const markdown = renderPanelMarkdown(aggregatePanel([reviewFile({ persona: 'grinder' })]));
    expect(markdown).toContain(ACTION_VERB_NOTE);
    expect(ACTION_VERB_NOTE).toContain('MODEL-AUTHORED');
    expect(ACTION_VERB_NOTE).toContain('distilledType');
  });

  it('flags an arcNote or quitTrigger shared by two personas, and counts the distinct ones', () => {
    const distinct = aggregateDistinctiveness([
      reviewFile({ persona: 'a', quitTrigger: 'the night never changes', days: [{ day: 1, engagement: 3, fulfilment: 3, arcNote: 'thread A' }] }),
      reviewFile({ persona: 'b', quitTrigger: 'nothing escalates', days: [{ day: 1, engagement: 3, fulfilment: 3, arcNote: 'thread B' }] }),
    ]);
    expect(distinct.distinctArcNotes).toBe(2);
    expect(distinct.distinctQuitTriggers).toBe(2);
    expect(distinct.duplicateArcNotes).toEqual([]);
    expect(distinct.rows.every((r) => !r.arcNoteShared && !r.quitTriggerShared)).toBe(true);

    const shared = aggregateDistinctiveness([
      reviewFile({ persona: 'a', quitTrigger: 'The night never changes.', days: [{ day: 1, engagement: 3, fulfilment: 3, arcNote: 'the same arc line' }] }),
      reviewFile({ persona: 'b', quitTrigger: 'the night never changes', days: [{ day: 1, engagement: 3, fulfilment: 3, arcNote: 'The same arc line!' }] }),
      reviewFile({ persona: 'c', quitTrigger: 'no other player', days: [{ day: 1, engagement: 3, fulfilment: 3, arcNote: 'its own arc' }] }),
    ]);
    expect(shared.distinctArcNotes).toBe(2);
    expect(shared.duplicateArcNotes).toEqual([{ value: 'the same arc line', personas: ['a', 'b'] }]);
    expect(shared.duplicateQuitTriggers).toEqual([{ value: 'the night never changes', personas: ['a', 'b'] }]);
    expect(shared.rows.filter((r) => r.arcNoteShared).map((r) => r.persona)).toEqual(['a', 'b']);
    expect(shared.rows.find((r) => r.persona === 'c')?.quitTriggerShared).toBe(false);
  });

  it('records a run that never wrote an arc note as a gap, not as a duplicate', () => {
    const result = aggregateDistinctiveness([
      reviewFile({ persona: 'casual', days: [] }),
      reviewFile({ persona: 'tourist', days: [] }),
    ]);
    expect(result.distinctArcNotes).toBe(0);
    expect(result.duplicateArcNotes).toEqual([]);
    expect(result.missingArcNotes).toEqual(['casual', 'tourist']);
    expect(renderPanelMarkdown(aggregatePanel([reviewFile({ persona: 'casual', days: [] })]))).toContain(
      'no closing arcNote at all: casual',
    );
  });
});

// ── Cost, composition, and the assembled report ──

describe('cost, composition and the assembled report', () => {
  it('totals the per-run cost every review file carries, merging call kinds', () => {
    const total = aggregateCost([
      reviewFile({ persona: 'a', cost: { brain: [10, 1000], critic: [2, 400] } }),
      reviewFile({ persona: 'b', cost: { brain: [12, 1500], critic: [1, 200] } }),
    ]);
    expect(total.runs).toBe(2);
    expect(total.totalCalls).toBe(25);
    expect(total.totalTokens).toBe(3100);
    expect(total.byCallKind[0]).toEqual({
      callKind: 'brain',
      calls: 22,
      tokens: 2500,
      callShare: 22 / 25,
      tokenShare: 2500 / 3100,
    });
    expect(total.perRun).toEqual([
      { persona: 'a', calls: 12, tokens: 1400 },
      { persona: 'b', calls: 13, tokens: 1700 },
    ]);
  });

  it('states the panel\'s own composition, and calls a one-day panel a breadth one', () => {
    const breadth = aggregateComposition([
      reviewFile({ persona: 'a', days: [{ day: 1, engagement: 3, fulfilment: 3 }] }),
      reviewFile({ persona: 'b', days: [{ day: 1, engagement: 3, fulfilment: 3 }] }),
    ]);
    expect(breadth).toEqual({
      personas: 2,
      shapes: [{ label: 'breadth', personas: 2, days: [1, 1] }],
      personaDays: 2,
    });

    const arc = aggregateComposition([
      reviewFile({ persona: 'a', days: [1, 2, 3, 4, 5, 6].map((day) => ({ day, engagement: 4, fulfilment: 3 })) }),
      reviewFile({ persona: 'b', days: [1, 2, 3, 4, 5, 6].map((day) => ({ day, engagement: 4, fulfilment: 3 })) }),
      reviewFile({ persona: 'c', days: [{ day: 1, engagement: 3, fulfilment: 3 }] }),
    ]);
    expect(arc.shapes).toEqual([
      { label: 'breadth', personas: 1, days: [1] },
      { label: 'arc', personas: 2, days: [6, 6] },
    ]);
    expect(arc.personaDays).toBe(13);
    const markdown = renderPanelMarkdown(aggregatePanel([
      reviewFile({ persona: 'a', days: [{ day: 1, engagement: 3, fulfilment: 3 }] }),
    ]));
    expect(markdown).toContain('1 persona(s) over 1 persona-day(s): 1 breadth (1 day each)');
    expect(markdown).toContain('no memory, no co-play and no content exhaustion');
  });

  it('assembles every section, and refuses to aggregate nothing at all', () => {
    const report = aggregatePanel([
      reviewFile({
        persona: 'explorer',
        frictions: [{ dayNumber: 1, what: 'The map has no edges I cannot see', severity: 2, recurrence: 'periodic' }],
      }),
      reviewFile({ persona: 'casual', building: 'nothing', verdict: 'would churn', quitHorizon: 'day 2' }),
    ]);
    expect(report.v).toBe(PANEL_FILE_VERSION);
    expect(report.runs.map((r) => r.persona)).toEqual(['explorer', 'casual']);
    expect(report.friction.exposureNote).toBe(EXPOSURE_NOTE);
    expect(report.histogram.rows).toHaveLength(2);
    expect(() => aggregatePanel([])).toThrow(PanelInputError);

    const markdown = renderPanelMarkdown(report);
    for (const heading of [
      '# Agent-player panel',
      '## What this panel cannot say',
      '## Score matrix',
      '## Rubric matrix',
      '## Engagement and fulfilment series',
      '## Friction by exposure',
      '### Ritual: met every session by someone',
      '### Everything else',
      '## Fulfilment signal',
      '## Anti-theatre check',
      '### Move kinds (what the brain chose)',
      '### Observed action labels (model-authored)',
      '### arcNote / quitTrigger distinctiveness',
      '## Runs and cost',
    ]) {
      expect(markdown).toContain(heading);
    }
    // A panel's own header must not claim more than a day-one panel can say.
    expect(markdown).toContain('onboarding instrument');
    expect(markdown).toContain('not a verdict on month three');
  });
});

// ── Input validation: a bad file is an error, never a silent skip ──

describe('review-file input (contract §9)', () => {
  it('rejects a reviews file whose `v` this panel does not read', () => {
    const file = reviewFile({ persona: 'explorer' });
    expect(() => parseReviewFile({ ...file, v: REVIEW_FILE_VERSION + 1 }, 'x.reviews.json')).toThrow(PanelInputError);
    expect(() => parseReviewFile({ ...file, v: REVIEW_FILE_VERSION + 1 }, 'x.reviews.json')).toThrow(/version 2/);
    expect(parseReviewFile(file, 'x.reviews.json')).toBe(file);
  });

  it('rejects a file missing the fields the aggregation reads', () => {
    const file = reviewFile({ persona: 'explorer' });
    expect(() => parseReviewFile(null, 'n.reviews.json')).toThrow(/not a JSON object/);
    expect(() => parseReviewFile({ ...file, v: undefined }, 'n.reviews.json')).toThrow(/missing numeric "v"/);
    expect(() => parseReviewFile({ ...file, persona: '' }, 'n.reviews.json')).toThrow(/missing "persona"/);
    expect(() => parseReviewFile({ ...file, dayNotes: undefined }, 'n.reviews.json')).toThrow(/missing "dayNotes"/);
    expect(() => parseReviewFile({ ...file, review: { ...file.review, quitHorizon: 3 } }, 'n.reviews.json')).toThrow(
      /missing "review.quitHorizon"/,
    );
  });

  it('reads a directory of review files, and fails loud on empty or unreadable ones', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'oak-panel-'));
    try {
      expect(() => readReviewDirectory(dir)).toThrow(/no \*.reviews\.json files/);
      expect(() => readReviewDirectory(path.join(dir, 'nope'))).toThrow(/cannot read directory/);

      const pathA = path.join(dir, 'a.json.reviews.json');
      writeFileSync(pathA, JSON.stringify(reviewFile({ persona: 'explorer' })));
      expect(readReviewDirectory(dir).map((r) => r.persona)).toEqual(['explorer']);

      // A second file for the same persona would double every number it appears in.
      writeFileSync(path.join(dir, 'b.json.reviews.json'), JSON.stringify(reviewFile({ persona: 'explorer' })));
      expect(() => readReviewDirectory(dir)).toThrow(/already read from/);

      // An unparseable file stops the panel rather than quietly shrinking it.
      writeFileSync(path.join(dir, 'b.json.reviews.json'), '{ not json');
      expect(() => readReviewDirectory(dir)).toThrow(/cannot read\/parse/);

      // A version mismatch is named, with both versions, so the reader knows what to do.
      writeFileSync(path.join(dir, 'b.json.reviews.json'), JSON.stringify({ ...reviewFile({ persona: 'casual' }), v: 9 }));
      expect(() => readReviewDirectory(dir)).toThrow(/reviews-file version 9 but this panel reads version 1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
