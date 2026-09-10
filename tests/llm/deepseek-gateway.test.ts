import { describe, it, expect, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import { DeepseekLlmGateway } from '../../src/llm/DeepseekLlmGateway.js';
import { ACTION_CATEGORIES } from '../../src/llm/LlmGateway.js';
import type { LlmContext } from '../../src/llm/LlmGateway.js';
import type { LlmCallRecord, LlmCallRecorder } from '../../src/llm/LlmCallRecorder.js';
import { DeepCapturePolicy } from '../../src/llm/capture-policy.js';





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

  function mockFetch(responseBody: unknown, status = 200): MockedFunction<typeof fetch> {
    return vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(responseBody),
      text: () => Promise.resolve(JSON.stringify(responseBody)),
    }) as unknown as MockedFunction<typeof fetch>;
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
  const promoted: Array<{ callId: number; fields: { rawPrompt?: string | null; reasoning?: string | null } }> = [];
  const recorder: LlmCallRecorder = {
    record: (r: LlmCallRecord) => { records.push(r); return records.length; },
    // The gateway really calls this on the deep-capture path, so the stub applies the
    // promotion to the recorded row rather than swallowing it — otherwise the assertions
    // below would be reading a record the production code had already moved past.
    promoteDeepCapture: (callId, fields) => {
      promoted.push({ callId, fields });
      const row = records[callId - 1];
      if (!row) return;
      if (fields.rawPrompt !== undefined) row.rawPrompt = fields.rawPrompt;
      if (fields.reasoning !== undefined) row.reasoning = fields.reasoning;
    },
  };
  return { records, recorder, promoted };
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

  it('always keeps reasoning + raw prompt for an over-threshold "spiral" call, toggle off', async () => {
    const { records, recorder } = capture();
    const spiral = 'x'.repeat(50);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        choices: [{ message: { content: JSON.stringify(goodDecision), reasoning_content: spiral }, finish_reason: 'stop' }],
        usage: {},
      }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
    // mode defaults to 'spiral'; threshold lowered so the 50-char chain counts as a spiral.
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: fetchFn, recorder, capturePolicy: new DeepCapturePolicy('spiral', 10) });
    await gw.decide(minimalContext);
    expect(records[0].reasoning).toBe(spiral);
    expect(records[0].rawPrompt).toContain('## You');
  });

  it('a failed dice verdict alone does NOT trigger reasoning/prompt capture', async () => {
    const { records, recorder } = capture();
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: responseWithThinking(), recorder });
    await gw.decide({ ...minimalContext, rollOutcome: 'failure' });
    expect(records[0].reasoning).toBeNull();
    expect(records[0].rawPrompt).toBeNull(); // not captured on a clean call by default
  });

  it('saves full reasoning AND the raw prompt on every well-formed call when mode is "all"', async () => {
    const { records, recorder } = capture();
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: responseWithThinking(), recorder, capturePolicy: new DeepCapturePolicy('all') });
    await gw.decide(minimalContext);
    expect(records[0].reasoning).toBe('deep thoughts here');
    expect(records[0].rawPrompt).toContain('## You'); // the full v9 markdown prompt is now captured
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

  it('warns when a resolving turn has only negative stamina/health mutations and no reward', async () => {
    const { records, recorder } = capture();
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: rewardlessFetch(), recorder });
    await gw.decide(minimalContext);
    const joined = records[0].validationWarnings.join(' ');
    expect(joined).toContain('resolving turn with only negative stamina/health mutations');
  });

  it('does NOT warn when a resolving turn includes a reward mutation (modify_rolls_remaining)', async () => {
    const { records, recorder } = capture();
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: rewardingFetch(), recorder });
    await gw.decide(minimalContext);
    const joined = records[0].validationWarnings.join(' ');
    expect(joined).not.toContain('resolving turn with only negative stamina/health mutations');
  });

  it('does NOT warn when a resolving turn includes add_item', async () => {
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
    expect(joined).not.toContain('resolving turn with only negative stamina/health mutations');
  });

  it('does NOT warn for a mid-decision turn (real options present, no reward expected)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        choices: [{
          message: { content: JSON.stringify({
            distilled_type: 'talk', stat: 'charisma', base_dc: 10,
            required: false, done: false,
            decision: [
              { label: 'Greet them warmly', dc_modifier: 0 },
              { label: 'Hang back and watch', dc_modifier: -1 },
            ],
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

describe('DeepseekLlmGateway — empty-turn rejection (D1)', () => {
  function emptyTurnFetch(): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        choices: [{
          // No decision options, no mutations field, no outcome_text — a dead turn.
          message: { content: JSON.stringify({
            distilled_type: 'wait', stat: 'wisdom', base_dc: 10,
            required: false, decision: [],
          }), reasoning_content: '' },
          finish_reason: 'stop',
        }],
        usage: {},
      }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
  }

  it('rejects (throws) a completely empty turn so the fallback retries instead of a dead turn', async () => {
    const { records, recorder } = capture();
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: emptyTurnFetch(), recorder });
    await expect(gw.decide(minimalContext)).rejects.toThrow(/empty turn/i);
    // Recorded as a diagnostic failure (carries the error).
    expect(records[0].error).toMatch(/empty turn/i);
  });

  it('does NOT reject when an empty decision carries an outcome_text (a legitimate no-op resolve)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        choices: [{
          message: { content: JSON.stringify({
            distilled_type: 'wait', stat: 'wisdom', base_dc: 10,
            required: false, decision: [], outcome_text: 'The moment passes.',
          }), reasoning_content: '' },
          finish_reason: 'stop',
        }],
        usage: {},
      }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
    const { recorder } = capture();
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: fetchFn, recorder });
    const result = await gw.decide(minimalContext);
    expect(result.outcomeText).toBe('The moment passes.');
  });
});

