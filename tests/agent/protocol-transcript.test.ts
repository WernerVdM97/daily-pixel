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
import { replayLog, replayFile } from '../../src/agent/replay.js';
import type { ProtocolEntry } from '../../src/agent/transcript.js';

const CORPUS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'protocol-corpus',
  'stub-1d.protocol.json',
);

describe('protocol-transcript smoke assertion (M8.5 gate)', () => {
  it('an in-process stub session → protocol log → replay → byte-equal', async () => {
    const run = await stubRun(1);
    const protocol = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];

    const result = await replayLog(protocol);

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
});
