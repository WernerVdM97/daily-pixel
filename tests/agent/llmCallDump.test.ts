import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';

import { buildAgentEngine } from '../../src/agent/engineHarness.js';
import { createAgentHarness } from '../../src/agent/harness.js';
import { ScriptedAgentPlayerGateway } from '../../src/agent/ScriptedAgentPlayerGateway.js';
import { SEED, buildDeterministicRouter } from '../../src/agent/deterministicSession.js';
import { buildLlmCallDump, llmCallDumpPath } from '../../src/agent/llmCallDump.js';
import { agentCapturePolicy } from '../../src/agent/harnessEnv.js';

/** One scripted action's four stage replies, in the order the machine asks for them. The brain's
 *  custom move resolves immediately (`decision: []`), so no decision beat is played. */
const STAGE_REPLIES: unknown[] = [
  { actionType: 'skill', flags: { unsafe_location: false, needs_roll: true, target_present: false } },
  { distilledType: 'chore', stat: 'physical', baseDc: 5, required: false, decision: [] },
  { mutations: [] },
  { outcome_text: 'You polish your boots.' },
];

const STAGE_KINDS = [
  'pipeline-classify',
  'pipeline-decide',
  'pipeline-resolve-mutate',
  'pipeline-resolve-narrate',
];

/** A transport stub that answers each stage in turn with reasoning attached, so the audit rows carry
 *  the signals a real DeepSeek reply does. */
function stageFetch(): typeof fetch {
  let call = 0;
  const fn = vi.fn(async () => {
    const body = STAGE_REPLIES[call++];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(body), reasoning: 'weighing the options' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
      text: async () => '',
    };
  });
  return fn as unknown as typeof fetch;
}

/** A stubbed live-shaped run: the real pipeline gateway (stubbed transport) recording into the
 *  harness's own `:memory:` DB, a scripted brain, one action played. */
async function runOneAction() {
  vi.stubGlobal('fetch', stageFetch());
  const agentEngine = buildAgentEngine({
    apiKey: 'test-key',
    recordLlmCalls: true,
    capturePolicy: agentCapturePolicy({}),
    // The critic is a second recorder into the same DB; off, so the row count is the four stages.
    criticEnabled: false,
    rollD20: () => 20,
  });
  const brain = new ScriptedAgentPlayerGateway([{ kind: 'custom', text: 'polish my boots' }]);
  const harness = createAgentHarness(agentEngine.engine, buildDeterministicRouter(agentEngine), brain, 'agent:dump');
  await harness.createCharacter(SEED);
  await harness.playOneAction();
  return agentEngine;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildLlmCallDump', () => {
  it('dumps one entry per recorded row, whole, in row order', async () => {
    const agentEngine = await runOneAction();
    const { n } = agentEngine.db.prepare('SELECT COUNT(*) AS n FROM llm_calls').get() as { n: number };

    const dump = buildLlmCallDump(agentEngine.db);

    expect(dump).toHaveLength(n);
    expect(n).toBe(STAGE_KINDS.length);
    expect(dump.map((row) => row.call_kind)).toEqual(STAGE_KINDS);
    expect(Object.keys(dump[0])).toEqual([
      'action_id',
      'prompt_version',
      'call_kind',
      'critic_severity',
      'beat',
      'model',
      'tier',
      'context_digest',
      'raw_prompt',
      'reasoning',
      'parse_ok',
      'validation_warnings',
      'error',
      'http_status',
      'prompt_tokens',
      'completion_tokens',
      'reasoning_chars',
      'latency_ms',
      'created_at',
    ]);
  });

  it('keeps the prompt and reasoning of a call that succeeded, not only of a diagnostic one', async () => {
    const agentEngine = await runOneAction();

    const decide = buildLlmCallDump(agentEngine.db).find((row) => row.call_kind === 'pipeline-decide');

    expect(decide).toBeDefined();
    expect(decide?.parse_ok).toBe(1);
    expect(decide?.error).toBeNull();
    expect(decide?.raw_prompt).toContain('polish my boots');
    expect(decide?.reasoning).toBe('weighing the options');
    expect(decide?.reasoning_chars).toBe('weighing the options'.length);
  });

  it('carries nothing about the host into the payload', async () => {
    const agentEngine = await runOneAction();

    const payload = JSON.stringify(buildLlmCallDump(agentEngine.db));

    expect(payload).not.toContain(os.tmpdir());
    expect(payload).not.toMatch(/\/(home|Users|tmp)\//);
  });

  it('is empty rather than absent for a run that recorded nothing', async () => {
    const agentEngine = buildAgentEngine({ apiKey: 'test-key', criticEnabled: false });
    expect(buildLlmCallDump(agentEngine.db)).toEqual([]);
  });
});

describe('llmCallDumpPath', () => {
  it('lands beside the transcript it derives from', () => {
    expect(llmCallDumpPath('runs/explorer.json')).toBe('runs/explorer.json.llm-calls.json');
  });
});
