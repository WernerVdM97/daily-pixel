import { describe, it, expect } from 'vitest';

import { buildAgentEngine } from '../../src/agent/engineHarness.js';
import { createAgentHarness } from '../../src/agent/harness.js';
import { ScriptedAgentPlayerGateway } from '../../src/agent/ScriptedAgentPlayerGateway.js';
import { PipelineScriptedGateway } from '../../src/sim/PipelineScriptedGateway.js';
import { SessionController } from '../../src/controller/SessionController.js';
import { viewToText } from '../../src/agent/viewToText.js';
import type { PipelineScript } from '../../src/sim/types.js';
import type { CharCreateData } from '../../src/engine/WorldEngine.js';
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
    // roll) to get both views, and confirm the transcript carries the PRIVATE compact view — not the
    // public broadcast copy meant for observers (Finding 1 / decision 2).
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
      expect(outcomeEvent.text).not.toBe(viewToText(r2.viewPublic));
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
