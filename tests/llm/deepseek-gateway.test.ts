import { describe, it, expect, vi } from 'vitest';
import { buildSystemPrompt, buildUserMessage } from '../../src/llm/prompt-builder.js';
import { DeepseekLlmGateway } from '../../src/llm/DeepseekLlmGateway.js';
import type { LlmContext, LlmDecision } from '../../src/llm/LlmGateway.js';
import type { LlmCallRecord } from '../../src/llm/LlmCallRecorder.js';



describe('PromptBuilder — system prompt', () => {
  it('includes the game master role and JSON output instruction', () => {
    const result = buildSystemPrompt();

    expect(result).toContain('The Warden\'s Oak');
    expect(result).toContain('valid JSON');
    expect(result).toContain('game master');
  });

  it('includes the decision rules (distilled_type, stat, base_dc, required, done)', () => {
    const result = buildSystemPrompt();

    expect(result).toContain('distilled_type');
    expect(result).toContain('base_dc');
    expect(result).toContain('required');
    expect(result).toContain('done');
    expect(result).toContain('dc_modifier');
    expect(result).toContain('bail');
  });

  it('includes the response schema fields', () => {
    const result = buildSystemPrompt();

    expect(result).toContain('decision');
    expect(result).toContain('mutations');
    expect(result).toContain('outcome_text');
  });
});

const minimalContext: LlmContext = {
  character: {
    class: 'Warrior',
    stats: { physical: 3, wisdom: -1, intelligence: 0, charisma: 0 },
    health: 12,
    stamina: 10,
    alignment: 'lawful good',
    dayJob: 'Blacksmith',
  },
  location: { name: 'The Warden\'s Oak' },
  nearbyNpcs: [],
  nearbyPcs: [],
  recentActions: [],
  rawInput: 'go hunt a wolf',
  scalingHint: 'Day 1 — standard difficulty',
};

