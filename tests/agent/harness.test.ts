import { describe, it, expect } from 'vitest';

import { buildAgentEngine } from '../../src/agent/engineHarness.js';
import { AgentHarness, createAgentHarness } from '../../src/agent/harness.js';
import { ScriptedAgentPlayerGateway } from '../../src/agent/ScriptedAgentPlayerGateway.js';
import { PipelineScriptedGateway } from '../../src/sim/PipelineScriptedGateway.js';
import { SessionController } from '../../src/controller/SessionController.js';
import { viewToText } from '../../src/agent/viewToText.js';
import { CID_DAYJOB, CID_DAYJOB_CUSTOM } from '../../src/controller/dayJob.js';
import type { PipelineScript } from '../../src/sim/types.js';
import type { CharCreateData, CharacterData, WorldEngine } from '../../src/engine/WorldEngine.js';
import type { ActionMenuResult, DayJobStart, StartRenderResult } from '../../src/controller/SessionController.js';
import type { MenuViewState, OutcomeViewState } from '../../src/view/viewState.js';
import type { AgentMove } from '../../src/agent/AgentPlayerGateway.js';

// ── M4.2 — harness bring-up + one action end-to-end. Proves the seam (parent decision 3): the
// agent enters at the SAME SessionController methods the Discord adapter calls, driving menu →
// custom action → decision beat → outcome with a scripted brain over a real WorldEngineImpl. Fully
// deterministic: scripted pipeline gateway + fixed d20, no network. ──

// The proven goblin-skirmish shape (src/sim/example-comparison-scenario.ts): "attack the goblin"
// is a clean heuristic-classify combat hit; decide offers two real options + a bail; a fixed 20
// beats the low DC, so resolve narrates a success. `classify` is a safety net — ignored on the
// heuristic hit, it keeps the run deterministic if the heuristic ever changes.
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

// A non-combat action whose DECIDE returns zero options auto-resolves inside `startAction`
// (PipelineActionStateMachine: empty decision on a non-combat action resolves in start()), so
// `runCustomAction` returns `StartRenderResult.kind === 'outcome'` directly — the immediate-outcome
// path that has a compact-private / full-public split (and the path Finding 1 was hiding in).
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
  alignment: 'Lawful Good',
  dayJob: 'Town Guard',
};

const USER_ID = 'agent:test';

function buildHarness(brainMoves: AgentMove[], script: PipelineScript = pipelineScript) {
  const agentEngine = buildAgentEngine({
    pipelineLlmGateway: new PipelineScriptedGateway(script),
    rollD20: () => 20, // fixed success against the low DC
  });
  const brain = new ScriptedAgentPlayerGateway(brainMoves);
  return { harness: createAgentHarness(agentEngine, brain, USER_ID), brain, agentEngine };
}

