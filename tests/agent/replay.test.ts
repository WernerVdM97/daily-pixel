/**
 * The protocol-log replay runner tests (M8.5 stage 7, DC-S2 + DC-S5) — the permanent tests
 * behind `npm run agent:replay`. The runner's in-process engines (`replayLog`/`replayFile`)
 * are driven directly; the CLI is a thin shell over `replayFile`.
 *
 * The real-class round-trip test below IS the probe result made permanent: PROBE B (stage 7
 * Task A) confirmed characterId assignment is reproducible on a fresh engine (the fresh DB's
 * first created character is again id 1; mulberry32 is keyed by characterId/dayNumber), so a
 * deterministic real-backend recording replays byte-equal on a fresh engine — the recorded
 * corpus class for M9's replay gate. The one probe finding: under a strict own-key deep-equal,
 * live envelopes carry `undefined`-valued optional view fields that the recorded JSON cannot
 * hold (JSON.stringify drops them) — so the runner compares BOTH sides in their JSON form
 * (the recorded log IS JSON; live envelopes normalize through a JSON round trip), the same
 * equivalence the contract suite's round-trip convention already blesses. That is a REAL
 * recursive structural comparison, not a JSON.stringify string compare (key order is
 * irrelevant — pinned by the key-reordering test below).
 *
 * Scope note: real-backend replay stays a same-weekday-class reproducer (SF3), and the
 * wall-clock dependence is broader than the greeting: the day-start greeting reads
 * `isWeekend()`, AND the nightly tick is wall-clock dependent too — the Saturday tick grants
 * the bonus roll and runs the Saturday NPC script (`getUTCDay() === 6`, WorldEngineImpl.ts)
 * and the 5-day absence nudge fires on the tick crossing five idle days — so a weekday-
 * recorded transcript replayed on a weekend deep-equal-mismatches (its hi.open envelope; a
 * MULTI-DAY recording also drifts in the action hints keyed off rollsRemaining after a
 * Saturday re-tick). These tests record and replay in-process on the same day, so the caveat
 * is inert here.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { replayLog, replayFile } from '../../src/agent/replay.js';
import { recordDeterministicRealSession } from '../../src/agent/deterministicSession.js';
import { PROTOCOL_VERSION } from '../../src/protocol/envelope.js';
import { stubRun } from '../../src/agent/stub.js';

// A fixed recording clock (DC-M10.6): replay pins the process clock to it, so a weekday-
// branching assertion no longer depends on the day the suite happens to run.
const RECORDED_AT = '2026-07-15T09:00:00.000Z';

import type { ProtocolDispatchEntry, ProtocolEntry } from '../../src/agent/transcript.js';
import type { AgentMove } from '../../src/agent/AgentPlayerGateway.js';

const USER_ID = 'agent:replay-test';

/** The deterministic real-backend day stream (the harness.test.ts goblin shape): day-job
 *  flow → decision ×2 → outcome, then sleep — one day, ending rested + a nightly tick. */
const REAL_DAY_MOVES: AgentMove[] = [
  { kind: 'menu-pick', index: 0 },
  { kind: 'choice', index: 0 },
  { kind: 'choice', index: 0 },
  { kind: 'sleep' },
];

/** Record a deterministic real-backend session. Delegates to the promoted recorder in
 *  `src/agent/deterministicSession.ts` (M10.1d) rather than keeping a second copy: this
 *  helper WAS that copy, and once replay's real arm started seeding the world explicitly,
 *  an unseeded local copy produced a stream replay could not match. One recorder, one
 *  environment contract. */
async function recordRealSession(
  moves: AgentMove[] = REAL_DAY_MOVES,
  recordBeats = false,
  recordedAt: string = RECORDED_AT,
): Promise<ProtocolEntry[]> {
  return recordDeterministicRealSession({ moves, recordBeats, recordedAt, userId: USER_ID });
}

/** Recursively reverse key order — a real deep comparison must be order-independent
 *  (JSON.stringify string-compare would falsely fail on this). */
function reorderKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).reverse()) {
      out[k] = reorderKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

const dispatches = (protocol: ProtocolEntry[]): ProtocolDispatchEntry[] =>
  protocol.filter((e): e is ProtocolDispatchEntry => e.kind === 'dispatch');

describe('replay — stub class round trip (DC-S2: the canned class is byte-for-byte)', () => {
  it('a fresh CannedStubBackend replays the stub run byte-equal (every envelope matched)', async () => {
    const run = await stubRun(1);
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];

    const result = await replayLog(protocol);

    expect(result.fatal).toBeUndefined();
    expect(result.backend).toBe('stub'); // header says stub, no flag → stub
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
    // 23 dispatches (creation walk + day loop) + 1 tick marker, every entry passed.
    expect(result.entries.every((e) => e.ok)).toBe(true);
    expect(result.entries.filter((e) => e.kind === 'dispatch')).toHaveLength(dispatches(protocol).length);
    expect(result.entries.filter((e) => e.kind === 'tick')).toHaveLength(1);
  });

  it('the inherit-arm stub recording (no creation walk) also replays byte-equal', async () => {
    const run = await stubRun(1, { inherit: true });
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];

    // DC-S5: an inherit stream starts at the day-start beat, not the creation walk.
    expect(dispatches(protocol)[0].event.type).toBe('hi.open');
    const result = await replayLog(protocol);

    expect(result.ok).toBe(true);
    expect(result.entries.every((e) => e.ok)).toBe(true);
  });

  it('a beats-recorded stub run replays byte-equal including the recorded beats arrays', async () => {
    // stubRun reads the DC-S1 knob from the env at construction — set + restore.
    const before = process.env.AGENT_PROTOCOL_BEATS;
    process.env.AGENT_PROTOCOL_BEATS = '1';
    let run: Awaited<ReturnType<typeof stubRun>>;
    try {
      run = await stubRun(1);
    } finally {
      if (before === undefined) delete process.env.AGENT_PROTOCOL_BEATS;
      else process.env.AGENT_PROTOCOL_BEATS = before;
    }
    const protocol = JSON.parse(JSON.stringify(run!.harness.transcript.protocol)) as ProtocolEntry[];
    expect(dispatches(protocol).some((d) => d.beats)).toBe(true);

    const result = await replayLog(protocol);

    expect(result.ok).toBe(true);
    // The dayjob.start entry recorded its loading beat and the replay re-emitted + deep-equal'd it.
    const dayJob = result.entries.find((e) => e.kind === 'dispatch' && e.eventType === 'dayjob.start');
    expect(dayJob?.ok).toBe(true);
  });

  it('the deep comparison is structural, not a JSON.stringify string compare (key order irrelevant)', async () => {
    const run = await stubRun(1);
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];

    // Reverse the key order of EVERY object in the recorded log — semantically identical JSON.
    const result = await replayLog(reorderKeys(protocol) as ProtocolEntry[]);

    expect(result.ok).toBe(true);
    expect(result.entries.every((e) => e.ok)).toBe(true);
  });
});

describe('replay — mismatch detection (non-vacuous: a tampered response is reported, not silent)', () => {
  it('flipping ok on the recorded dayjob.start response fails with seq + diff', async () => {
    const run = await stubRun(1);
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];

    const dayJob = dispatches(protocol).find((d) => d.event.type === 'dayjob.start')!;
    expect(dayJob.response.ok).toBe(true);
    // The tamper: the recorded envelope claims failure; the replay emits the real success.
    dayJob.response = { v: 1, ok: false, error: { code: 'no-rolls', message: 'tampered' } };

    const result = await replayLog(protocol);

    expect(result.ok).toBe(false);
    const entry = result.entries.find((e) => e.seq === dayJob.seq)!;
    expect(entry.ok).toBe(false);
    expect(entry.eventType).toBe('dayjob.start');
    expect(entry.diff?.some((d) => d.startsWith('response.ok'))).toBe(true);
  });

  it('reports the mismatch with the specific field that differs', async () => {
    const run = await stubRun(1);
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];

    const look = dispatches(protocol).find((d) => d.event.type === 'screen.look')!;
    // Tamper a nested field inside the recorded view text.
    (look.response as { view: { text: string } }).view.text = 'tampered look text';

    const result = await replayLog(protocol);

    expect(result.ok).toBe(false);
    const entry = result.entries.find((e) => e.seq === look.seq)!;
    expect(entry.diff?.some((d) => d.includes('response.view.text'))).toBe(true);
  });
});

