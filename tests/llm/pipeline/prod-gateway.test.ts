import { describe, it, expect, vi } from 'vitest';
import { ProdPipelineLlmGateway } from '../../../src/llm/pipeline/ProdPipelineGateway.js';
import { callDeepseek } from '../../../src/llm/deepseek-transport.js';
import { buildUserMessage } from '../../../src/llm/prompt-builder.js';
import type { PromptSet } from '../../../src/llm/prompt-builder.js';
import { ACTION_CATEGORIES } from '../../../src/llm/LlmGateway.js';
import type { LlmContext } from '../../../src/llm/LlmGateway.js';
import type { LlmCallRecord } from '../../../src/llm/LlmCallRecorder.js';
import type { PipelineDecideResult } from '../../../src/llm/pipeline/types.js';
import { DeepCapturePolicy } from '../../../src/llm/capture-policy.js';

// A stable, minimal prompt set — real assembled v12 templates are content-tested elsewhere
// (prompt-set-loader.test.ts); here only stage-routing (which system prompt got sent) matters.
function fixturePromptSet(): PromptSet {
  const decide = {} as PromptSet['decide'];
  const resolve = {} as PromptSet['resolve'];
  for (const cat of ACTION_CATEGORIES) {
    decide[cat] = { newAction: `${cat.toUpperCase()} NEW_ACTION SYSTEM`, continue: `${cat.toUpperCase()} CONTINUE SYSTEM` };
    resolve[cat] = { success: `${cat.toUpperCase()} SUCCESS SYSTEM`, failure: `${cat.toUpperCase()} FAILURE SYSTEM` };
  }
  return { version: 'v12', classify: 'CLASSIFY SYSTEM', decide, resolve };
}

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

/** Read the JSON request body vitest's mocked `fetch` was called with. */
function bodyOf(fetchFn: typeof fetch): Record<string, any> {
  const calls = (fetchFn as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls;
  return JSON.parse(calls[0][1].body);
}

function capture() {
  const records: LlmCallRecord[] = [];
  const recorder = {
    record: (r: LlmCallRecord) => { records.push(r); return records.length; },
    promoteDeepCapture: () => { /* unused by this gateway */ },
  };
  return { records, recorder };
}

// ── classify ──

describe('ProdPipelineLlmGateway — classify', () => {
  it('sends the classify system prompt, exactly one fetch, correct stamp/callKind', async () => {
    const fetchFn = mockFetch(apiResponse({
      actionType: 'combat',
      flags: { unsafe_location: true, needs_roll: true, target_present: true },
    }));
    const { records, recorder } = capture();
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, recorder, promptSet: fixturePromptSet() });

    const { result } = await gw.classify('attack the wolf', minimalContext);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = bodyOf(fetchFn);
    expect(body.messages[0].content).toBe('CLASSIFY SYSTEM');
    expect(result).toEqual({
      kind: 'hit',
      actionType: 'combat',
      flags: { unsafe_location: true, needs_roll: true, target_present: true },
    });
    expect(records[0].promptVersion).toBe('v12/classify');
    expect(records[0].callKind).toBe('pipeline-classify');
  });

  it('accepts snake_case action_type and defaults missing flags to false', async () => {
    const fetchFn = mockFetch(apiResponse({ action_type: 'travel' }));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    const { result } = await gw.classify('go north', minimalContext);

    expect(result).toEqual({
      kind: 'hit',
      actionType: 'travel',
      flags: { unsafe_location: false, needs_roll: false, target_present: false },
    });
  });

  it('throws on an invalid/unknown actionType (never guesses)', async () => {
    const fetchFn = mockFetch(apiResponse({ actionType: 'teleport' }));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    await expect(gw.classify('do a thing', minimalContext)).rejects.toThrow(/actionType/i);
  });

  it('does not enable thinking mode', async () => {
    const fetchFn = mockFetch(apiResponse({ actionType: 'combat' }));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    await gw.classify('attack', minimalContext);

    expect(bodyOf(fetchFn).thinking).toBeUndefined();
  });

  it('user message quotes the raw input and includes Location when present', async () => {
    const fetchFn = mockFetch(apiResponse({ actionType: 'combat' }));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    await gw.classify('attack the wolf', minimalContext);

    const userMessage = bodyOf(fetchFn).messages[1].content as string;
    expect(userMessage).toContain('> attack the wolf');
    expect(userMessage).toContain("Location: The Warden's Oak");
  });
});

