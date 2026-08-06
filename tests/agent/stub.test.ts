import { describe, it, expect } from 'vitest';

import { stubRun } from '../../src/agent/stub.js';
import { PROTOCOL_VERSION } from '../../src/protocol/envelope.js';
import type { ProtocolDispatchEntry, ProtocolEntry } from '../../src/agent/transcript.js';

// ── M8.5 stage 6 (DC-S2) — the stub-backed smoke run, driven in-process via stubRun (the
// CLI wrapper in src/agent/stub.ts is a thin shell over this same function). The run is
// deterministic and token-free; the assertions pin the CANNED FULL-LIFECYCLE SCRIPT: the
// creation walk FIRST, then the DC-S3 day-start beats (hi.open + screen.stats before the
// first menu.open), the day-job + custom flows each resolving through TWO action.choose
// beats, the look-after-outcome screen.look, and the nightly rest.begin + tick marker. ──

/** The dispatch entries of a protocol log, in order. */
function dispatches(protocol: ProtocolEntry[]): ProtocolDispatchEntry[] {
  return protocol.filter((e): e is ProtocolDispatchEntry => e.kind === 'dispatch');
}

describe('stubRun — fresh arm (DC-S2 canned full-lifecycle script)', () => {
  it('plays one full day (day-job flow + custom flow + sleep) ending slept', async () => {
    const { harness, summaries } = await stubRun(1);

    // Two completed actions: the day-job flow's outcome + the custom-action flow's outcome.
    expect(summaries).toEqual([{ dayNumber: 1, outcomes: 2, ended: 'slept' }]);
    const s = harness.transcript.summary();
    expect(s.outcomes).toBe(2);
    expect(s.findings).toEqual({ error: 0, warning: 0 });
    // The scripted day-start greeting beat fired the semantic greeting event.
    expect(s.greetings).toBe(1);
  });

  it('records the creation walk FIRST, then the DC-S3 beats in order, then the night', async () => {
    const { harness } = await stubRun(1);
    const protocol = harness.transcript.protocol;
    const ds = dispatches(protocol);

    // The whole dispatch stream, pinned: creation walk (join.open → wizard.answer →
    // wizard.choose ×6 → character.create), then the day-start beats, then the day-job
    // flow, the custom flow, the sleep menu.open, and the nightly rest.begin. The tick
    // marker is the protocol's last entry.
    expect(ds.map((d) => d.event.type)).toEqual([
      'join.open',
      'wizard.answer',
      'wizard.choose',
      'wizard.choose',
      'wizard.choose',
      'wizard.choose',
      'wizard.choose',
      'wizard.choose',
      'character.create',
      'hi.open',
      'screen.stats',
      'menu.open',
      'dayjob.start',
      'action.choose',
      'action.choose',
      'screen.look',
      'menu.open',
      'action.custom',
      'action.choose',
      'action.choose',
      'screen.look',
      'menu.open',
      'rest.begin',
    ]);

    // The header is honest: scripted brain + stub backend class + the stable session id.
    expect(protocol[0]).toEqual({
      seq: 0,
      kind: 'header',
      v: PROTOCOL_VERSION,
      userId: 'agent:stub',
      brain: 'scripted',
      backend: 'stub',
    });

    // The wizard walk is the step-ordered creation walk (steps 2-7, the lowercase step-5
    // value the defs validate against), every walk envelope ok.
    const walk = ds.slice(0, 9);
    const chooseSteps = walk
      .filter((d): d is ProtocolDispatchEntry & { event: { type: 'wizard.choose'; step: number } } => d.event.type === 'wizard.choose')
      .map((d) => d.event.step);
    expect(chooseSteps).toEqual([2, 3, 4, 5, 6, 7]);
    for (const d of walk) expect(d.response.ok).toBe(true);

    // DC-S3 order: hi.open + screen.stats sit immediately BEFORE the first menu.open; the
    // look-after-outcome screen.look follows each outcome-producing action.choose.
    const firstMenu = ds.findIndex((d) => d.event.type === 'menu.open');
    expect(firstMenu).toBeGreaterThan(-1);
    expect(ds.slice(firstMenu - 2, firstMenu).map((d) => d.event.type)).toEqual(['hi.open', 'screen.stats']);
    for (const idx of [14, 19]) {
      expect(ds[idx].event.type).toBe('action.choose');
      expect(ds[idx + 1].event.type).toBe('screen.look');
    }

    // The beats SUCCEED (F1 net gap): the screen.stats / screen.look / rest.begin envelopes
    // are all ok:true — the canned script must feed them real views, not the base stub's
    // silent no-character defaults (a future deletion of those config lines fails here).
    const stats = ds.find((d) => d.event.type === 'screen.stats');
    expect(stats?.response.ok).toBe(true);
    for (const look of ds.filter((d) => d.event.type === 'screen.look')) {
      expect(look.response.ok).toBe(true);
    }
    const rest = ds.find((d) => d.event.type === 'rest.begin');
    expect(rest?.response.ok).toBe(true);

    // The nightly rest.begin dispatch precedes the tick marker, which reports day 2.
    const restIdx = protocol.findIndex((e) => e.kind === 'dispatch' && e.event.type === 'rest.begin');
    const tickIdx = protocol.findIndex((e) => e.kind === 'tick');
    expect(restIdx).toBeGreaterThan(-1);
    expect(tickIdx).toBeGreaterThan(restIdx);
    expect(protocol[tickIdx].kind === 'tick' && protocol[tickIdx].dayNumber).toBe(2);

    // The semantic transcript recorded the greeting + the day boundary from the same tick.
    expect(harness.transcript.events.some((e) => e.type === 'greeting')).toBe(true);
    const dayEvent = harness.transcript.events.find((e) => e.type === 'day');
    expect(dayEvent?.type === 'day' && dayEvent.dayNumber).toBe(2);
  });
});

describe('stubRun — inherit arm (DC-S7 no-walk)', () => {
  it('plays the same day with no creation walk — the first dispatch is the day-start beat', async () => {
    const { harness, summaries } = await stubRun(1, { inherit: true });

    expect(summaries).toEqual([{ dayNumber: 1, outcomes: 2, ended: 'slept' }]);

    const ds = dispatches(harness.transcript.protocol);
    const types = ds.map((d) => d.event.type);
    expect(types).toEqual([
      'hi.open',
      'screen.stats',
      'menu.open',
      'dayjob.start',
      'action.choose',
      'action.choose',
      'screen.look',
      'menu.open',
      'action.custom',
      'action.choose',
      'action.choose',
      'screen.look',
      'menu.open',
      'rest.begin',
    ]);

    // The walk is absent ENTIRELY — not one creation dispatch anywhere in the stream.
    const forbidden: Array<ProtocolDispatchEntry['event']['type']> = ['join.open', 'wizard.answer', 'wizard.choose', 'character.create'];
    for (const t of forbidden) {
      expect(types.includes(t)).toBe(false);
    }
  });
});

describe('stubRun — determinism (stage 9 dogfood depends on byte-reproducibility)', () => {
  it('fresh runs on fresh instances produce deep-equal protocol logs', async () => {
    const run1 = await stubRun(1);
    const run2 = await stubRun(1);

    // Byte-deterministic: no timestamps, no RNG, no wall-clock — the same events, envelopes
    // and seq numbers every run. Stage 9's replay dogfood replays this log byte-equal.
    expect(run1.harness.transcript.protocol).toEqual(run2.harness.transcript.protocol);
    expect(run1.summaries).toEqual(run2.summaries);
  });
});
