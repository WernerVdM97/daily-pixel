import { describe, it, expect } from 'vitest';

import { PROTOCOL_VERSION, validateGameResponse } from '../../src/protocol/envelope.js';
import { validateGameEvent } from '../../src/protocol/events.js';

// ── M5.0 — pins the protocol types and their hand-rolled validators (DC-P1/P2/P8, see
// docs/engine/json-seam-protocol.md): every GameEvent variant and every GameResponse arm
// must validate when well-formed and be rejected when malformed. This is the tested ground
// under the M5.1 router's negative-space barrier (malformed payloads → ok:false
// 'invalid-event', never a throw) and its per-response conformance assertion. ──

const decisionView = {
  screen: 'decision',
  title: { emoji: '⚔️', text: 'The gate' },
  colorIntent: 'decision',
  storyThread: { full: 'long form', collapsed: 'short form' },
  narration: 'You hear wolves in the dark.',
  combatStatus: 'Healthy',
  prompt: 'What do you do?',
  optionLines: ['A. Fight', 'B. Flee'],
  buttons: [
    { kind: 'choice', letter: 'A', customId: 'action:choice:0', favoured: false },
    { kind: 'bail', label: 'Leave', customId: 'action:bail' },
  ],
  footer: 'Rolls left: 2',
  openingFrame: 'The oak stands watch.',
};

const outcomeView = {
  screen: 'outcome',
  title: { emoji: '💰', text: 'Reward' },
  colorIntent: 'success',
  locationLine: 'The clearing',
  breadcrumb: 'Day 3',
  sceneBlock: 'The campfire crackles.',
  isCombat: false,
  storyThread: { full: 'long form', collapsed: 'short form' },
  outcomeBlock: 'You earned 5 silver.',
};

const noticeView = { screen: 'notice', text: '🙏 Thanks. The warden listens.', ephemeral: true };

const menuView = {
  screen: 'menu',
  title: { emoji: '🛠️', text: 'Day job' },
  description: 'Pick your work.',
  buttons: [
    { label: 'Walk the rounds', customId: 'action:dayjob:0', style: 'primary' },
    { label: 'Patrol the walls', customId: 'action:dayjob:1', style: 'secondary' },
  ],
};

const loadingView = { screen: 'loading', body: '⏳ Starting…' };

const commuteView = { screen: 'commute', destination: 'The mine', idle: 'The road is quiet.' };

const allViews = [decisionView, outcomeView, noticeView, menuView, loadingView, commuteView];

const allFacts = {
  distilledType: 'patrol',
  characterName: 'Werner',
  characterClass: 'ranger',
  actionId: 3,
  nav: { rollsRemaining: 2, hasPendingAction: false, hasRestedToday: true },
  narration: 'Your previous action could not be recovered.',
};

// ── validateGameEvent — every variant validates when well-formed ──

describe('validateGameEvent — valid events', () => {
  it('accepts menu.open', () => {
    const event = { type: 'menu.open', playerId: 'user-1' };
    expect(validateGameEvent(event)).toEqual({ ok: true, event });
  });

  it('accepts dayjob.start with any non-negative jobIndex', () => {
    for (const jobIndex of [0, 1, 7]) {
      const event = { type: 'dayjob.start', playerId: 'user-1', jobIndex };
      expect(validateGameEvent(event)).toEqual({ ok: true, event });
    }
  });

  it('accepts action.custom with non-empty text', () => {
    const event = { type: 'action.custom', playerId: 'user-1', text: 'walk the rounds' };
    expect(validateGameEvent(event)).toEqual({ ok: true, event });
  });

  it('accepts action.choose with an option selector', () => {
    const event = { type: 'action.choose', playerId: 'user-1', selector: { kind: 'option', index: 2 } };
    expect(validateGameEvent(event)).toEqual({ ok: true, event });
  });

  it('accepts action.choose with the bail selector', () => {
    const event = { type: 'action.choose', playerId: 'user-1', selector: { kind: 'bail' } };
    expect(validateGameEvent(event)).toEqual({ ok: true, event });
  });

  it('accepts feedback.submit on every surface, with and without actionId', () => {
    for (const surface of ['sleep', 'release', 'outcome-feedback']) {
      const event = { type: 'feedback.submit', playerId: 'user-1', surface, text: 'loved it' };
      expect(validateGameEvent(event)).toEqual({ ok: true, event });
    }
    const withAction = {
      type: 'feedback.submit', playerId: 'user-1', surface: 'outcome-feedback', text: 'good fight', actionId: 42,
    };
    expect(validateGameEvent(withAction)).toEqual({ ok: true, event: withAction });
  });

  it('accepts bug.submit with an actionId', () => {
    const event = { type: 'bug.submit', playerId: 'user-1', text: 'crash on /action', actionId: 7 };
    expect(validateGameEvent(event)).toEqual({ ok: true, event });
  });
});

