import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { LlmCallRepository } from '../../src/db/repositories/llm-call.js';
import { summarizeLlmCosts, formatLlmCostSummary } from '../../src/agent/llmCostSummary.js';
import type { LlmCallRecord } from '../../src/llm/LlmCallRecorder.js';

let db: Database.Database;
let repo: LlmCallRepository;

/** A full, realistic `llm_calls` row — spelled out (not partial) so a test overriding one field
 *  can't accidentally leave a required column undefined and mask a query bug with a NULL. */
function baseRecord(overrides?: Partial<LlmCallRecord>): LlmCallRecord {
  return {
    appVersion: '0.3.3-test',
    promptVersion: 'v12/skill',
    callKind: 'pipeline-decide',
    criticSeverity: null,
    beat: null,
    model: 'deepseek-v4-flash',
    temperature: 0.7,
    tier: 0,
    playerInput: 'barter with the merchant',
    contextDigest: '{}',
    rawPrompt: null,
    reasoning: null,
    responseJson: '{}',
    parseOk: true,
    validationWarnings: [],
    error: null,
    httpStatus: 200,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    reasoningChars: null,
    latencyMs: 250,
    finishReason: 'stop',
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  repo = new LlmCallRepository(db);
});

describe('summarizeLlmCosts', () => {
  it('reports zeroed totals against an empty llm_calls table (no division-by-zero NaN)', () => {
    const summary = summarizeLlmCosts(db);
    expect(summary.totalCalls).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.byCallKind).toEqual([]);
    expect(summary.criticVerdicts).toEqual([]);
    expect(summary.actionableCritic).toBe(0);
    expect(summary.actionableCriticLegacyCount).toBe(0);
  });

  it('totals calls and tokens across every call_kind', () => {
    repo.record(baseRecord({ callKind: 'pipeline-classify', totalTokens: 40 }));
    repo.record(baseRecord({ callKind: 'pipeline-decide', totalTokens: 150 }));
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'ok', totalTokens: 60 }));

    const summary = summarizeLlmCosts(db);

    expect(summary.totalCalls).toBe(3);
    expect(summary.totalTokens).toBe(250);
  });

  it('breaks down by call_kind with correct call/token shares', () => {
    // 3 decide calls @ 100 tokens each, 1 critic call @ 100 tokens — 75%/25% calls, 300/400=75%
    // decide tokens vs 100/400=25% critic tokens.
    repo.record(baseRecord({ callKind: 'pipeline-decide', totalTokens: 100 }));
    repo.record(baseRecord({ callKind: 'pipeline-decide', totalTokens: 100 }));
    repo.record(baseRecord({ callKind: 'pipeline-decide', totalTokens: 100 }));
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'ok', totalTokens: 100 }));

    const summary = summarizeLlmCosts(db);

    const decideRow = summary.byCallKind.find((r) => r.callKind === 'pipeline-decide');
    const criticRow = summary.byCallKind.find((r) => r.callKind === 'critic');
    expect(decideRow).toMatchObject({ calls: 3, tokens: 300, callShare: 0.75, tokenShare: 0.75 });
    expect(criticRow).toMatchObject({ calls: 1, tokens: 100, callShare: 0.25, tokenShare: 0.25 });
  });

  it('distributes critic verdicts by severity, including NULL for a failed/unparsed critic call', () => {
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'ok' }));
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'ok' }));
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'minor' }));
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'major' }));
    // A critic call that errored before producing a verdict — critic_severity NULL (schema.sql:84).
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: null, parseOk: false, error: 'transport error' }));

    const summary = summarizeLlmCosts(db);

    const bySeverity = Object.fromEntries(summary.criticVerdicts.map((v) => [String(v.severity), v.count]));
    expect(bySeverity).toEqual({ ok: 2, minor: 1, major: 1, null: 1 });
  });

  it('actionableCritic counts ONLY decide+major and narrate+minor — the two provably-actionable combos', () => {
    // Actionable: decide beat major (fires a bounded re-decide), narrate beat minor (patches
    // outcomeText). Both must be counted.
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'major', beat: 'decision' }));
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'minor', beat: 'resolution' }));
    // Provable no-ops per the 2-of-6 rule — logged and discarded, must NOT be counted.
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'minor', beat: 'decision' }));
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'major', beat: 'resolution' }));
    // Never actionable by definition.
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'ok', beat: 'decision' }));

    const summary = summarizeLlmCosts(db);

    expect(summary.actionableCritic).toBe(2);
    expect(summary.actionableCriticLegacyCount).toBe(0);
    expect(summary.actionableCriticNote).toMatch(/2-of-6/i);
    expect(summary.actionableCriticNote).toMatch(/beat/i);
  });

  it('counts a NULL-beat critic row (pre-migration/legacy) separately, never folded into actionableCritic', () => {
    // Legacy rows predating the `beat` column — even a major verdict here must not be silently
    // counted as actionable (no beat recorded means "unknown", not "decide beat").
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'major', beat: null }));
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'minor', beat: null }));
    // A real actionable row alongside the legacy ones, to prove the two figures don't bleed together.
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'major', beat: 'decision' }));

    const summary = summarizeLlmCosts(db);

    expect(summary.actionableCritic).toBe(1);
    expect(summary.actionableCriticLegacyCount).toBe(2);
  });

  // The first RA-4 A/B had to INFER that every narrate critic call was inert (6 major + 0 minor
  // with an actionable count of 6 forces all 6 onto decide beats). This split reports the decide
  // vs narrate spend directly, so the value gap between the critic's two halves is legible without
  // that inference — it is the comparison the keep/gate/drop call rests on.
  it('criticByBeat splits critic spend and non-ok verdicts by reviewed beat', () => {
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'major', beat: 'decision', totalTokens: 100 }));
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'ok', beat: 'decision', totalTokens: 100 }));
    // Two narrate calls paid for, both inert — the shape the A/B actually observed.
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'ok', beat: 'resolution', totalTokens: 50 }));
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'ok', beat: 'resolution', totalTokens: 50 }));
    // A non-critic row must not leak into the split.
    repo.record(baseRecord({ callKind: 'pipeline-decide', criticSeverity: null, totalTokens: 999 }));

    const summary = summarizeLlmCosts(db);
    const decide = summary.criticByBeat.find((r) => r.beat === 'decision');
    const narrate = summary.criticByBeat.find((r) => r.beat === 'resolution');

    expect(decide).toEqual({ beat: 'decision', calls: 2, tokens: 200, nonOkVerdicts: 1 });
    expect(narrate).toEqual({ beat: 'resolution', calls: 2, tokens: 100, nonOkVerdicts: 0 });
  });

  it('a non-critic call_kind never pollutes the critic-verdict distribution', () => {
    repo.record(baseRecord({ callKind: 'pipeline-decide', criticSeverity: null }));
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'major' }));

    const summary = summarizeLlmCosts(db);

    expect(summary.criticVerdicts).toEqual([{ severity: 'major', count: 1 }]);
  });
});

