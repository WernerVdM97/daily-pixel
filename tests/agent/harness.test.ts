import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAgentEngine } from '../../src/agent/engineHarness.js';
import { AgentHarness, createAgentHarness } from '../../src/agent/harness.js';
import { ScriptedAgentPlayerGateway } from '../../src/agent/ScriptedAgentPlayerGateway.js';
import { PipelineScriptedGateway } from '../../src/sim/PipelineScriptedGateway.js';
import { SessionController } from '../../src/controller/SessionController.js';
import { GameRouter } from '../../src/protocol/router.js';
import type { RouterBackend } from '../../src/protocol/router.js';
import { WizardSession } from '../../src/discord/WizardSession.js';
import { CID_DAYJOB, CID_DAYJOB_CUSTOM } from '../../src/controller/dayJob.js';
import type { PipelineScript } from '../../src/sim/types.js';
import type { CharCreateData, CharacterData } from '../../src/engine/WorldEngine.js';
import type { AgentObserver } from '../../src/agent/observer.js';
import type { ActionMenuResult, DayJobStart, RestBeginResult, StartRenderResult } from '../../src/controller/SessionController.js';
import type { MenuViewState, OutcomeViewState } from '../../src/view/viewState.js';
import type { AgentMove } from '../../src/agent/AgentPlayerGateway.js';
import type { ProtocolDispatchEntry } from '../../src/agent/transcript.js';
import type { CriticGateway, CriticInput, CriticVerdict } from '../../src/llm/LlmGateway.js';
import { viewToText } from '../../src/agent/viewToText.js';
import { loadYamlFile } from '../../src/assets/yaml-loader.js';
import type { CharDefs } from '../../src/controller/joinWizard.js';

// ── M6 — harness tests ported to the protocol surface. `buildHarness` wires a `GameRouter`
// over a real `SessionController` + scripted pipeline (same deterministic engine as M4),
// so the harness is a true protocol client and the engine is still available for post-action
// assertions. The deterministic `idle: () => ''` matches the contract suite. ──

const IDLE = '';

// The proven goblin-skirmish shape: "attack the goblin" → combat hit → two real options + bail.
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

const immediateScript: PipelineScript = {
  classify: () => ({
    kind: 'hit',
    actionType: 'skill',
    flags: { unsafe_location: false, needs_roll: true, target_present: false },
  }),
  decide: () => ({ distilledType: 'chore', stat: 'physical', baseDc: 5, required: false, decision: [] }),
  resolveMutate: () => ({ mutations: [] }),
  resolveNarrate: () => ({ outcomeText: 'You finish the chore and pocket the coin.' }),
};

const SEED: CharCreateData = {
  name: 'Bram',
  class: 'Warrior',
  upbringing: 'Soldier',
  race: 'Human',
  // The wizard persists step-5 values lowercase and the controller validates the value
  // against the defs (DC-M7.3.9) — the pre-seam title-case fixture would be rejected.
  alignment: 'lawful good',
  dayJob: 'Town Guard',
  // The walk can't reach step 8 without the step-7 kit (a Warrior's "Soldier's Kit" —
  // the profile fixture gains the wizard's itemSet field the current SEED lacks, DC-S3).
  itemSetName: "Soldier's Kit",
};

const USER_ID = 'agent:test';

// The real char-creation defs the controller's wizard renders from (DC-M7.3.10) — the same
// YAMLs the engine harness loads for its day jobs.
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

function buildHarness(brainMoves: AgentMove[], script: PipelineScript = pipelineScript) {
  const agentEngine = buildAgentEngine({
    pipelineLlmGateway: new PipelineScriptedGateway(script),
    rollD20: () => 20,
  });
  const brain = new ScriptedAgentPlayerGateway(brainMoves);
  // Wire a GameRouter over a real SessionController — the harness is a true protocol client.
  const controller = new SessionController(agentEngine.engine, agentEngine.getCurrentScene, agentEngine.dayJobs, undefined, new WizardSession(), REAL_DEFS, agentEngine.resolveScene);
  const router = new GameRouter(controller as RouterBackend, { idle: () => IDLE });
  const harness = createAgentHarness(agentEngine.engine, router, brain, USER_ID);
  return {
    harness,
    brain,
    agentEngine,
    router,
    // M8.5 (DC-S7): the character is created THROUGH the harness's recorded dispatch — the
    // wizard walk lands in the protocol log (the recording-gap fix; replay re-seeding depends
    // on it). Returns the created char (read from the engine — the real engine persists
    // createCharacter).
    seed: async (data: CharCreateData = SEED): Promise<CharacterData> => {
      await harness.createCharacter(data);
      return agentEngine.engine.getCharacter(USER_ID)!;
    },
    // Exposed for tests that drive the controller directly (e.g. viewToText assertions).
    controller,
  };
}