// ── validateGameEvent — malformed payloads are rejected with a message, never thrown ──

describe('validateGameEvent — invalid events', () => {
  it('rejects non-object payloads', () => {
    for (const raw of [null, undefined, 'menu.open', 42, true, []]) {
      const result = validateGameEvent(raw);
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects an unknown event type', () => {
    const result = validateGameEvent({ type: 'menu.unknown', playerId: 'user-1' });
    expect(result).toEqual({ ok: false, message: expect.any(String) });
  });

  it('rejects a missing, empty, or wrong-typed playerId', () => {
    for (const playerId of [undefined, '', 42, null]) {
      const result = validateGameEvent({ type: 'menu.open', playerId });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a missing, negative, fractional, or string jobIndex', () => {
    for (const jobIndex of [undefined, -1, 1.5, '1', NaN, Infinity]) {
      const result = validateGameEvent({ type: 'dayjob.start', playerId: 'user-1', jobIndex });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a missing or empty action.custom text', () => {
    for (const text of [undefined, '', 42]) {
      const result = validateGameEvent({ type: 'action.custom', playerId: 'user-1', text });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a malformed action.choose selector', () => {
    const cases = [
      { type: 'action.choose', playerId: 'user-1' }, // no selector
      { type: 'action.choose', playerId: 'user-1', selector: null },
      { type: 'action.choose', playerId: 'user-1', selector: { kind: 'other' } },
      { type: 'action.choose', playerId: 'user-1', selector: { kind: 'option' } }, // missing index
      { type: 'action.choose', playerId: 'user-1', selector: { kind: 'option', index: -1 } },
      { type: 'action.choose', playerId: 'user-1', selector: { kind: 'option', index: 1.5 } },
      { type: 'action.choose', playerId: 'user-1', selector: { kind: 'option', index: '1' } },
    ];
    for (const raw of cases) {
      const result = validateGameEvent(raw);
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a missing or unknown feedback.submit surface', () => {
    for (const surface of [undefined, 'outcome-bug', 'SLEEP', 3]) {
      const result = validateGameEvent({ type: 'feedback.submit', playerId: 'user-1', surface, text: 'hey' });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a missing or empty feedback/bug text', () => {
    for (const raw of [
      { type: 'feedback.submit', playerId: 'user-1', surface: 'sleep' },
      { type: 'feedback.submit', playerId: 'user-1', surface: 'sleep', text: '' },
      { type: 'bug.submit', playerId: 'user-1' },
      { type: 'bug.submit', playerId: 'user-1', text: 7 },
    ]) {
      const result = validateGameEvent(raw);
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a zero, negative, fractional, or string actionId when present', () => {
    for (const actionId of [0, -2, 1.5, '7', NaN]) {
      for (const raw of [
        { type: 'feedback.submit', playerId: 'user-1', surface: 'outcome-feedback', text: 'ok', actionId },
        { type: 'bug.submit', playerId: 'user-1', text: 'ok', actionId },
      ]) {
        const result = validateGameEvent(raw);
        expect(result).toEqual({ ok: false, message: expect.any(String) });
      }
    }
  });
});

// ── validateGameResponse — both envelope arms validate when well-formed ──

describe('validateGameResponse — valid envelopes', () => {
  it('pins PROTOCOL_VERSION to 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('accepts a minimal ok:true envelope without view or facts', () => {
    const envelope = { v: PROTOCOL_VERSION, ok: true };
    expect(validateGameResponse(envelope)).toEqual({ ok: true, response: envelope });
  });

  it('accepts every ViewState variant', () => {
    for (const view of allViews) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: true, view });
      expect(result).toEqual({ ok: true, response: { v: PROTOCOL_VERSION, ok: true, view } });
    }
  });

  it('accepts ok:true with all whitelisted facts and an exact nav', () => {
    const envelope = { v: PROTOCOL_VERSION, ok: true, view: noticeView, facts: allFacts };
    expect(validateGameResponse(envelope)).toEqual({ ok: true, response: envelope });
  });

  it('accepts a well-formed restUnsafe fact (unsafe rest, DC-M7.1.4)', () => {
    const envelope = {
      v: PROTOCOL_VERSION, ok: true,
      facts: { restUnsafe: { name: 'Werner', prev: { health: 10, stamina: 10 }, updated: { health: 9, stamina: 10 } } },
    };
    expect(validateGameResponse(envelope)).toEqual({ ok: true, response: envelope });
  });

  it('accepts ok:false with facts (the stale-session narration case)', () => {
    const envelope = {
      v: PROTOCOL_VERSION, ok: false,
      error: { code: 'stale-session', message: 'Resume where you left off?' },
      facts: { narration: 'Your previous action could not be recovered.' },
    };
    expect(validateGameResponse(envelope)).toEqual({ ok: true, response: envelope });
  });

  it('accepts every GameErrorCode', () => {
    for (const code of ['no-character', 'no-rolls', 'stale-session', 'session-expired', 'illegal-move', 'unsafe', 'empty-action', 'invalid-event', 'internal']) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: false, error: { code, message: 'boom' } });
      expect(result).toEqual({ ok: true, response: { v: PROTOCOL_VERSION, ok: false, error: { code, message: 'boom' } } });
    }
  });

  it('round-trips a kitchen-sink envelope through JSON unchanged', () => {
    const envelope = { v: PROTOCOL_VERSION, ok: true, view: decisionView, facts: allFacts };
    const result = validateGameResponse(envelope);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // every field is JSON-serialisable, so the validated envelope survives a round-trip
      expect(JSON.parse(JSON.stringify(result.response))).toEqual(envelope);
    }
  });
});

