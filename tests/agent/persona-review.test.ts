/**
 * T5 — the persona voice (spec § F, `docs/engine/agent-player-personas.md`): the review seam, the
 * review's prompt, the reply parser and the reviews file. The three things pinned here that nothing
 * else can see:
 *
 * - `unobserved` is accepted on EVERY rubric criterion and rejected outside the 1..5 ∪ {'unobserved'}
 *   set, because a criterion the session could not exercise must be able to say so (spec § Risks);
 * - `parseQuitHorizon` reads the four prompt-constrained shapes and fails safe on noise, so the panel
 *   can sequence churn horizons without trusting the model's phrasing;
 * - the prompt the prod gateway loads actually asks for every field the parser requires — prompt and
 *   parser drifting apart is this task's one silent failure mode, and it would only surface on a paid
 *   run.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  ScriptedPlaytestCriticGateway,
  scriptedPersonaReview,
} from '../../src/agent/ScriptedPlaytestCriticGateway.js';
import {
  ProdPlaytestCriticGateway,
  buildReviewMessage,
  composePersonaReviewPrompt,
} from '../../src/agent/ProdPlaytestCriticGateway.js';
import {
  compareQuitHorizons,
  parseQuitHorizon,
} from '../../src/agent/PlaytestCriticGateway.js';
import type {
  PersonaReview,
  PersonaReviewInput,
  PlaytestReport,
} from '../../src/agent/PlaytestCriticGateway.js';
import { agentCriticStamp, loadCriticTemplate } from '../../src/agent/criticPrompt.js';
import { REVIEW_FILE_VERSION, buildReviewFile, formatPersonaReview, personaReviewInput } from '../../src/agent/reviewFile.js';
import { Transcript } from '../../src/agent/transcript.js';
import type { LlmCostSummary } from '../../src/agent/llmCostSummary.js';
import type { LlmCallRecord } from '../../src/llm/LlmCallRecorder.js';

const REPORT: PlaytestReport = {
  pacing: 'Brisk.',
  clarity: 'Clear.',
  fun: 'Diverting.',
  difficulty: 'Fair.',
  summary: 'Tighten the day-job loop.',
};

const RUBRIC_FIELDS = ['ritualPull', 'visibleStakes', 'somethingToBuild', 'aliveness', 'memory'] as const;

const REVIEW: PersonaReview = {
  persona: 'explorer',
  rubric: {
    ritualPull: 4,
    visibleStakes: 3,
    somethingToBuild: 2,
    aliveness: 'unobserved',
    memory: 'unobserved',
  },
  scores: { engagement: 4, fulfilment: 3, clarity: 2, challenge: 4, variety: 2 },
  returnTomorrow: 'probably',
  hook: 'The rumour about the Shrine of the First Flame.',
  building: 'The archive thread; two leads left.',
  quitTrigger: 'A map that stops opening.',
  quitHorizon: 'week 2',
  engaging: ['The oath scene at the gate.'],
  boring: ['The third identical work menu.'],
  clunky: ['Bail dice read differently on two bails.'],
  best: 'The sergeant handing me a patrol.',
  worst: 'The same three tasks re-offered after every action.',
  verdict: 'would drift off',
  review: 'I came for the map and got a good scene out of it. Three sentences of voice go here.',
};

/** A completed one-day run with a day note, a friction and a recon screen — everything the reviewer
 *  is asked to read beyond the raw play log. */
function sampleInput(persona = 'explorer'): PersonaReviewInput {
  const t = sampleTranscript();
  return personaReviewInput(persona, t);
}

function sampleTranscript(): Transcript {
  const t = new Transcript();
  t.protocolHeader('agent:play-1', 'prod', 'real', '2026-09-13T09:00:00.000Z', 'explorer');
  t.turn('menu', 'Household Chores', [], { kind: 'custom', text: 'search the cart' });
  t.outcome('You find a brass key.', 'search');
  t.recon('map', 'The East Road runs north.');
  t.friction({ dayNumber: 1, what: 'bail dice read inconsistently', severity: 3, recurrence: 'periodic' });
  t.dayNote({ dayNumber: 1, engagement: 4, fulfilment: 3, line: 'A good scene, three buttons.', arcNote: 'the temple' });
  return t;
}

const COST: LlmCostSummary = {
  totalCalls: 12,
  totalTokens: 130_000,
  byCallKind: [],
  criticVerdicts: [],
  criticByBeat: [],
  actionableCritic: 0,
  actionableCriticLegacyCount: 0,
  actionableCriticNote: '',
};