describe('replay — validation failures (malformed/missing entries are failures, never silent skips)', () => {
  it('an event with an unknown type is a per-entry validation failure', async () => {
    const run = await stubRun(1);
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];

    const menu = dispatches(protocol).find((d) => d.event.type === 'menu.open')!;
    (menu.event as { type: string }).type = 'not.a.real.event';

    const result = await replayLog(protocol);

    expect(result.ok).toBe(false);
    const entry = result.entries.find((e) => e.seq === menu.seq)!;
    expect(entry.ok).toBe(false);
    expect(entry.validationError).toContain('unknown event type');
  });

  it('replayFile: a non-array protocol file is a fatal validation failure', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
    const file = path.join(dir, 'not-array.json');
    writeFileSync(file, JSON.stringify({ not: 'an array' }));
    try {
      const result = await replayFile(file);
      expect(result.ok).toBe(false);
      expect(result.fatal).toContain('JSON array');
    } finally {
      unlinkSync(file);
    }
  });

  it('replayFile: a missing header entry is a fatal validation failure', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
    const file = path.join(dir, 'no-header.json');
    writeFileSync(file, JSON.stringify([{ seq: 1, kind: 'dispatch', event: { type: 'menu.open', playerId: 'x' }, response: { v: 1, ok: true, view: { screen: 'menu', title: { emoji: '', text: '' }, description: '', buttons: [] }, facts: {} } }]));
    try {
      const result = await replayFile(file);
      expect(result.ok).toBe(false);
      expect(result.fatal).toContain('header');
    } finally {
      unlinkSync(file);
    }
  });

  it('replayFile: broken seq numbering is a fatal validation failure', async () => {
    const run = await stubRun(1);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
    const file = path.join(dir, 'broken-seq.json');
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];
    // Drop entry 2 so entry 3's recorded seq no longer matches its position.
    writeFileSync(file, JSON.stringify([protocol[0], protocol[1], ...protocol.slice(3)]));
    try {
      const result = await replayFile(file);
      expect(result.ok).toBe(false);
      expect(result.fatal).toContain('seq');
    } finally {
      unlinkSync(file);
    }
  });

  it('an action.choose WITHOUT a selector is an event-invalid failure, not a crash (SF1)', async () => {
    const run = await stubRun(1);
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];

    // Pin the fixture: the entry before the first action.choose records a decision view, so
    // pre-fix the sanity block dereferenced event.selector.kind and threw a TypeError. The fix
    // validates the event BEFORE the sanity block, so a missing selector is an event-invalid
    // per-entry validation failure.
    const ds = dispatches(protocol);
    const choose = ds.find((d) => d.event.type === 'action.choose')!;
    const before = ds[ds.indexOf(choose) - 1];
    expect(before.event.type).toBe('dayjob.start');
    expect(before.response.ok && before.response.view?.screen).toBe('decision');
    delete (choose.event as { selector?: unknown }).selector;

    const result = await replayLog(protocol);

    expect(result.ok).toBe(false);
    const entry = result.entries.find((e) => e.seq === choose.seq)!;
    expect(entry.ok).toBe(false);
    expect(entry.validationError).toContain('event invalid');
    expect(entry.validationError).toContain('selector');
  });

  it('a tick marker before the first dispatch is a fatal structural failure (SF2)', async () => {
    // Fabricated tick-led stream: [header, tick, action.custom] — a tick only ever follows a
    // day's dispatches, so a tick-led stream is structurally malformed (entries.length counts
    // ticks, so the first-dispatch invariant would otherwise be evadable by a leading tick).
    const dir = mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
    const file = path.join(dir, 'tick-led.json');
    const tickLed: ProtocolEntry[] = [
      { seq: 0, kind: 'header', v: PROTOCOL_VERSION, userId: USER_ID, brain: 'scripted', backend: 'stub', recordedAt: RECORDED_AT },
      { seq: 1, kind: 'tick', dayNumber: 2 },
      { seq: 2, kind: 'dispatch', event: { type: 'action.custom', playerId: USER_ID, text: 'hi' }, response: { v: PROTOCOL_VERSION, ok: true } },
    ];
    writeFileSync(file, JSON.stringify(tickLed));
    try {
      const result = await replayFile(file);
      expect(result.ok).toBe(false);
      expect(result.fatal).toContain('tick marker precedes the first dispatch');
    } finally {
      unlinkSync(file);
    }

    // In-process arm: replayLog cannot file-reject, but its first-dispatch invariant must
    // still catch the tick-led stream (the dispatch-only counter, not entries.length).
    const direct = await replayLog(tickLed);
    expect(direct.ok).toBe(false);
    expect(direct.entries.find((e) => e.kind === 'dispatch')?.ok).toBe(false);
  });

  it('a real-backend replay of an inherit-class transcript (no creation walk) errors out', async () => {
    // A genuine inherit-class recording: the stub inherit arm's stream has no walk.
    const run = await stubRun(1, { inherit: true });
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];
    expect(dispatches(protocol)[0].event.type).not.toBe('join.open');

    const result = await replayLog(protocol, { backend: 'real' });

    expect(result.ok).toBe(false);
    // DC-S2: re-seeding happens by replaying the recorded creation walk — absent here, so the
    // caller must pre-seed instead. Error, never a silent skip.
    expect(result.fatal).toContain('creation walk');
  });
});