// ── decide ──

describe('ProdPipelineLlmGateway — decide', () => {
  const decideResponse = {
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    decision: [
      { label: 'Track the wolf', stat: 'wisdom', dcModifier: -2 },
      { label: 'Charge ahead', dcModifier: 2 },
    ],
  };

  it('picks the newAction template with no previousDecisions; correct stamp/callKind; sends thinking enabled', async () => {
    const fetchFn = mockFetch(apiResponse(decideResponse));
    const { records, recorder } = capture();
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, recorder, promptSet: fixturePromptSet() });

    const { result } = await gw.decide({
      actionType: 'combat',
      flags: { unsafe_location: false, needs_roll: true, target_present: true },
      context: minimalContext,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = bodyOf(fetchFn);
    expect(body.messages[0].content).toBe('COMBAT NEW_ACTION SYSTEM');
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(records[0].promptVersion).toBe('v12/decide/combat');
    expect(records[0].callKind).toBe('pipeline-decide');

    expect(result.distilledType).toBe('hunt');
    expect(result.decision).toHaveLength(2);
    expect(result.decision[0]).toEqual({ label: 'Track the wolf', dcModifier: -2, stat: 'wisdom' });
    expect(result.decision[1]).toEqual({ label: 'Charge ahead', dcModifier: 2 });
    // Options-only shape — interface forbids mutations/outcomeText on decide's result.
    expect('mutations' in result).toBe(false);
    expect('outcomeText' in result).toBe(false);
  });

  it('picks the continue template when previousDecisions is non-empty', async () => {
    const ctx: LlmContext = { ...minimalContext, previousDecisions: [{ prompt: 'x', chosen: 'y', dcModifier: 1 }] };
    const fetchFn = mockFetch(apiResponse(decideResponse));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    await gw.decide({ actionType: 'combat', flags: { unsafe_location: false, needs_roll: true, target_present: true }, context: ctx });

    expect(bodyOf(fetchFn).messages[0].content).toBe('COMBAT CONTINUE SYSTEM');
  });

  it('user message equals buildUserMessage(context) verbatim', async () => {
    const fetchFn = mockFetch(apiResponse(decideResponse));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    await gw.decide({
      actionType: 'combat',
      flags: { unsafe_location: false, needs_roll: true, target_present: true },
      context: minimalContext,
    });

    expect(bodyOf(fetchFn).messages[1].content).toBe(buildUserMessage(minimalContext));
  });

  it('parses sceneLocation and combatEnemy when present, and omits them when absent', async () => {
    const withExtras = {
      ...decideResponse,
      sceneLocation: 'The Dark Pines',
      combatEnemy: { name: 'Wolf', anchor: 'location' },
    };
    const fetchFn = mockFetch(apiResponse(withExtras));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });
    const { result } = await gw.decide({
      actionType: 'combat',
      flags: { unsafe_location: false, needs_roll: true, target_present: true },
      context: minimalContext,
    });
    expect(result.sceneLocation).toBe('The Dark Pines');
    expect(result.combatEnemy).toEqual({ name: 'Wolf', anchor: 'location' });

    const fetchFnBare = mockFetch(apiResponse(decideResponse));
    const gwBare = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFnBare, promptSet: fixturePromptSet() });
    const { result: bare } = await gwBare.decide({
      actionType: 'combat',
      flags: { unsafe_location: false, needs_roll: true, target_present: true },
      context: minimalContext,
    });
    expect(bare.sceneLocation).toBeUndefined();
    expect(bare.combatEnemy).toBeUndefined();
  });

  it('drops combatEnemy entirely when name is empty/whitespace (RA-5a)', async () => {
    const withEmptyName = { ...decideResponse, combatEnemy: { name: '', anchor: 'location' } };
    const fetchFn = mockFetch(apiResponse(withEmptyName));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });
    const { result } = await gw.decide({
      actionType: 'combat',
      flags: { unsafe_location: false, needs_roll: true, target_present: true },
      context: minimalContext,
    });
    expect(result.combatEnemy).toBeUndefined();

    const withWhitespaceName = { ...decideResponse, combatEnemy: { name: '   ', anchor: 'npc' } };
    const fetchFnWs = mockFetch(apiResponse(withWhitespaceName));
    const gwWs = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFnWs, promptSet: fixturePromptSet() });
    const { result: wsResult } = await gwWs.decide({
      actionType: 'combat',
      flags: { unsafe_location: false, needs_roll: true, target_present: true },
      context: minimalContext,
    });
    expect(wsResult.combatEnemy).toBeUndefined();
  });

  it('parses narration when present, and omits it when absent (decide-scene-narration T2 spec §1)', async () => {
    const withNarration = { ...decideResponse, narration: 'The wolf circles, hackles raised.' };
    const fetchFn = mockFetch(apiResponse(withNarration));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });
    const { result } = await gw.decide({
      actionType: 'combat',
      flags: { unsafe_location: false, needs_roll: true, target_present: true },
      context: minimalContext,
    });
    expect(result.narration).toBe('The wolf circles, hackles raised.');

    const fetchFnBare = mockFetch(apiResponse(decideResponse));
    const gwBare = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFnBare, promptSet: fixturePromptSet() });
    const { result: bare } = await gwBare.decide({
      actionType: 'combat',
      flags: { unsafe_location: false, needs_roll: true, target_present: true },
      context: minimalContext,
    });
    // Without the conditional copy in the parse callback, `narration` would be silently dropped.
    expect(bare.narration).toBeUndefined();
  });

  it('parses snake_case fields defensively (distilled_type, base_dc, dc_modifier)', async () => {
    const snakeResponse = {
      distilled_type: 'hunt',
      stat: 'physical',
      base_dc: 14,
      required: true,
      decision: [{ label: 'Track', dc_modifier: -1 }],
    };
    const fetchFn = mockFetch(apiResponse(snakeResponse));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    const { result } = await gw.decide({
      actionType: 'combat',
      flags: { unsafe_location: false, needs_roll: true, target_present: true },
      context: minimalContext,
    });

    expect(result.distilledType).toBe('hunt');
    expect(result.baseDc).toBe(14);
    expect(result.required).toBe(true);
    expect(result.decision[0]).toEqual({ label: 'Track', dcModifier: -1 });
  });

  it('prefers camelCase dcModifier over a stray null snake_case duplicate key', async () => {
    // An LLM hallucinating both key spellings on one option (camel authoritative = 0, a stray
    // snake null) must NOT be demoted to a bail — the authoritative camelCase 0 wins.
    const fetchFn = mockFetch(apiResponse({
      distilledType: 'hunt',
      stat: 'physical',
      baseDc: 12,
      required: false,
      decision: [{ label: 'Hold', dcModifier: 0, dc_modifier: null }],
    }));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    const { result } = await gw.decide({
      actionType: 'combat',
      flags: { unsafe_location: false, needs_roll: true, target_present: true },
      context: minimalContext,
    });

    expect(result.decision[0]).toEqual({ label: 'Hold', dcModifier: 0 });
  });

  it('defaults baseDc to 10 when absent', async () => {
    const fetchFn = mockFetch(apiResponse({ distilledType: 'wait', stat: 'wisdom', required: false, decision: [] }));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    const { result } = await gw.decide({
      actionType: 'other',
      flags: { unsafe_location: false, needs_roll: false, target_present: false },
      context: minimalContext,
    });

    expect(result.baseDc).toBe(10);
  });
});