// ── injected-fetch helpers (mirror tests/agent/critic-gateway.test.ts) ──

function mockFetch(responseBody: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(responseBody),
    text: () => Promise.resolve(JSON.stringify(responseBody)),
  }) as unknown as typeof fetch;
}

function apiResponse(content: unknown): unknown {
  return { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] };
}

function bodyOf(fetchFn: typeof fetch): Record<string, any> {
  const calls = (fetchFn as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls;
  return JSON.parse(calls[0][1].body);
}

function capture() {
  const records: LlmCallRecord[] = [];
  const recorder = {
    record: (r: LlmCallRecord) => { records.push(r); return records.length; },
    promoteDeepCapture: () => { /* unused */ },
  };
  return { records, recorder };
}

function makeReviewer(fetchFn: typeof fetch, recorder?: ReturnType<typeof capture>['recorder']) {
  return new ProdPlaytestCriticGateway({
    apiKey: 'test-key',
    fetch: fetchFn,
    recorder,
    systemPrompt: 'CRITIC SYSTEM',
    personaReviewSystemPrompt: 'REVIEW SYSTEM',
  });
}

/** The reply the prompt asks for, with a per-test override. */
function reviewReply(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    persona: 'explorer',
    rubric: { ritualPull: 4, visibleStakes: 3, somethingToBuild: 2, aliveness: 'unobserved', memory: 'unobserved' },
    scores: { engagement: 4, fulfilment: 3, clarity: 2, challenge: 4, variety: 2 },
    returnTomorrow: 'probably',
    hook: 'The rumour about the shrine.',
    building: 'The archive thread.',
    quitTrigger: 'A map that stops opening.',
    quitHorizon: 'week 2',
    engaging: ['the gate scene'],
    boring: [],
    clunky: ['bail dice'],
    best: 'the patrol assignment',
    worst: 'the repeated work menu',
    verdict: 'would drift off',
    review: 'Three sentences of voice.',
    ...overrides,
  };
}

// ── ScriptedPlaytestCriticGateway ──

describe('ScriptedPlaytestCriticGateway — persona review (T5)', () => {
  it('returns a constructed review and records the input it reviewed', async () => {
    const gw = new ScriptedPlaytestCriticGateway(REPORT, REVIEW);
    const input = sampleInput();

    expect(await gw.review(input)).toBe(REVIEW);
    expect(gw.reviewCalls).toHaveLength(1);
    expect(gw.reviewCalls[0]).toBe(input);
    // Critique and review are separate calls through the same stub — neither records the other's input.
    expect(gw.calls).toHaveLength(0);
    expect(gw.reviewCalls[0].persona).toBe('explorer');
  });

  it('answers in the default scripted voice for the persona it was asked about', async () => {
    const gw = new ScriptedPlaytestCriticGateway(REPORT);
    const review = await gw.review(sampleInput('grinder'));

    expect(review.persona).toBe('grinder');
    // The two criteria a scripted one-day run cannot have exercised are `unobserved`, not scored low.
    expect(review.rubric).toEqual(scriptedPersonaReview('grinder').rubric);
    expect(review.rubric.aliveness).toBe('unobserved');
    expect(review.rubric.memory).toBe('unobserved');
  });
});

// ── ProdPlaytestCriticGateway — request assembly ──

