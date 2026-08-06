import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAgentEngine } from '../../src/agent/engineHarness.js';
import { createAgentHarness, type AgentHarnessOptions } from '../../src/agent/harness.js';
import { seedCharacterViaProtocol } from '../../src/agent/seedCharacter.js';
import { ScriptedAgentPlayerGateway } from '../../src/agent/ScriptedAgentPlayerGateway.js';
import { Transcript } from '../../src/agent/transcript.js';
import { PipelineScriptedGateway } from '../../src/sim/PipelineScriptedGateway.js';
import { SessionController } from '../../src/controller/SessionController.js';
import { GameRouter } from '../../src/protocol/router.js';
import type { RouterBackend } from '../../src/protocol/router.js';
import { PROTOCOL_VERSION } from '../../src/protocol/envelope.js';
import { WizardSession } from '../../src/discord/WizardSession.js';
import type { PipelineScript } from '../../src/sim/types.js';
import type { CharCreateData, CharacterData } from '../../src/engine/WorldEngine.js';
import type { AgentMove } from '../../src/agent/AgentPlayerGateway.js';
import type { ProtocolDispatchEntry, ProtocolEntry } from '../../src/agent/transcript.js';
import { loadYamlFile } from '../../src/assets/yaml-loader.js';
import type { CharDefs } from '../../src/controller/joinWizard.js';

// ── M8.5 task 1 (DC-S1) — the protocol log. Same deterministic buildHarness shape as
// harness.test.ts (real SessionController + scripted pipeline gateway + seeded character
// through the protocol) so the run is byte-deterministic and the assertions read the
// transcript's parallel `protocol` array next to the unchanged semantic `events`. ──

const IDLE = '';

// The proven goblin-skirmish shape (same fixture as harness.test.ts): a day-job work flow
// yields a decision with two real options + bail, so a day-job action dispatches
// menu.open → dayjob.start → action.choose ×2 → outcome.
const pipelineScript: PipelineScript = {
  classify: () => ({
    kind: 'hit',
    actionType: 'combat',
    flags: { unsafe_location: false, needs_roll: true, target_present: true },
  }),
  decide: () => ({
    distilledType: 'combat',
    stat: 'physical',
    baseDc: 8,
    required: false,
    decision: [
      { label: 'Press the attack', dcModifier: 0 },
      { label: 'Feint and strike', dcModifier: 1 },
      { label: 'Step back', dcModifier: null },
    ],
  }),
  resolveMutate: () => ({ mutations: [{ type: 'modify_wealth', amount: 5 }] }),
  resolveNarrate: () => ({ outcomeText: 'Your blade finds its mark; the goblin falls.' }),
};

const SEED: CharCreateData = {
  name: 'Bram',
  class: 'Warrior',
  upbringing: 'Soldier',
  race: 'Human',
  // The wizard persists step-5 values lowercase and the controller validates the value
  // against the defs (DC-M7.3.9) — same lowercase fixture as harness.test.ts.
  alignment: 'lawful good',
  dayJob: 'Town Guard',
  itemSetName: "Soldier's Kit",
};

const USER_ID = 'agent:protocol-log';

const CC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'char-creation');
function loadDefs<T>(file: string): T[] {
  return loadYamlFile(path.join(CC_DIR, file)) as T[];
}
const REAL_DEFS: CharDefs = {
  classes: loadDefs('classes.yml'),
  backgrounds: loadDefs('backgrounds.yml'),
  races: loadDefs('races.yml'),
  alignments: loadDefs('alignments.yml'),
  dayJobs: loadDefs('day-jobs.yml'),
  itemSets: loadDefs('item-sets.yml'),
};

function buildHarness(brainMoves: AgentMove[], options?: AgentHarnessOptions) {
  const agentEngine = buildAgentEngine({
    pipelineLlmGateway: new PipelineScriptedGateway(pipelineScript),
    rollD20: () => 20,
  });
  const brain = new ScriptedAgentPlayerGateway(brainMoves);
  const controller = new SessionController(agentEngine.engine, agentEngine.getCurrentScene, agentEngine.dayJobs, undefined, new WizardSession(), REAL_DEFS, agentEngine.resolveScene);
  const router = new GameRouter(controller as RouterBackend, { idle: () => IDLE });
  return {
    harness: createAgentHarness(agentEngine.engine, router, brain, USER_ID, options),
    agentEngine,
    router,
    // M7.3: creation goes through the protocol via the raw router — the DC-S7 recording-gap
    // (the walk not landing in the protocol log) is task 4's fix, not task 1's.
    seed: async (data: CharCreateData = SEED): Promise<CharacterData> => {
      await seedCharacterViaProtocol(router, USER_ID, data);
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
    // header + one entry per dispatch (menu.open → dayjob.start → action.choose ×2).
    expect(protocol.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);

    const ds = dispatches(protocol);
    expect(ds.map((d) => d.event.type)).toEqual(['menu.open', 'dayjob.start', 'action.choose', 'action.choose']);

    // The dayjob.start entry carries the caller's event fields verbatim (jobIndex).
    const dayJob = ds[1];
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