describe('DeepseekLlmGateway — cartographer enrich (D3)', () => {
  function enrichFetch(body: unknown): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        choices: [{ message: { content: JSON.stringify(body) } }],
      }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
  }

  it('parses a structured cartographer result', async () => {
    const gw = new DeepseekLlmGateway({
      apiKey: 'x',
      fetch: enrichFetch({ is_safe: 0, description: 'A cold ruin.', matchesExisting: '' }),
    });
    const result = await gw.enrich({ newName: 'The Cold Ruin', existingNames: ['Town Square'], narrative: 'you enter a ruin' });
    expect(result.is_safe).toBe(0);
    expect(result.description).toBe('A cold ruin.');
    expect(result.matchesExisting).toBeUndefined(); // empty string dropped
  });

  it('parses geometry fields: region, emoji, node_tier, onwardFrontiers (clamped to 3, bad difficulty → 2)', async () => {
    const gw = new DeepseekLlmGateway({
      apiKey: 'x',
      fetch: enrichFetch({
        is_safe: 0, description: 'A reach of ash.', region: 'The Ashen Reach', emoji: '🌋', node_tier: 1,
        onwardFrontiers: [
          { teaser: 'a smoking ridge', difficulty: 3 },
          { teaser: 'a cracked road', difficulty: 9 }, // invalid → 2
          { teaser: 'a ravine' },                        // missing → 2
          { teaser: 'a fourth — dropped', difficulty: 1 },
          { teaser: '', difficulty: 1 },                 // empty → dropped
        ],
      }),
    });
    const result = await gw.enrich({ newName: 'Cinderhold', existingNames: [], narrative: 'ash', knownRegions: ['The Vale'] });
    expect(result.region).toBe('The Ashen Reach');
    expect(result.emoji).toBe('🌋');
    expect(result.node_tier).toBe(1);
    expect(result.onwardFrontiers).toEqual([
      { teaser: 'a smoking ridge', difficulty: 3 },
      { teaser: 'a cracked road', difficulty: 2 },
      { teaser: 'a ravine', difficulty: 2 },
    ]); // clamped to 3, empties dropped, bad/missing difficulty → 2
  });

  it('flags a duplicate via matchesExisting', async () => {
    const gw = new DeepseekLlmGateway({
      apiKey: 'x',
      fetch: enrichFetch({ is_safe: 1, description: 'The shrine.', matchesExisting: 'The Shrine of the First Flame' }),
    });
    const result = await gw.enrich({ newName: 'The Temple', existingNames: ['The Shrine of the First Flame'], narrative: 'a temple' });
    expect(result.matchesExisting).toBe('The Shrine of the First Flame');
    expect(result.is_safe).toBe(1);
  });

  it('parses tags from a comma-separated string (normalized, deduped, lowercased)', async () => {
    const gw = new DeepseekLlmGateway({
      apiKey: 'x',
      fetch: enrichFetch({ is_safe: 0, description: 'A drowned hall.', tags: 'Swamp, bog ,bog, WET' }),
    });
    const result = await gw.enrich({ newName: 'The Drowned Hall', existingNames: [], narrative: 'a swamp' });
    expect(result.tags).toBe('swamp,bog,wet');
  });

  it('parses tags from an array form too', async () => {
    const gw = new DeepseekLlmGateway({
      apiKey: 'x',
      fetch: enrichFetch({ is_safe: 0, description: 'Ruins.', tags: ['ruins', 'ancient', 'stone'] }),
    });
    const result = await gw.enrich({ newName: 'The Old Keep', existingNames: [], narrative: 'ruins' });
    expect(result.tags).toBe('ruins,ancient,stone');
  });

  it('omits tags when none are supplied or all are blank', async () => {
    const gw = new DeepseekLlmGateway({
      apiKey: 'x',
      fetch: enrichFetch({ is_safe: 0, description: 'Nowhere.', tags: ' , ' }),
    });
    const result = await gw.enrich({ newName: 'Nowhere', existingNames: [], narrative: '' });
    expect(result.tags).toBeUndefined();
  });

  it('returns an empty result (never throws) on a non-200 / malformed response', async () => {
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('boom'), json: () => Promise.resolve({}) }) as unknown as typeof fetch;
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: bad });
    await expect(gw.enrich({ newName: 'X', existingNames: [], narrative: '' })).resolves.toEqual({});
  });
});