describe('ProdPlaytestCriticGateway — persona review request', () => {
  it('sends the review template + the persona fragment as the system prompt, and the series + log', async () => {
    const fetchFn = mockFetch(apiResponse(reviewReply()));
    await makeReviewer(fetchFn).review(sampleInput());

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const system = bodyOf(fetchFn).messages[0].content as string;
    expect(system).toContain('REVIEW SYSTEM');
    // The persona's own fragment rides along: ten reviews must be ten voices (spec § A).
    expect(system).toContain('You are an Explorer');

    const user = bodyOf(fetchFn).messages[1].content as string;
    expect(user).toContain('RUN SUMMARY:');
    expect(user).toContain('DAY NOTES');
    expect(user).toContain('day 1: 4 / 3 — A good scene, three buttons.');
    expect(user).toContain('the temple');
    expect(user).toContain('FRICTIONS');
    expect(user).toContain('3, periodic — bail dice read inconsistently');
    expect(user).toContain('RECON SCREENS CONSULTED');
    expect(user).toContain('/map: The East Road runs north.');
    expect(user).toContain('PLAY LOG:');
    expect(bodyOf(fetchFn).response_format).toEqual({ type: 'json_object' });
  });

  it('renders an absent series as (none) rather than dropping the section', () => {
    const msg = buildReviewMessage({ ...sampleInput(), dayNotes: [], frictions: [], reconScreens: [] });
    expect(msg).toContain('DAY NOTES');
    expect(msg).toContain('(none reported)');
    expect(msg).toContain('RECON SCREENS CONSULTED');
    expect(msg).toContain('(none)');
  });

  it('renders day logs when the caller supplies them', () => {
    const withLogs = buildReviewMessage({ ...sampleInput(), dayLogs: ['1. free action: "search the cart" → a brass key'] });
    expect(withLogs).toContain('DAY LOGS:');
    expect(withLogs).toContain('search the cart');
    // And omits the section entirely when it does not: the harness does not retain day logs.
    expect(buildReviewMessage(sampleInput())).not.toContain('DAY LOGS:');
  });

  it('composes the review prompt from the template and the persona fragment', () => {
    const composed = composePersonaReviewPrompt('TEMPLATE', 'soldier');
    expect(composed.startsWith('TEMPLATE')).toBe(true);
    expect(composed).toContain('You are a Soldier');
    expect(composed).toContain('Quit condition');
  });
});

// ── ProdPlaytestCriticGateway — reply parsing ──

describe('ProdPlaytestCriticGateway — persona review parse', () => {
  it('returns the validated, trimmed review', async () => {
    const gw = makeReviewer(mockFetch(apiResponse(reviewReply({ hook: '  the shrine rumour  ' }))));
    const review = await gw.review(sampleInput());

    expect(review.hook).toBe('the shrine rumour');
    expect(review.rubric).toEqual(REVIEW.rubric);
    expect(review.scores).toEqual(REVIEW.scores);
    expect(review.returnTomorrow).toBe('probably');
    expect(review.quitHorizon).toBe('week 2');
    expect(review.clunky).toEqual(['bail dice']);
    expect(review.boring).toEqual([]);
    expect(review.verdict).toBe('would drift off');
  });

  it.each(RUBRIC_FIELDS)('accepts every rubric value on %s, unobserved included', async (field) => {
    for (const value of [1, 2, 3, 4, 5, 'unobserved'] as const) {
      const reply = reviewReply({
        rubric: { ...reviewReply().rubric as object, [field]: value },
      });
      const review = await makeReviewer(mockFetch(apiResponse(reply))).review(sampleInput());
      expect(review.rubric[field]).toBe(value);
    }
  });

  it.each([
    ['0', 0],
    ['6', 6],
    ['a float', 4.5],
    ['a numeric string', '4'],
    ['null', null],
    ['the wrong word', 'n/a'],
  ])('rejects a rubric value outside 1..5 and unobserved (%s)', async (_label, value) => {
    const reply = reviewReply({ rubric: { ...reviewReply().rubric as object, memory: value } });
    await expect(makeReviewer(mockFetch(apiResponse(reply))).review(sampleInput())).rejects.toThrow(
      /rubric value "memory" is .* expected an integer 1\.\.5 or "unobserved"/,
    );
  });

  it('rejects a score outside 1..5 — unobserved is a rubric answer, not a session score', async () => {
    const reply = reviewReply({ scores: { ...reviewReply().scores as object, variety: 'unobserved' } });
    await expect(makeReviewer(mockFetch(apiResponse(reply))).review(sampleInput())).rejects.toThrow(
      /score "variety" is .* expected an integer 1\.\.5/,
    );
  });

  it.each(['hook', 'building', 'quitTrigger', 'quitHorizon', 'best', 'worst', 'review', 'persona'])(
    'throws when the required field "%s" is missing',
    async (field) => {
      const reply = reviewReply();
      delete reply[field];
      await expect(makeReviewer(mockFetch(apiResponse(reply))).review(sampleInput())).rejects.toThrow(
        new RegExp(`review field "${field}" is missing or empty`),
      );
    },
  );

  it('throws when a required list field is missing or mistyped', async () => {
    const missing = reviewReply();
    delete missing.boring;
    await expect(makeReviewer(mockFetch(apiResponse(missing))).review(sampleInput())).rejects.toThrow(
      /review field "boring" is missing or not an array/,
    );

    const mistyped = reviewReply({ engaging: ['the gate scene', ''] });
    await expect(makeReviewer(mockFetch(apiResponse(mistyped))).review(sampleInput())).rejects.toThrow(
      /review field "engaging\[1\]" is missing or empty/,
    );
  });

  it('reads the closed vocabularies case-, spacing- and punctuation-insensitively, and rejects anything else', async () => {
    const relaxed = reviewReply({ returnTomorrow: ' Yes ', verdict: 'Would  Drift Off.' });
    const review = await makeReviewer(mockFetch(apiResponse(relaxed))).review(sampleInput());
    expect(review.returnTomorrow).toBe('yes');
    expect(review.verdict).toBe('would drift off');

    const wrong = reviewReply({ returnTomorrow: 'maybe' });
    await expect(makeReviewer(mockFetch(apiResponse(wrong))).review(sampleInput())).rejects.toThrow(
      /review field "returnTomorrow" is .* expected one of "yes", "probably", "no"/,
    );
  });

  it('accepts an unparseable quitHorizon — the panel buckets it rather than losing the run', async () => {
    const reply = reviewReply({ quitHorizon: 'whenever the grind gets old' });
    const review = await makeReviewer(mockFetch(apiResponse(reply))).review(sampleInput());
    expect(parseQuitHorizon(review.quitHorizon).kind).toBe('unknown');
  });

  it('throws on a missing rubric or scores object', async () => {
    const noRubric = reviewReply();
    delete noRubric.rubric;
    await expect(makeReviewer(mockFetch(apiResponse(noRubric))).review(sampleInput())).rejects.toThrow(
      /review field "rubric" is missing or not an object/,
    );

    const noScores = reviewReply({ scores: 4 });
    await expect(makeReviewer(mockFetch(apiResponse(noScores))).review(sampleInput())).rejects.toThrow(
      /review field "scores" is missing or not an object/,
    );
  });

  it('throws on a transport failure or an unparseable body', async () => {
    await expect(makeReviewer(mockFetch({ error: 'boom' }, 500)).review(sampleInput())).rejects.toThrow(
      /OpenRouter API error 500/,
    );
    await expect(
      makeReviewer(mockFetch({ choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }] })).review(
        sampleInput(),
      ),
    ).rejects.toThrow(/failed to parse/);
  });
});