describe('AgentHarness — one action end-to-end', () => {
  it('drives menu → custom action → decision beat → outcome through the controller', async () => {
    const { harness, brain, agentEngine } = buildHarness([
      { kind: 'custom', text: 'attack the goblin' }, // pick the free-text slot from the menu
      // The pipeline runs up to two decision beats before resolving; pick the first option at each.
      { kind: 'choice', index: 0 },
      { kind: 'choice', index: 0 },
    ]);
    const char = harness.seedCharacter(SEED);
    expect(char.name).toBe('Bram');
    expect(char.stats.physical).toBeGreaterThan(0); // real stat derivation (Warrior + real assets)

    const result = await harness.playOneAction();
    expect(result).toEqual({ kind: 'outcome' });

    const events = harness.transcript.events;
    // The brain answered one turn per screen it was shown; the run ends on an outcome.
    const turns = events.filter((e) => e.type === 'turn');
    expect(brain.calls).toHaveLength(turns.length);
    expect(events[events.length - 1].type).toBe('outcome');

    // Turn 1 = the day-job menu, offering the day-job picks + a custom slot + sleep.
    const menuTurn = events[0];
    expect(menuTurn.type === 'turn' && menuTurn.screen).toBe('menu');
    expect(menuTurn.type === 'turn' && menuTurn.text).toContain('Daily Work');
    expect(menuTurn.type === 'turn' && menuTurn.offered).toContain('Type your own action');
    expect(menuTurn.type === 'turn' && menuTurn.offered).toContain('Go to sleep — end the day');

    // The action authored at least one decision the brain answered, offering the scripted options.
    const decisionTurn = events.find((e) => e.type === 'turn' && e.screen === 'decision');
    expect(decisionTurn?.type === 'turn' && decisionTurn.offered.some((l) => l.includes('Press the attack'))).toBe(true);

    // The outcome the brain would read carries the narrated success.
    const outcome = events[events.length - 1];
    expect(outcome.type === 'outcome' && outcome.text).toContain('the goblin falls');

    // The engine actually resolved the action: wealth mutation applied, a roll spent.
    const after = agentEngine.engine.getCharacter(USER_ID)!;
    expect(after.wealth).toBe(char.wealth + 5);
    expect(after.rollsRemaining).toBe(char.rollsRemaining - 1);
  });

  it('picking a day-job menu button runs the work flow to an outcome', async () => {
    const { harness, agentEngine } = buildHarness([
      { kind: 'menu-pick', index: 0 }, // first day-job task on the menu
      { kind: 'choice', index: 0 },
      { kind: 'choice', index: 0 },
    ]);
    const char = harness.seedCharacter(SEED);
    const result = await harness.playOneAction();

    expect(result).toEqual({ kind: 'outcome' });
    // Day-job work commutes the guard to their workplace (they start at the Oak).
    const after = agentEngine.engine.getCharacter(USER_ID)!;
    expect(after.location).not.toBe(char.location);
  });

  it('an action that resolves immediately transcripts the private (acting-player) view', async () => {
    // run 1: drive the immediate-resolve action through the harness.
    const { harness, brain } = buildHarness([{ kind: 'custom', text: 'polish my boots' }], immediateScript);
    harness.seedCharacter(SEED);
    const result = await harness.playOneAction();
    expect(result).toEqual({ kind: 'outcome' });
    // Only the menu turn — no decision beat — confirms the immediate-outcome branch of
    // handleStartResult ran (the previously-untested path that hid Finding 1).
    expect(brain.calls).toHaveLength(1);
    const outcomeEvent = harness.transcript.events.at(-1);
    expect(outcomeEvent?.type).toBe('outcome');

    // run 2: reproduce the controller result deterministically (fresh engine, same script + fixed
    // roll) to get both views, and confirm the transcript carries the acting player's own view
    // (Finding 1 / decision 2). RA-6 made the two arms byte-identical on this auto-resolve path,
    // so the old `viewPrivate !== viewPublic` discriminator is gone; what is asserted instead is
    // the property RA-6 bought — the private arm carries the full gamebook trail, not the compact
    // variant that dropped the story thread on a path where no decision embed preceded it.
    const ae2 = buildAgentEngine({
      pipelineLlmGateway: new PipelineScriptedGateway(immediateScript),
      rollD20: () => 20,
    });
    const c2 = new SessionController(ae2.engine, ae2.getCurrentScene, ae2.dayJobs);
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
    const { harness } = buildHarness([{ kind: 'sleep' }]);
    harness.seedCharacter(SEED);
    const result = await harness.playOneAction();
    expect(result).toEqual({ kind: 'slept' });
    expect(harness.transcript.events).toHaveLength(1); // just the menu turn
  });
});

