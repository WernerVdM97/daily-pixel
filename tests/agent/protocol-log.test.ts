import { describe, it, expect } from 'vitest';

import { buildAgentEngine } from '../../src/agent/engineHarness.js';
import { createAgentHarness, type AgentHarnessOptions } from '../../src/agent/harness.js';
import { ScriptedAgentPlayerGateway } from '../../src/agent/ScriptedAgentPlayerGateway.js';
import { Transcript } from '../../src/agent/transcript.js';
import { deterministicPipelineScript as pipelineScript, SEED, buildDeterministicRouter } from '../../src/agent/deterministicSession.js';
import { PipelineScriptedGateway } from '../../src/sim/PipelineScriptedGateway.js';
import { PROTOCOL_VERSION } from '../../src/protocol/envelope.js';
import type { CharCreateData, CharacterData } from '../../src/engine/WorldEngine.js';
import type { AgentMove } from '../../src/agent/AgentPlayerGateway.js';
import type { ProtocolDispatchEntry, ProtocolEntry } from '../../src/agent/transcript.js';

// M8.5 stage 7 (DC-S2): the deterministic session wiring (pipeline script, SEED profile, the
// SessionController→router construction) moved to src/agent/deterministicSession.ts — the
// replay runner needs the src-side source; this suite imports it (the pipelineScript alias
// keeps the test bodies unchanged). The REPLAY tests replay this suite's stream shape.

// ── M8.5 task 1 (DC-S1) — the protocol log. Same deterministic buildHarness shape as
// harness.test.ts (real SessionController + scripted pipeline gateway + seeded character
// through the protocol) so the run is byte-deterministic and the assertions read the
// transcript's parallel `protocol` array next to the unchanged semantic `events`. ──

const USER_ID = 'agent:protocol-log';

function buildHarness(brainMoves: AgentMove[], options?: AgentHarnessOptions) {
  const agentEngine = buildAgentEngine({
    pipelineLlmGateway: new PipelineScriptedGateway(pipelineScript),
    rollD20: () => 20,
  });
  const brain = new ScriptedAgentPlayerGateway(brainMoves);
  // M8.5 stage 7 (DC-S2): the SessionController wiring lives in deterministicSession.ts.
  const router = buildDeterministicRouter(agentEngine);
  const harness = createAgentHarness(agentEngine.engine, router, brain, USER_ID, options);
  return {
    harness,
    agentEngine,
    router,
    // M8.5 (DC-S7): creation goes through the harness's recorded dispatch — the walk lands
    // in the protocol log (the recording-gap fix; stage 7's replay re-seeding depends on it).
    seed: async (data: CharCreateData = SEED): Promise<CharacterData> => {
      await harness.createCharacter(data);
      return agentEngine.engine.getCharacter(USER_ID)!;
    },
  };
}

/** The dispatch entries of a protocol log, in order. */
function dispatches(protocol: ProtocolEntry[]): ProtocolDispatchEntry[] {
  return protocol.filter((e): e is ProtocolDispatchEntry => e.kind === 'dispatch');
}

describe('AgentHarness — protocol log header (DC-S1)', () => {
  it('writes the header entry first with scripted/real defaults', async () => {
    const { harness } = buildHarness([{ kind: 'sleep' }]);

    expect(harness.transcript.protocol[0]).toEqual({
      seq: 0,
      kind: 'header',
      v: PROTOCOL_VERSION,
      userId: USER_ID,
      brain: 'scripted',
      backend: 'real',
    });
  });

  it('options override the header brain/backend classes', async () => {
    const { harness } = buildHarness([{ kind: 'sleep' }], { brain: 'prod', backend: 'stub' });

    expect(harness.transcript.protocol[0]).toEqual({
      seq: 0,
      kind: 'header',
      v: PROTOCOL_VERSION,
      userId: USER_ID,
      brain: 'prod',
      backend: 'stub',
    });
  });
});