// ── ProdPlaytestCriticGateway — audit ──

describe('ProdPlaytestCriticGateway — persona review audit', () => {
  it('records one row stamped agent-critic-v2/persona-review', async () => {
    const { records, recorder } = capture();
    await makeReviewer(mockFetch(apiResponse(reviewReply())), recorder).review(sampleInput());

    expect(records).toHaveLength(1);
    expect(records[0].callKind).toBe('agent-persona-review');
    expect(records[0].promptVersion).toBe(agentCriticStamp('persona-review'));
    expect(records[0].playerInput).toContain('persona explorer');
    expect(records[0].parseOk).toBe(true);
    expect(records[0].error).toBeNull();
  });

  it('records a diagnostic row on a validation failure', async () => {
    const { records, recorder } = capture();
    const gw = makeReviewer(mockFetch(apiResponse(reviewReply({ best: '' }))), recorder);
    await expect(gw.review(sampleInput())).rejects.toThrow(/review field "best" is missing or empty/);

    expect(records).toHaveLength(1);
    expect(records[0].parseOk).toBe(true);
    expect(records[0].error).toMatch(/review field "best" is missing or empty/);
    expect(records[0].rawPrompt).toContain('RUN SUMMARY:');
  });
});

// ── parseQuitHorizon ──

describe('parseQuitHorizon', () => {
  it.each([
    ['day 2', 'day', 2, 2],
    ['week 2', 'week', 2, 14],
    ['month 3', 'month', 3, 90],
    ['never on this evidence', 'never', null, null],
  ])('reads "%s"', (raw, kind, n, days) => {
    expect(parseQuitHorizon(raw)).toEqual({ kind, n, days, raw });
  });

  it.each([
    ['Day 5', 'day', 5],
    ['in about week 2', 'week', 2],
    ['Month 3.', 'month', 3],
    ['2 weeks', 'week', 2],
    ['3 months or so', 'month', 3],
    ['NEVER ON THIS EVIDENCE', 'never', null],
    ['never', 'never', null],
  ])('is tolerant of phrasing: "%s"', (raw, kind, n) => {
    const parsed = parseQuitHorizon(raw);
    expect(parsed.kind).toBe(kind);
    expect(parsed.n).toBe(n);
    expect(parsed.raw).toBe(raw);
  });

  it.each([
    ['within a week', 'week'],
    ['a few days in', 'day'],
    ['after a month or two', 'month'],
  ])('keeps the unit and drops the absent figure: "%s"', (raw, kind) => {
    expect(parseQuitHorizon(raw)).toEqual({ kind, n: null, days: null, raw });
  });

  it.each([
    ['whenever the grind gets old', ''],
    ['when the map runs out', ''],
    ['not before Christmas', ''],
    ['   ', ''],
  ])('reports noise as unknown rather than a horizon: "%s"', (raw) => {
    expect(parseQuitHorizon(raw)).toEqual({ kind: 'unknown', n: null, days: null, raw: raw.trim() });
  });

  it('does not read a unit out of an unrelated word', () => {
    expect(parseQuitHorizon('daytime drudgery').kind).toBe('unknown');
  });

  it('orders soonest churn first, with never after every bounded horizon and unknown last', () => {
    const sorted = ['unknown', 'never', 'month 3', 'week 2', 'day 5'].map(parseQuitHorizon).sort(compareQuitHorizons);
    expect(sorted.map((h) => `${h.kind} ${h.n}`)).toEqual([
      'day 5',
      'week 2',
      'month 3',
      'never null',
      'unknown null',
    ]);
  });

  it('orders a figure-less horizon of a kind before a figured one', () => {
    expect(compareQuitHorizons(parseQuitHorizon('within a week'), parseQuitHorizon('week 2'))).toBeLessThan(0);
    expect(compareQuitHorizons(parseQuitHorizon('week 1'), parseQuitHorizon('week 2'))).toBeLessThan(0);
    expect(compareQuitHorizons(parseQuitHorizon('week 2'), parseQuitHorizon('week 2'))).toBe(0);
  });
});