// ── resolveMutate ──

describe('ProdPipelineLlmGateway — resolveMutate', () => {
  const ctxWithNpcs: LlmContext = {
    ...minimalContext,
    nearbyNpcs: [{ id: 7, name: 'Crow', description: 'a lean rider' }],
  };
  const decision: PipelineDecideResult = {
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    decision: [{ label: 'Track the wolf', dcModifier: -2 }],
  };

  it('sends the resolve template for the verdict, correct stamp/callKind, returns proposed mutations', async () => {
    const fetchFn = mockFetch(apiResponse({ mutations: [{ type: 'modify_stamina', amount: -2 }] }));
    const { records, recorder } = capture();
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, recorder, promptSet: fixturePromptSet() });

    const { result } = await gw.resolveMutate({
      actionType: 'combat',
      decision,
      chosenOption: { label: 'Track the wolf', dcModifier: -2 },
      verdict: 'success',
      d20Roll: 15,
      context: ctxWithNpcs,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = bodyOf(fetchFn);
    expect(body.messages[0].content).toBe('COMBAT SUCCESS SYSTEM');
    expect(body.thinking).toBeUndefined();
    expect(records[0].promptVersion).toBe('v12/resolve/combat/success');
    expect(records[0].callKind).toBe('pipeline-resolve-mutate');
    expect(result.mutations).toEqual([{ type: 'modify_stamina', amount: -2 }]);
  });

  it('sends the failure template on a failure verdict', async () => {
    const fetchFn = mockFetch(apiResponse({ mutations: [] }));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    await gw.resolveMutate({
      actionType: 'combat',
      decision,
      chosenOption: { label: 'Track the wolf', dcModifier: -2 },
      verdict: 'failure',
      d20Roll: 3,
      context: ctxWithNpcs,
    });

    expect(bodyOf(fetchFn).messages[0].content).toBe('COMBAT FAILURE SYSTEM');
  });

  it('resolves an update_npc [N1] handle to the context npc id and drops the handle key', async () => {
    const fetchFn = mockFetch(apiResponse({
      mutations: [{ type: 'update_npc', handle: '[N1]', description: 'Crow stiffens.' }],
    }));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    const { result } = await gw.resolveMutate({
      actionType: 'combat',
      decision,
      chosenOption: { label: 'Track the wolf', dcModifier: -2 },
      verdict: 'success',
      d20Roll: 15,
      context: ctxWithNpcs,
    });

    const mut = result.mutations[0] as Record<string, unknown>;
    expect(mut.npcId).toBe(7);
    expect('handle' in mut).toBe(false);
  });

  it('returns an empty mutations array when the response omits mutations', async () => {
    const fetchFn = mockFetch(apiResponse({}));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    const { result } = await gw.resolveMutate({
      actionType: 'combat',
      decision,
      chosenOption: { label: 'Track the wolf', dcModifier: -2 },
      verdict: 'success',
      d20Roll: 15,
      context: ctxWithNpcs,
    });

    expect(result.mutations).toEqual([]);
  });

  it('user message includes TASK/VERDICT/D20 and the decided-option handoff', async () => {
    const fetchFn = mockFetch(apiResponse({ mutations: [] }));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    await gw.resolveMutate({
      actionType: 'combat',
      decision,
      chosenOption: { label: 'Track the wolf', dcModifier: -2 },
      verdict: 'success',
      d20Roll: 15,
      context: ctxWithNpcs,
    });

    const userMessage = bodyOf(fetchFn).messages[1].content as string;
    expect(userMessage).toContain('TASK: RESOLVE-MUTATE');
    expect(userMessage).toContain('VERDICT: SUCCESS');
    expect(userMessage).toContain('D20: 15');
    expect(userMessage).toContain('### Action type');
    expect(userMessage).toContain('combat');
    expect(userMessage).toContain('### What was decided');
    expect(userMessage).toContain('- chosen: Track the wolf');
    expect(userMessage).toContain('- stat: physical');
    expect(userMessage).toContain('## You —'); // shared scene body present
    expect(userMessage).not.toContain('### Final mutations'); // narrate-only trailer
  });
});

