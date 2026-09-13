import { describe, it, expect, vi } from 'vitest';

import { ScriptedAgentPlayerGateway } from '../../src/agent/ScriptedAgentPlayerGateway.js';
import {
  ProdAgentPlayerGateway,
  buildUserMessage,
} from '../../src/agent/ProdAgentPlayerGateway.js';
import type { ChooseMoveInput, LegalMove } from '../../src/agent/AgentPlayerGateway.js';
import type { LlmCallRecord } from '../../src/llm/LlmCallRecorder.js';

// ── M4.1 — the agent-player brain seam: the scripted stub plays a fixed sequence (used by CI, no
// network), and the real OpenRouter-backed gateway parses a move-pick from a canned JSON body via an
// injected fetch, maps it to a legal AgentMove, and records one llm_calls row. The real LLM never
// runs here — every network hit is a mocked fetch. ──

const CHARACTER = {
  name: 'Bram',
  class: 'Town Guard',
  health: 12,
  maxHealth: 12,
  stamina: 10,
  maxStamina: 10,
  rollsRemaining: 3,
  wealth: 5,
  location: "The Warden's Oak",
};

// A menu turn: two on-screen day-job buttons (positional view indices 0/1) plus the always-there
// contextual moves — a free-text slot and sleep.
const MENU_MOVES: LegalMove[] = [
  { move: { kind: 'menu-pick', index: 0 }, label: 'Patrol the walls' },
  { move: { kind: 'menu-pick', index: 1 }, label: 'Guard the gate' },
  { move: { kind: 'custom', text: '' }, label: 'Type your own action' },
  { move: { kind: 'sleep' }, label: 'Go to sleep' },
];

function menuInput(): ChooseMoveInput {
  return { screenText: '⚔️ Action\n\nPick a task.\n\n[0] Patrol\n[1] Gate', moves: MENU_MOVES, character: CHARACTER };
}

// A decision turn: two choices + a bail (view button indices preserved on the AgentMove).
const DECISION_MOVES: LegalMove[] = [
  { move: { kind: 'choice', index: 0 }, label: 'Advance carefully' },
  { move: { kind: 'choice', index: 1 }, label: 'Charge in' },
  { move: { kind: 'bail' }, label: 'Retreat' },
];

function decisionInput(): ChooseMoveInput {
  return { screenText: '⚔️ Action\n\nThe wolf snarls.\n\n[0] Advance\n[1] Charge', moves: DECISION_MOVES, character: CHARACTER };
}

// ── injected-fetch helpers (mirror tests/llm/pipeline/prod-gateway.test.ts) ──

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
  return new ProdAgentPlayerGateway({
    apiKey: 'test-key',
    fetch: fetchFn,
    recorder,
    systemPrompt: 'AGENT SYSTEM',
  });
}

// ── ScriptedAgentPlayerGateway ──

describe('ScriptedAgentPlayerGateway', () => {
  it('plays back the scripted moves in order and records what it was shown', async () => {
    const gw = new ScriptedAgentPlayerGateway([
      { kind: 'menu-pick', index: 1 },
      { kind: 'choice', index: 0 },
    ]);

    // A bare-move script is wrapped into single-move turns, so every pre-recon scenario reads as
    // it always did — the brain half of the turn is simply empty.
    expect(await gw.chooseMove(menuInput())).toEqual({ move: { kind: 'menu-pick', index: 1 } });
    expect(await gw.chooseMove(decisionInput())).toEqual({ move: { kind: 'choice', index: 0 } });

    expect(gw.calls).toHaveLength(2);
    expect(gw.calls[0].moves).toBe(MENU_MOVES);
    expect(gw.calls[1].moves).toBe(DECISION_MOVES);
  });

  it('plays back a whole-turn script, notes included (spec § B)', async () => {
    const turn = {
      move: { kind: 'sleep' as const },
      intent: 'chase the Oath thread',
      arcNote: 'the temple; three consecrations left',
      dayNote: { engagement: 4 as const, fulfilment: 3 as const, line: 'A quiet day.', arcNote: 'the temple; two left' },
      droppedNotes: ['friction dropped: severity 9 is not 1-5'],
    };
    const gw = new ScriptedAgentPlayerGateway([turn]);

    expect(await gw.chooseMove(menuInput())).toEqual(turn);
  });

  it('throws loudly when the script is exhausted rather than repeating or idling', async () => {
    const gw = new ScriptedAgentPlayerGateway([{ kind: 'sleep' }]);
    await gw.chooseMove(menuInput());
    await expect(gw.chooseMove(menuInput())).rejects.toThrow(/script exhausted/);
  });
});

// ── ProdAgentPlayerGateway — request assembly ──