// ── the verb histogram (contract §9) ──

describe('Transcript.verbHistogram', () => {
  it("counts the brain's move kinds and the engine's action verbs from two different axes", () => {
    const t = new Transcript();
    t.turn('menu', 'Household Chores', [], { kind: 'custom', text: 'search the cart' });
    t.outcome('You find a brass key.', 'search');
    t.turn('menu', 'Household Chores', [], { kind: 'menu-pick', index: 1 });
    t.outcome('You stand the gate.', 'skill');
    t.turn('menu', 'Household Chores', [], { kind: 'recon', screen: 'map' });
    t.turn('menu', 'Household Chores', [], { kind: 'sleep' });
    // An outcome whose envelope carried no `distilledType` is simply uncounted on the verb axis.
    t.outcome('Something happened.');

    expect(t.verbHistogram()).toEqual({
      kinds: { custom: 1, 'menu-pick': 1, recon: 1, sleep: 1 },
      verbs: { search: 1, skill: 1 },
    });
  });

  it('returns empty histograms for a run that chose nothing', () => {
    expect(new Transcript().verbHistogram()).toEqual({ kinds: {}, verbs: {} });
  });

  it('separates a custom slot from the verb it resolved as', () => {
    const t = new Transcript();
    t.turn('menu', 'x', [], { kind: 'custom', text: 'lie down by the fire' });
    t.outcome('You doze.', 'rest');
    const { kinds, verbs } = t.verbHistogram();
    expect(kinds.custom).toBe(1);
    expect(verbs.custom).toBeUndefined();
    expect(verbs.rest).toBe(1);
  });
});

// ── the reviews file ──