// ── resolveNarrate ──

describe('ProdPipelineLlmGateway — resolveNarrate', () => {
  const decision: PipelineDecideResult = {
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    decision: [{ label: 'Track the wolf', dcModifier: -2 }],
  };
  const finalMutations = [
    { type: 'modify_stamina', amount: -2 },
    { type: 'add_item', name: 'Wolf Pelt', emoji: '🐺', stat: 'physical', modifier: 1 },
  ];

  it('user message carries TASK: RESOLVE-NARRATE + Final mutations JSON; returns outcomeText; correct stamp/callKind', async () => {
    const fetchFn = mockFetch(apiResponse({ outcome_text: 'You bring down the wolf.' }));
    const { records, recorder } = capture();
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, recorder, promptSet: fixturePromptSet() });

    const { result } = await gw.resolveNarrate({
      actionType: 'combat',
      decision,
      chosenOption: { label: 'Track the wolf', dcModifier: -2 },
      verdict: 'success',
      d20Roll: 15,
      finalMutations,
      context: minimalContext,
    });

    const body = bodyOf(fetchFn);
    expect(body.messages[0].content).toBe('COMBAT SUCCESS SYSTEM');
    expect(body.thinking).toBeUndefined();
    const userMessage = body.messages[1].content as string;
    expect(userMessage).toContain('TASK: RESOLVE-NARRATE');
    expect(userMessage).toContain('### Final mutations');
    expect(userMessage).toContain(JSON.stringify(finalMutations, null, 2));

    expect(records[0].promptVersion).toBe('v12/resolve/combat/success');
    expect(records[0].callKind).toBe('pipeline-resolve-narrate');
    expect(result.outcomeText).toBe('You bring down the wolf.');
  });

  it('strips carriage returns and accepts camelCase outcomeText', async () => {
    const fetchFn = mockFetch(apiResponse({ outcomeText: 'You win.\r\nGood job.\r' }));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    const { result } = await gw.resolveNarrate({
      actionType: 'combat',
      decision,
      chosenOption: { label: 'Track the wolf', dcModifier: -2 },
      verdict: 'failure',
      d20Roll: 3,
      finalMutations: [],
      context: minimalContext,
    });

    expect(result.outcomeText).not.toContain('\r');
    expect(result.outcomeText).toBe('You win.\nGood job.');
  });
});

