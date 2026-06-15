import { describe, it, expect, vi } from 'vitest';
import { buildSystemPrompt, buildUserMessage } from '../../src/llm/prompt-builder.js';
import { DeepseekLlmGateway } from '../../src/llm/DeepseekLlmGateway.js';
import type { LlmContext, LlmDecision } from '../../src/llm/LlmGateway.js';



describe('PromptBuilder — system prompt', () => {
  it('includes the game master role and JSON-only instruction', () => {
    const result = buildSystemPrompt();

    expect(result).toContain('The Warden\'s Oak');
    expect(result).toContain('Return JSON only');
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

  it('disables thinking mode', async () => {
    const fetchFn = mockFetch(validApiResponse);
    const gateway = new DeepseekLlmGateway({
      apiKey: 'test-key',
      fetch: fetchFn,
    });

    await gateway.decide(minimalContext);

    const body = JSON.parse(fetchFn.mock.calls[0][1]!.body as string);
    expect(body.thinking).toEqual({ type: 'disabled' });
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