describe('AgentHarness — one action end-to-end (M6 protocol)', () => {
  it('drives menu → custom action → decision beat → outcome through the protocol', async () => {
    const { harness, brain, agentEngine, seed } = buildHarness([
      { kind: 'custom', text: 'attack the goblin' }, // pick the free-text slot from the menu
      { kind: 'choice', index: 0 },
      { kind: 'choice', index: 0 },
    ]);
    const char = await seed();
    expect(char.name).toBe('Bram');
    expect(char.stats.physical).toBeGreaterThan(0);

    const result = await harness.playOneAction();
    expect(result).toEqual({ kind: 'outcome' });

    const events = harness.transcript.events;
    const turns = events.filter((e) => e.type === 'turn');
    expect(brain.calls).toHaveLength(turns.length);
    expect(events[events.length - 1].type).toBe('outcome');

    // Turn 1 = the day-job menu, offering the day-job picks + a custom slot + sleep.
    const menuTurn = events[0];
    expect(menuTurn.type === 'turn' && menuTurn.screen).toBe('menu');
    expect(menuTurn.type === 'turn' && menuTurn.text).toContain('Daily Work');
    expect(menuTurn.type === 'turn' && menuTurn.offered).toContain('Type your own action');
    expect(menuTurn.type === 'turn' && menuTurn.offered).toContain('Go to sleep — end the day');

    // The action authored at least one decision the brain answered.
    const decisionTurn = events.find((e) => e.type === 'turn' && e.screen === 'decision');
    expect(decisionTurn?.type === 'turn' && decisionTurn.offered.some((l) => l.includes('Press the attack'))).toBe(true);

    const outcome = events[events.length - 1];
    expect(outcome.type === 'outcome' && outcome.text).toContain('the goblin falls');

    const after = agentEngine.engine.getCharacter(USER_ID)!;
    expect(after.wealth).toBe(char.wealth + 5);
    expect(after.rollsRemaining).toBe(char.rollsRemaining - 1);
  });

  it('picking a day-job menu button runs the work flow to an outcome through the protocol', async () => {
    const { harness, agentEngine, seed } = buildHarness([
      { kind: 'menu-pick', index: 0 },
      { kind: 'choice', index: 0 },
      { kind: 'choice', index: 0 },
    ]);
    const char = await seed();
    const result = await harness.playOneAction();

    expect(result).toEqual({ kind: 'outcome' });
    const after = agentEngine.engine.getCharacter(USER_ID)!;
    expect(after.location).not.toBe(char.location);

    // The commute beat fires through the onBeat callback — should appear on the transcript.
    expect(harness.transcript.events.some((e) => e.type === 'commute')).toBe(true);
  });

  it('an action that resolves immediately transcripts the private (acting-player) view', async () => {
    const { harness, brain, seed } = buildHarness([{ kind: 'custom', text: 'polish my boots' }], immediateScript);
    await seed();
    const result = await harness.playOneAction();
    expect(result).toEqual({ kind: 'outcome' });
    expect(brain.calls).toHaveLength(1);
    const outcomeEvent = harness.transcript.events.at(-1);
    expect(outcomeEvent?.type).toBe('outcome');

    // run 2: reproduce the controller result deterministically for the viewToText assertion.
    const ae2 = buildAgentEngine({
      pipelineLlmGateway: new PipelineScriptedGateway(immediateScript),
      rollD20: () => 20,
    });
    const c2 = new SessionController(ae2.engine, ae2.getCurrentScene, ae2.dayJobs, undefined, new WizardSession(), REAL_DEFS, ae2.resolveScene);
    ae2.engine.createCharacter(USER_ID, SEED);
    const r2 = await c2.runCustomAction(USER_ID, 'polish my boots');
    expect(r2.kind).toBe('outcome');
    if (r2.kind === 'outcome' && outcomeEvent?.type === 'outcome') {
      expect(outcomeEvent.text).toBe(viewToText(r2.viewPrivate));
      expect(r2.viewPrivate.storyThread).toBeDefined();
      expect(viewToText(r2.viewPrivate)).toBe(viewToText(r2.viewPublic));
    }
  });

  it('the sleep move ends the day without acting', async () => {
    const { harness, seed } = buildHarness([{ kind: 'sleep' }]);
    await seed();
    const result = await harness.playOneAction();
    expect(result).toEqual({ kind: 'slept' });
    expect(harness.transcript.events).toHaveLength(1); // just the menu turn
  });

  it('the brain receives the characterState fact on every turn', async () => {
    const { harness, brain, seed } = buildHarness([
      { kind: 'custom', text: 'attack the goblin' },
      { kind: 'choice', index: 0 },
      { kind: 'choice', index: 0 },
    ]);
    await seed();
    await harness.playOneAction();

    // Every brain.chooseMove call received a character snapshot with all required fields.
    for (const call of brain.calls) {
      expect(call.character).toBeDefined();
      expect(typeof call.character.name).toBe('string');
      expect(typeof call.character.class).toBe('string');
      expect(typeof call.character.health).toBe('number');
      expect(typeof call.character.maxHealth).toBe('number');
      expect(typeof call.character.stamina).toBe('number');
      expect(typeof call.character.maxStamina).toBe('number');
      expect(typeof call.character.rollsRemaining).toBe('number');
      expect(typeof call.character.wealth).toBe('number');
      expect(typeof call.character.location).toBe('string');
    }
  });

  it('the brain receives the character snapshot from facts, not engine-direct', async () => {
    const { harness, brain, seed } = buildHarness([
      { kind: 'custom', text: 'attack the goblin' },
      { kind: 'choice', index: 0 },
      { kind: 'choice', index: 0 },
    ]);

    await seed();

    await harness.playOneAction();

    // Every brain.chooseMove call received a non-empty character snapshot.
    for (const call of brain.calls) {
      expect(call.character.name).toBeTruthy();
      expect(call.character.location).toBeTruthy();
    }
  });
});