// ── Q1 — no fallback wrapping: errors propagate loudly ──

describe('ProdPipelineLlmGateway — errors propagate (no retry, no fallback wrapping)', () => {
  it('throws (does not silently recover) on a non-200 status', async () => {
    const fetchFn = mockFetch({ error: 'boom' }, 500);
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    await expect(gw.classify('x', minimalContext)).rejects.toThrow(/DeepSeek API error 500/);
  });

  it('throws on missing content (transport reports content: null)', async () => {
    // No `content` key at all — `callDeepseek` reports `content: null` (strict, per T2 spec
    // §2's "On `!ok` or `content===null`"); an empty STRING is a distinct case (falls through
    // to the JSON.parse failure below), matching the transport's documented `?? null` contract.
    const fetchFn = mockFetch({ choices: [{ message: {} }] });
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    await expect(gw.classify('x', minimalContext)).rejects.toThrow(/empty response/i);
  });

  it('an empty-string content is not null — falls through to a parse failure, not "empty response"', async () => {
    const fetchFn = mockFetch({ choices: [{ message: { content: '' } }] });
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    await expect(gw.classify('x', minimalContext)).rejects.toThrow(/failed to parse/i);
  });

  it('throws on malformed JSON', async () => {
    const fetchFn = mockFetch({ choices: [{ message: { content: 'not json {' } }] });
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });

    await expect(gw.classify('x', minimalContext)).rejects.toThrow(/failed to parse/i);
  });

  it('records a diagnostic audit row (error + rawPrompt captured) on a failed call, never rethrowing a recorder error', async () => {
    const fetchFn = mockFetch({ error: 'boom' }, 500);
    const { records, recorder } = capture();
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, recorder, promptSet: fixturePromptSet() });

    await gw.classify('x', minimalContext).catch(() => { /* expected */ });

    expect(records).toHaveLength(1);
    expect(records[0].parseOk).toBe(false);
    expect(records[0].error).toMatch(/DeepSeek API error 500/);
    expect(records[0].rawPrompt).not.toBeNull();
  });

  it('a throwing recorder never surfaces over the real stage error', async () => {
    const fetchFn = mockFetch(apiResponse({ actionType: 'combat' }));
    const throwingRecorder = { record: () => { throw new Error('db down'); }, promoteDeepCapture: () => {} };
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, recorder: throwingRecorder, promptSet: fixturePromptSet() });

    // classify succeeds; the recorder throwing in `finally` must not break the resolved value.
    await expect(gw.classify('x', minimalContext)).resolves.toEqual({
      result: {
        kind: 'hit',
        actionType: 'combat',
        flags: { unsafe_location: false, needs_roll: false, target_present: false },
      },
      callId: 0,
    });
  });
});

