import { describe, it, expect, vi } from 'vitest';
import { DeepseekLlmGateway } from '../../src/llm/DeepseekLlmGateway.js';
import type { CriticInput } from '../../src/llm/LlmGateway.js';
import type { LlmCallRecord } from '../../src/llm/LlmCallRecorder.js';
import { DeepCapturePolicy } from '../../src/llm/capture-policy.js';

const criticInput: CriticInput = {
  beat: 'resolution',
  rollOutcome: 'failure',
  decision: {
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: false,
    decision: [],
    outcomeText: 'You triumph over the wolf and claim its pelt.',
    mutations: [],
  },
  finalMutations: [{ type: 'modify_stamina', amount: -2 }],
  contextDigest: '{"location":"The Dark Pines"}',
  playerInput: 'hunt the wolf',
  warnings: ['resolving turn with only negative stamina/health mutations'],
};

/** Mock a critic API response (verdict JSON + optional thinking). */
function mockFetch(verdict: unknown, opts: { status?: number; reasoning?: string } = {}): typeof fetch {
  const status = opts.status ?? 200;
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({
      choices: [{
        message: {
          content: typeof verdict === 'string' ? verdict : JSON.stringify(verdict),
          ...(opts.reasoning !== undefined ? { reasoning_content: opts.reasoning } : {}),
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    text: () => Promise.resolve(''),
  }) as unknown as typeof fetch;
}

function makeRecorder() {
  const records: LlmCallRecord[] = [];
  const promotions: Array<{ callId: number; rawPrompt?: string | null; reasoning?: string | null }> = [];
  return {
    records,
    promotions,
    recorder: {
      record: (r: LlmCallRecord) => { records.push(r); return records.length; },
      promoteDeepCapture: (callId: number, f: { rawPrompt?: string | null; reasoning?: string | null }) =>
        promotions.push({ callId, ...f }),
    },
  };
}

describe('DeepseekLlmGateway.critique', () => {
  it('parses a clean verdict (ok = pass through)', async () => {
    const gw = new DeepseekLlmGateway({ apiKey: 'k', fetch: mockFetch({ ok: true, severity: 'minor', issues: [] }) });
    const v = await gw.critique(criticInput);
    expect(v).toEqual({ ok: true, severity: 'minor', issues: [] });
  });

  it('parses a minor defect and maps outcome_text → outcomeText in the patch', async () => {
    const gw = new DeepseekLlmGateway({
      apiKey: 'k',
      fetch: mockFetch({
        ok: false,
        severity: 'minor',
        issues: ['narration reads as a win but ROLL VERDICT is FAILURE'],
        patch: { outcome_text: 'The wolf slips away; you are left winded and empty-handed.' },
      }),
    });
    const v = await gw.critique(criticInput);
    expect(v.ok).toBe(false);
    expect(v.severity).toBe('minor');
    expect(v.issues).toHaveLength(1);
    expect(v.patch).toEqual({ outcomeText: 'The wolf slips away; you are left winded and empty-handed.' });
  });

  it('does not attach a patch on a major defect', async () => {
    const gw = new DeepseekLlmGateway({
      apiKey: 'k',
      fetch: mockFetch({ ok: false, severity: 'major', issues: ['combat silently converted to rest'], patch: { prompt: 'x' } }),
    });
    const v = await gw.critique(criticInput);
    expect(v.severity).toBe('major');
    expect(v.patch).toBeUndefined();
  });

  it('records the call tagged call_kind=critic / prompt_version=critic-v1', async () => {
    const { records, recorder } = makeRecorder();
    const gw = new DeepseekLlmGateway({ apiKey: 'k', fetch: mockFetch({ ok: true, severity: 'minor', issues: [] }), recorder });
    await gw.critique(criticInput);
    expect(records).toHaveLength(1);
    expect(records[0].callKind).toBe('critic');
    expect(records[0].promptVersion).toBe('critic-v1');
    expect(records[0].playerInput).toBe('hunt the wolf');
    expect(records[0].responseJson).toContain('"ok"'); // response always recorded on success
    expect(records[0].parseOk).toBe(true);
  });

  it('captures thinking on every call when mode is "all"', async () => {
    const { records, recorder } = makeRecorder();
    const gw = new DeepseekLlmGateway({
      apiKey: 'k',
      recorder,
      capturePolicy: new DeepCapturePolicy('all'),
      fetch: mockFetch({ ok: true, severity: 'minor', issues: [] }, { reasoning: 'checked verdict vs prose — consistent' }),
    });
    await gw.critique(criticInput);
    expect(records[0].reasoning).toBe('checked verdict vs prose — consistent');
    expect(records[0].reasoningChars).toBe('checked verdict vs prose — consistent'.length);
  });

  it('omits thinking on a clean call when mode is "spiral" (but still gauges its length)', async () => {
    const { records, recorder } = makeRecorder();
    const gw = new DeepseekLlmGateway({
      apiKey: 'k',
      recorder, // capturePolicy defaults to mode 'spiral'
      fetch: mockFetch({ ok: true, severity: 'minor', issues: [] }, { reasoning: 'some thinking' }),
    });
    await gw.critique(criticInput);
    expect(records[0].reasoning).toBeNull();
    expect(records[0].reasoningChars).toBe('some thinking'.length);
  });

  it('captures thinking + raw prompt on a parse failure regardless of the toggle', async () => {
    const { records, recorder } = makeRecorder();
    const gw = new DeepseekLlmGateway({
      apiKey: 'k',
      recorder, // toggle off
      fetch: mockFetch('not valid json', { reasoning: 'i got confused' }),
    });
    const v = await gw.critique(criticInput);
    expect(v.ok).toBe(true); // fails open
    expect(records[0].parseOk).toBe(false);
    expect(records[0].error).not.toBeNull();
    expect(records[0].reasoning).toBe('i got confused'); // diagnostic → captured
    expect(records[0].rawPrompt).not.toBeNull();          // diagnostic → captured
  });

  it('records critic_severity = ok and does NOT keep thinking on a clean verdict (toggle off)', async () => {
    const { records, recorder } = makeRecorder();
    const gw = new DeepseekLlmGateway({
      apiKey: 'k', recorder,
      fetch: mockFetch({ ok: true, severity: 'minor', issues: [] }, { reasoning: 'all consistent' }),
    });
    await gw.critique(criticInput);
    expect(records[0].criticSeverity).toBe('ok');
    expect(records[0].reasoning).toBeNull();
  });

  it('on a flagged verdict, records the severity AND always keeps thinking + raw prompt (toggle off)', async () => {
    const { records, recorder } = makeRecorder();
    const gw = new DeepseekLlmGateway({
      apiKey: 'k', recorder, // capturePolicy defaults to mode 'spiral', not a spiral here
      fetch: mockFetch(
        { ok: false, severity: 'minor', issues: ['win narration on a FAILURE'], patch: { outcome_text: 'fixed' } },
        { reasoning: 'verdict vs prose mismatch' },
      ),
    });
    await gw.critique(criticInput);
    expect(records[0].criticSeverity).toBe('minor');
    expect(records[0].reasoning).toBe('verdict vs prose mismatch'); // forced by the flag
    expect(records[0].rawPrompt).not.toBeNull();                    // forced by the flag
  });

  it('backfills the critiqued decision row with its prompt + reasoning when flagged', async () => {
    const { promotions, recorder } = makeRecorder();
    const gw = new DeepseekLlmGateway({
      apiKey: 'k', recorder,
      fetch: mockFetch({ ok: false, severity: 'minor', issues: ['mismatch'], patch: { outcome_text: 'fixed' } }),
    });
    // The decision under critique carries its own audit-row id + transient prompt/reasoning.
    const flaggedInput: CriticInput = {
      ...criticInput,
      decision: { ...criticInput.decision, _llmCallId: 42, _rawPrompt: '## You — Ranger', _reasoning: 'why it chose this' },
    };
    await gw.critique(flaggedInput);
    expect(promotions).toEqual([{ callId: 42, rawPrompt: '## You — Ranger', reasoning: 'why it chose this' }]);
  });

  it('does NOT backfill the decision row when the verdict is ok', async () => {
    const { promotions, recorder } = makeRecorder();
    const gw = new DeepseekLlmGateway({
      apiKey: 'k', recorder, fetch: mockFetch({ ok: true, severity: 'minor', issues: [] }),
    });
    await gw.critique({ ...criticInput, decision: { ...criticInput.decision, _llmCallId: 42 } });
    expect(promotions).toHaveLength(0);
  });

  it('records a major flag severity', async () => {
    const { records, recorder } = makeRecorder();
    const gw = new DeepseekLlmGateway({
      apiKey: 'k', recorder,
      fetch: mockFetch({ ok: false, severity: 'major', issues: ['combat converted to rest'] }),
    });
    await gw.critique(criticInput);
    expect(records[0].criticSeverity).toBe('major');
  });

  it('fails open and records the error on a transport failure', async () => {
    const { records, recorder } = makeRecorder();
    const gw = new DeepseekLlmGateway({
      apiKey: 'k',
      recorder,
      fetch: vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch,
    });
    const v = await gw.critique(criticInput);
    expect(v).toMatchObject({ ok: true, severity: 'minor', issues: [] }); // never blocks gameplay
    expect(v._llmCallId).toBe(1); // the (failed) critic call is still recorded + linkable
    expect(records[0].callKind).toBe('critic');
    expect(records[0].error).toContain('network down');
    expect(records[0].parseOk).toBe(false);
    expect(records[0].criticSeverity).toBeNull(); // no verdict produced
  });
});