describe('replay — DC-S5 sequence sanity (the choice-fidelity invariants)', () => {
  it('an out-of-range action.choose selector fails against the preceding decision view', async () => {
    const run = await stubRun(1);
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];

    const choose = dispatches(protocol).find((d) => d.event.type === 'action.choose')!;
    // The stub decision view has exactly one choice button (index 0) + a bail — 99 is out of range.
    (choose.event as { selector: { kind: 'option'; index: number } }).selector = { kind: 'option', index: 99 };

    const result = await replayLog(protocol);

    expect(result.ok).toBe(false);
    const entry = result.entries.find((e) => e.seq === choose.seq)!;
    expect(entry.ok).toBe(false);
    expect(entry.validationError).toContain('not within the preceding decision view');
  });

  it('an action.choose without a preceding decision view fails (the stale-rule carve is exact)', async () => {
    const run = await stubRun(1);
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];

    // Tamper the first action.choose to follow a notice view, not a decision: replace the
    // recorded RESPONSE of the entry before it (dayjob.start's decision view) with a notice
    // view — the DC-S5 preceding-view check reads the recorded envelope's view. The tampered
    // dayjob.start entry itself then also reports an envelope mismatch (live decision view vs
    // recorded notice) — the assertion below is about the action.choose sanity failure.
    const ds = dispatches(protocol);
    const firstChoose = ds.find((d) => d.event.type === 'action.choose')!;
    const firstChooseIdx = ds.indexOf(firstChoose);
    const before = ds[firstChooseIdx - 1];
    // The entry BEFORE the first action.choose must be dayjob.start in this stream.
    expect(before.event.type).toBe('dayjob.start');
    before.response = { v: 1, ok: true, view: { screen: 'notice', text: 'The ridge is quiet.', ephemeral: true } };

    const result = await replayLog(protocol);

    expect(result.ok).toBe(false);
    const entry = result.entries.find((e) => e.seq === firstChoose.seq)!;
    expect(entry.validationError).toContain('without a preceding decision view');
  });

  it('a wizard.* event outside the creation walk prefix fails', async () => {
    const run = await stubRun(1);
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];

    // The stream's first menu.open sits after character.create — rewrite it as a wizard.choose.
    const menu = dispatches(protocol).find((d) => d.event.type === 'menu.open')!;
    const walk = dispatches(protocol).find((d) => d.event.type === 'character.create')!;
    expect(menu.seq).toBeGreaterThan(walk.seq);
    menu.event = { type: 'wizard.choose', playerId: menu.event.playerId, step: 3, value: 'Soldier' };

    const result = await replayLog(protocol);

    expect(result.ok).toBe(false);
    const entry = result.entries.find((e) => e.seq === menu.seq)!;
    expect(entry.validationError).toContain('outside the creation walk prefix');
  });

  it('the scripted beats (hi.open/screen.stats/screen.look) need no preceding-view check', async () => {
    // The inherit stream starts with hi.open and the look beat follows outcomes — both are
    // chrome (the stale-rule carve): the replay must NOT demand a preceding menu/decision
    // view for them. A byte-green replay of the inherit recording is the proof.
    const run = await stubRun(1, { inherit: true });
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];

    const result = await replayLog(protocol);

    expect(result.ok).toBe(true);
    expect(result.entries.every((e) => e.ok)).toBe(true);
  });
});