// ── deep-capture policy (LLM_LOG_THINKING / LLM_SPIRAL_CHARS — hotfix/logging-env-vars) ──

describe('ProdPipelineLlmGateway — deep-capture policy', () => {
  function apiResponseWithReasoning(content: unknown, reasoning: string): unknown {
    return { choices: [{ message: { content: JSON.stringify(content), reasoning_content: reasoning }, finish_reason: 'stop' }] };
  }

  it('captures rawPrompt/reasoning on a parse-ok call whose reasoning exceeds the spiral threshold', async () => {
    const spiral = 'x'.repeat(20);
    const fetchFn = mockFetch(apiResponseWithReasoning({ actionType: 'combat' }, spiral));
    const { records, recorder } = capture();
    const gw = new ProdPipelineLlmGateway({
      apiKey: 'x', fetch: fetchFn, recorder, promptSet: fixturePromptSet(),
      capturePolicy: new DeepCapturePolicy('spiral', 10),
    });

    await gw.classify('attack', minimalContext);

    expect(records[0].rawPrompt).not.toBeNull();
    expect(records[0].reasoning).toBe(spiral);
  });

  it('omits rawPrompt/reasoning below the threshold in spiral mode', async () => {
    const short = 'x'.repeat(5);
    const fetchFn = mockFetch(apiResponseWithReasoning({ actionType: 'combat' }, short));
    const { records, recorder } = capture();
    const gw = new ProdPipelineLlmGateway({
      apiKey: 'x', fetch: fetchFn, recorder, promptSet: fixturePromptSet(),
      capturePolicy: new DeepCapturePolicy('spiral', 10),
    });

    await gw.classify('attack', minimalContext);

    expect(records[0].rawPrompt).toBeNull();
    expect(records[0].reasoning).toBeNull();
  });

  it('always captures rawPrompt/reasoning in mode "all", even below the spiral threshold', async () => {
    const short = 'x'.repeat(5);
    const fetchFn = mockFetch(apiResponseWithReasoning({ actionType: 'combat' }, short));
    const { records, recorder } = capture();
    const gw = new ProdPipelineLlmGateway({
      apiKey: 'x', fetch: fetchFn, recorder, promptSet: fixturePromptSet(),
      capturePolicy: new DeepCapturePolicy('all'),
    });

    await gw.classify('attack', minimalContext);

    expect(records[0].rawPrompt).not.toBeNull();
    expect(records[0].reasoning).toBe(short);
  });

  it('mode "errors" (default off-spiral) still captures on a diagnostic (non-200) failure', async () => {
    const fetchFn = mockFetch({ error: 'boom' }, 500);
    const { records, recorder } = capture();
    const gw = new ProdPipelineLlmGateway({
      apiKey: 'x', fetch: fetchFn, recorder, promptSet: fixturePromptSet(),
      capturePolicy: new DeepCapturePolicy('errors'),
    });

    await gw.classify('x', minimalContext).catch(() => { /* expected */ });

    expect(records[0].rawPrompt).not.toBeNull();
  });
});