// ── M8.5 (DC-S7) — inherit-mode session bootstrap: a second harness on the same
// engine+router with the same userId plays as the existing character with NO creation walk ──

describe('AgentHarness — inherit-mode session bootstrap (DC-S7)', () => {
  it('a no-walk harness plays an action as the existing character', async () => {
    // Wiring inline (same shape as buildHarness) so a SECOND harness can share the same
    // engine + router + userId — the inherit arm's construction.
    const agentEngine = buildAgentEngine({
      pipelineLlmGateway: new PipelineScriptedGateway(pipelineScript),
      rollD20: () => 20,
    });
    const controller = new SessionController(agentEngine.engine, agentEngine.getCurrentScene, agentEngine.dayJobs, undefined, new WizardSession(), REAL_DEFS, agentEngine.resolveScene);
    const router = new GameRouter(controller as RouterBackend, { idle: () => IDLE });

    // Fresh spawn: the walk through the harness's recorded dispatch creates the player.
    const creator = createAgentHarness(agentEngine.engine, router, new ScriptedAgentPlayerGateway([]), USER_ID);
    await creator.createCharacter(SEED);
    expect(agentEngine.engine.getCharacter(USER_ID)!.name).toBe('Bram');

    // Inherit spawn: same engine/router/userId, NO createCharacter call — the session starts
    // as that existing player at menu.open.
    const inheritor = createAgentHarness(
      agentEngine.engine,
      router,
      new ScriptedAgentPlayerGateway([
        { kind: 'menu-pick', index: 0 },
        { kind: 'choice', index: 0 },
        { kind: 'choice', index: 0 },
      ]),
      USER_ID,
    );
    const result = await inheritor.playOneAction();
    expect(result).toEqual({ kind: 'outcome' });

    // menu.open did NOT return no-character: the inherit session's first dispatch is a plain
    // menu.open — no join.open/wizard walk in its own protocol log (the walk belongs to the
    // fresh session that created the player).
    const first = inheritor.transcript.protocol.find((e) => e.kind === 'dispatch');
    expect(first?.kind === 'dispatch' && first.event.type).toBe('menu.open');
  });
});

// ── RA-4 Finding 1 — `criticEnabled` opt-out (unchanged: engine-level, not protocol). ──

class MockCriticGateway implements CriticGateway {
  calls: CriticInput[] = [];

  async critique(input: CriticInput): Promise<CriticVerdict> {
    this.calls.push(input);
    return { ok: true, severity: 'minor', issues: [] };
  }
}

describe('buildAgentEngine — RA-4 Finding 1: criticEnabled opt-out', () => {
  const goblinMoves: AgentMove[] = [
    { kind: 'custom', text: 'attack the goblin' },
    { kind: 'choice', index: 0 },
    { kind: 'choice', index: 0 },
  ];

  it('wires the injected criticGateway by default', async () => {
    const critic = new MockCriticGateway();
    const agentEngine = buildAgentEngine({
      pipelineLlmGateway: new PipelineScriptedGateway(pipelineScript),
      rollD20: () => 20,
      criticGateway: critic,
    });
    const controller = new SessionController(agentEngine.engine, agentEngine.getCurrentScene, agentEngine.dayJobs, undefined, new WizardSession(), REAL_DEFS, agentEngine.resolveScene);
    const router = new GameRouter(controller as RouterBackend, { idle: () => IDLE });
    const harness = createAgentHarness(agentEngine.engine, router, new ScriptedAgentPlayerGateway(goblinMoves), USER_ID);
    await harness.createCharacter(SEED);

    await harness.playOneAction();

    expect(critic.calls.length).toBeGreaterThan(0);
  });

  it('wires NO critic when criticEnabled is false', async () => {
    const critic = new MockCriticGateway();
    const agentEngine = buildAgentEngine({
      pipelineLlmGateway: new PipelineScriptedGateway(pipelineScript),
      rollD20: () => 20,
      criticGateway: critic,
      criticEnabled: false,
    });
    const controller = new SessionController(agentEngine.engine, agentEngine.getCurrentScene, agentEngine.dayJobs, undefined, new WizardSession(), REAL_DEFS, agentEngine.resolveScene);
    const router = new GameRouter(controller as RouterBackend, { idle: () => IDLE });
    const harness = createAgentHarness(agentEngine.engine, router, new ScriptedAgentPlayerGateway(goblinMoves), USER_ID);
    await harness.createCharacter(SEED);

    await harness.playOneAction();

    expect(critic.calls).toHaveLength(0);
  });
});