describe('replay — deterministic real-backend round trip (PROBE B made permanent: the corpus class)', () => {
  it('a deterministic real recording replays byte-equal on a fresh engine (re-seed + tick re-execution)', async () => {
    const protocol = await recordRealSession();

    // The recording's own identity (the verify-first obligation, recorded):
    const recordedHeader = protocol[0];
    expect(recordedHeader.kind === 'header' && recordedHeader.backend).toBe('real');
    expect(dispatches(protocol)[0].event.type).toBe('join.open');

    const result = await replayLog(protocol, { backend: 'real' });

    expect(result.fatal).toBeUndefined();
    expect(result.ok).toBe(true);
    // Every entry validated AND matched — 18 dispatches (creation walk + greeting + stats +
    // day loop + look + rest) + the nightly tick, which re-executed via engine.tick(true)
    // on the fresh engine (dayNumber asserted against the recorded marker).
    expect(result.entries.every((e) => e.ok)).toBe(true);
    expect(result.entries.at(-1)).toMatchObject({ kind: 'tick', ok: true });
  });

  it('a deterministic real recording with recorded beats replays byte-equal (commute beat included)', async () => {
    const protocol = await recordRealSession(REAL_DAY_MOVES, true);

    const dayJob = dispatches(protocol).find((d) => d.event.type === 'dayjob.start')!;
    expect(dayJob.beats?.map((b) => (b.ok ? b.view?.screen : 'err'))).toEqual(['loading', 'commute']);

    const result = await replayLog(protocol, { backend: 'real' });

    expect(result.ok).toBe(true);
    const entry = result.entries.find((e) => e.seq === dayJob.seq)!;
    expect(entry.ok).toBe(true);
  });

  it('a tampered tick dayNumber is reported as a mismatch (the engine.tick(true) assert)', async () => {
    const protocol = await recordRealSession();
    const tick = protocol.find((e) => e.kind === 'tick')!;
    expect(tick.kind === 'tick' && tick.dayNumber).toBe(2);
    if (tick.kind === 'tick') tick.dayNumber = 99;

    const result = await replayLog(protocol, { backend: 'real' });

    expect(result.ok).toBe(false);
    const entry = result.entries.at(-1)!;
    expect(entry.kind).toBe('tick');
    expect(entry.diff?.[0]).toContain('tick dayNumber');
  });

  it('a --stub/--real override differing from the recorded header is honored with a warning', async () => {
    const run = await stubRun(1);
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];
    expect(protocol[0].kind === 'header' && protocol[0].backend).toBe('stub');

    // Force the real backend against a stub-class recording: honored (it builds the real
    // engine and replays — the canned stub envelopes then mismatch, which is exactly the
    // audit-net signal), with the warning recorded.
    const result = await replayLog(protocol, { backend: 'real' });

    expect(result.fatal).toBeUndefined(); // honored, not refused
    expect(result.backend).toBe('real');
    expect(result.warnings.some((w) => w.includes("'stub'") && w.includes('forces'))).toBe(true);
    // The recorded stub envelopes are canned fixtures — the real engine emits real views, so
    // the replay reports the divergence rather than silently passing.
    expect(result.ok).toBe(false);
    expect(result.entries.some((e) => !e.ok)).toBe(true);
  });

  it('a real recording forced onto the stub backend is honored with a warning (mismatches reported, not silent)', async () => {
    const protocol = await recordRealSession();
    expect(protocol[0].kind === 'header' && protocol[0].backend).toBe('real');

    const result = await replayLog(protocol, { backend: 'stub' });

    expect(result.fatal).toBeUndefined(); // honored, not refused
    expect(result.backend).toBe('stub');
    expect(result.warnings.some((w) => w.includes("'real'") && w.includes('forces'))).toBe(true);
    // The canned stub fixtures cannot equal the real engine's envelopes — the divergence is
    // reported per-entry rather than silently passing.
    expect(result.ok).toBe(false);
    expect(result.entries.some((e) => !e.ok)).toBe(true);
  });

  // DC-M10.6 — the clock pin, proven load-bearing rather than asserted. SF3 deferred
  // real-backend corpus entries since M8.5 precisely because these streams read the wall
  // clock: the day-start greeting branches on `isWeekend()` and the nightly tick grants the
  // Saturday bonus roll on `getUTCDay() === 6`. Replay now pins the process clock to
  // `header.recordedAt`, so the recording's own weekday is what the replay sees.
  it('pins the process clock to header.recordedAt, so a weekday-branching recording replays green on any day (DC-M10.6)', async () => {
    const SATURDAY = '2026-07-18T09:00:00.000Z';
    const protocol = await recordRealSession(REAL_DAY_MOVES, false, SATURDAY);
    expect(protocol[0].kind === 'header' && protocol[0].recordedAt).toBe(SATURDAY);

    const green = await replayLog(protocol);
    expect(green.fatal).toBeUndefined();
    expect(green.ok).toBe(true);

    // The tamper that makes the pin non-vacuous: the identical stream, restamped to a
    // Wednesday. If the clock were NOT pinned, both runs would read the same wall clock and
    // agree — so this going red is the whole proof that the stamp is what replay obeys.
    const restamped = JSON.parse(JSON.stringify(protocol)) as ProtocolEntry[];
    (restamped[0] as { recordedAt: string }).recordedAt = '2026-07-15T09:00:00.000Z';
    const red = await replayLog(restamped);
    expect(red.ok).toBe(false);
  });
});