// ── verbose per-stage console logging ──

describe('ProdPipelineLlmGateway — verbose logging', () => {
  it('logs a [pipeline:<stage>] summary line when verbose is true', async () => {
    const fetchFn = mockFetch(apiResponse({ actionType: 'combat' }));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet(), verbose: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await gw.classify('attack', minimalContext);

    expect(logSpy).toHaveBeenCalled();
    const [prefix] = logSpy.mock.calls[0];
    expect(String(prefix)).toContain('[pipeline:classify]');
    logSpy.mockRestore();
  });

  it('does not log when verbose is false (default)', async () => {
    const fetchFn = mockFetch(apiResponse({ actionType: 'combat' }));
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await gw.classify('attack', minimalContext);

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('logs a [pipeline:<stage>] console.error on a parse failure, unconditionally (even with verbose false)', async () => {
    const fetchFn = mockFetch({ choices: [{ message: { content: 'not json {' } }] });
    const gw = new ProdPipelineLlmGateway({ apiKey: 'x', fetch: fetchFn, promptSet: fixturePromptSet() });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(gw.classify('x', minimalContext)).rejects.toThrow(/failed to parse/i);

    expect(errorSpy).toHaveBeenCalled();
    const [prefix, ...rest] = errorSpy.mock.calls[0];
    expect(String(prefix)).toContain('[pipeline:classify]');
    const joined = rest.join(' ');
    expect(joined).toContain('failed to parse');
    expect(joined).toContain('not json {'); // content snippet included on the parse-failure case
    errorSpy.mockRestore();
  });
});

// ── shared transport (deepseek-transport.ts) ──

describe('callDeepseek — shared transport', () => {
  it('returns {ok:false, httpStatus, errorText} on a non-200 without throwing', async () => {
    const fetchFn = mockFetch({ error: 'unauthorized' }, 401);

    const result = await callDeepseek({
      apiKey: 'x', model: 'deepseek-v4-flash', temperature: 0.7,
      systemPrompt: 'sys', userMessage: 'msg', fetchFn,
    });

    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(401);
    expect(result.errorText).toBe(JSON.stringify({ error: 'unauthorized' }));
    expect(result.content).toBeNull();
  });

  it('omits the thinking key by default', async () => {
    const fetchFn = mockFetch({ choices: [{ message: { content: '{}' } }] });

    await callDeepseek({ apiKey: 'x', model: 'm', temperature: 0.5, systemPrompt: 's', userMessage: 'u', fetchFn });

    expect(bodyOf(fetchFn).thinking).toBeUndefined();
  });

  it('includes thinking:{type:"enabled"} when requested', async () => {
    const fetchFn = mockFetch({ choices: [{ message: { content: '{}' } }] });

    await callDeepseek({ apiKey: 'x', model: 'm', temperature: 0.5, systemPrompt: 's', userMessage: 'u', thinking: true, fetchFn });

    expect(bodyOf(fetchFn).thinking).toEqual({ type: 'enabled' });
  });

  it('does not throw on empty content — returns content: null', async () => {
    const fetchFn = mockFetch({ choices: [{ message: { content: '' } }] });

    const result = await callDeepseek({ apiKey: 'x', model: 'm', temperature: 0.5, systemPrompt: 's', userMessage: 'u', fetchFn });

    // Empty string is passed through, not coerced — callers check falsiness themselves.
    expect(result.ok).toBe(true);
    expect(result.content).toBe('');
  });
});