describe('ProdAgentPlayerGateway — request', () => {
  it('sends the versioned system prompt, JSON mode, and a user message listing the legal moves', async () => {
    const fetchFn = mockFetch(apiResponse({ thought: 't', choice: 0 }));
    await makeGateway(fetchFn).chooseMove(menuInput());

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = bodyOf(fetchFn);
    expect(body.messages[0].content).toBe('AGENT SYSTEM');
    expect(body.response_format).toEqual({ type: 'json_object' });
    // Legal moves are numbered 0..N by list position for the brain to pick by.
    expect(body.messages[1].content).toContain('0. Patrol the walls');
    expect(body.messages[1].content).toContain('3. Go to sleep');
  });

  it('defaults the system prompt to the whole v2 set — brain.md plus the handbook', async () => {
    const fetchFn = mockFetch(apiResponse({ choice: 0 }));
    await new ProdAgentPlayerGateway({ apiKey: 'test-key', fetch: fetchFn }).chooseMove(menuInput());

    const system = bodyOf(fetchFn).messages[0].content as string;
    expect(system).toContain('move-picker');
    expect(system).toContain('player handbook');
  });

  it('buildUserMessage renders SCREEN, numbered MOVES, and CHARACTER', () => {
    const msg = buildUserMessage(decisionInput());
    expect(msg).toContain('SCREEN:');
    expect(msg).toContain('The wolf snarls.');
    expect(msg).toMatch(/MOVES:\n0\. Advance carefully\n1\. Charge in\n2\. Retreat/);
    expect(msg).toContain('"class":"Town Guard"');
    expect(msg).toContain('"rollsRemaining":3');
  });
});

// ── ProdAgentPlayerGateway — working-memory sections (T2, contract §7b) ──

// T1 plumbed the brain's working memory into `ChooseMoveInput`; this is the render half. The
// preservation rule is load-bearing: with none of the new fields present the message must stay
// byte-identical to the pre-rework text, because that is the baseline arm's prompt.