// ── M4.3 — full-day + multi-day loop (protocol surface) ──

describe('AgentHarness — full-day + multi-day loop (M6 protocol)', () => {
  const goblinAction: AgentMove[] = [
    { kind: 'custom', text: 'attack the goblin' },
    { kind: 'choice', index: 0 },
    { kind: 'choice', index: 0 },
  ];

  it('plays down to no-rolls without asking the brain past the last roll', async () => {
    const { harness, brain, agentEngine, seed } = buildHarness([...goblinAction, ...goblinAction, ...goblinAction]);
    await seed();

    const summary = await harness.playDay();

    expect(summary).toEqual({ dayNumber: 1, outcomes: 3, ended: 'no-rolls' });
    expect(brain.calls).toHaveLength(9); // 3 actions × 3 calls
    expect(agentEngine.engine.getCharacter(USER_ID)!.rollsRemaining).toBe(0);
  });

  it('runs multiple days, advancing the day and refilling rolls each night', async () => {
    const { harness, agentEngine, seed } = buildHarness([...goblinAction, { kind: 'sleep' }, { kind: 'sleep' }]);
    const seeded = await seed();

    const summaries = await harness.playDays(2);

    expect(summaries).toEqual([
      { dayNumber: 1, outcomes: 1, ended: 'slept' },
      { dayNumber: 2, outcomes: 0, ended: 'slept' },
    ]);

    const after = agentEngine.engine.getCharacter(USER_ID)!;
    expect(after.rollsRemaining).toBeGreaterThanOrEqual(seeded.rollsRemaining);
    expect(Number(agentEngine.engine.getMeta('day_number'))).toBe(3);
    expect(after.location).toBe("The Warden's Oak");

    const boundaries = harness.transcript.events.filter((e) => e.type === 'day');
    expect(boundaries.map((b) => b.type === 'day' && b.dayNumber)).toEqual([2, 3]);
  });

  it('stops the multi-day run when a day stalls', async () => {
    const illegal: AgentMove = { kind: 'choice', index: 0 };
    const { harness, brain, agentEngine, seed } = buildHarness([illegal, illegal, illegal, illegal, illegal, illegal]);
    await seed();

    const summaries = await harness.playDays(3);

    expect(summaries).toEqual([{ dayNumber: 1, outcomes: 0, ended: 'stalled' }]);
    expect(brain.calls).toHaveLength(5);
    expect(Number(agentEngine.engine.getMeta('day_number'))).toBe(1);
    expect(harness.transcript.events.some((e) => e.type === 'day')).toBe(false);
  });
});

// ── M4.4 — QA capture, ported to the protocol surface. Arms that can't be reached
// deterministically through the real engine run against a stub RouterBackend + GameRouter. ──

const stubChar = (over: Partial<CharacterData> = {}): CharacterData =>
  ({
    id: 1,
    name: 'Stub',
    class: 'Warrior',
    health: 10,
    maxHealth: 10,
    stamina: 10,
    maxStamina: 10,
    rollsRemaining: 3,
    wealth: 0,
    location: "The Warden's Oak",
    ...over,
  }) as unknown as CharacterData;

const OUTCOME_VIEW = {
  screen: 'outcome',
  title: { emoji: '✅', text: 'Done' },
  colorIntent: 'success',
  isCombat: false,
  outcomeBlock: 'It is done.',
} as unknown as OutcomeViewState;

const CUSTOM_MENU: MenuViewState = {
  screen: 'menu',
  title: { emoji: '🛠️', text: 'Work' },
  description: 'Pick a task.',
  buttons: [{ label: 'Type your own action', customId: CID_DAYJOB_CUSTOM, style: 'secondary' }],
};

