import { describe, it, expect, vi } from 'vitest';

import { ScriptedPlaytestCriticGateway } from '../../src/agent/ScriptedPlaytestCriticGateway.js';
import { ProdPlaytestCriticGateway, buildCritiqueMessage } from '../../src/agent/ProdPlaytestCriticGateway.js';
import { AGENT_CRITIC_STAMP } from '../../src/agent/criticPrompt.js';
import { Transcript } from '../../src/agent/transcript.js';
import type { CritiqueInput, PlaytestReport } from '../../src/agent/PlaytestCriticGateway.js';
import type { LlmCallRecord } from '../../src/llm/LlmCallRecorder.js';

// ── M4.5 — the playtest-critic seam (goal b): the scripted stub returns a fixed report (CI, no
// network), and the real DeepSeek-backed gateway renders a completed run into a user message,
// parses a `{pacing,clarity,fun,difficulty,summary}` report from a canned JSON body via an injected
// fetch, and records one llm_calls row. The real LLM never runs here — every hit is a mocked fetch. ──

const REPORT: PlaytestReport = {
  pacing: 'Brisk but never rushed.',
  clarity: 'Prompts read clearly.',
  fun: 'The goblin skirmish had real tension.',
  difficulty: 'Fair — the favoured hint helped.',
  summary: 'A solid session; tighten the day-job loop.',
};

/** A small completed run covering every TranscriptEvent kind the critic renders. */
function sampleRun(): CritiqueInput {
  const t = new Transcript();
  t.turn(
    'menu',
    '⚔️ Action\nPick a task.',
    [
      { move: { kind: 'custom', text: '' }, label: 'Type your own action' },
      { move: { kind: 'sleep' }, label: 'Go to sleep' },
    ],
    { kind: 'custom', text: 'attack the goblin' },
  );
  t.commute('The Gate', 'You head to the The Gate. (-1 stamina)');
  t.outcome('Your blade finds its mark; the goblin falls.');
  t.deadEnd('empty-action', 'nothing came of it');
  t.finding('warning', 'illegal move on menu screen: choice');
  t.day(2, 'nightly tick — rested at the Oak, world advanced');
  return { events: t.events, summary: t.summary() };
}

// ── injected-fetch helpers (mirror tests/agent/agent-gateway.test.ts) ──

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

function makeGateway(fetchFn: typeof fetch, recorder?: ReturnType<typeof capture>['recorder']) {
  return new ProdPlaytestCriticGateway({
    apiKey: 'test-key',
    fetch: fetchFn,
    recorder,
    systemPrompt: 'CRITIC SYSTEM',
  });
}

// ── ScriptedPlaytestCriticGateway ──

describe('ScriptedPlaytestCriticGateway', () => {
  it('returns the fixed report and records what it was asked to critique', async () => {
    const gw = new ScriptedPlaytestCriticGateway(REPORT);
    const input = sampleRun();

    expect(await gw.critique(input)).toBe(REPORT);
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0]).toBe(input);
  });
});

// ── ProdPlaytestCriticGateway — request assembly + render ──

describe('ProdPlaytestCriticGateway — request', () => {
  it('sends the versioned system prompt, JSON mode, and the rendered run', async () => {
    const fetchFn = mockFetch(apiResponse(REPORT));
    await makeGateway(fetchFn).critique(sampleRun());

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = bodyOf(fetchFn);
    expect(body.messages[0].content).toBe('CRITIC SYSTEM');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[1].content).toContain('RUN SUMMARY:');
    expect(body.messages[1].content).toContain('PLAY LOG:');
  });

  it('buildCritiqueMessage renders the scoreboard and every event kind as a log line', () => {
    const msg = buildCritiqueMessage(sampleRun());
    expect(msg).toContain('RUN SUMMARY:');
    expect(msg).toContain('"outcomes":1');
    // the turn line carries the chosen move + the offered labels
    expect(msg).toContain('[menu]');
    expect(msg).toContain('chose {"kind":"custom","text":"attack the goblin"}');
    expect(msg).toContain('COMMUTE → The Gate');
    expect(msg).toContain('OUTCOME: Your blade finds its mark; the goblin falls.');
    expect(msg).toContain('DEAD-END: empty-action (nothing came of it)');
    expect(msg).toContain('⚠ FINDING [warning]: illegal move on menu screen: choice');
    expect(msg).toContain('── NIGHT → day 2:');
  });

  it('collapses a multi-line screen render to one log line', () => {
    const t = new Transcript();
    t.turn('decision', 'line one\n\nline two\n  line three', [], { kind: 'bail' });
    const msg = buildCritiqueMessage({ events: t.events, summary: t.summary() });
    expect(msg).toContain('[decision] line one line two line three');
  });
});

// ── ProdPlaytestCriticGateway — response parse → PlaytestReport ──

describe('ProdPlaytestCriticGateway — parse', () => {
  it('returns the validated, trimmed report', async () => {
    const gw = makeGateway(mockFetch(apiResponse({ ...REPORT, pacing: '  brisk  ' })));
    const report = await gw.critique(sampleRun());
    expect(report.pacing).toBe('brisk');
    expect(report.summary).toBe(REPORT.summary);
  });

  it('throws when a dimension is missing', async () => {
    const { fun, ...missingFun } = REPORT;
    void fun;
    const gw = makeGateway(mockFetch(apiResponse(missingFun)));
    await expect(gw.critique(sampleRun())).rejects.toThrow(/"fun" is missing or empty/);
  });

  it('throws when a dimension is blank', async () => {
    const gw = makeGateway(mockFetch(apiResponse({ ...REPORT, difficulty: '   ' })));
    await expect(gw.critique(sampleRun())).rejects.toThrow(/"difficulty" is missing or empty/);
  });

  it('throws on a non-2xx response', async () => {
    const gw = makeGateway(mockFetch({ error: 'boom' }, 500));
    await expect(gw.critique(sampleRun())).rejects.toThrow(/DeepSeek API error 500/);
  });

  it('throws on an unparseable body', async () => {
    const gw = makeGateway(mockFetch({ choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }] }));
    await expect(gw.critique(sampleRun())).rejects.toThrow(/failed to parse/);
  });
});

// ── ProdPlaytestCriticGateway — audit ──

describe('ProdPlaytestCriticGateway — audit', () => {
  it('records one row stamped agent-critic on success', async () => {
    const { records, recorder } = capture();
    await makeGateway(mockFetch(apiResponse(REPORT)), recorder).critique(sampleRun());

    expect(records).toHaveLength(1);
    expect(records[0].callKind).toBe('agent-critic');
    expect(records[0].promptVersion).toBe(AGENT_CRITIC_STAMP);
    expect(records[0].parseOk).toBe(true);
    expect(records[0].error).toBeNull();
  });

  it('records a diagnostic row (parseOk false, error + rawPrompt set) on failure', async () => {
    const { records, recorder } = capture();
    const gw = makeGateway(mockFetch({ error: 'boom' }, 500), recorder);
    await expect(gw.critique(sampleRun())).rejects.toThrow();

    expect(records).toHaveLength(1);
    expect(records[0].parseOk).toBe(false);
    expect(records[0].error).toMatch(/DeepSeek API error 500/);
    expect(records[0].rawPrompt).toContain('RUN SUMMARY:');
  });
});