describe('PromptBuilder — user message', () => {
  it('includes character section with class, stats, health, stamina, alignment, dayJob', () => {
    const result = buildUserMessage(minimalContext);

    expect(result).toContain('CHARACTER:');
    expect(result).toContain('Warrior');
    expect(result).toContain('physical');
    expect(result).toContain('wisdom');
    expect(result).toContain('intelligence');
    expect(result).toContain('charisma');
    expect(result).toContain('health');
    expect(result).toContain('stamina');
    expect(result).toContain('lawful good');
    expect(result).toContain('Blacksmith');
  });

  it('includes the location name', () => {
    const result = buildUserMessage(minimalContext);

    expect(result).toContain('LOCATION:');
    expect(result).toContain('The Warden\'s Oak');
  });

  it('includes nearby NPCs with name and description', () => {
    const ctx: LlmContext = {
      ...minimalContext,
      nearbyNpcs: [
        { name: 'Greta', description: 'A stern blacksmith' },
        { name: 'Old Tom', description: 'A wandering hermit' },
      ],
    };

    const result = buildUserMessage(ctx);

    expect(result).toContain('NEARBY NPCS:');
    expect(result).toContain('Greta');
    expect(result).toContain('A stern blacksmith');
    expect(result).toContain('Old Tom');
    expect(result).toContain('A wandering hermit');
  });

  it('shows "none" when no NPCs are nearby', () => {
    const result = buildUserMessage(minimalContext);

    expect(result).toContain('NEARBY NPCS:');
    expect(result).toContain('none');
  });

  it('includes nearby PCs with name and class', () => {
    const ctx: LlmContext = {
      ...minimalContext,
      nearbyPcs: [
        { name: 'Aldric', class: 'Warrior' },
        { name: 'Lyra', class: 'Rogue' },
      ],
    };

    const result = buildUserMessage(ctx);

    expect(result).toContain('NEARBY PCS:');
    expect(result).toContain('Aldric');
    expect(result).toContain('Warrior');
    expect(result).toContain('Lyra');
    expect(result).toContain('Rogue');
  });

  it('shows "none" when no PCs are nearby', () => {
    const result = buildUserMessage(minimalContext);

    expect(result).toContain('NEARBY PCS:');
    expect(result).toContain('none');
  });

  it('includes recent actions with type and outcome', () => {
    const ctx: LlmContext = {
      ...minimalContext,
      recentActions: [
        { type: 'hunt', outcome: 'failure' },
        { type: 'travel', outcome: 'success' },
      ],
    };

    const result = buildUserMessage(ctx);

    expect(result).toContain('RECENT ACTIONS');
    expect(result).toContain('hunt');
    expect(result).toContain('failure');
    expect(result).toContain('travel');
    expect(result).toContain('success');
  });

  it('weaves each recent action narrative into the thread when present', () => {
    const ctx: LlmContext = {
      ...minimalContext,
      // Production order is newest-first (created_at DESC): hunt is the most recent.
      recentActions: [
        { type: 'hunt', outcome: 'failure', narrative: 'The stag bolted into the pines.' },
        { type: 'travel', outcome: 'success', narrative: 'You crossed the river ford by dusk.' },
      ],
    };

    const result = buildUserMessage(ctx);

    expect(result).toContain('RECENT ACTIONS');
    expect(result).toContain('You crossed the river ford by dusk.');
    expect(result).toContain('The stag bolted into the pines.');
    // Rendered oldest-first, so the older 'travel' beat precedes the newer 'hunt'.
    expect(result.indexOf('crossed the river')).toBeLessThan(result.indexOf('stag bolted'));
  });

  it('shows "none" when no recent actions', () => {
    const result = buildUserMessage(minimalContext);

    expect(result).toContain('RECENT ACTIONS');
    expect(result).toContain('none');
  });

  it('includes the raw input', () => {
    const result = buildUserMessage(minimalContext);

    expect(result).toContain('PLAYER INPUT:');
    expect(result).toContain('go hunt a wolf');
  });

  it('includes the scaling hint', () => {
    const result = buildUserMessage(minimalContext);

    expect(result).toContain('Day 1 — standard difficulty');
  });

  it('includes previous decisions when present', () => {
    const ctx: LlmContext = {
      ...minimalContext,
      previousDecisions: [
        { prompt: 'You spot deer tracks heading east…', chosen: 'Follow deer', dcModifier: 0 },
        { prompt: 'The thicket is dense and dry…', chosen: 'Stalk', dcModifier: -1 },
      ],
    };

    const result = buildUserMessage(ctx);

    expect(result).toContain('PREVIOUS DECISIONS');
    expect(result).toContain('Follow deer');
    expect(result).toContain('Stalk');
    expect(result).toContain('dc_modifier');
  });

  it('omits previous decisions section when not present', () => {
    const result = buildUserMessage(minimalContext);

    expect(result).not.toContain('PREVIOUS DECISIONS');
  });

  it('marks PHASE NEW_ACTION when there is no history or roll', () => {
    expect(buildUserMessage(minimalContext)).toContain('PHASE: NEW_ACTION');
  });

  it('marks PHASE CONTINUE when prior decisions exist but no roll', () => {
    const ctx: LlmContext = {
      ...minimalContext,
      previousDecisions: [{ prompt: 'You spot tracks…', chosen: 'Follow', dcModifier: 0 }],
    };
    expect(buildUserMessage(ctx)).toContain('PHASE: CONTINUE');
  });

  it('marks PHASE RESOLVE_ROLL when a roll verdict is attached', () => {
    const ctx: LlmContext = {
      ...minimalContext,
      previousDecisions: [{ prompt: 'You spot tracks…', chosen: 'Follow', dcModifier: 0 }],
      rollOutcome: 'success',
    };
    const result = buildUserMessage(ctx);
    expect(result).toContain('PHASE: RESOLVE_ROLL');
    expect(result).toContain('ROLL RESULT: SUCCESS');
  });
});

// ── DeepseekLlmGateway — response parsing & error handling ──

