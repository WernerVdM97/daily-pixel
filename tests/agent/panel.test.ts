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
 * - friction grouping is by SIMILARITY, not exact text, because the design rule the section exists to
 *   apply ("raised by one persona is taste; raised by four is a design finding") is invisible when
 *   four personas word one defect four ways — and the merge has to stay conservative, because a
 *   wrongly merged theme HIDES a finding where a split one merely under-ranks it;
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
  FRICTION_MERGE_THRESHOLD,
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
  aggregateRuns,
  aggregateScores,
  aggregateSeries,
  frictionSimilarity,
  frictionTokens,
  isNothingAnswer,
  normalizePhrase,
  orderReviews,
  parseReviewFile,
  partitionFrictions,
  readReviewDirectory,
  renderPanelMarkdown,
  runLength,
  sparkline,
} from '../../src/agent/panel.js';
import { REVIEW_FILE_VERSION, type ReviewFile } from '../../src/agent/reviewFile.js';
import { PROTOCOL_VERSION } from '../../src/protocol/envelope.js';
import type { PersonaReview, PersonaScores, PersonaRubric } from '../../src/agent/PlaytestCriticGateway.js';
import type { Recurrence } from '../../src/agent/AgentPlayerGateway.js';
import type { LlmCostSummary } from '../../src/agent/llmCostSummary.js';
import type { DayNoteEvent, FrictionEvent, TranscriptSummary } from '../../src/agent/transcript.js';

// ── Fixtures: a synthetic review file, built the way T5's `buildReviewFile` builds one ──

interface ReviewFileOptions {
  persona: string;
  /** One entry per day note; `arcNote` defaults to a persona-specific line. */
  days?: Array<{ day: number; engagement: number; fulfilment: number; arcNote?: string }>;
  /** Overrides on the DERIVED summary. The run's length comes from `greetings`/`dayBoundaries`, not
   *  from the notes, so a test that models a lost note must say how many days were played. */
  summary?: Partial<TranscriptSummary>;
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

function reviewFile(options: ReviewFileOptions): ReviewFile {
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
      ...options.summary,
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
    // Canonical order (churn horizon, ties by name) — the same row order as every other section.
    expect(rows).toEqual([
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
      // Unreadable phrasing sorts FIRST: the parser could not read it, and an unread phrase is not
      // evidence of a long horizon, so it must not be shown as the panel's most loyal persona.
      'tourist',
      'casual',
      'collector',
      'storyteller',
      'lapsed-returner',
    ]);
    expect(rows.map((r) => r.quitHorizon.kind)).toEqual(['unknown', 'day', 'week', 'month', 'never']);
  });

  it('says under the table why an unreadable horizon leads, and prints the raw phrase', () => {
    const markdown = renderPanelMarkdown(
      aggregatePanel([
        reviewFile({ persona: 'tourist', quitHorizon: 'it depends, honestly' }),
        reviewFile({ persona: 'casual', quitHorizon: 'day 3' }),
      ]),
    );
    const lines = markdown.split('\n');
    const tableRow = lines.findIndex((l) => l.startsWith('| tourist |'));
    const noteRow = lines.findIndex((l) => l.includes('sort FIRST, not last'));
    expect(noteRow).toBeGreaterThan(-1);
    expect(noteRow).toBeLessThan(tableRow);
    expect(markdown).toContain('an unread phrase is not evidence of a long horizon');
    expect(markdown).toContain('| tourist | 4 | 3 | 3 | 3 | 3 | would play again tomorrow | probably | it depends, honestly |');

    // A panel with no unreadable horizon does not carry the note at all.
    const clean = renderPanelMarkdown(aggregatePanel([reviewFile({ persona: 'casual', quitHorizon: 'day 3' })]));
    expect(clean).not.toContain('sort FIRST, not last');
  });

  it('surfaces `returnTomorrow` and `hook` — the retention half of the churn reading', () => {
    const reviews = [
      reviewFile({ persona: 'explorer', returnTomorrow: 'yes', quitHorizon: 'week 2' }),
      reviewFile({ persona: 'casual', returnTomorrow: 'no', quitHorizon: 'day 2' }),
    ];
    const rows = aggregateScores(reviews);
    expect(rows.map((r) => [r.persona, r.returnTomorrow, r.hook])).toEqual([
      ['casual', 'no', 'the Oath thread'],
      ['explorer', 'yes', 'the Oath thread'],
    ]);

    const report = aggregatePanel(reviews);
    expect(report.scores.every((row) => row.hook !== '')).toBe(true);
    expect(report.scores[0].hook).toBe(reviewFile({ persona: 'x' }).review.hook);

    const markdown = renderPanelMarkdown(report);
    expect(markdown).toContain('## Retention signal');
    expect(markdown).toContain('1 said yes, 0 said probably, 1 said no');
    expect(markdown).toContain('| casual | no | the Oath thread |');
    // ...and the score matrix itself carries the answer, not just the prose section.
    expect(markdown).toContain('| persona | engagement | fulfilment | clarity | challenge | variety | verdict | return tomorrow | quitHorizon |');
    expect(markdown).toContain('| casual | 4 | 3 | 3 | 3 | 3 | would play again tomorrow | no | day 2 |');
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
      '| casual | — | no days rated | — | — |',
    );
  });

  it('lists the days when the series has a hole rather than printing a range that hides it', () => {
    const gap = reviewFile({
      persona: 'storyteller',
      days: [
        { day: 1, engagement: 4, fulfilment: 3 },
        { day: 3, engagement: 3, fulfilment: 2 },
      ],
      summary: { greetings: 3, dayBoundaries: 3 },
    });
    expect(renderPanelMarkdown(aggregatePanel([gap]))).toContain('| storyteller | days 1, 3 | 2 of 3 days rated (no note: day 2) |');
    const whole = reviewFile({
      persona: 'storyteller',
      days: [
        { day: 1, engagement: 4, fulfilment: 3 },
        { day: 2, engagement: 3, fulfilment: 2 },
      ],
    });
    expect(renderPanelMarkdown(aggregatePanel([whole]))).toContain('| storyteller | days 1-2 | 2 of 2 days rated |');
  });
});