// ── validateGameResponse — malformed envelopes are rejected with a message, never thrown ──

describe('validateGameResponse — invalid envelopes', () => {
  it('rejects non-object payloads', () => {
    for (const raw of [null, undefined, 'x', 42, true, []]) {
      const result = validateGameResponse(raw);
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a missing, wrong-typed, or future v', () => {
    for (const raw of [
      { ok: true }, // missing v
      { v: '1', ok: true },
      { v: null, ok: true },
      { v: PROTOCOL_VERSION + 1, ok: true }, // future breaking change must be detectable
    ]) {
      const result = validateGameResponse(raw);
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a missing or wrong-typed ok', () => {
    for (const ok of [undefined, 'yes', 1]) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a view whose screen discriminant is not one of the six variants', () => {
    for (const view of [
      { screen: 'battle', text: 'nope', ephemeral: true },
      { text: 'no screen at all', ephemeral: true },
      'not an object',
    ]) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: true, view });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects views missing required string fields', () => {
    for (const view of [
      { screen: 'notice', ephemeral: true }, // missing text
      { screen: 'notice', text: 'x' }, // missing ephemeral
      { screen: 'loading' }, // missing body
      { screen: 'commute', idle: 'x' }, // missing destination
      { screen: 'menu', description: 'x', buttons: [] }, // missing title
      { screen: 'decision', title: { emoji: 'a', text: 'b' }, prompt: 'p', optionLines: [], buttons: [], footer: 'f' }, // missing colorIntent
    ]) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: true, view });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects wrong-typed view fields', () => {
    for (const view of [
      { screen: 'notice', text: 42, ephemeral: true },
      { screen: 'notice', text: 'x', ephemeral: 'yes' },
      { screen: 'loading', body: 42 },
      { screen: 'commute', destination: 'x', idle: 42 },
      { screen: 'outcome', title: { emoji: 'a', text: 'b' }, colorIntent: 'success', isCombat: 'no', outcomeBlock: 'x' },
      { screen: 'decision', title: { emoji: 'a', text: 'b' }, colorIntent: 'decision', prompt: 'p', optionLines: 'A, B', buttons: [], footer: 'f' },
    ]) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: true, view });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects an unknown facts key', () => {
    for (const facts of [
      { nope: 1 },
      { distilledType: 'patrol', nope: 1 },
    ]) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: true, facts });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects non-object facts', () => {
    for (const facts of [null, 'x', [], 42]) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: true, facts });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a malformed nav fact', () => {
    for (const nav of [
      'nope',
      { rollsRemaining: 2, hasPendingAction: true }, // missing hasRestedToday
      { rollsRemaining: 2, hasPendingAction: true, hasRestedToday: false, extra: 1 },
      { rollsRemaining: '2', hasPendingAction: true, hasRestedToday: false },
      { rollsRemaining: 2, hasPendingAction: 'yes', hasRestedToday: false },
      { rollsRemaining: 2, hasPendingAction: true, hasRestedToday: null },
    ]) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: true, facts: { nav } });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a non-integer or non-finite nav rollsRemaining', () => {
    // typeof number passes NaN/Infinity/fractionals, so the check must be Number.isInteger
    for (const rollsRemaining of [NaN, 1.5, Infinity, -Infinity]) {
      const result = validateGameResponse({
        v: PROTOCOL_VERSION, ok: true,
        facts: { nav: { rollsRemaining, hasPendingAction: false, hasRestedToday: true } },
      });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a restUnsafe fact that is not a plain object', () => {
    for (const restUnsafe of ['nope', 42, null, []]) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: true, facts: { restUnsafe } });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a restUnsafe fact without exactly 3 keys', () => {
    for (const restUnsafe of [
      { name: 'Werner' }, // missing prev + updated
      { name: 'Werner', prev: { health: 10, stamina: 10 } }, // missing updated
      { name: 'Werner', prev: { health: 10, stamina: 10 }, updated: { health: 10, stamina: 10 }, extra: 1 },
    ]) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: true, facts: { restUnsafe } });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a restUnsafe fact with a missing, empty, or wrong-typed name', () => {
    for (const name of [undefined, '', 42]) {
      const result = validateGameResponse({
        v: PROTOCOL_VERSION, ok: true,
        facts: { restUnsafe: { name, prev: { health: 10, stamina: 10 }, updated: { health: 10, stamina: 10 } } },
      });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a malformed restUnsafe prev', () => {
    for (const prev of [
      undefined, // missing
      'nope',
      { health: 10 }, // missing stamina
      { health: -1, stamina: 10 }, // negative health
      { health: 10, stamina: 1.5 }, // non-integer stamina
      { health: 10, stamina: 10, extra: 1 }, // extra key
    ]) {
      const result = validateGameResponse({
        v: PROTOCOL_VERSION, ok: true,
        facts: { restUnsafe: { name: 'Werner', prev, updated: { health: 10, stamina: 10 } } },
      });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a malformed restUnsafe updated', () => {
    for (const updated of [
      undefined, // missing
      'nope',
      { health: 10 }, // missing stamina
      { health: -1, stamina: 10 }, // negative health
      { health: 10, stamina: 1.5 }, // non-integer stamina
      { health: 10, stamina: 10, extra: 1 }, // extra key
    ]) {
      const result = validateGameResponse({
        v: PROTOCOL_VERSION, ok: true,
        facts: { restUnsafe: { name: 'Werner', prev: { health: 10, stamina: 10 }, updated } },
      });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a non-JSON-serialisable facts value', () => {
    for (const facts of [
      { narration: undefined },
      { narration: () => 'nope' }, // stringify only returns undefined for a TOP-LEVEL function
    ]) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: true, facts });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a nested function deep inside a facts value', () => {
    // a nested function/undefined is silently DROPPED by JSON.stringify, so only a
    // deep walk catches it — stringify alone would call this value "serialisable"
    for (const facts of [
      { narration: { nested: () => 'nope' } },
      { narration: [{ inner: { deeper: () => 'nope' } }] },
    ]) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: true, facts });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects an ok:true envelope that also carries error', () => {
    const result = validateGameResponse({
      v: PROTOCOL_VERSION, ok: true,
      error: { code: 'internal', message: 'boom' },
    });
    expect(result).toEqual({ ok: false, message: expect.any(String) });
  });

  it('rejects an ok:false envelope that also carries view', () => {
    const result = validateGameResponse({
      v: PROTOCOL_VERSION, ok: false,
      error: { code: 'internal', message: 'boom' },
      view: noticeView,
    });
    expect(result).toEqual({ ok: false, message: expect.any(String) });
  });

  it('rejects ok:false without an error object', () => {
    for (const error of [undefined, null, 'x']) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: false, error });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects an unknown error code', () => {
    for (const code of ['no-char', 'NO-CHARACTER', 42, undefined]) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: false, error: { code, message: 'x' } });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });

  it('rejects a missing, wrong-typed, or empty error.message', () => {
    for (const message of [undefined, 42, '']) {
      const result = validateGameResponse({ v: PROTOCOL_VERSION, ok: false, error: { code: 'internal', message } });
      expect(result).toEqual({ ok: false, message: expect.any(String) });
    }
  });
});