describe('DeepseekLlmGateway', () => {
  const validApiResponse = {
    choices: [{
      message: {
        content: JSON.stringify({
          distilled_type: 'hunt',
          stat: 'physical',
          base_dc: 12,
          required: false,
          done: false,
          decision: [
            { label: 'Track the wolf', dc_modifier: -2 },
            { label: 'Charge ahead', dc_modifier: 2 },
            { label: 'Bail', dc_modifier: null },
          ],
        }),
      },
    }],
  };

  function mockFetch(responseBody: unknown, status = 200): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(responseBody),
      text: () => Promise.resolve(JSON.stringify(responseBody)),
    }) as unknown as typeof fetch;
  }

  it('parses a valid API response into an LlmDecision', async () => {
    const gateway = new DeepseekLlmGateway({
      apiKey: 'test-key',
      fetch: mockFetch(validApiResponse),
    });

    const result = await gateway.decide(minimalContext);

    expect(result.distilledType).toBe('hunt');
    expect(result.stat).toBe('physical');
    expect(result.baseDc).toBe(12);
    expect(result.required).toBe(false);
    expect(result.done).toBe(false);
    expect(result.decision).toHaveLength(3);
    expect(result.decision[0]).toEqual({ label: 'Track the wolf', dcModifier: -2 });
    expect(result.decision[1]).toEqual({ label: 'Charge ahead', dcModifier: 2 });
    expect(result.decision[2]).toEqual({ label: 'Bail', dcModifier: null });
  });

  it('parses a valid per-option stat and omits invalid/absent ones', async () => {
    const response = {
      choices: [{
        message: {
          content: JSON.stringify({
            distilled_type: 'talk',
            stat: 'physical',
            base_dc: 12,
            required: false,
            done: false,
            decision: [
              { label: 'Charm him', stat: 'charisma', dc_modifier: 0 },   // valid override
              { label: 'Reason with him', stat: 'mind', dc_modifier: -1 }, // invalid → omitted
              { label: 'Force it', dc_modifier: 2 },                       // absent → omitted
            ],
          }),
        },
      }],
    };
    const gateway = new DeepseekLlmGateway({ apiKey: 'test-key', fetch: mockFetch(response) });

    const result = await gateway.decide(minimalContext);

    expect(result.decision[0]).toEqual({ label: 'Charm him', dcModifier: 0, stat: 'charisma' });
    // Invalid and absent stats are dropped — the option inherits the action default downstream.
    expect(result.decision[1]).toEqual({ label: 'Reason with him', dcModifier: -1 });
    expect(result.decision[2]).toEqual({ label: 'Force it', dcModifier: 2 });
  });

  it('strips carriage returns from LLM prose (prompt, outcome_text, labels)', async () => {
    const response = {
      choices: [{
        message: {
          content: JSON.stringify({
            distilled_type: 'travel',
            stat: 'physical',
            base_dc: 10,
            required: false,
            done: true,
            prompt: 'You set out.\r\nThe road is long.\r',
            decision: [{ label: 'Press on\r', dc_modifier: 0 }],
            outcome_text: 'You arrive.\r\nThe gate creaks.\r',
          }),
        },
      }],
    };
    const gateway = new DeepseekLlmGateway({ apiKey: 'test-key', fetch: mockFetch(response) });

    const result = await gateway.decide(minimalContext);

    expect(result.prompt).not.toContain('\r');
    expect(result.outcomeText).not.toContain('\r');
    expect(result.decision[0].label).not.toContain('\r');
    expect(result.outcomeText).toBe('You arrive.\nThe gate creaks.');
  });

  it('uses the deepseek-v4-flash model', async () => {
    const fetchFn = mockFetch(validApiResponse);
    const gateway = new DeepseekLlmGateway({
      apiKey: 'test-key',
      fetch: fetchFn,
    });

    await gateway.decide(minimalContext);

    const body = JSON.parse(fetchFn.mock.calls[0][1]!.body as string);
    expect(body.model).toBe('deepseek-v4-flash');
  });

  it('sends system + user messages', async () => {
    const fetchFn = mockFetch(validApiResponse);
    const gateway = new DeepseekLlmGateway({
      apiKey: 'test-key',
      fetch: fetchFn,
    });

    await gateway.decide(minimalContext);

    const body = JSON.parse(fetchFn.mock.calls[0][1]!.body as string);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
  });

  it('uses JSON response format', async () => {
    const fetchFn = mockFetch(validApiResponse);
    const gateway = new DeepseekLlmGateway({
      apiKey: 'test-key',
      fetch: fetchFn,
    });

    await gateway.decide(minimalContext);

    const body = JSON.parse(fetchFn.mock.calls[0][1]!.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('enables thinking mode', async () => {
    const fetchFn = mockFetch(validApiResponse);
    const gateway = new DeepseekLlmGateway({
      apiKey: 'test-key',
      fetch: fetchFn,
    });

    await gateway.decide(minimalContext);

    const body = JSON.parse(fetchFn.mock.calls[0][1]!.body as string);
    expect(body.thinking).toEqual({ type: 'enabled' });
  });

  it('sets the Authorization header', async () => {
    const fetchFn = mockFetch(validApiResponse);
    const gateway = new DeepseekLlmGateway({
      apiKey: 'test-key',
      fetch: fetchFn,
    });

    await gateway.decide(minimalContext);

    const headers = fetchFn.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('uses configurable temperature (default 0.7)', async () => {
    const fetchFn = mockFetch(validApiResponse);
    const gateway = new DeepseekLlmGateway({
      apiKey: 'test-key',
      fetch: fetchFn,
      temperature: 0.3,
    });

    await gateway.decide(minimalContext);

    const body = JSON.parse(fetchFn.mock.calls[0][1]!.body as string);
    expect(body.temperature).toBe(0.3);
  });

  it('throws on non-OK status', async () => {
    const gateway = new DeepseekLlmGateway({
      apiKey: 'test-key',
      fetch: mockFetch({ error: 'unauthorized' }, 401),
    });

    await expect(gateway.decide(minimalContext)).rejects.toThrow(/DeepSeek API error 401/);
  });

  it('throws on malformed JSON in response', async () => {
    const gateway = new DeepseekLlmGateway({
      apiKey: 'test-key',
      fetch: mockFetch({
        choices: [{ message: { content: 'not valid json {' } }],
      }),
    });

    await expect(gateway.decide(minimalContext)).rejects.toThrow('Failed to parse');
  });

  it('throws when content is empty', async () => {
    const gateway = new DeepseekLlmGateway({
      apiKey: 'test-key',
      fetch: mockFetch({
        choices: [{ message: { content: '' } }],
      }),
    });

    await expect(gateway.decide(minimalContext)).rejects.toThrow('empty response');
  });

  it('throws on network error (fetch rejects)', async () => {
    const gateway = new DeepseekLlmGateway({
      apiKey: 'test-key',
      fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });

    await expect(gateway.decide(minimalContext)).rejects.toThrow('ECONNREFUSED');
  });
});

/** Shared test helper: return a recorder that collects records in an array. */
function capture() {
  const records: LlmCallRecord[] = [];
  const recorder = { record: (r: LlmCallRecord) => { records.push(r); return records.length; } };
  return { records, recorder };
}

describe('DeepseekLlmGateway — reasoning (thinking) capture gating', () => {
  const goodDecision = {
    distilled_type: 'travel', stat: 'physical', base_dc: 10,
    required: false, done: true, decision: [], mutations: [],
  };

  function responseWithThinking(): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        choices: [{
          message: { content: JSON.stringify(goodDecision), reasoning_content: 'deep thoughts here' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
  }

  /** Malformed (unparseable) content — the LLM "failed" to return valid format. */
  function malformedResponse(): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        choices: [{
          message: { content: 'not json {', reasoning_content: 'deep thoughts here' },
          finish_reason: 'stop',
        }],
      }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
  }

  it('does NOT save full reasoning on a clean, well-formed call, but keeps the char count', async () => {
    const { records, recorder } = capture();
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: responseWithThinking(), recorder });
    await gw.decide(minimalContext);
    expect(records[0].reasoning).toBeNull();
    expect(records[0].reasoningChars).toBe('deep thoughts here'.length);
  });

  it('saves full reasoning when the LLM returns malformed format (diagnostic, hardcoded)', async () => {
    const { records, recorder } = capture();
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: malformedResponse(), recorder });
    await gw.decide(minimalContext).catch(() => { /* parse error expected */ });
    expect(records[0].parseOk).toBe(false);
    expect(records[0].reasoning).toBe('deep thoughts here');
  });

  it('a failed dice verdict alone does NOT trigger reasoning capture', async () => {
    const { records, recorder } = capture();
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: responseWithThinking(), recorder });
    await gw.decide({ ...minimalContext, rollOutcome: 'failure' });
    expect(records[0].reasoning).toBeNull();
  });

  it('saves full reasoning on every well-formed call when logThinkingAll is set', async () => {
    const { records, recorder } = capture();
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: responseWithThinking(), recorder, logThinkingAll: true });
    await gw.decide(minimalContext);
    expect(records[0].reasoning).toBe('deep thoughts here');
  });
});