// ── The run's length: the summary's, never the highest surviving note ──

describe('the run length comes from the summary, not from the day notes', () => {
  it('does not read a lost note as a shorter run, so a two-day run stays an arc run', () => {
    // The exact failure the harness warns about: day 2 closed with no dayNote captured, so the only
    // note left is day 1. The old form read that as a ONE-DAY run, which flipped the panel's own
    // header to the breadth prose ("it cannot speak to the core goal") under-counted persona-days
    // and hid the hole.
    const lost = reviewFile({
      persona: 'homesteader',
      days: [{ day: 1, engagement: 4, fulfilment: 4 }],
      summary: { greetings: 2, dayBoundaries: 2 },
    });
    expect(runLength(lost)).toEqual({ played: 2, rated: [1], unrated: [2] });
    expect(aggregateComposition([lost])).toEqual({
      personas: 1,
      shapes: [{ label: 'arc', personas: 1, days: [2] }],
      personaDays: 2,
    });
    const markdown = renderPanelMarkdown(aggregatePanel([lost]));
    expect(markdown).toContain('An arc panel is the **retention instrument**');
    expect(markdown).not.toContain('cannot speak to the core goal');
    expect(markdown).toContain('1 persona(s) over 2 persona-day(s): 1 arc (2 days each)');
  });

  it('reads the days played as the max of greetings and day boundaries', () => {
    const days = [1, 2, 3].map((day) => ({ day, engagement: 4, fulfilment: 3 }));
    // A clean five-day run: N greetings and N nightly ticks.
    expect(runLength(reviewFile({ persona: 'a', days, summary: { greetings: 5, dayBoundaries: 5 } })).played).toBe(5);
    // The final day ended non-clean (`stalled`/`crashed`/`no-character`), so it never ticked: N
    // greetings, N-1 boundaries. The greeting is proof the day was played.
    expect(runLength(reviewFile({ persona: 'a', days, summary: { greetings: 5, dayBoundaries: 4 } })).played).toBe(5);
    // A summary that lags its own notes cannot shorten the run either: a run may never be reported
    // as shorter than the series it printed.
    expect(runLength(reviewFile({ persona: 'a', days, summary: { greetings: 1, dayBoundaries: 0 } })).played).toBe(3);
  });

  it('counts the day the note went missing at the END of the series', () => {
    const file = reviewFile({
      persona: 'grinder',
      days: [1, 2, 3].map((day) => ({ day, engagement: 4, fulfilment: 3 })),
      summary: { greetings: 4, dayBoundaries: 4 },
    });
    expect(runLength(file)).toEqual({ played: 4, rated: [1, 2, 3], unrated: [4] });
    const markdown = renderPanelMarkdown(aggregatePanel([file]));
    expect(markdown).toContain('| grinder | days 1-3 | 3 of 4 days rated (no note: day 4) |');
    // The runs table carries the same pair, so the length is never read off the notes.
    expect(markdown).toContain('| grinder | 2026-09-13T10:00:00.000Z | 4 | 3/4 |');
  });

  it('never renders a run with no notes as a 0-day breadth run', () => {
    const unrated = reviewFile({
      persona: 'casual',
      days: [],
      summary: { greetings: 3, dayBoundaries: 3 },
    });
    expect(runLength(unrated)).toEqual({ played: 3, rated: [], unrated: [1, 2, 3] });
    const markdown = renderPanelMarkdown(aggregatePanel([unrated]));
    expect(markdown).toContain('| casual | — | no days rated (no note: days 1-3) | — | — |');
    expect(markdown).toContain('1 arc (3 days each)');
    expect(markdown).toContain('a day that closed unrated was still played');
    expect(markdown).toContain('| casual | 2026-09-13T10:00:00.000Z | 3 | 0/3 |');
  });
});

// ── The arc note over time: spec § G's "the day the arc note stops growing" ──