describe('buildUserMessage — working memory (T2)', () => {
  const BASE = decisionInput();

  it('stays byte-identical to the pre-rework text when no memory field is present', () => {
    expect(buildUserMessage(BASE)).toBe(
      [
        'SCREEN:',
        '⚔️ Action\n\nThe wolf snarls.\n\n[0] Advance\n[1] Charge',
        '',
        'MOVES:',
        '0. Advance carefully\n1. Charge in\n2. Retreat',
        '',
        'CHARACTER:',
        '{"name":"Bram","class":"Town Guard","hp":"12/12","stamina":"10/10","rollsRemaining":3,"wealth":5,"location":"The Warden\'s Oak"}',
      ].join('\n'),
    );
  });

  it("renders every section, in the contract's order, when its field is present", () => {
    const msg = buildUserMessage({
      ...BASE,
      recap: 'YESTERDAY (day 1):\n1. You stood the gate.\nended: slept',
      dayLog: '1. day job: Stand the gate → You finish the chore.\n2. recon: /map → 🗺️ The World Map',
      intentNote: 'heading north for the archive; stamina low',
      arcNote: 'the temple; three consecrations left',
      lastRecon: { screen: 'map', text: '🗺️ The World Map\n━━━' },
    });

    const headers = ['RECAP:', 'TODAY SO FAR:', 'INTENT:', 'ARC:', 'LAST LOOK: /map', 'SCREEN:', 'MOVES:', 'CHARACTER:'];
    const offsets = headers.map((h) => msg.indexOf(h));
    expect(offsets.every((i) => i >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it("carries each block's text, and drops a section whose field is absent", () => {
    const withRecapOnly = buildUserMessage({ ...BASE, recap: 'YESTERDAY (day 1):\nended: slept' });
    expect(withRecapOnly).toContain('RECAP:\nYESTERDAY (day 1):\nended: slept');
    expect(withRecapOnly).not.toContain('TODAY SO FAR:');
    expect(withRecapOnly).not.toContain('INTENT:');
    expect(withRecapOnly).not.toContain('ARC:');
    expect(withRecapOnly).not.toContain('LAST LOOK');

    const withReconOnly = buildUserMessage({
      ...BASE,
      lastRecon: { screen: 'journal', text: '📖 Your journal.' },
    });
    expect(withReconOnly).toContain('LAST LOOK: /journal\n📖 Your journal.');
    expect(withReconOnly).not.toContain('RECAP:');
  });
});

// ── ProdAgentPlayerGateway — response parse → AgentMove ──

// Every arm below returns the move wrapped in a `BrainTurn` (T1): the gateway resolves the MOVE
// half of the reply and leaves the note fields empty.

describe('ProdAgentPlayerGateway — parse', () => {
  it('maps a menu choice to the underlying view-positional AgentMove', async () => {
    // choice 1 (list position) → MENU_MOVES[1] = menu-pick with VIEW index 1.
    const gw = makeGateway(mockFetch(apiResponse({ thought: 'patrol', choice: 1 })));
    expect(await gw.chooseMove(menuInput())).toEqual({ move: { kind: 'menu-pick', index: 1 } });
  });

  it('preserves the VIEW-positional index, not the list position (DA-6 crux)', async () => {
    // The brain picks by list position, but menu-pick/choice moves must carry the underlying
    // VIEW button index. Here list position and view index deliberately diverge, so a regression
    // that rebuilt the move from `choice` (list position) instead of returning the stored move
    // would fail: list position 0 → view index 5, list position 1 → view index 2.
    const divergent: LegalMove[] = [
      { move: { kind: 'menu-pick', index: 5 }, label: 'Fifth button' },
      { move: { kind: 'menu-pick', index: 2 }, label: 'Second button' },
    ];
    const input: ChooseMoveInput = { screenText: 'menu', moves: divergent, character: CHARACTER };
    const gw = makeGateway(mockFetch(apiResponse({ choice: 0 })));
    expect(await gw.chooseMove(input)).toEqual({ move: { kind: 'menu-pick', index: 5 } });
  });

  it('maps a bail pick to the bail move', async () => {
    const gw = makeGateway(mockFetch(apiResponse({ choice: 2 })));
    expect(await gw.chooseMove(decisionInput())).toEqual({ move: { kind: 'bail' } });
  });

  it('maps a recon screen pick to the recon move (the brain-chosen turn, spec § C)', async () => {
    const moves: LegalMove[] = [
      { move: { kind: 'menu-pick', index: 0 }, label: 'Patrol the walls' },
      { move: { kind: 'recon', screen: 'map' }, label: '/map — the world map' },
    ];
    const input: ChooseMoveInput = { screenText: 'menu', moves, character: CHARACTER };
    const gw = makeGateway(mockFetch(apiResponse({ choice: 1 })));
    expect(await gw.chooseMove(input)).toEqual({ move: { kind: 'recon', screen: 'map' } });
  });

  it('fills a custom slot with the trimmed free text', async () => {
    const gw = makeGateway(mockFetch(apiResponse({ choice: 2, text: '  search the cart  ' })));
    expect(await gw.chooseMove(menuInput())).toEqual({ move: { kind: 'custom', text: 'search the cart' } });
  });

  it('throws on an out-of-range choice', async () => {
    const gw = makeGateway(mockFetch(apiResponse({ choice: 9 })));
    await expect(gw.chooseMove(menuInput())).rejects.toThrow(/not a legal move index/);
  });

  it('throws on a non-integer choice', async () => {
    const gw = makeGateway(mockFetch(apiResponse({ thought: 'hmm' })));
    await expect(gw.chooseMove(menuInput())).rejects.toThrow(/not a legal move index/);
  });

  it('throws when a custom slot is chosen with no text', async () => {
    const gw = makeGateway(mockFetch(apiResponse({ choice: 2, text: '   ' })));
    await expect(gw.chooseMove(menuInput())).rejects.toThrow(/no text/);
  });

  it('throws on a non-2xx response', async () => {
    const gw = makeGateway(mockFetch({ error: 'boom' }, 500));
    await expect(gw.chooseMove(menuInput())).rejects.toThrow(/OpenRouter API error 500/);
  });

  it('throws on an unparseable body', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ choices: [{ message: { content: 'not json' } }] }),
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;
    await expect(makeGateway(fetchFn).chooseMove(menuInput())).rejects.toThrow(/failed to parse/);
  });
});

// ── ProdAgentPlayerGateway — audit recording ──

describe('ProdAgentPlayerGateway — recording', () => {
  it('records one row stamped agent-v2 / agent-player on success', async () => {
    const { records, recorder } = capture();
    await makeGateway(mockFetch(apiResponse({ choice: 0 })), recorder).chooseMove(menuInput());

    expect(records).toHaveLength(1);
    expect(records[0].promptVersion).toBe('agent-v2');
    expect(records[0].callKind).toBe('agent-player');
    expect(records[0].parseOk).toBe(true);
    expect(records[0].error).toBeNull();
    expect(records[0].rawPrompt).toBeNull(); // deep capture only on diagnostic rows
  });

  it('records a diagnostic row (error + deep-captured prompt) on failure', async () => {
    const { records, recorder } = capture();
    await expect(
      makeGateway(mockFetch(apiResponse({ choice: 99 })), recorder).chooseMove(menuInput()),
    ).rejects.toThrow();

    expect(records).toHaveLength(1);
    expect(records[0].parseOk).toBe(true); // JSON parsed; the choice was out of range
    expect(records[0].error).toMatch(/not a legal move index/);
    expect(records[0].rawPrompt).toContain('MOVES:'); // captured for the repro
  });
});