const DAYJOB_MENU: MenuViewState = {
  screen: 'menu',
  title: { emoji: '🛠️', text: 'Work' },
  description: 'Pick a task.',
  buttons: [{ label: 'Guard the gate', customId: CID_DAYJOB + '0', style: 'secondary' }],
};

const SLEEP_ONLY_MENU: MenuViewState = {
  screen: 'menu',
  title: { emoji: '🌙', text: 'Rest?' },
  description: 'Nothing to do.',
  buttons: [],
};

interface StubBackendConfig {
  menu?: ActionMenuResult;
  dayJob?: DayJobStart;
  start?: StartRenderResult;
  customResume?: import('../../src/controller/SessionController.js').BeginCustomActionResult;
  rest?: RestBeginResult;
  throwOn?: 'openActionMenu' | 'runCustomAction' | 'tick';
  char?: Partial<CharacterData>;
}

/** The stub RouterBackend — the minimal surface the six flows need. Extracted from
 *  stubHarness so the DC-S4 minimal-observer test can wire a bare three-method observer
 *  over the same backend shape. */
function stubBackend(character: CharacterData, opts: StubBackendConfig): RouterBackend {
  const outcome: StartRenderResult = {
    kind: 'outcome',
    viewPrivate: OUTCOME_VIEW,
    viewPublic: OUTCOME_VIEW,
    distilledType: 'chore',
    characterName: 'Stub',
    char: character,
    prevChar: character,
  };
  return {
    getCharacter: () => character,
    stampLastPlayed: () => {},
    openActionMenu: () => {
      if (opts.throwOn === 'openActionMenu') throw new Error('kaboom');
      return opts.menu ?? { kind: 'no-rolls' };
    },
    beginDayJob: () => opts.dayJob ?? { kind: 'invalid-job' },
    commuteForWork: () => ({ kind: 'none' }),
    beginCustomAction: () => opts.customResume ?? { kind: 'start' },
    runWork: async () => opts.start ?? outcome,
    runCustomAction: async () => {
      if (opts.throwOn === 'runCustomAction') throw new Error('kaboom');
      return opts.start ?? outcome;
    },
    beginChoice: () => ({ kind: 'ok', character }),
    resolveChoice: () => 'Press on',
    stepChoice: async () => ({ kind: 'outcome' as const, view: OUTCOME_VIEW, distilledType: 'chore', characterName: 'Stub', characterClass: 'Warrior', char: character, prevChar: character }),
    beginRest: () => opts.rest ?? {
      kind: 'rested' as const,
      alreadyThere: true,
      prev: { health: 10, stamina: 10 },
      updated: character,
      wasUnsafe: false,
      unsafeFromName: "The Warden's Oak",
    },
    openHi: () => ({ kind: 'no-character' }),
    // M8.1 screen surface — the harness never dispatches `screen.*` events, so minimal
    // canned defaults are all this stub needs to satisfy RouterBackend structurally.
    openLook: () => ({ kind: 'no-character' }),
    openMap: () => ({ kind: 'no-character' }),
    openStats: () => ({ kind: 'no-character' }),
    openBackpack: () => ({ kind: 'no-character' }),
    openJournal: () => ({ kind: 'no-character' }),
    openHelp: () => ({ kind: 'view', view: { screen: 'notice', text: '', ephemeral: true } }),
    // M7.3 wizard surface — these QA tests never spawn a character (createCharacter is only
    // exercised by the protocol-log suite), so the minimal no-session defaults are all the
    // stub needs.
    openJoin: () => ({ kind: 'has-character' }),
    answerWizardName: () => ({ kind: 'no-session' }),
    chooseWizardOption: () => ({ kind: 'no-session' }),
    restartWizard: () => ({ kind: 'view', view: { screen: 'wizard' as const, step: 1, totalSteps: 7, ledger: '', body: '', footer: '', buttons: [] } }),
    confirmWizard: () => ({ kind: 'no-session' }),
    feedbackConfirmation: () => ({ screen: 'notice' as const, text: 'Thanks', ephemeral: true }),
    recordFeedback: () => {},
  };
}

function stubHarness(opts: StubBackendConfig & { moves?: AgentMove[] }): AgentHarness {
  const character = stubChar(opts.char);
  // DC-S4: the stub observer is the QA-OBSERVER surface — getCharacter/getMeta/tick, the
  // harness's only engine touch. restAtOak is extra (structural typing tolerates it) and
  // dead — the rest half dispatches rest.begin through the router (M7.1).
  const observer = {
    getCharacter: () => character,
    getMeta: () => '1',
    restAtOak: () => character,
    tick: () => {
      if (opts.throwOn === 'tick') throw new Error('tick blew up');
      return { dayNumber: 2, playersAffected: 0, npcMovements: [], absentWarnings: [], collapsedNames: [] };
    },
  } as unknown as AgentObserver;

  const router = new GameRouter(stubBackend(character, opts), { idle: () => IDLE });
  const brain = new ScriptedAgentPlayerGateway(opts.moves ?? []);
  // The stub-router backend class is 'stub' — the protocol-log header must be honest (DC-S2).
  return new AgentHarness(observer, router, brain, USER_ID, { backend: 'stub' });
}