describe('AgentHarness — protocol log dispatch entries (DC-S1)', () => {
  it('records exactly one dispatch entry per dispatch, in order, with seq increasing from 1', async () => {
    const { harness, seed } = buildHarness([
      { kind: 'menu-pick', index: 0 },
      { kind: 'choice', index: 0 },
      { kind: 'choice', index: 0 },
    ]);
    await seed();

    const result = await harness.playOneAction();
    expect(result).toEqual({ kind: 'outcome' });

    const protocol = harness.transcript.protocol;
    // header + the creation walk (join.open → wizard.answer → wizard.choose ×6 →
    // character.create) + one entry per play dispatch (menu.open → dayjob.start →
    // action.choose ×2) + the DC-S3 look-after-outcome beat (screen.look after the outcome).
    expect(protocol.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

    const ds = dispatches(protocol);
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
      'menu.open',
      'dayjob.start',
      'action.choose',
      'action.choose',
      'screen.look',
    ]);

    // The dayjob.start entry carries the caller's event fields verbatim (jobIndex).
    const dayJob = ds[10];
    expect(dayJob.event.type === 'dayjob.start' && dayJob.event.jobIndex).toBe(0);
    expect(dayJob.response.ok).toBe(true);

    // Every envelope is the router's authoritative response, all ok on this path.
    for (const d of ds) {
      expect(d.response.ok).toBe(true);
      expect(d.response.v).toBe(PROTOCOL_VERSION);
    }
  });

  it('records no beats field on any dispatch entry by default', async () => {
    const { harness, seed } = buildHarness([
      { kind: 'menu-pick', index: 0 },
      { kind: 'choice', index: 0 },
      { kind: 'choice', index: 0 },
    ]);
    await seed();
    await harness.playOneAction();

    for (const d of dispatches(harness.transcript.protocol)) {
      expect('beats' in d).toBe(false);
    }
  });

  it('records the router interstitial beats on the dayjob.start entry when recordBeats is on', async () => {
    const { harness, seed } = buildHarness(
      [
        { kind: 'menu-pick', index: 0 },
        { kind: 'choice', index: 0 },
        { kind: 'choice', index: 0 },
      ],
      { recordBeats: true },
    );
    await seed();
    await harness.playOneAction();

    const ds = dispatches(harness.transcript.protocol);
    const dayJob = ds.find((d) => d.event.type === 'dayjob.start');
    expect(dayJob).toBeDefined();
    // The router emits a loading beat then a commute beat on this flow (the char commutes to
    // work) — pin the exact sequence so a future beat reorder/rename flags as drift.
    expect(dayJob!.beats!.map((b) => (b.ok ? b.view?.screen : `err:${b.error.code}`))).toEqual([
      'loading',
      'commute',
    ]);
  });
});

describe('AgentHarness — protocol log creation walk (DC-S7)', () => {
  it('records the full creation walk in order before the first play dispatch', async () => {
    const { harness, seed } = buildHarness([
      { kind: 'menu-pick', index: 0 },
      { kind: 'choice', index: 0 },
      { kind: 'choice', index: 0 },
    ]);
    await seed();

    // The load-bearing DC-S7 assertion: the creation walk lands in the protocol log IN ORDER
    // — join.open → wizard.answer → wizard.choose ×6 (steps 2-7) → character.create. Stage 7's
    // replay re-seeding replays exactly these dispatches on a fresh engine, so a missing or
    // reordered walk entry here is a hard failure, not a churn.
    const walk = dispatches(harness.transcript.protocol);
    expect(walk.map((d) => d.event.type)).toEqual([
      'join.open',
      'wizard.answer',
      'wizard.choose',
      'wizard.choose',
      'wizard.choose',
      'wizard.choose',
      'wizard.choose',
      'wizard.choose',
      'character.create',
    ]);

    // The wizard steps are in order 2-7 and the step-5 alignment value passes through as given
    // (the lowercase fixture — the controller validates against the defs). Every walk envelope
    // is ok (the walk throws on any rejection, so an ok:false here would have surfaced already).
    const chooseSteps = walk
      .filter((d): d is ProtocolDispatchEntry & { event: { type: 'wizard.choose'; step: number; value: string } } => d.event.type === 'wizard.choose')
      .map((d) => d.event.step);
    expect(chooseSteps).toEqual([2, 3, 4, 5, 6, 7]);
    const step5 = walk.find((d) => d.event.type === 'wizard.choose' && d.event.step === 5);
    expect(step5?.event.type === 'wizard.choose' && step5.event.value).toBe('lawful good');
    for (const d of walk) expect(d.response.ok).toBe(true);

    // The first PLAY dispatch follows the walk — the play stream starts after character.create.
    // The look-after-outcome beat (screen.look) appends AFTER the play dispatches — nothing
    // inserts before them (the walk is before, the look after).
    await harness.playOneAction();
    const after = dispatches(harness.transcript.protocol);
    expect(after.map((d) => d.event.type)).toEqual([
      'join.open',
      'wizard.answer',
      'wizard.choose',
      'wizard.choose',
      'wizard.choose',
      'wizard.choose',
      'wizard.choose',
      'wizard.choose',
      'character.create',
      'menu.open',
      'dayjob.start',
      'action.choose',
      'action.choose',
      'screen.look',
    ]);
  });
});