describe('DeepseekLlmGateway — summarizeWeek (weekly recap)', () => {
  function recapFetch(content: unknown): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(content) } }] }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
  }

  it('parses digest + highlights from the model response', async () => {
    const fetchFn = recapFetch({
      digest: 'A grim week on the eastern road.',
      highlights: ['Bron slew the wraith', 'Aldric claimed the road'],
    });
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: fetchFn });
    const out = await gw.summarizeWeek([
      { character: 'Bron', type: 'combat', outcome: 'success', narrative: 'The wraith fell.' },
    ]);
    expect(out.digest).toBe('A grim week on the eastern road.');
    expect(out.highlights).toEqual(['Bron slew the wraith', 'Aldric claimed the road']);
  });

  it('drops non-string / blank highlight entries', async () => {
    const fetchFn = recapFetch({ digest: 'd', highlights: ['kept', '', 42, '  '] });
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: fetchFn });
    const out = await gw.summarizeWeek([]);
    expect(out.highlights).toEqual(['kept']);
  });

  it('throws on a non-200 so the caller uses its deterministic fallback', async () => {
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}), text: () => Promise.resolve('') }) as unknown as typeof fetch;
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: bad });
    await expect(gw.summarizeWeek([])).rejects.toThrow();
  });

  it('throws when the response has neither digest nor highlights', async () => {
    const fetchFn = recapFetch({ something: 'else' });
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: fetchFn });
    await expect(gw.summarizeWeek([])).rejects.toThrow();
  });
});