describe('buildReviewFile (contract §9)', () => {
  it('assembles a self-sufficient file from a finished transcript', () => {
    const transcript = sampleTranscript();
    const file = buildReviewFile({ persona: 'explorer', review: REVIEW, transcript, cost: COST });

    expect(file).toEqual({
      v: REVIEW_FILE_VERSION,
      persona: 'explorer',
      header: {
        seq: 0,
        kind: 'header',
        v: expect.any(Number),
        userId: 'agent:play-1',
        brain: 'prod',
        backend: 'real',
        recordedAt: '2026-09-13T09:00:00.000Z',
        persona: 'explorer',
      },
      summary: transcript.summary(),
      review: REVIEW,
      dayNotes: [
        { type: 'day-note', dayNumber: 1, engagement: 4, fulfilment: 3, line: 'A good scene, three buttons.', arcNote: 'the temple' },
      ],
      frictions: [
        { type: 'friction', dayNumber: 1, what: 'bail dice read inconsistently', severity: 3, recurrence: 'periodic' },
      ],
      verbs: { custom: 1 },
      actionVerbs: { search: 1 },
      arcNotes: ['the temple'],
      cost: COST,
    });
    expect(file.v).toBe(1);
  });

  it('carries no header when there is no protocol log, rather than inventing one', () => {
    const file = buildReviewFile({ persona: 'explorer', review: REVIEW, transcript: new Transcript(), cost: COST });
    expect(file.header).toBeNull();
    expect(file.arcNotes).toEqual([]);
    expect(file.summary.turns).toBe(0);
  });

  it('survives a JSON round-trip with no undefined holes', () => {
    const file = buildReviewFile({ persona: 'casual', review: REVIEW, transcript: sampleTranscript(), cost: COST });
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
  });
});

describe('personaReviewInput', () => {
  it('slices the series the reviewer is asked about out of the transcript', () => {
    const input = personaReviewInput('explorer', sampleTranscript());
    expect(input.persona).toBe('explorer');
    expect(input.dayNotes).toHaveLength(1);
    expect(input.frictions).toHaveLength(1);
    expect(input.reconScreens.map((r) => r.screen)).toEqual(['map']);
    expect(input.summary.outcomes).toBe(1);
    // The harness does not retain the brain's day log across days, so the runner cannot pass one.
    expect(input.dayLogs).toBeUndefined();
  });
});

describe('formatPersonaReview', () => {
  it('prints every field, with unobserved visible as itself', () => {
    const text = formatPersonaReview(REVIEW);
    expect(text).toContain('── persona review (explorer) ──');
    expect(text).toContain('aliveness unobserved');
    expect(text).toContain('memory unobserved');
    expect(text).toContain('engagement 4');
    expect(text).toContain('tomorrow: probably — verdict: would drift off');
    expect(text).toContain('quit:     week 2 — A map that stops opening.');
    expect(text).toContain('engaging: The oath scene at the gate.');
    expect(text).toContain('boring: The third identical work menu.');
  });

  it('prints an empty list as (none) rather than as a blank', () => {
    expect(formatPersonaReview({ ...REVIEW, boring: [] })).toContain('boring: (none)');
  });
});

// ── the prompt the parser depends on ──

describe('persona-review.md (spec § F)', () => {
  const prompt = loadCriticTemplate('persona-review');

  it('names the three benchmark questions and the long-horizon lens', () => {
    expect(prompt).toContain('Would I come back tomorrow?');
    expect(prompt).toContain('something I am building that I would miss');
    expect(prompt).toContain('What would make me quit, and how soon?');
    expect(prompt).toMatch(/December/);
    expect(prompt).toContain('year-long daily ritual');
  });

  it('carries the five criteria and makes unobserved first-class', () => {
    for (const field of RUBRIC_FIELDS) expect(prompt).toContain(field);
    for (const score of ['engagement', 'fulfilment', 'clarity', 'challenge', 'variety']) {
      expect(prompt).toContain(score);
    }
    expect(prompt).toContain('unobserved');
    // The two criteria a short run cannot honestly score, named as such (spec § Instrument limits).
    expect(prompt).toContain('aliveness');
    expect(prompt).toContain('memory');
    expect(prompt).toMatch(/one-day run cannot honestly rate/);
  });

  it('asks for every field the parser requires, in a JSON-only reply', () => {
    expect(prompt).toContain('valid JSON only');
    for (const key of [
      'persona',
      'rubric',
      'scores',
      'returnTomorrow',
      'hook',
      'building',
      'quitTrigger',
      'quitHorizon',
      'engaging',
      'boring',
      'clunky',
      'best',
      'worst',
      'verdict',
      'review',
    ]) {
      expect(prompt).toContain(`"${key}"`);
    }
  });

  it('constrains quitHorizon to the four shapes parseQuitHorizon reads, and the closed vocabularies', () => {
    expect(prompt).toContain('day N');
    expect(prompt).toContain('week N');
    expect(prompt).toContain('month N');
    expect(prompt).toContain('never on this evidence');
    expect(prompt).toContain('would play again tomorrow');
    expect(prompt).toContain('would drift off');
    expect(prompt).toContain('would churn');
    expect(prompt).toContain('probably');
  });
});