// ── M4.3 — full-day + multi-day loop. `playDay` runs actions until the day ends; `playDays`
// bookends each day with the engine-direct rest+nightly-tick (DA-4) and advances. Still fully
// deterministic (scripted brain + scripted pipeline + fixed d20, no network). ──
describe('AgentHarness — full-day + multi-day loop', () => {
  // One goblin action = 3 brain calls (menu pick + two decision beats to the outcome). The starting
  // roll allowance is 3, so three actions deplete the day; the fourth menu open returns no-rolls.
  const goblinAction: AgentMove[] = [
    { kind: 'custom', text: 'attack the goblin' },
    { kind: 'choice', index: 0 },
    { kind: 'choice', index: 0 },
  ];

  it('plays down to no-rolls without asking the brain past the last roll', async () => {
    const { harness, brain, agentEngine } = buildHarness([...goblinAction, ...goblinAction, ...goblinAction]);
    harness.seedCharacter(SEED);

    const summary = await harness.playDay();

    expect(summary).toEqual({ dayNumber: 1, outcomes: 3, ended: 'no-rolls' });
    // Three actions × three calls — the fourth (no-rolls) menu short-circuits before the brain,
    // so the script is consumed exactly, not over-run.
    expect(brain.calls).toHaveLength(9);
    expect(agentEngine.engine.getCharacter(USER_ID)!.rollsRemaining).toBe(0);
  });

  it('runs multiple days, advancing the day and refilling rolls each night', async () => {
    // Day 1: one goblin action (spends a roll), then sleep. Day 2: sleep straight away. The night
    // between them must rest the guard back at the Oak, advance the day, and refill the spent roll.
    const { harness, agentEngine } = buildHarness([...goblinAction, { kind: 'sleep' }, { kind: 'sleep' }]);
    const seeded = harness.seedCharacter(SEED);

    const summaries = await harness.playDays(2);

    expect(summaries).toEqual([
      { dayNumber: 1, outcomes: 1, ended: 'slept' },
      { dayNumber: 2, outcomes: 0, ended: 'slept' },
    ]);

    const after = agentEngine.engine.getCharacter(USER_ID)!;
    // Day 1 spent a roll (3→2); the nightly tick refilled it — proof the DA-4 bookend ran. Assert
    // `>=` not `===` the seeded allowance: tick's roll grant carries a +1 Saturday-UTC bonus off the
    // real clock (not injectable here), so a hard `=== 3` would flake ~1/7 of the time. `>= 3` still
    // fails if no refill happened (rolls would sit at the depleted 2).
    expect(after.rollsRemaining).toBeGreaterThanOrEqual(seeded.rollsRemaining);
    // Two nights ticked past day 1, so the world sits on day 3. The guard is still at the Oak — not
    // because it was rested there (faithful endDay skips restAtOak while rolls remain, M4.4), but
    // because the goblin custom action never relocates it in the first place.
    expect(Number(agentEngine.engine.getMeta('day_number'))).toBe(3);
    expect(after.location).toBe("The Warden's Oak");

    // Each night left a day-boundary marker on the transcript (two ticks → two boundaries).
    const boundaries = harness.transcript.events.filter((e) => e.type === 'day');
    expect(boundaries.map((b) => b.type === 'day' && b.dayNumber)).toEqual([2, 3]);
  });

  it('stops the multi-day run when a day stalls instead of replaying the wedge', async () => {
    // A `choice` move is illegal on the MENU screen, so every action stumbles without resolving.
    // Five consecutive stumbles stall the day; a stalled day must END the run — pressing on would
    // just replay the same frozen state each remaining day (Finding 1). Script six illegals: only
    // five are consumed (day 1 stalls at the fifth), proving day 2 never runs.
    const illegal: AgentMove = { kind: 'choice', index: 0 };
    const { harness, brain, agentEngine } = buildHarness([illegal, illegal, illegal, illegal, illegal, illegal]);
    harness.seedCharacter(SEED);

    const summaries = await harness.playDays(3);

    expect(summaries).toEqual([{ dayNumber: 1, outcomes: 0, ended: 'stalled' }]);
    expect(brain.calls).toHaveLength(5); // exactly STUCK_LIMIT — the sixth move is never asked for
    // No night ticked (the run stopped before `endDay`), so the world is still on day 1.
    expect(Number(agentEngine.engine.getMeta('day_number'))).toBe(1);
    expect(harness.transcript.events.some((e) => e.type === 'day')).toBe(false);
  });
});

// ── M4.4 — QA capture. Exception → error finding + a graceful `crashed` disposition; a cheap
// invariant sweep after every outcome and tick; the commute beat; the faithful endDay; the run
// scoreboard. Arms that can't be reached deterministically through the real engine (a crash, an
// out-of-band character, the resume-*/day-job guards) run against a stub SessionController +
// WorldEngine that returns the arm directly — the harness takes both as constructor deps. ──

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