// ── v11 vocabulary additions ──

function decideResponse(payload: Record<string, unknown>): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }],
    }),
    text: () => Promise.resolve(''),
  }) as unknown as typeof fetch;
}

const baseDecision = {
  distilled_type: 'travel',
  stat: 'physical',
  base_dc: 10,
  required: false,
  done: false,
  decision: [],
  mutations: [{ type: 'move_to', name: 'The Dark Pines' }],
  outcome_text: 'You head north.',
};

describe('DeepseekLlmGateway — v11 category field', () => {
  it('parses a valid category value', async () => {
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: decideResponse({ ...baseDecision, category: 'travel' }) });
    const result = await gw.decide(minimalContext);
    expect(result.category).toBe('travel');
  });

  it('parses all valid category values without error', async () => {
    for (const cat of ACTION_CATEGORIES) {
      const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: decideResponse({ ...baseDecision, category: cat }) });
      const result = await gw.decide(minimalContext);
      expect(result.category).toBe(cat);
    }
  });

  it('ignores unknown category values (undefined, not thrown)', async () => {
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: decideResponse({ ...baseDecision, category: 'teleport' }) });
    const result = await gw.decide(minimalContext);
    expect(result.category).toBeUndefined();
  });

  it('omits category when absent from the response', async () => {
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: decideResponse(baseDecision) });
    const result = await gw.decide(minimalContext);
    expect(result.category).toBeUndefined();
  });
});

describe('DeepseekLlmGateway — v11 NPC handle resolution', () => {
  const ctxWithNpcs: LlmContext = {
    ...minimalContext,
    nearbyNpcs: [
      { id: 7, name: 'Crow', description: 'a lean rider' },
      { id: 12, name: 'Greta', description: 'the blacksmith' },
    ],
  };

  it('resolves [N1] handle to first NPC id in update_npc and removes the handle key', async () => {
    const payload = {
      ...baseDecision,
      mutations: [{ type: 'update_npc', handle: '[N1]', description: 'Crow stiffens.' }],
    };
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: decideResponse(payload) });
    const result = await gw.decide(ctxWithNpcs);
    const mut = result.mutations![0] as Record<string, unknown>;
    expect(mut.npcId).toBe(7);
    // handle must be truly absent — spreading `handle: undefined` leaves the key present.
    expect('handle' in mut).toBe(false);
  });

  it('resolves [N2] handle to second NPC id in remove_npc', async () => {
    const payload = {
      ...baseDecision,
      mutations: [{ type: 'remove_npc', handle: '[N2]' }],
    };
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: decideResponse(payload) });
    const result = await gw.decide(ctxWithNpcs);
    const mut = result.mutations![0] as Record<string, unknown>;
    expect(mut.npcId).toBe(12);
    expect(mut.handle).toBeUndefined();
  });

  it('falls back to npcId: 0 for an unknown handle (unknown [N3] when only 2 NPCs present)', async () => {
    const payload = {
      ...baseDecision,
      mutations: [{ type: 'update_npc', handle: '[N3]', description: 'Changed.' }],
    };
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: decideResponse(payload) });
    const result = await gw.decide(ctxWithNpcs);
    const mut = result.mutations![0] as Record<string, unknown>;
    expect(mut.npcId).toBe(0);
  });

  it('leaves add_npc mutations untouched (no handle involved)', async () => {
    const payload = {
      ...baseDecision,
      mutations: [{ type: 'add_npc', name: 'Nikolai', class: 'Ranger', description: 'A hunter.' }],
    };
    const gw = new DeepseekLlmGateway({ apiKey: 'x', fetch: decideResponse(payload) });
    const result = await gw.decide(ctxWithNpcs);
    const mut = result.mutations![0] as Record<string, unknown>;
    expect(mut.name).toBe('Nikolai');
    expect(mut.npcId).toBeUndefined();
  });
});