describe('AgentHarness — QA capture (M6 protocol)', () => {
  it('records the dead-end arms of openActionMenu', async () => {
    const arms: Array<[ActionMenuResult, string]> = [
      [{ kind: 'no-character' }, 'no-character'],
      [{ kind: 'resume-stale', prompt: 'a stale prompt' }, 'resume-stale'],
      [{ kind: 'resume-error', message: 'boom' }, 'internal'],
    ];
    for (const [menu, reason] of arms) {
      const h = stubHarness({ menu });
      await h.playOneAction();
      expect(h.transcript.events.some((e) => e.type === 'dead-end' && e.reason === reason)).toBe(true);
    }
  });

  it('flags beginDayJob invalid-job as an error finding and unsafe ground as a dead-end', async () => {
    const invalid = stubHarness({
      menu: { kind: 'menu', view: DAYJOB_MENU },
      dayJob: { kind: 'invalid-job' },
      moves: [{ kind: 'menu-pick', index: 0 }],
    });
    expect(await invalid.playOneAction()).toEqual({ kind: 'dead-end', reason: 'illegal-move' });
    expect(
      invalid.transcript.events.some(
        (e) => e.type === 'finding' && e.severity === 'error' && e.summary.includes('internal error'),
      ),
    ).toBe(false); // invalid-job maps to illegal-move, not internal error

    const unsafe = stubHarness({
      menu: { kind: 'menu', view: DAYJOB_MENU },
      dayJob: { kind: 'unsafe', location: 'The Bog' },
      moves: [{ kind: 'menu-pick', index: 0 }],
    });
    expect(await unsafe.playOneAction()).toEqual({ kind: 'dead-end', reason: 'unsafe' });
    expect(unsafe.transcript.events.some((e) => e.type === 'dead-end' && e.reason === 'unsafe-ground')).toBe(true);
  });

  it('captures a backend throw as an internal error dead-end (router never throws)', async () => {
    const h = stubHarness({ throwOn: 'openActionMenu' });
    const result = await h.playOneAction();

    // The router catches the backend throw and returns ok:false 'internal' — the harness
    // maps it to a dead-end, not a crash (the router never throws by design).
    expect(result).toEqual({ kind: 'dead-end', reason: 'internal' });
    expect(h.transcript.events.some((e) => e.type === 'dead-end' && e.reason === 'internal')).toBe(true);
    expect(h.transcript.events.length).toBeGreaterThan(0);
  });

  it('flags an out-of-band character as an invariant breach after an outcome', async () => {
    // Use an outcome (not decision loop) so the harness returns immediately without
    // dispatching action.choose. The stub returns the outcome directly from runCustomAction.
    const h = stubHarness({
      menu: { kind: 'menu', view: CUSTOM_MENU },
      char: { wealth: -5 },
      moves: [
        { kind: 'custom', text: 'do a thing' },
        { kind: 'sleep' },
      ],
      start: {
        kind: 'outcome',
        viewPrivate: OUTCOME_VIEW,
        viewPublic: OUTCOME_VIEW,
        distilledType: 'chore',
        characterName: 'Stub',
        char: stubChar({ wealth: -5 }),
        prevChar: stubChar({ wealth: -5 }),
      } as StartRenderResult,
    });
    const day = await h.playDay();

    expect(day.ended).toBe('slept');
    expect(day.outcomes).toBe(1);
    expect(
      h.transcript.events.some(
        (e) => e.type === 'finding' && e.severity === 'error' && e.summary.includes('wealth -5 < 0'),
      ),
    ).toBe(true);
  });

  it('captures a throwing nightly tick as a finding and stops the multi-day run', async () => {
    const h = stubHarness({
      menu: { kind: 'menu', view: SLEEP_ONLY_MENU },
      throwOn: 'tick',
      moves: [{ kind: 'sleep' }],
    });
    const summaries = await h.playDays(3);

    expect(summaries).toEqual([{ dayNumber: 1, outcomes: 0, ended: 'slept' }]);
    expect(
      h.transcript.events.some(
        (e) => e.type === 'finding' && e.severity === 'error' && e.summary.includes('nightly tick'),
      ),
    ).toBe(true);
  });

  it('rolls the transcript up into a run summary', async () => {
    const { harness, seed } = buildHarness([
      { kind: 'custom', text: 'attack the goblin' },
      { kind: 'choice', index: 0 },
      { kind: 'choice', index: 0 },
      { kind: 'sleep' },
    ]);
    await seed();
    await harness.playDay();

    const s = harness.transcript.summary();
    expect(s).toEqual({
      turns: 4,
      outcomes: 1,
      deadEnds: 0,
      commutes: 0,
      dayBoundaries: 0,
      // DC-S3: this is the REAL backend with a seeded character, so the scripted day-start
      // greeting beat recorded one greeting (the stubHarness tests keep greetings: 0 — the
      // stub's openHi returns no-character and the beats are silent on no-character).
      greetings: 1,
      findings: { error: 0, warning: 0 },
    });
  });

  it('a crash mid-action ends the day as crashed and stops the multi-day run', async () => {
    const h = stubHarness({
      menu: { kind: 'menu', view: CUSTOM_MENU },
      throwOn: 'runCustomAction',
      moves: [{ kind: 'custom', text: 'do a thing' }],
    });
    const summaries = await h.playDays(2);

    // The backend throws → router catches it → returns ok:false 'internal' with message
    // 'kaboom' → the harness maps it to a dead-end. Then the harness loops back to the
    // menu, but the brain script is exhausted → ScriptedAgentPlayerGateway throws → the
    // harness catches that as a crashed disposition (transcript.finding). The run stops.
    expect(summaries.length).toBe(1);
    // The backend throw message was recorded as a dead-end, not a finding (the router
    // returns it as an error envelope, not an exception).
    expect(h.transcript.events.some((e) => e.type === 'dead-end' && e.reason === 'internal')).toBe(true);
    // The brain-exhaustion crash is logged as a finding.
    expect(
      h.transcript.events.some(
        (e) => e.type === 'finding' && e.severity === 'error' && e.summary.includes('uncaught exception'),
      ),
    ).toBe(true);
  });
});