describe('formatLlmCostSummary', () => {
  it('renders a human-readable block covering totals, per-kind shares, and the actionable note', () => {
    repo.record(baseRecord({ callKind: 'pipeline-decide', totalTokens: 100 }));
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'major', beat: 'decision', totalTokens: 50 }));

    const text = formatLlmCostSummary(summarizeLlmCosts(db));

    expect(text).toContain('llm cost summary');
    expect(text).toContain('2 call(s), 150 token(s)');
    expect(text).toContain('pipeline-decide');
    expect(text).toContain('critic');
    expect(text).toContain('actionable critic: 1');
    expect(text).not.toContain('legacy'); // no NULL-beat rows in this run
  });

  it('surfaces the legacy figure only when a NULL-beat critic row is actually present', () => {
    repo.record(baseRecord({ callKind: 'critic', criticSeverity: 'major', beat: null, totalTokens: 50 }));

    const text = formatLlmCostSummary(summarizeLlmCosts(db));

    expect(text).toContain('actionable critic: 0');
    expect(text).toContain('actionable critic (legacy, no beat recorded): 1');
  });

  it('omits the critic-verdict lines entirely when the run made no critic calls', () => {
    repo.record(baseRecord({ callKind: 'pipeline-decide' }));

    const text = formatLlmCostSummary(summarizeLlmCosts(db));

    expect(text).not.toContain('critic verdicts');
    expect(text).not.toContain('actionable critic');
  });
});