describe('AgentHarness — protocol log nightly tick marker (DC-S1)', () => {
  it('records a tick entry after the rest.begin dispatch once the day ends', async () => {
    const { harness, seed } = buildHarness([
      { kind: 'menu-pick', index: 0 },
      { kind: 'choice', index: 0 },
      { kind: 'choice', index: 0 },
      { kind: 'sleep' },
    ]);
    await seed();

    const summaries = await harness.playDays(1);
    expect(summaries).toEqual([{ dayNumber: 1, outcomes: 1, ended: 'slept' }]);

    const protocol = harness.transcript.protocol;
    const restIdx = protocol.findIndex((e) => e.kind === 'dispatch' && e.event.type === 'rest.begin');
    const tickIdx = protocol.findIndex((e) => e.kind === 'tick');
    expect(restIdx).toBeGreaterThan(-1);
    expect(tickIdx).toBeGreaterThan(restIdx);
    expect(protocol[tickIdx].kind === 'tick' && protocol[tickIdx].dayNumber).toBe(2);

    // The semantic log is unchanged by the protocol log: it carries the day boundary (from
    // the same tick) but never protocol-only entry kinds.
    const kinds: Set<string> = new Set(harness.transcript.events.map((e) => e.type));
    for (const kind of ['header', 'dispatch', 'tick']) {
      expect(kinds.has(kind)).toBe(false);
    }
    const dayEvent = harness.transcript.events.find((e) => e.type === 'day');
    expect(dayEvent?.type === 'day' && dayEvent.dayNumber).toBe(2);
  });
});

describe('AgentHarness — protocol log day-start + look beats (DC-S3)', () => {
  it('records the day-start greeting + stats beats before play and the look beat after the outcome', async () => {
    const { harness, seed } = buildHarness([
      { kind: 'menu-pick', index: 0 },
      { kind: 'choice', index: 0 },
      { kind: 'choice', index: 0 },
      { kind: 'sleep' },
    ]);
    await seed();

    const summaries = await harness.playDays(1);
    expect(summaries).toEqual([{ dayNumber: 1, outcomes: 1, ended: 'slept' }]);

    // The semantic greeting event — the hi screen text (loose: non-empty + carries the
    // character's name), and the summary counts it.
    const greeting = harness.transcript.events.find((e) => e.type === 'greeting');
    expect(greeting?.type === 'greeting' && greeting.text.length).toBeGreaterThan(0);
    expect(greeting?.type === 'greeting' && greeting.text).toContain('Bram');
    expect(harness.transcript.summary().greetings).toBe(1);

    // The protocol log: the day-start hi.open + screen.stats dispatches sit BEFORE the first
    // menu.open (hi first, stats beside it — the DC-S3 scripted order).
    const ds = dispatches(harness.transcript.protocol);
    const firstMenu = ds.findIndex((d) => d.event.type === 'menu.open');
    expect(firstMenu).toBeGreaterThan(-1);
    expect(ds.slice(firstMenu - 2, firstMenu).map((d) => d.event.type)).toEqual(['hi.open', 'screen.stats']);
    // No greeting when no-character (not reachable on this path) — the greeting is only
    // recorded from an ok hi.open, never from a finding.

    // The look-after-outcome beat: screen.look is the dispatch immediately AFTER the
    // outcome-producing action.choose.
    const lastChoose = ds.findLastIndex((d) => d.event.type === 'action.choose');
    expect(lastChoose).toBeGreaterThan(-1);
    expect(ds[lastChoose + 1].event.type).toBe('screen.look');
  });
});

describe('Transcript — greeting plumbing (DC-S3, type-level only)', () => {
  it('records a greeting event and counts it in the summary', () => {
    const t = new Transcript();
    t.greeting('The morning light breaks over the Oak.');

    expect(t.events).toEqual([{ type: 'greeting', text: 'The morning light breaks over the Oak.' }]);
    const s = t.summary();
    expect(s.greetings).toBe(1);
    expect(s).toEqual({
      turns: 0,
      outcomes: 0,
      deadEnds: 0,
      commutes: 0,
      dayBoundaries: 0,
      greetings: 1,
      findings: { error: 0, warning: 0 },
    });
  });
});