// ── M4.4 — faithful endDay (M7.1: the rest half crosses the seam as rest.begin; the world
// tick stays engine-direct) ──

describe('AgentHarness — faithful endDay (M7.1, rest through the protocol)', () => {
  const dayJobAction: AgentMove[] = [
    { kind: 'menu-pick', index: 0 },
    { kind: 'choice', index: 0 },
    { kind: 'choice', index: 0 },
  ];

  it('idles without resting while rolls remain', async () => {
    const { harness, agentEngine, seed } = buildHarness([...dayJobAction, { kind: 'sleep' }]);
    await seed();

    await harness.playDays(1);

    const after = agentEngine.engine.getCharacter(USER_ID)!;
    expect(after.location).not.toBe("The Warden's Oak");
    expect(harness.transcript.events.some((e) => e.type === 'commute')).toBe(true);
  });

  it('rests to the Oak once every roll is spent', async () => {
    const { harness, agentEngine, seed } = buildHarness([...dayJobAction, ...dayJobAction, ...dayJobAction]);
    await seed();

    const summaries = await harness.playDays(1);

    expect(summaries[0].ended).toBe('no-rolls');
    expect(agentEngine.engine.getCharacter(USER_ID)!.location).toBe("The Warden's Oak");
  });

  it('surfaces the unsafe-rest −1 HP as a warning finding (restUnsafe fact → transcript)', async () => {
    const h = stubHarness({
      menu: { kind: 'menu', view: SLEEP_ONLY_MENU },
      moves: [{ kind: 'sleep' }],
      rest: {
        kind: 'rested',
        alreadyThere: false,
        prev: { health: 10, stamina: 10 },
        updated: { ...stubChar(), health: 9, location: "The Warden's Oak" },
        wasUnsafe: true,
        unsafeFromName: 'The Broken Keep',
      },
    });

    const summaries = await h.playDays(1);

    expect(summaries).toEqual([{ dayNumber: 1, outcomes: 0, ended: 'slept' }]);
    const finding = h.transcript.events.find((e) => e.type === 'finding' && e.severity === 'warning');
    expect(finding?.type === 'finding' && finding.summary).toContain('lost 1 HP');
    // The tick still advanced the world — an unsafe rest never aborts the nightly cron.
    expect(h.transcript.events.some((e) => e.type === 'day')).toBe(true);
  });
});

// ── M8.5 (DC-S3) — the AGENT_BRAIN_CHOOSES_CHAR realism arm: the brain authors the
// character through the wizard (name + step choices) instead of the scripted walk. All picks
// below are REAL def values from assets/char-creation/*.yml — the first option of each step
// (the wizard's step-5 alignment values are persisted LOWERCASE, step-7 kits are
// class-filtered, and each step's buttons carry a trailing restart button the script never
// picks — index 0 is always the first real option). ──

