/**
 * The M8.5 protocol-transcript smoke assertion (stage 9 — the M8.5 gate "the protocol-
 * transcript smoke assertion green" made permanent: an in-process stub session → its
 * protocol log → replay → byte-equal) + the M8.5 corpus staleness pin (the committed
 * corpus entry for M9's replay gate must replay byte-green AND deep-equal a fresh
 * in-process run, so the committed bytes cannot rot to M9 — regenerate when the tooling
 * drifts, per tests/fixtures/protocol-corpus/README.md).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stubRun } from '../../src/agent/stub.js';
import { recordDeterministicRealSession } from '../../src/agent/deterministicSession.js';
import { replayLog, replayFile } from '../../src/agent/replay.js';
import type { ProtocolEntry } from '../../src/agent/transcript.js';

const CORPUS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'protocol-corpus');
const CORPUS_FILE = path.join(CORPUS_DIR, 'stub-1d.protocol.json');
const REAL_CORPUS_FILE = path.join(CORPUS_DIR, 'real-1d.protocol.json');

// Hermetic against an ambient AGENT_PROTOCOL_BEATS=1 (the DC-S1 beats knob): a beats-bearing
// fresh log could not deep-equal the committed no-beats corpus — force the knob off.
delete process.env.AGENT_PROTOCOL_BEATS;

describe('protocol-transcript smoke assertion (M8.5 gate)', () => {
  it('an in-process stub session → protocol log → replay → byte-equal', async () => {
    const run = await stubRun(1);
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];

    const result = await replayLog(protocol);

    // Every non-header protocol entry got a replay result — cannot pass vacuously on an
    // empty stream (a dead dispatch recorder would otherwise replay exit-green with zero
    // entries).
    expect(result.entries.length).toBe(protocol.length - 1);

    expect(result.fatal).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.entries.every((e) => e.ok)).toBe(true);
  });
});

describe("M8.5 corpus — committed transcripts for M9's replay gate", () => {
  it('the committed stub transcript replays byte-green', async () => {
    const result = await replayFile(CORPUS_FILE);

    expect(result.fatal).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.entries.every((e) => e.ok)).toBe(true);
  });

  it('the committed stub transcript is current with the tooling (deep-equals a fresh in-process run)', async () => {
    const run = await stubRun(1);
    const fresh = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];
    const committed = JSON.parse(readFileSync(CORPUS_FILE, 'utf-8')) as ProtocolEntry[];

    expect(fresh).toEqual(committed);
  });

  // M10.1d — the REAL-backend arm of M9's replay gate, which the gate has always claimed
  // ("stub + deterministic real-backend transcripts byte-green") and never had. Deferred
  // since M8.5 on the SF3 same-weekday-class caveat, which DC-M10.6's clock pin discharges:
  // the entry stamps a fixed clock and both the recording and the replay run on it. No live
  // LLM and no API key — the pipeline gateway is scripted and the d20 is fixed.
  it('the committed real-backend transcript replays byte-green', async () => {
    const result = await replayFile(REAL_CORPUS_FILE);

    expect(result.fatal).toBeUndefined();
    expect(result.backend).toBe('real');
    expect(result.ok).toBe(true);
    expect(result.entries.every((e) => e.ok)).toBe(true);
    // Non-vacuity, mirroring the smoke assertion above: a dead recorder would otherwise
    // replay exit-green over an empty stream.
    const committed = JSON.parse(readFileSync(REAL_CORPUS_FILE, 'utf-8')) as ProtocolEntry[];
    expect(result.entries.length).toBe(committed.length - 1);
  });

  it('the committed real-backend transcript is current with the tooling (deep-equals a fresh in-process run)', async () => {
    const fresh = await recordDeterministicRealSession();
    const committed = JSON.parse(readFileSync(REAL_CORPUS_FILE, 'utf-8')) as ProtocolEntry[];

    expect(fresh).toEqual(committed);
  });
});