describe('DeepseekLlmGateway — validation warnings (rule 4b)', () => {
  function rewardlessFetch(): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        choices: [{
          message: { content: JSON.stringify({
            distilled_type: 'train', stat: 'physical', base_dc: 10,
            required: false, done: true, decision: [],
            mutations: [{ type: 'modify_stamina', amount: -1 }],
            outcome_text: 'You train hard.',
          }), reasoning_content: '' },
          finish_reason: 'stop',
        }],
        usage: {},
      }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
  }

  function rewardingFetch(): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        choices: [{
          message: { content: JSON.stringify({
            distilled_type: 'train', stat: 'physical', base_dc: 10,
            required: false, done: true, decision: [],
            mutations: [
              { type: 'modify_stamina', amount: -1 },
              { type: 'modify_rolls_remaining', amount: 1 },
            ],
            outcome_text: 'You train hard and feel sharper.',
          }), reasoning_content: '' },
          finish_reason: 'stop',
        }],
        usage: {},
      }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
  }

  it('warns when done:true has only negative stamina/health mutations and no reward', async () => {
    const { records, recorder } = capture();
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: rewardlessFetch(), recorder });
    await gw.decide(minimalContext);
    const joined = records[0].validationWarnings.join(' ');
    expect(joined).toContain('done:true with only negative stamina/health mutations');
  });

  it('does NOT warn when done:true includes a reward mutation (modify_rolls_remaining)', async () => {
    const { records, recorder } = capture();
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: rewardingFetch(), recorder });
    await gw.decide(minimalContext);
    const joined = records[0].validationWarnings.join(' ');
    expect(joined).not.toContain('done:true with only negative stamina/health mutations');
  });

  it('does NOT warn when done:true mutations include add_item', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        choices: [{
          message: { content: JSON.stringify({
            distilled_type: 'hunt', stat: 'physical', base_dc: 10,
            required: false, done: true, decision: [],
            mutations: [
              { type: 'modify_stamina', amount: -2 },
              { type: 'add_item', name: 'Wolf Pelt', emoji: '🐺', stat: 'physical', modifier: 1 },
            ],
            outcome_text: 'You bring down the wolf.',
          }), reasoning_content: '' },
          finish_reason: 'stop',
        }],
        usage: {},
      }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
    const { records, recorder } = capture();
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: fetchFn, recorder });
    await gw.decide(minimalContext);
    const joined = records[0].validationWarnings.join(' ');
    expect(joined).not.toContain('done:true with only negative stamina/health mutations');
  });

  it('does NOT warn when done:false (mid-decision, no reward expected)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        choices: [{
          message: { content: JSON.stringify({
            distilled_type: 'talk', stat: 'charisma', base_dc: 10,
            required: false, done: false,
            decision: [{ label: 'Greet them warmly', dc_modifier: 0 }],
          }), reasoning_content: '' },
          finish_reason: 'stop',
        }],
        usage: {},
      }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
    const { records, recorder } = capture();
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: fetchFn, recorder });
    await gw.decide(minimalContext);
    expect(records[0].validationWarnings).toEqual([]);
  });
});