describe('the per-day arc note series (spec § G)', () => {
  it('carries every day\'s arc note, not just the closing one', () => {
    const rows = aggregateSeries([
      reviewFile({
        persona: 'homesteader',
        days: [
          { day: 1, engagement: 4, fulfilment: 4, arcNote: 'get a routine at the gate' },
          { day: 2, engagement: 4, fulfilment: 4, arcNote: 'get a routine at the gate and a cooked meal' },
          { day: 3, engagement: 4, fulfilment: 3, arcNote: 'get a routine at the gate and a cooked meal' },
        ],
      }),
    ]);
    expect(rows[0].arcNotes).toEqual([
      { day: 1, note: 'get a routine at the gate' },
      { day: 2, note: 'get a routine at the gate and a cooked meal' },
      { day: 3, note: 'get a routine at the gate and a cooked meal' },
    ]);
    // The closing note alone (the old shape) cannot show that day 3 added nothing.
    const markdown = renderPanelMarkdown(
      aggregatePanel([
        reviewFile({
          persona: 'homesteader',
          days: [
            { day: 1, engagement: 4, fulfilment: 4, arcNote: 'get a routine at the gate' },
            { day: 2, engagement: 4, fulfilment: 4, arcNote: 'get a routine at the gate and a cooked meal' },
            { day: 3, engagement: 4, fulfilment: 3, arcNote: 'get a routine at the gate and a cooked meal' },
          ],
        }),
      ]),
    );
    expect(markdown).toContain('### The arc note, day by day');
    expect(markdown).toContain('the day the arc note stops growing');
    expect(markdown).toContain('| homesteader | 1 | get a routine at the gate |');
    expect(markdown).toContain('| homesteader | 3 | get a routine at the gate and a cooked meal |');
  });

  it('pairs each day note with its own arc note even when the notes arrive out of day order', () => {
    const file = reviewFile({
      persona: 'grinder',
      days: [{ day: 2, engagement: 3, fulfilment: 2, arcNote: 'day two' }],
    });
    file.dayNotes.unshift({ ...file.dayNotes[0], dayNumber: 1, arcNote: 'day one' });
    file.arcNotes = ['day one', 'day two'];
    expect(aggregateSeries([file])[0].arcNotes).toEqual([
      { day: 1, note: 'day one' },
      { day: 2, note: 'day two' },
    ]);
  });

  it('says there was no arc note series rather than printing an empty table', () => {
    expect(renderPanelMarkdown(aggregatePanel([reviewFile({ persona: 'casual', days: [] })]))).toContain(
      '_No day notes, so no arc note was recorded._',
    );
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
      // Personas are listed in the panel's canonical order, like every other section.
      personas: ['explorer', 'grinder', 'soldier'],
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

  it('sums each report\'s OWN severity x weight instead of multiplying attributes of two reports', () => {
    // Contract §9's worked failure: a severity-2 `ritual` from one persona plus a severity-5 `once`
    // from another used to score 5 x 180 x 2 = 1800, a number NO single report supported. The sum is
    // 2 x 180 + 5 x 1 = 365.
    const themes = aggregateFrictions([
      reviewFile({
        persona: 'explorer',
        frictions: [{ dayNumber: 1, what: 'The Oak door sticks', severity: 2, recurrence: 'ritual' }],
      }),
      reviewFile({
        persona: 'soldier',
        frictions: [{ dayNumber: 1, what: 'the oak door sticks!', severity: 5, recurrence: 'once' }],
      }),
    ]);
    expect(themes[0].exposure).toBe(2 * RECURRENCE_WEIGHT.ritual + 5 * RECURRENCE_WEIGHT.once);
    expect(themes[0].exposure).toBe(365);
    // ...and the severity, tag set and persona count stay display columns, unmultiplied.
    expect(themes[0]).toMatchObject({
      worstSeverity: 5,
      recurrences: ['once', 'ritual'],
      personaCount: 2,
      count: 2,
    });

    // A report repeated by one persona contributes each time, like any sum: (2 + 4) x 13.
    const repeated = aggregateFrictions([
      reviewFile({
        persona: 'grinder',
        frictions: [
          { dayNumber: 1, what: 'Training needs a roll I do not have', severity: 2, recurrence: 'periodic' },
          { dayNumber: 2, what: 'training needs a roll i do not have', severity: 4, recurrence: 'periodic' },
        ],
      }),
    ]);
    expect(repeated[0].exposure).toBe((2 + 4) * RECURRENCE_WEIGHT.periodic);

    // The caveat in the panel's own header describes the sum, not the old product.
    expect(EXPOSURE_NOTE).toContain('sum, over every report of the theme');
    expect(EXPOSURE_NOTE).toContain('never multiplied together');
  });

  it('makes the JSON self-describing: `friction.themes` is every theme, ritual included', () => {
    const report = aggregatePanel([
      reviewFile({
        persona: 'homesteader',
        frictions: [{ dayNumber: 1, what: 'Cosy play has nowhere to go', severity: 2, recurrence: 'once' }],
      }),
      reviewFile({
        persona: 'lapsed-returner',
        frictions: [{ dayNumber: 1, what: 'Catching up gives me nothing to catch up on', severity: 2, recurrence: 'ritual' }],
      }),
    ]);
    // A consumer summing `themes` gets the whole panel: the ritual half is IN the list, not the other
    // side of a partition it has to know to add back.
    expect(report.friction.themes.map((t) => t.label)).toEqual([
      'Catching up gives me nothing to catch up on',
      'Cosy play has nowhere to go',
    ]);
    expect(report.friction.ritual.map((t) => t.label)).toEqual(['Catching up gives me nothing to catch up on']);
    expect(report.friction.themes).toContainEqual(report.friction.ritual[0]);
    const bySum = report.friction.themes.reduce((sum, t) => sum + t.exposure, 0);
    const byParts = [...report.friction.ritual, ...report.friction.themes.filter((t) => !t.ritual)].reduce(
      (sum, t) => sum + t.exposure,
      0,
    );
    expect(bySum).toBe(byParts);
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
    // This key stays EXACT, and is still what the distinctiveness tables dedupe on. Friction themes
    // do not use it: they group by `frictionSimilarity`, a separate thresholded step, because exact
    // text cannot see that "the menu repeats itself" and "the menu re offers the same 3 jobs" are
    // the same complaint... or, more to the point, that two differently worded reports are.
    expect(normalizePhrase('the menu repeats itself')).not.toBe(normalizePhrase('the menu re offers the same 3 jobs'));
    expect(frictionSimilarity(frictionTokens('The menu repeats itself'), frictionTokens('the menu re offers the same 3 jobs')))
      .toBeLessThan(FRICTION_MERGE_THRESHOLD);
  });
});

// ── Friction grouping by similarity (the fix for one defect reported four ways) ──

describe('friction themes grouped by sentence similarity, not exact text', () => {
  const friction = (what: string, dayNumber = 1): { dayNumber: number; what: string; severity: number; recurrence: Recurrence } => ({
    dayNumber,
    what,
    severity: 2,
    recurrence: 'periodic',
  });

  it('merges differently worded reports of one defect and keeps a different complaint apart', () => {
    const themes = aggregateFrictions([
      reviewFile({
        persona: 'explorer',
        frictions: [friction('The decision screen still offered a door option after my rolls were spent')],
      }),
      reviewFile({
        persona: 'soldier',
        frictions: [
          friction('A decision screen offered the same door option after the rolls were spent', 3),
          // A different defect, one shared word (`menu`), stays its own theme.
          friction('The menu repeats the same three jobs', 2),
        ],
      }),
    ]);
    expect(themes).toHaveLength(2);
    const merged = themes.find((t) => t.personas.length === 2)!;
    expect(merged).toMatchObject({
      personaCount: 2,
      count: 2,
      phrasings: 2,
      personas: ['explorer', 'soldier'],
      exposure: 2 * RECURRENCE_WEIGHT.periodic * 2,
    });
    expect(themes.find((t) => t.personas.length === 1)?.label).toBe('The menu repeats the same three jobs');
  });

  it('unwinds a camelCase join, drops stopwords, and stems, so one defect worded two ways matches', () => {
    expect([...frictionTokens('The work menu still offered gate options after my rolls were spent')].sort()).toEqual([
      'gate',
      'menu',
      'offer',
      'option',
      'roll',
      'spent',
      'still',
      'work',
    ]);
    // `rollsRemaining` is ONE word to a plain splitter, which is exactly what used to keep
    // "rollsRemaining at 0" and "0 rolls remaining" apart.
    expect([...frictionTokens('rollsRemaining at 0')].sort()).toEqual(['0', 'remain', 'roll']);
    expect(frictionSimilarity(frictionTokens('rollsRemaining at 0 on the decision prompt'), frictionTokens('0 rolls remaining on the decision prompt'))).toBe(1);
    // Case/punctuation/whitespace variants of one text are still a perfect match.
    expect(frictionSimilarity(frictionTokens('The Oak door sticks'), frictionTokens('the oak door sticks!'))).toBe(1);
    // ...and a subset is NOT a match: Dice (unlike containment, which would score this 1.0) charges
    // the short report for every word the long one adds, which is what stops a two-word report being
    // swallowed by any sentence that happens to contain it.
    expect(
      frictionSimilarity(
        frictionTokens('The menu repeats'),
        frictionTokens(
          'The menu repeats itself in the tavern on the East Road after a long day of chores and the same three jobs come back every evening without resolution',
        ),
      ),
    ).toBeLessThan(FRICTION_MERGE_THRESHOLD);
  });

  it('groups transitively, and in a way that does not depend on the order the files arrive in', () => {
    // One theme per persona, so the panel's canonical order IS the file order: A ~ B and B ~ C, while
    // A and C share one word. The union-find pass puts all three in one theme, which is the documented
    // and unavoidable consequence of a transitive merge — see FRICTION_MERGE_THRESHOLD.
    const a = 'The decision screen offers a door option after the rolls were spent';
    const b = 'The work menu offers a door option after the rolls were spent';
    const c = 'The work menu offers a guard post while the night is long';
    expect(frictionSimilarity(frictionTokens(a), frictionTokens(b))).toBeGreaterThanOrEqual(FRICTION_MERGE_THRESHOLD);
    expect(frictionSimilarity(frictionTokens(b), frictionTokens(c))).toBeGreaterThanOrEqual(FRICTION_MERGE_THRESHOLD);
    expect(frictionSimilarity(frictionTokens(a), frictionTokens(c))).toBeLessThan(FRICTION_MERGE_THRESHOLD);
    const themes = aggregateFrictions([
      reviewFile({ persona: 'explorer', frictions: [friction(a)] }),
      reviewFile({ persona: 'grinder', frictions: [friction(b)] }),
      reviewFile({ persona: 'soldier', frictions: [friction(c)] }),
    ]);
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({ count: 3, personaCount: 3, phrasings: 3, exposure: 3 * 2 * RECURRENCE_WEIGHT.periodic });
    // Same reports, opposite file order: the same three-way merge (the relation is symmetric and the
    // components of a graph do not depend on the order the edges are visited).
    const reversed = aggregateFrictions([
      reviewFile({ persona: 'soldier', quitHorizon: 'week 1', frictions: [friction(c)] }),
      reviewFile({ persona: 'grinder', frictions: [friction(b)] }),
      reviewFile({ persona: 'explorer', frictions: [friction(a)] }),
    ]);
    expect(reversed).toHaveLength(1);
    expect(reversed[0].count).toBe(3);
  });

  it('keeps every report in `reports`, and counts the distinct wordings in `phrasings`', () => {
    const themes = aggregateFrictions([
      reviewFile({
        persona: 'grinder',
        frictions: [
          friction('Two day-job buttons gave no visible payout readout in the recap'),
          // The same wording again (case/punctuation only): two reports, ONE phrasing.
          friction('two day job buttons gave no visible payout readout in the recap!', 4),
        ],
      }),
      reviewFile({
        persona: 'explorer',
        frictions: [friction('The recap gave no visible payout readout for the two day-job buttons', 2)],
      }),
    ]);
    expect(themes).toHaveLength(1);
    expect(themes[0].count).toBe(3);
    expect(themes[0].phrasings).toBe(2);
    expect(themes[0].personaCount).toBe(2);
    // Nothing is hidden by a merge: every report is listed, with the persona, day, severity and tag
    // it came from, so `count` is exactly the length of the list a reader can check.
    expect(themes[0].reports).toEqual([
      { persona: 'explorer', dayNumber: 2, what: 'The recap gave no visible payout readout for the two day-job buttons', severity: 2, recurrence: 'periodic' },
      { persona: 'grinder', dayNumber: 1, what: 'Two day-job buttons gave no visible payout readout in the recap', severity: 2, recurrence: 'periodic' },
      { persona: 'grinder', dayNumber: 4, what: 'two day job buttons gave no visible payout readout in the recap!', severity: 2, recurrence: 'periodic' },
    ]);
    expect(themes[0].reports).toHaveLength(themes[0].count);
  });

  it('still sums each report\'s OWN severity x weight, and still takes the worst severity and the tag set', () => {
    const themes = aggregateFrictions([
      reviewFile({
        persona: 'explorer',
        frictions: [{ dayNumber: 1, what: 'The unsafe-ground copy doubles the same article', severity: 4, recurrence: 'once' }],
      }),
      reviewFile({
        persona: 'soldier',
        frictions: [{ dayNumber: 2, what: 'The unsafe ground copy doubles the same article!', severity: 2, recurrence: 'ritual' }],
      }),
    ]);
    expect(themes).toHaveLength(1);
    // 4 x 1 + 2 x 180, NOT worst severity x dearest tag x personas.
    expect(themes[0].exposure).toBe(4 * RECURRENCE_WEIGHT.once + 2 * RECURRENCE_WEIGHT.ritual);
    expect(themes[0]).toMatchObject({ worstSeverity: 4, recurrences: ['once', 'ritual'], ritual: true, personaCount: 2, count: 2 });
  });

  it('takes its label from the first report in canonical order, and names the merge in panel.md', () => {
    const reviews = [
      reviewFile({
        persona: 'explorer',
        frictions: [friction('The decision screen still offered a door option after my rolls were spent')],
      }),
      reviewFile({
        persona: 'soldier',
        frictions: [friction('A decision screen offered the same door option after the rolls were spent', 3)],
      }),
    ];
    const [merged] = aggregateFrictions(reviews);
    expect(merged.label).toBe('The decision screen still offered a door option after my rolls were spent');
    expect(merged.theme).toBe(normalizePhrase(merged.label));

    const markdown = renderPanelMarkdown(aggregatePanel(reviews));
    // The merge is visible in the table (`phrasings`) AND spelled out with every wording it swallowed,
    // so a reader can disagree with the judgement instead of having to trust it.
    expect(markdown).toContain('| theme | personas | reports | phrasings | worst sev | recurrence | exposure | raised by |');
    expect(markdown).toContain('### Merged phrasings');
    expect(markdown).toContain('- 2 report(s), 2 phrasing(s), raised by explorer, soldier:');
    expect(markdown).toContain('  - "A decision screen offered the same door option after the rolls were spent" (soldier)');
    expect(markdown).toContain('`panel.json` under `friction.themes[].reports`');

    // A theme written one way is not a merge, and says nothing about merging.
    const single = renderPanelMarkdown(
      aggregatePanel([reviewFile({ persona: 'explorer', frictions: [friction('The map has no edges I cannot see')] })]),
    );
    expect(single).not.toContain('### Merged phrasings');
  });
});

// ── The real arc panel: the acceptance fixture for similarity merging ──

/** The 14 friction reports of the real four-persona, five-day arc panel (`/tmp/agent-panel/arc-panel`,
 *  recorded 2026-09-14), copied verbatim. Every one of them is severity 2, `periodic`. This is the
 *  data the defect was found on: five of these reports are ONE defect (menus still offering
 *  roll-costing options once the rolls are spent) raised by four personas, which exact-text grouping
 *  could not see, because no two of the five are worded alike. */
const ARC_PANEL_FRICTIONS: Record<string, Array<{ dayNumber: number; what: string }>> = {
  explorer: [
    { dayNumber: 1, what: "The work menu offers Town Guard chores while I'm standing out on the East Road mid-scout, yanking me back to the same three buttons" },
    { dayNumber: 1, what: "The day's work menu offered me Town Guard chores while I was standing mid-scouting out on the East Road, funnelling me back to the same local buttons instead of the thread I'm on." },
    { dayNumber: 3, what: 'Free-text pursuit east along the East Road was answered three times by the Town Guard work menu; the world map never opened or moved.' },
    { dayNumber: 4, what: "The work menu offers village-guard chores while I'm standing out on the East Road, which doesn't match where the story has me." },
    { dayNumber: 5, what: 'A decision screen appeared with 0 rolls remaining, so it is unclear whether picking a button can still act or whether the day is simply over.' },
  ],
  grinder: [
    { dayNumber: 2, what: "The day's log records which verb ran but never what each paid, so I cannot tell which day-job action earned the most copper." },
    { dayNumber: 3, what: "Daily work menu re-lists 'Inspect the lockup' unchanged after I already ran it, so it's unclear whether repeating pays or whether I lose a roll." },
    { dayNumber: 3, what: 'Two day-job buttons (Inspect the lockup, Haul and load) gave no visible payout readout in the recap, so I cannot tell which verb actually paid best per roll.' },
    { dayNumber: 3, what: 'A decision prompt with rollsRemaining at 0 — unclear whether resolving it is free or needs a roll I no longer have.' },
  ],
  homesteader: [
    { dayNumber: 1, what: 'The work menu still offered gate options after my rolls were spent, so I had to back out instead of just being told the day was done.' },
  ],
  soldier: [
    { dayNumber: 1, what: 'The hunt decision menu appeared with 0 rolls remaining and no sleep option among the moves, so the fight on offer could not actually be taken.' },
    { dayNumber: 3, what: 'A scout decision was offered with 0 rolls remaining and no sleep or bail option listed, so the cost of picking is unclear.' },
    { dayNumber: 5, what: 'Three free-text actions on the same strongbox beat each returned a near-identical variant with no escalation or resolution' },
    { dayNumber: 5, what: "On the day's final roll, standing on unsafe ground with a live thread, the work menu offered only question-a-stranger, wait tables and help at the market — no combat option at all, so I had to force i…" },
  ],
};

const arcPanelReviews = (): ReviewFile[] =>
  Object.entries(ARC_PANEL_FRICTIONS).map(([persona, frictions]) =>
    reviewFile({ persona, frictions: frictions.map((f) => ({ ...f, severity: 2, recurrence: 'periodic' })) }),
  );

describe('the real arc panel (acceptance fixture)', () => {
  const themes = aggregateFrictions(arcPanelReviews());
  const byLabel = (label: string): (typeof themes)[number] => {
    const found = themes.find((t) => t.label === label);
    expect(found, `no theme labelled ${label}`).toBeDefined();
    return found!;
  };
  const ZERO_ROLLS = 'A decision screen appeared with 0 rolls remaining, so it is unclear whether picking a button can still act or whether the day is simply over.';
  const LOCATION = "The work menu offers Town Guard chores while I'm standing out on the East Road mid-scout, yanking me back to the same three buttons";

  it('collapses 14 exact-text themes into 8, and the roll-exhaustion defect becomes the top finding', () => {
    // 14 reports of severity 2 `periodic`, i.e. 14 x 26 = 364 of exposure in, 364 out.
    expect(themes.reduce((sum, t) => sum + t.count, 0)).toBe(14);
    expect(themes.reduce((sum, t) => sum + t.exposure, 0)).toBe(14 * 2 * RECURRENCE_WEIGHT.periodic);
    expect(themes).toHaveLength(8);

    // The defect five reports and four personas raised, now visible as one theme: four of them merge
    // (`0 rolls remaining`, `rollsRemaining at 0`), and it TOPS the ranking.
    const zeroRolls = themes[0];
    expect(themes[0]).toBe(byLabel(ZERO_ROLLS));
    expect(zeroRolls).toMatchObject({
      personaCount: 3,
      count: 4,
      phrasings: 4,
      personas: ['explorer', 'grinder', 'soldier'],
      worstSeverity: 2,
      recurrences: ['periodic'],
      exposure: 4 * 2 * RECURRENCE_WEIGHT.periodic,
    });

    // The explorer's location/thread group: one persona, so taste rather than a design finding — and
    // the persona count is what separates the two themes tied on 104.
    const location = byLabel(LOCATION);
    expect(location).toMatchObject({ personaCount: 1, count: 4, phrasings: 4, personas: ['explorer'], exposure: 104 });
    expect(location.exposure).toBe(zeroRolls.exposure);
    expect(themes[1]).toBe(location);

    // Everything else is a once-each report, and nothing was lost or double-counted by the merge.
    expect(themes.slice(2).map((t) => [t.count, t.personaCount, t.exposure])).toEqual([
      [1, 1, 26],
      [1, 1, 26],
      [1, 1, 26],
      [1, 1, 26],
      [1, 1, 26],
      [1, 1, 26],
    ]);
    for (const theme of themes) expect(theme.reports).toHaveLength(theme.count);
  });

  // ── The two groupings the brief expected and this measure does NOT produce, with the numbers ──
  // Both are threshold questions, not implementation bugs, and both are decided by the same pair of
  // scores, quoted here so the next reader can re-open the judgement armed with numbers instead of
  // prose. 0.3125 (5/16) and 0.3871 are `frictionSimilarity` on the shipped tokeniser.
  it('records the two groupings a conservative threshold refuses, and why', () => {
    const payoutA = ARC_PANEL_FRICTIONS.grinder[0].what;
    const payoutB = ARC_PANEL_FRICTIONS.grinder[2].what;
    const homesteader = ARC_PANEL_FRICTIONS.homesteader[0].what;
    const locationExplorer = ARC_PANEL_FRICTIONS.explorer[1].what;

    // (1) The two grinder reports about not being told what each action paid score 0.3125: below the
    // threshold, so they stay two themes of 26 where the brief expected one of 52.
    expect(frictionSimilarity(frictionTokens(payoutA), frictionTokens(payoutB))).toBeCloseTo(5 / 16, 6);
    expect(frictionSimilarity(frictionTokens(payoutA), frictionTokens(payoutB))).toBeLessThan(FRICTION_MERGE_THRESHOLD);
    expect(themes.filter((t) => t.label === payoutA || t.label === payoutB)).toHaveLength(2);

    // (2) The homesteader's roll-exhaustion report shares only the boilerplate "the work menu offered
    // ..." with the explorer's location complaint, and scores 0.3871 — the HIGHEST false-merge
    // candidate in the panel. So any threshold low enough to merge the payout pair (0.3125) sits far
    // below it, and puts a roll-exhaustion report in the location/thread theme: measured at 0.35, the
    // location theme swallows the homesteader report AND the soldier's no-combat-option report into
    // one 6-report theme mixing three defects. Hence 0.4 — under-merging only under-ranks a finding,
    // over-merging hides one. The consequence, stated plainly: the roll-exhaustion theme counts 3
    // personas and 4 reports, not the 4 personas and 5 reports the brief expected, because the
    // homesteader's wording shares NO content word with the other four.
    expect(frictionSimilarity(frictionTokens(homesteader), frictionTokens(locationExplorer))).toBeCloseTo(0.387, 3);
    expect(frictionSimilarity(frictionTokens(homesteader), frictionTokens(locationExplorer))).toBeLessThan(FRICTION_MERGE_THRESHOLD);
    // Its fellow roll-exhaustion reports are no closer, so the one report cannot be rescued from the
    // other direction either: 0.222 against the theme's own label, 0.083 and 0.286 against the other
    // two (it shares "work menu", "offered" and "rolls" with them and nothing else).
    expect(frictionSimilarity(frictionTokens(homesteader), frictionTokens(ZERO_ROLLS))).toBeCloseTo(0.222, 3);
    expect(byLabel(homesteader)).toMatchObject({ personaCount: 1, count: 1, exposure: 26 });
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
    expect(signal.named.map((n) => n.persona)).toEqual(['collector', 'explorer']);
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
    const explorer = rows.find((r) => r.persona === 'explorer')!;
    const casual = rows.find((r) => r.persona === 'casual')!;
    expect(explorer.total).toBe(10);
    expect(explorer.kinds.choice).toBe(0);
    expect(explorer.freeTextShare).toBeCloseTo(0.5);
    // The baseline arm's headline: the free-text slot used zero times.
    expect(casual.freeTextShare).toBe(0);
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
    expect(report.runs.map((r) => r.persona)).toEqual(['casual', 'explorer']);
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

// ── One canonical row order for every section ──

describe('one canonical order everywhere (spec § H)', () => {
  const reviews = [
    reviewFile({ persona: 'tourist', quitHorizon: 'who knows, honestly' }),
    reviewFile({ persona: 'grinder', quitHorizon: 'month 1' }),
    reviewFile({ persona: 'casual', quitHorizon: 'day 2' }),
    reviewFile({ persona: 'explorer', quitHorizon: 'day 2' }),
  ];
  // Churn horizon, ties by name: the two `day 2` personas in name order, and the unreadable horizon
  // first rather than last.
  const expected = ['tourist', 'casual', 'explorer', 'grinder'];
  const personas = (rows: ReadonlyArray<{ persona: string }>): string[] => rows.map((r) => r.persona);

  it('orders every aggregation by churn horizon, ties by name', () => {
    expect(personas(orderReviews(reviews))).toEqual(expected);
    expect(personas(aggregateScores(reviews))).toEqual(expected);
    expect(personas(aggregateRuns(reviews))).toEqual(expected);
    expect(personas(aggregateRubric(reviews).rows)).toEqual(expected);
    expect(personas(aggregateSeries(reviews))).toEqual(expected);
    expect(personas(aggregateHistogram(reviews).rows)).toEqual(expected);
    expect(personas(aggregateActionVerbs(reviews))).toEqual(expected);
    expect(personas(aggregateCost(reviews).perRun)).toEqual(expected);
    expect(personas(aggregateDistinctiveness(reviews).rows)).toEqual(expected);
    expect(aggregateFulfilment(reviews).named.filter((n) => n.persona !== '').length).toBe(expected.length);
  });

  it('makes row N of one markdown table the same persona as row N of the next', () => {
    const markdown = renderPanelMarkdown(aggregatePanel(reviews));
    const firstDataRow = (heading: string): string => {
      const lines = markdown.split('\n');
      const start = lines.findIndex((l) => l === heading);
      expect(start).toBeGreaterThan(-1);
      const rows = lines.slice(start).filter((l) => l.startsWith('| '));
      return rows[2]; // header, separator, first data row
    };
    for (const heading of [
      '## Score matrix',
      '## Retention signal',
      '## Rubric matrix',
      '## Engagement and fulfilment series',
      '### The arc note, day by day',
      '### Move kinds (what the brain chose)',
      '### Observed action labels (model-authored)',
      '### arcNote / quitTrigger distinctiveness',
      '## Runs and cost',
    ]) {
      expect(firstDataRow(heading)).toContain('| tourist |');
    }
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

      // A malformed CELL stops the panel too, and the message names the file it came from.
      writeFileSync(
        path.join(dir, 'b.json.reviews.json'),
        JSON.stringify({ ...reviewFile({ persona: 'casual' }), review: { ...reviewFile({ persona: 'casual' }).review, rubric: { ...reviewFile({ persona: 'casual' }).review.rubric, ritualPull: 7 } } }),
      );
      expect(() => readReviewDirectory(dir)).toThrow(/b\.json\.reviews\.json: review\.rubric\.ritualPull: expected an integer 1-5 or the exact string "unobserved", got 7/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Malformed cells (contract §9: a file the panel does not understand must stop it) ──

  it('rejects an out-of-range or mistyped rubric cell, naming the field', () => {
    const file = reviewFile({ persona: 'explorer' });
    const withRubric = (rubric: unknown) => ({ ...file, review: { ...file.review, rubric } });
    expect(() => parseReviewFile(withRubric({ ...file.review.rubric, ritualPull: 7 }), 'r.reviews.json')).toThrow(
      /r\.reviews\.json: review\.rubric\.ritualPull: expected an integer 1-5 or the exact string "unobserved", got 7/,
    );
    expect(() => parseReviewFile(withRubric({ ...file.review.rubric, ritualPull: 0 }), 'r.reviews.json')).toThrow(
      /review\.rubric\.ritualPull/,
    );
    expect(() => parseReviewFile(withRubric({ ...file.review.rubric, visibleStakes: 3.5 }), 'r.reviews.json')).toThrow(
      /review\.rubric\.visibleStakes: expected an integer 1-5 or the exact string "unobserved", got 3\.5/,
    );
    // A near-miss of `unobserved` is a mistyped cell, not a gap: `unobserved` is the exact string.
    expect(() => parseReviewFile(withRubric({ ...file.review.rubric, aliveness: 'Unobserved' }), 'r.reviews.json')).toThrow(
      /review\.rubric\.aliveness: expected an integer 1-5 or the exact string "unobserved", got "Unobserved"/,
    );
    expect(() => parseReviewFile(withRubric({ ...file.review.rubric, memory: 'unobserved' }), 'r.reviews.json')).not.toThrow();
  });

  it('rejects a MISSING rubric key rather than counting it as `unobserved`', () => {
    const file = reviewFile({ persona: 'explorer' });
    const rubric: Record<string, unknown> = { ...file.review.rubric };
    delete rubric.ritualPull;
    // A silent `undefined` here would print the literal `undefined` in the matrix AND drop the
    // persona from that criterion's coverage — the exact reading the `unobserved` rule prevents.
    expect(() => parseReviewFile({ ...file, review: { ...file.review, rubric } }, 'r.reviews.json')).toThrow(
      /review\.rubric\.ritualPull: expected an integer 1-5 or the exact string "unobserved", got nothing \(the key is missing\)/,
    );
  });

  it('rejects a mistyped score cell, so a string can never reach a numeric column', () => {
    const file = reviewFile({ persona: 'explorer' });
    const withScores = (scores: unknown) => ({ ...file, review: { ...file.review, scores } });
    expect(() => parseReviewFile(withScores({ ...file.review.scores, variety: 'high' }), 'r.reviews.json')).toThrow(
      /review\.scores\.variety: expected an integer 1-5, got "high"/,
    );
    expect(() => parseReviewFile(withScores({ ...file.review.scores, engagement: 9 }), 'r.reviews.json')).toThrow(
      /review\.scores\.engagement: expected an integer 1-5, got 9/,
    );
    // `unobserved` belongs to the rubric alone: the five scores rate the session (spec § F).
    expect(() => parseReviewFile(withScores({ ...file.review.scores, clarity: 'unobserved' }), 'r.reviews.json')).toThrow(
      /review\.scores\.clarity: expected an integer 1-5, got "unobserved"/,
    );
    const scores: Record<string, unknown> = { ...file.review.scores };
    delete scores.challenge;
    expect(() => parseReviewFile(withScores(scores), 'r.reviews.json')).toThrow(/review\.scores\.challenge/);
  });

  it('rejects a day-note cell that is not a 1-5 integer', () => {
    const file = reviewFile({ persona: 'explorer' });
    expect(() => parseReviewFile({ ...file, dayNotes: [{ ...file.dayNotes[0], engagement: 'four' }] }, 'r.reviews.json')).toThrow(
      /dayNotes\[0\]\.engagement: expected an integer 1-5, got "four"/,
    );
    expect(() => parseReviewFile({ ...file, dayNotes: [{ ...file.dayNotes[0], fulfilment: 6 }] }, 'r.reviews.json')).toThrow(
      /dayNotes\[0\]\.fulfilment: expected an integer 1-5, got 6/,
    );
    expect(() => parseReviewFile({ ...file, dayNotes: [{ engagement: 3, fulfilment: 3 }] }, 'r.reviews.json')).toThrow(
      /dayNotes\[0\]\.dayNumber: expected a number, got nothing \(the key is missing\)/,
    );
  });

  it('rejects an out-of-vocabulary friction severity or recurrence', () => {
    const file = reviewFile({
      persona: 'explorer',
      frictions: [{ dayNumber: 1, what: 'The menu repeats', severity: 2, recurrence: 'once' }],
    });
    const withFriction = (patch: Record<string, unknown>) => ({ ...file, frictions: [{ ...file.frictions[0], ...patch }] });
    // severity 9 in a 1-5 scale, and a tag no weight exists for (exposure 0, blank rank cell).
    expect(() => parseReviewFile(withFriction({ severity: 9 }), 'r.reviews.json')).toThrow(
      /frictions\[0\]\.severity: expected an integer 1-5, got 9/,
    );
    expect(() => parseReviewFile(withFriction({ recurrence: 'daily' }), 'r.reviews.json')).toThrow(
      /frictions\[0\]\.recurrence: expected one of once\|periodic\|ritual, got "daily"/,
    );
    // A non-string `what` would crash `normalizePhrase` as a TypeError rather than a PanelInputError.
    expect(() => parseReviewFile(withFriction({ what: 12 }), 'r.reviews.json')).toThrow(
      /frictions\[0\]\.what: expected a string, got 12/,
    );
  });

  it('rejects a summary count that is not a number, because the run length comes from it', () => {
    const file = reviewFile({ persona: 'explorer' });
    expect(() => parseReviewFile({ ...file, summary: { ...file.summary, greetings: 'two' } }, 'r.reviews.json')).toThrow(
      /summary\.greetings: expected a number, got "two"/,
    );
    const summary: Record<string, unknown> = { ...file.summary };
    delete summary.dayBoundaries;
    expect(() => parseReviewFile({ ...file, summary }, 'r.reviews.json')).toThrow(
      /summary\.dayBoundaries: expected a number, got nothing \(the key is missing\)/,
    );
    expect(() => parseReviewFile({ ...file, summary: { ...file.summary, findings: { error: 0 } } }, 'r.reviews.json')).toThrow(
      /summary\.findings\.warning: expected a number/,
    );
  });

  it('rejects a verb or cost figure that is not a number, instead of concatenating it into a total', () => {
    const file = reviewFile({ persona: 'explorer' });
    expect(() => parseReviewFile({ ...file, verbs: { 'menu-pick': '3' } }, 'r.reviews.json')).toThrow(
      /verbs\.menu-pick: expected a number, got "3"/,
    );
    expect(() => parseReviewFile({ ...file, cost: { ...file.cost, totalTokens: null } }, 'r.reviews.json')).toThrow(
      /cost\.totalTokens: expected a number, got null/,
    );
    expect(() => parseReviewFile({ ...file, arcNotes: ['fine', 7] }, 'r.reviews.json')).toThrow(
      /arcNotes\[1\]: expected a string, got 7/,
    );
  });
});