// A menu with no day-job buttons — `menuLegalMoves` still offers the contextual sleep move.
const SLEEP_ONLY_MENU: MenuViewState = {
  screen: 'menu',
  title: { emoji: '🌙', text: 'Rest?' },
  description: 'Nothing to do.',
  buttons: [],
};

interface StubOpts {
  menu?: ActionMenuResult;
  dayJob?: DayJobStart;
  start?: StartRenderResult;
  throwOn?: 'openActionMenu' | 'runCustomAction' | 'tick';
  char?: Partial<CharacterData>;
  moves?: AgentMove[];
}

function stubHarness(opts: StubOpts): AgentHarness {
  const character = stubChar(opts.char);
  const engine = {
    getCharacter: () => character,
    getMeta: () => '1',
    restAtOak: () => character,
    tick: () => {
      if (opts.throwOn === 'tick') throw new Error('tick blew up');
      return { dayNumber: 2, playersAffected: 0, npcMovements: [], absentWarnings: [], collapsedNames: [] };
    },
  } as unknown as WorldEngine;
  const outcome: StartRenderResult = {
    kind: 'outcome',
    viewPrivate: OUTCOME_VIEW,
    viewPublic: OUTCOME_VIEW,
    distilledType: 'chore',
    characterName: 'Stub',
    char: character,
    prevChar: character,
  };
  const controller = {
    stampLastPlayed: () => {},
    openActionMenu: () => {
      if (opts.throwOn === 'openActionMenu') throw new Error('kaboom');
      return opts.menu ?? { kind: 'no-rolls' };
    },
    beginDayJob: () => opts.dayJob ?? { kind: 'invalid-job' },
    commuteForWork: () => ({ kind: 'none' }),
    beginCustomAction: () => ({ kind: 'start' }),
    runCustomAction: async () => {
      if (opts.throwOn === 'runCustomAction') throw new Error('kaboom');
      return opts.start ?? outcome;
    },
  } as unknown as SessionController;
  const brain = new ScriptedAgentPlayerGateway(opts.moves ?? []);
  return new AgentHarness(engine, controller, brain, USER_ID);
}

