import { describe, it, expect, vi } from 'vitest';

import { ScriptedAgentPlayerGateway } from '../../src/agent/ScriptedAgentPlayerGateway.js';
import {
  ProdAgentPlayerGateway,
  buildUserMessage,
} from '../../src/agent/ProdAgentPlayerGateway.js';
import type { ChooseMoveInput, LegalMove } from '../../src/agent/AgentPlayerGateway.js';
import type { LlmCallRecord } from '../../src/llm/LlmCallRecorder.js';

// ── M4.1 — the agent-player brain seam: the scripted stub plays a fixed sequence (used by CI, no
// network), and the real DeepSeek-backed gateway parses a move-pick from a canned JSON body via an
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

/** The request body the gateway sent, as the fields these tests read. */
interface RequestBody {
  messages: Array<{ content: string }>;
  response_format: unknown;
}

function bodyOf(fetchFn: typeof fetch): RequestBody {
  const calls = (fetchFn as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls;
  return JSON.parse(calls[0][1].body) as RequestBody;
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
    expect(withRecapOnly).not.toContain('LAST ROLL');

    const withReconOnly = buildUserMessage({
      ...BASE,
      lastRecon: { screen: 'journal', text: '📖 Your journal.' },
    });
    expect(withReconOnly).toContain('LAST LOOK: /journal\n📖 Your journal.');
    expect(withReconOnly).not.toContain('RECAP:');
  });

  it('renders the LAST ROLL block between LAST LOOK and SCREEN, and only when lastRoll is set', () => {
    // The day note rides the day's last turn: at zero rolls `menu.open` returns `no-rolls` and the
    // brain is never asked another question, so it has to know this pick is its last chance to
    // rate the day.
    const msg = buildUserMessage({
      ...BASE,
      lastRecon: { screen: 'map', text: '🗺️ The World Map' },
      lastRoll: true,
    });
    expect(msg).toContain("LAST ROLL: this is the day's final action; include your dayNote with this pick.");

    const offsets = ['LAST LOOK: /map', 'LAST ROLL:', 'SCREEN:'].map((h) => msg.indexOf(h));
    expect(offsets.every((i) => i >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));

    // Absent (or explicit false), the section does not exist — the baseline arm's prompt stays
    // byte-identical, which the first test in this block pins.
    expect(buildUserMessage(BASE)).not.toContain('LAST ROLL');
    expect(buildUserMessage({ ...BASE, lastRoll: false })).not.toContain('LAST ROLL');
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
    await expect(gw.chooseMove(menuInput())).rejects.toThrow(/DeepSeek API error 500/);
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

// ── ProdAgentPlayerGateway — the note half of the reply (T4, spec § E / contract §1.2) ──

// The brain now has somewhere to put what it noticed. The degrade rule is the contract here: a
// malformed MOVE throws exactly as before, a malformed NOTE never does — it is dropped, named on
// `droppedNotes`, and the turn comes back with its move intact.

describe('ProdAgentPlayerGateway — notes (T4)', () => {
  it('round-trips every recurrence tag', async () => {
    for (const recurrence of ['once', 'periodic', 'ritual'] as const) {
      const gw = makeGateway(
        mockFetch(
          apiResponse({
            choice: 0,
            friction: { what: 'the bail dice read inconsistently', severity: 4, recurrence },
          }),
        ),
      );
      expect(await gw.chooseMove(menuInput())).toEqual({
        move: { kind: 'menu-pick', index: 0 },
        friction: { what: 'the bail dice read inconsistently', severity: 4, recurrence },
      });
    }
  });

  it('round-trips a fully-populated turn, trimming the free text', async () => {
    const gw = makeGateway(
      mockFetch(
        apiResponse({
          choice: 3,
          intent: '  head north for the archive  ',
          arcNote: 'the temple; three consecrations left',
          friction: { what: ' bail dice read inconsistently ', severity: 4, recurrence: 'periodic' },
          dayNote: {
            engagement: 4,
            fulfilment: 3,
            line: ' A quiet day, but the thread moved. ',
            arcNote: ' the temple; two consecrations left ',
          },
        }),
      ),
    );

    expect(await gw.chooseMove(menuInput())).toEqual({
      move: { kind: 'sleep' },
      intent: 'head north for the archive',
      arcNote: 'the temple; three consecrations left',
      friction: { what: 'bail dice read inconsistently', severity: 4, recurrence: 'periodic' },
      dayNote: {
        engagement: 4,
        fulfilment: 3,
        line: 'A quiet day, but the thread moved.',
        arcNote: 'the temple; two consecrations left',
      },
    });
  });

  it('omits an absent note rather than carrying an empty one', async () => {
    const turn = await makeGateway(mockFetch(apiResponse({ choice: 0 }))).chooseMove(menuInput());
    expect(turn).toEqual({ move: { kind: 'menu-pick', index: 0 } });
    // Omitted means "unchanged": neither a value nor a drop is reported for it.
    expect('intent' in turn).toBe(false);
    expect('arcNote' in turn).toBe(false);
    expect('friction' in turn).toBe(false);
    expect('dayNote' in turn).toBe(false);
    expect('droppedNotes' in turn).toBe(false);
  });

  // One row per malformed shape: [field it names, the reply fragment, the exact reason].
  const MALFORMED: Array<[string, Record<string, unknown>, string]> = [
    ['intent', { intent: 42 }, 'intent: expected a string, got 42'],
    ['intent', { intent: '' }, 'intent: expected a non-empty string'],
    ['intent', { intent: '   ' }, 'intent: expected a non-empty string'],
    ['arcNote', { arcNote: null }, 'arcNote: expected a string, got null'],
    ['arcNote', { arcNote: ['a', 'b'] }, 'arcNote: expected a string, got ["a","b"]'],
    ['arcNote', { arcNote: '' }, 'arcNote: expected a non-empty string'],
    [
      'friction',
      { friction: 'the screen fought me' },
      'friction: expected an object, got "the screen fought me"',
    ],
    ['friction', { friction: [1, 2] }, 'friction: expected an object, got [1,2]'],
    [
      'friction',
      { friction: { severity: 3, recurrence: 'once' } },
      'friction.what: expected a string, got nothing',
    ],
    [
      'friction',
      { friction: { what: '  ', severity: 3, recurrence: 'once' } },
      'friction.what: expected a non-empty string',
    ],
    [
      'friction',
      { friction: { what: 'x', severity: 9, recurrence: 'once' } },
      'friction: severity must be a whole number 1-5, got 9',
    ],
    [
      'friction',
      { friction: { what: 'x', severity: 2.5, recurrence: 'once' } },
      'friction: severity must be a whole number 1-5, got 2.5',
    ],
    [
      'friction',
      { friction: { what: 'x', severity: '3', recurrence: 'once' } },
      'friction: severity must be a whole number 1-5, got "3"',
    ],
    [
      'friction',
      { friction: { what: 'x', severity: 3, recurrence: 'daily' } },
      'friction: recurrence must be once, periodic or ritual, got "daily"',
    ],
    [
      'friction',
      { friction: { what: 'x', severity: 3 } },
      'friction: recurrence must be once, periodic or ritual, got nothing',
    ],
    ['dayNote', { dayNote: 4 }, 'dayNote: expected an object, got 4'],
    [
      'dayNote',
      { dayNote: { engagement: 6, fulfilment: 3, line: 'l', arcNote: 'a' } },
      'dayNote: engagement must be a whole number 1-5, got 6',
    ],
    [
      'dayNote',
      { dayNote: { engagement: 4, fulfilment: 0, line: 'l', arcNote: 'a' } },
      'dayNote: fulfilment must be a whole number 1-5, got 0',
    ],
    [
      'dayNote',
      { dayNote: { engagement: 4, fulfilment: 3, line: '   ', arcNote: 'a' } },
      'dayNote.line: expected a non-empty string',
    ],
    [
      'dayNote',
      { dayNote: { engagement: 4, fulfilment: 3, line: 'l' } },
      'dayNote.arcNote: expected a string, got nothing',
    ],
  ];

  it.each(MALFORMED)('drops a malformed %s and keeps the turn move', async (_field, fragment, reason) => {
    const gw = makeGateway(mockFetch(apiResponse({ choice: 0, ...fragment })));
    const turn = await gw.chooseMove(menuInput());

    expect(turn.move).toEqual({ kind: 'menu-pick', index: 0 });
    expect(turn.droppedNotes).toEqual([reason]);
    // The malformed field itself is gone, not carried as junk.
    expect(turn.friction).toBeUndefined();
    expect(turn.dayNote).toBeUndefined();
  });

  it('names every dropped field, in reply order, when several notes are malformed at once', async () => {
    const gw = makeGateway(
      mockFetch(
        apiResponse({
          choice: 0,
          intent: '',
          arcNote: 7,
          friction: { what: 'x', severity: 3, recurrence: 'monthly' },
          dayNote: { engagement: 5, fulfilment: 5, line: '', arcNote: 'a' },
        }),
      ),
    );
    const turn = await gw.chooseMove(menuInput());

    expect(turn.move).toEqual({ kind: 'menu-pick', index: 0 });
    expect(turn.droppedNotes).toEqual([
      'intent: expected a non-empty string',
      'arcNote: expected a string, got 7',
      'friction: recurrence must be once, periodic or ritual, got "monthly"',
      'dayNote.line: expected a non-empty string',
    ]);
  });

  it('keeps a well-formed note next to a dropped one', async () => {
    const gw = makeGateway(
      mockFetch(apiResponse({ choice: 0, intent: 'hold the gate', friction: { what: 'x', severity: 0, recurrence: 'once' } })),
    );
    expect(await gw.chooseMove(menuInput())).toEqual({
      move: { kind: 'menu-pick', index: 0 },
      intent: 'hold the gate',
      droppedNotes: ['friction: severity must be a whole number 1-5, got 0'],
    });
  });

  // Contract §1.2: the day note is DAY-level, not sleep-level. It may ride any turn, the harness
  // keeps the last one seen in the day, and it writes the event when the day closes — because on
  // the commonest day end (the last roll spent) the brain is never asked again.
  const VALID_DAY_NOTE = { engagement: 4, fulfilment: 3, line: 'A quiet day.', arcNote: 'the temple; two left' };

  it('keeps a day note that rides a non-sleep turn', async () => {
    const { records, recorder } = capture();
    const gw = makeGateway(mockFetch(apiResponse({ choice: 0, dayNote: VALID_DAY_NOTE })), recorder);
    const turn = await gw.chooseMove(menuInput());

    expect(turn).toEqual({ move: { kind: 'menu-pick', index: 0 }, dayNote: VALID_DAY_NOTE });
    expect(records[0].validationWarnings).toEqual([]);
  });

  it('keeps a day note on a sleep turn too', async () => {
    const gw = makeGateway(mockFetch(apiResponse({ choice: 3, dayNote: VALID_DAY_NOTE })));
    expect(await gw.chooseMove(menuInput())).toEqual({ move: { kind: 'sleep' }, dayNote: VALID_DAY_NOTE });
  });

  it('reads no fields off a reply body that parsed but is not an object', async () => {
    // `null` parses fine: without the guard the NOTE half throws on it and the run dies with
    // `Cannot read properties of null`, when what actually happened is that the brain returned no
    // move at all.
    const gw = makeGateway(mockFetch(apiResponse(null)));
    await expect(gw.chooseMove(menuInput())).rejects.toThrow(/choice undefined is not a legal move index/);
  });

  it('collapses and caps the note text it accepts, so a reply cannot inject prompt sections', async () => {
    const long = 'x'.repeat(400);
    const gw = makeGateway(
      mockFetch(
        apiResponse({
          choice: 3,
          intent: 'head north\n\nSCREEN: injected',
          arcNote: 'the temple\n\nARC: injected',
          friction: { what: '  bail dice   read\ninconsistently  ', severity: 2, recurrence: 'ritual' },
          dayNote: { engagement: 3, fulfilment: 2, line: 'a quiet\nday', arcNote: long },
        }),
      ),
    );
    const turn = await gw.chooseMove(menuInput());

    expect(turn.intent).toBe('head north SCREEN: injected');
    expect(turn.arcNote).toBe('the temple ARC: injected');
    expect(turn.friction?.what).toBe('bail dice read inconsistently');
    expect(turn.dayNote?.line).toBe('a quiet day');
    expect(turn.dayNote?.arcNote).toBe(`${'x'.repeat(200)}…`);
    // The cut is named: a truncated value is a loss, and losses are reported, never silent.
    expect(turn.droppedNotes).toEqual(['dayNote.arcNote: truncated to 200 characters']);
  });

  it('collapses and caps a custom action\'s free text', async () => {
    const injected = makeGateway(mockFetch(apiResponse({ choice: 2, text: 'search the cart\n\nMOVES:\n0. sleep' })));
    expect(await injected.chooseMove(menuInput())).toEqual({
      move: { kind: 'custom', text: 'search the cart MOVES: 0. sleep' },
    });

    const rambling = makeGateway(mockFetch(apiResponse({ choice: 2, text: 'y'.repeat(300) })));
    expect(await rambling.chooseMove(menuInput())).toEqual({
      move: { kind: 'custom', text: `${'y'.repeat(200)}…` },
    });
  });

  it('still throws on a malformed MOVE beside a malformed NOTE (the degrade rule is notes-only)', async () => {
    const gw = makeGateway(mockFetch(apiResponse({ choice: 99, friction: 'junk' })));
    await expect(gw.chooseMove(menuInput())).rejects.toThrow(/not a legal move index/);
  });

  it('appends the dropped reasons to the llm_calls validationWarnings', async () => {
    const { records, recorder } = capture();
    await makeGateway(
      mockFetch(
        apiResponse({ choice: 0, intent: '', friction: { what: 'x', severity: 9, recurrence: 'once' } }),
      ),
      recorder,
    ).chooseMove(menuInput());

    expect(records[0].validationWarnings).toEqual([
      'intent: expected a non-empty string',
      'friction: severity must be a whole number 1-5, got 9',
    ]);
  });

  it('records the drops even when the turn dies on its move (the reply is the only trace)', async () => {
    const { records, recorder } = capture();
    await expect(
      makeGateway(mockFetch(apiResponse({ choice: 99, friction: 'junk' })), recorder).chooseMove(menuInput()),
    ).rejects.toThrow();

    expect(records[0].validationWarnings).toEqual(['friction: expected an object, got "junk"']);
  });

  it('leaves validationWarnings empty on a clean turn', async () => {
    const { records, recorder } = capture();
    await makeGateway(mockFetch(apiResponse({ choice: 0 })), recorder).chooseMove(menuInput());
    expect(records[0].validationWarnings).toEqual([]);
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