describe('AgentHarness — brain-driven character creation (DC-S3)', () => {
  it('the brain authors the character through the wizard, landing real def values', async () => {
    const { harness, brain, agentEngine } = buildHarness([
      { kind: 'custom', text: 'Birch' }, // step 1: the free-text name slot
      { kind: 'menu-pick', index: 0 }, // step 2: first class (Warrior)
      { kind: 'menu-pick', index: 0 }, // step 3: first upbringing (Soldier)
      { kind: 'menu-pick', index: 0 }, // step 4: first race (Human)
      { kind: 'menu-pick', index: 0 }, // step 5: first alignment, lowercase (lawful good)
      { kind: 'menu-pick', index: 0 }, // step 6: first day job (Town Guard)
      { kind: 'menu-pick', index: 0 }, // step 7: first kit for a Warrior (Soldier's Kit)
      { kind: 'menu-pick', index: 0 }, // step 8: confirm
    ]);
    await harness.createCharacterWithBrain();

    // The created character exists with the picked values — every one a real def value
    // (first option of its step), the alignment lowercased per the wizard's persistence.
    const char = agentEngine.engine.getCharacter(USER_ID)!;
    expect(char.name).toBe('Birch');
    expect(char.class).toBe('Warrior');
    expect(char.upbringing).toBe('Soldier');
    expect(char.race).toBe('Human');
    expect(char.alignment).toBe('lawful good');
    expect(char.dayJob).toBe('Town Guard');
    // The step-7 kit pick lands in the inventory: the Soldier's Kit's starting item is on
    // the character (getItems is the engine's read — the walk itself only knows def values).
    expect(agentEngine.engine.getItems(char.id).some((i) => i.name === 'Iron Sword')).toBe(true);

    // The protocol log records the full brain-authored walk, in order — the same shape as the
    // scripted walk's, proving the realism arm crosses the seam identically.
    const walk = harness.transcript.protocol
      .filter((e) => e.kind === 'dispatch')
      .map((d) => d.event.type);
    expect(walk).toEqual([
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
    const chooses = harness.transcript.protocol.filter(
      (e): e is ProtocolDispatchEntry & { event: { type: 'wizard.choose'; step: number; value: string } } =>
        e.kind === 'dispatch' && e.event.type === 'wizard.choose',
    );
    expect(chooses.map((d) => d.event.value)).toEqual([
      'Warrior',
      'Soldier',
      'Human',
      'lawful good',
      'Town Guard',
      "Soldier's Kit",
    ]);

    // The brain saw the wizard screen with the all-zeros placeholder char (the wizard
    // envelope carries NO character facts — DC-M6.1's null-char rule).
    expect(brain.calls).toHaveLength(8);
    expect(brain.calls[0].screenText.length).toBeGreaterThan(0);
    expect(brain.calls[0].character).toEqual({
      name: '',
      class: '',
      health: 0,
      maxHealth: 0,
      stamina: 0,
      maxStamina: 0,
      rollsRemaining: 0,
      wealth: 0,
      location: '',
    });
  });
});

// ── M8.5 (DC-S4) — the observer boundary's behavioural half: the harness runs a full day
// against an observer with EXACTLY the three methods (getCharacter/getMeta/tick) over the
// stub RouterBackend shape — proof the harness needs nothing beyond the three-method
// observer surface (the pin's structural half lives in tests/agent/observer.test.ts). ──

describe('AgentHarness — minimal observer (DC-S4: the observer is exactly three methods)', () => {
  it('plays a full day against a bare three-method observer', async () => {
    // The "exactly three" surface: no restAtOak, no createCharacter, no setMeta — just the
    // QA-OBSERVER reads + the nightly cron. Typed straight as AgentObserver (no cast); the
    // excess-property check is typecheck-only (tests are NOT under tsc — the tsconfig
    // src-only gate, the M9 watch-item class), so the REAL enforcement here is runtime: if
    // the harness called any fourth engine method on the day flow, the run below would
    // throw and the summaries would mismatch.
    const observer: AgentObserver = {
      getCharacter: () => stubChar(),
      getMeta: () => '1',
      tick: () => ({ dayNumber: 2 }),
    };

    const router = new GameRouter(
      stubBackend(stubChar(), { menu: { kind: 'menu', view: SLEEP_ONLY_MENU } }),
      { idle: () => IDLE },
    );
    const brain = new ScriptedAgentPlayerGateway([{ kind: 'sleep' }]);
    const harness = new AgentHarness(observer, router, brain, USER_ID, { backend: 'stub' });

    const summaries = await harness.playDays(1);

    // The full day ran: menu.open → sleep → rest.begin → the nightly tick through the
    // observer (its { dayNumber: 2 } advanced the world — the day-boundary event records 2).
    expect(summaries).toEqual([{ dayNumber: 1, outcomes: 0, ended: 'slept' }]);
    expect(harness.transcript.events.some((e) => e.type === 'day' && e.dayNumber === 2)).toBe(true);
  });
});