describe('AgentHarness — QA capture (M4.4)', () => {
  it('records the dead-end arms of openActionMenu', async () => {
    const arms: Array<[ActionMenuResult, string]> = [
      [{ kind: 'no-character' }, 'no-character'],
      [{ kind: 'resume-stale', prompt: 'a stale prompt' }, 'resume-stale'],
      [{ kind: 'resume-error', message: 'boom' }, 'resume-error'],
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
    expect(await invalid.playOneAction()).toEqual({ kind: 'dead-end', reason: 'invalid-job' });
    expect(
      invalid.transcript.events.some(
        (e) => e.type === 'finding' && e.severity === 'error' && e.summary.includes('invalid-job'),
      ),
    ).toBe(true);

    const unsafe = stubHarness({
      menu: { kind: 'menu', view: DAYJOB_MENU },
      dayJob: { kind: 'unsafe', location: 'The Bog' },
      moves: [{ kind: 'menu-pick', index: 0 }],
    });
    expect(await unsafe.playOneAction()).toEqual({ kind: 'dead-end', reason: 'unsafe' });
    expect(unsafe.transcript.events.some((e) => e.type === 'dead-end' && e.reason === 'unsafe-ground')).toBe(true);
  });

  it('captures an uncaught exception as an error finding + a crashed disposition, keeping the repro', async () => {
    const h = stubHarness({ throwOn: 'openActionMenu' });
    const result = await h.playOneAction();

    expect(result.kind).toBe('crashed');
    // The crashed disposition names the failing seam call (the breadcrumb), so a QA reader knows
    // exactly where it died without digging through the stack.
    if (result.kind === 'crashed') expect(result.phase).toBe('openActionMenu');
    const finding = h.transcript.events.find((e) => e.type === 'finding');
    expect(finding?.type === 'finding' && finding.severity).toBe('error');
    expect(finding?.type === 'finding' && finding.summary).toContain('openActionMenu');
    // The transcript survived rather than the exception tearing the run down — it IS the repro.
    expect(h.transcript.events.length).toBeGreaterThan(0);
  });

  it('flags an out-of-band character as an invariant breach after an outcome', async () => {
    // A negative wealth the engine's own mutation guards should have blocked — the post-outcome
    // sweep must catch it. Action 1 resolves an outcome (triggering the sweep); action 2 sleeps.
    const h = stubHarness({
      menu: { kind: 'menu', view: CUSTOM_MENU },
      char: { wealth: -5 },
      moves: [
        { kind: 'custom', text: 'do a thing' },
        { kind: 'sleep' },
      ],
    });
    const day = await h.playDay();

    expect(day).toEqual({ dayNumber: 1, outcomes: 1, ended: 'slept' });
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

    // Day 1 slept cleanly; endDay's tick then threw, so the run stops with just the one day.
    expect(summaries).toEqual([{ dayNumber: 1, outcomes: 0, ended: 'slept' }]);
    expect(
      h.transcript.events.some(
        (e) => e.type === 'finding' && e.severity === 'error' && e.summary.includes('nightly tick'),
      ),
    ).toBe(true);
  });

  it('rolls the transcript up into a run summary', async () => {
    const { harness } = buildHarness([
      { kind: 'custom', text: 'attack the goblin' },
      { kind: 'choice', index: 0 },
      { kind: 'choice', index: 0 },
      { kind: 'sleep' },
    ]);
    harness.seedCharacter(SEED);
    await harness.playDay();

    const s = harness.transcript.summary();
    // One goblin action = 1 menu turn + 2 decision turns; the sleep adds a 4th menu turn. No commute
    // (a custom action doesn't relocate), no night (single playDay), no findings.
    expect(s).toEqual({
      turns: 4,
      outcomes: 1,
      deadEnds: 0,
      commutes: 0,
      dayBoundaries: 0,
      findings: { error: 0, warning: 0 },
    });
  });

  it('a crash mid-action ends the day as crashed and stops the multi-day run', async () => {
    // runCustomAction throws mid-action — the crash must propagate to a `crashed` DaySummary and
    // stop `playDays` (day 2 never runs), proving the in-day crash path, not just the standalone one.
    const h = stubHarness({
      menu: { kind: 'menu', view: CUSTOM_MENU },
      throwOn: 'runCustomAction',
      moves: [{ kind: 'custom', text: 'do a thing' }],
    });
    const summaries = await h.playDays(2);

    expect(summaries).toEqual([{ dayNumber: 1, outcomes: 0, ended: 'crashed' }]);
    expect(
      h.transcript.events.some(
        (e) => e.type === 'finding' && e.severity === 'error' && e.summary.includes('runCustomAction'),
      ),
    ).toBe(true);
  });
});

describe('AgentHarness — faithful endDay (M4.4)', () => {
  // Day-job work commutes the guard away from the Oak (they start there); whether endDay rests them
  // back turns on rolls spent.
  const dayJobAction: AgentMove[] = [
    { kind: 'menu-pick', index: 0 },
    { kind: 'choice', index: 0 },
    { kind: 'choice', index: 0 },
  ];

  it('idles without resting while rolls remain — the guard stays where it worked', async () => {
    const { harness, agentEngine } = buildHarness([...dayJobAction, { kind: 'sleep' }]);
    harness.seedCharacter(SEED);

    await harness.playDays(1);

    const after = agentEngine.engine.getCharacter(USER_ID)!;
    // Rolls left (spent 1 of 3), so a real player couldn't /sleep-rest — endDay skips restAtOak and
    // the guard is NOT teleported home; it's still at the workplace it commuted to.
    expect(after.location).not.toBe("The Warden's Oak");
    // The commute was a real beat the player saw — it's on the transcript now (M4.2 deferral).
    expect(harness.transcript.events.some((e) => e.type === 'commute')).toBe(true);
  });

  it('rests to the Oak once every roll is spent', async () => {
    const { harness, agentEngine } = buildHarness([...dayJobAction, ...dayJobAction, ...dayJobAction]);
    harness.seedCharacter(SEED);

    const summaries = await harness.playDays(1);

    expect(summaries[0].ended).toBe('no-rolls');
    // Rolls hit 0, so endDay CAN rest — the guard returns home from the workplace.
    expect(agentEngine.engine.getCharacter(USER_ID)!.location).toBe("The Warden's Oak");
  });
});
