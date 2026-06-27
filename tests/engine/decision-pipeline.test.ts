/**
 * Decision-pipeline integration tests — start → step → resolve through the REAL
 * WorldEngineImpl (not ActionStateMachine in isolation).
 *
 * Branch logic (failure-strip, bail, auto-finish, roll-first/narration, nat-1/nat-20,
 * DC accumulation, critic hook) is already covered against the machine in
 * tests/engine/action-machine.test.ts, and per-mutation validation/application in
 * tests/engine/action-mutations.test.ts. This file deliberately does NOT re-test those.
 * It covers the seam those don't: that a resolved action is actually PERSISTED — the roll
 * drained, character deltas applied, item rows created, the failure-strip reflected in the
 * stored character, the action row written, and resumeAction rehydrating from the DB
 * without a fresh LLM call.
 *
 * Determinism: injected rollD20 + MockLlmGateway (the established fixture; a resolving step
 * calls decide() twice — decision beat then narration — and the single canned decision
 * serves both, exactly as the happy-path test relies on).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorldEngineImpl } from '../../src/engine/WorldEngineImpl.js';
import { MockLlmGateway } from '../../src/llm/MockLlmGateway.js';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import { ItemRepository } from '../../src/db/repositories/item.js';
import { ActionRepository } from '../../src/db/repositories/action.js';
import { NpcRepository } from '../../src/db/repositories/npc.js';
import type { LlmDecision } from '../../src/llm/LlmGateway.js';

const USER_ID = 'pipeline-user-1';

interface Ctx {
  engine: WorldEngineImpl;
  llm: MockLlmGateway;
  actionRepo: ActionRepository;
  charId: number;
}

/** Build a real engine over an in-memory DB with a deterministic d20. */
function setup(rollD20: () => number): Ctx {
  initDb(':memory:');
  migrate(getDb());
  const llm = new MockLlmGateway();
  const actionRepo = new ActionRepository(getDb());
  const engine = new WorldEngineImpl({
    db: getDb(),
    llm,
    userRepo: new UserRepository(getDb()),
    charRepo: new CharacterRepository(getDb()),
    itemRepo: new ItemRepository(getDb()),
    actionRepo,
    npcRepo: new NpcRepository(getDb()),
    rollD20,
    dayJobIncome: { Blacksmith: 10 },
  });
  const char = engine.createCharacter(USER_ID, {
    name: 'Aldric',
    class: 'Warrior',
    upbringing: 'Soldier',
    race: 'Human',
    alignment: 'lawful good',
    dayJob: 'Blacksmith',
  });
  return { engine, llm, actionRepo, charId: char.id };
}

/** First beat: real, rollable options so the action does not auto-finish. */
function firstDecision(baseDc: number): LlmDecision {
  return {
    prompt: 'A wolf circles in the gloom.',
    distilledType: 'hunt',
    stat: 'physical',
    baseDc,
    required: false,
    done: false,
    decision: [
      { label: 'Press the attack', dcModifier: 0 },
      { label: 'Step back', dcModifier: null },
    ],
    mutations: [],
    outcomeText: '',
  };
}

/** A decision with no real options → start() auto-finishes it outright. With no world-changing
 *  mutations it's a refundable no-op (e.g. a "look"). */
function autoFinishNoop(): LlmDecision {
  return {
    prompt: 'You glance at the old key.',
    distilledType: 'inspect',
    stat: 'wisdom',
    baseDc: 10,
    required: false,
    done: true,
    decision: [],
    mutations: [],
    outcomeText: 'Nothing of note.',
  };
}

/** An auto-finished action that GRANTS a roll (e.g. a "rest"). A roll gain is world-changing,
 *  so the action is charged — the grant nets against the cost rather than stacking on a refund. */
function autoFinishRollGrant(): LlmDecision {
  return {
    ...autoFinishNoop(),
    distilledType: 'rest',
    mutations: [{ type: 'modify_rolls_remaining', amount: 1 }],
    outcomeText: 'You rest a moment.',
  };
}

/** Resolving beat: done + the rolled outcome's mutations/prose (serves both the
 *  decision-beat and the narration call). */
function resolveDecision(over: Partial<LlmDecision>): LlmDecision {
  return {
    prompt: '',
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: true,
    decision: [{ label: 'Finish it', dcModifier: 0 }],
    mutations: [],
    outcomeText: 'It is settled.',
    ...over,
  };
}

describe('decision pipeline — WorldEngineImpl integration', () => {
  let ctx: Ctx;

  beforeEach(() => {
    // Fixed weekday so no Saturday bonus-roll perturbs the roll-count assertions.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
  });

  afterEach(() => {
    closeDb();
    vi.useRealTimers();
  });

  it('success path persists rewards, drains the roll, and writes the action row', async () => {
    ctx = setup(() => 18); // 18 + bonus vs DC 10 → success (not a nat-20 crit)
    const before = ctx.engine.getCharacter(USER_ID)!;
    expect(before.rollsRemaining).toBe(3);

    ctx.llm.setDecision(firstDecision(10));
    const start = await ctx.engine.startAction(ctx.charId, 'hunt the wolf');
    expect(start.outcome).toBeUndefined(); // not auto-finished
    expect(start.firstDecision.options).toHaveLength(2);

    ctx.llm.setDecision(
      resolveDecision({
        mutations: [
          { type: 'add_item', name: 'Wolf Pelt', emoji: '🐺', stat: 'wisdom', modifier: 1, quantity: 1 },
          { type: 'modify_wealth', amount: 5 },
        ],
        outcomeText: 'Your blade finds its mark.',
      }),
    );
    const step = await ctx.engine.stepAction(ctx.charId, 'Press the attack');

    expect(step.resolved).toBe(true);
    if (!step.resolved) return;
    expect(step.outcome.outcome).toBe('success');
    expect(step.outcome.playerRolled).toBe(18);
    expect(step.outcome.rollsDelta).toBe(-1); // the action spent its start-drained roll

    // Persisted character state.
    const after = ctx.engine.getCharacter(USER_ID)!;
    expect(after.wealth).toBe(before.wealth + 5);
    expect(after.rollsRemaining).toBe(2); // drained at start, charged (player rolled)
    expect(after.lastActionState).toBeNull(); // mid-action state cleared

    // Persisted item row.
    expect(ctx.engine.getItems(ctx.charId).some((i) => i.name === 'Wolf Pelt')).toBe(true);

    // Persisted action row.
    const recent = ctx.actionRepo.findRecentByCharacterId(ctx.charId, 1);
    expect(recent).toHaveLength(1);
    expect(recent[0].type).toBe('hunt');
    expect(recent[0].outcome).toBe('success');
  });

  it('failure path strips rewards but persists costs in the stored character', async () => {
    ctx = setup(() => 2); // 2 + bonus vs DC 20 → failure (not a nat-1 crit)
    const before = ctx.engine.getCharacter(USER_ID)!;
    const peltBefore = ctx.engine.getItems(ctx.charId).filter((i) => i.name === 'Trinket').length;

    ctx.llm.setDecision(firstDecision(20));
    await ctx.engine.startAction(ctx.charId, 'hunt the wolf');

    ctx.llm.setDecision(
      resolveDecision({
        mutations: [
          { type: 'add_item', name: 'Trinket', emoji: '💍', stat: 'charisma', modifier: 1, quantity: 1 }, // reward → dropped
          { type: 'modify_wealth', amount: 10 }, // reward → dropped
          { type: 'modify_health', amount: -3 }, // cost → kept
        ],
        outcomeText: 'The wolf is too quick; you stagger back, bleeding.',
      }),
    );
    const step = await ctx.engine.stepAction(ctx.charId, 'Press the attack');

    expect(step.resolved).toBe(true);
    if (!step.resolved) return;
    expect(step.outcome.outcome).toBe('failure');

    const after = ctx.engine.getCharacter(USER_ID)!;
    // Rewards stripped: no item, wealth unchanged.
    expect(ctx.engine.getItems(ctx.charId).filter((i) => i.name === 'Trinket').length).toBe(peltBefore);
    expect(after.wealth).toBe(before.wealth);
    // Costs kept: health damage applied, flat failure stamina penalty (−2) applied.
    expect(after.health).toBe(before.health - 3);
    expect(after.stamina).toBe(before.stamina - 2);
    expect(after.rollsRemaining).toBe(2); // charged — the player rolled

    expect(ctx.actionRepo.findRecentByCharacterId(ctx.charId, 1)[0].outcome).toBe('failure');
  });

  it('surfaces the persisted action id so a bug/feedback report links to it as a valid FK', async () => {
    ctx = setup(() => 18);

    ctx.llm.setDecision(firstDecision(10));
    await ctx.engine.startAction(ctx.charId, 'hunt the wolf');
    ctx.llm.setDecision(resolveDecision({ outcomeText: 'Done.' }));
    const step = await ctx.engine.stepAction(ctx.charId, 'Press the attack');

    expect(step.resolved).toBe(true);
    if (!step.resolved) return;

    // The outcome carries the row id that was just written.
    const actionRow = ctx.actionRepo.findRecentByCharacterId(ctx.charId, 1)[0];
    expect(step.outcome.actionId).toBe(actionRow.id);

    // A report submitted from that outcome stores the FK.
    ctx.engine.submitBug(ctx.charId, 'wolf clipped through the wall', step.outcome.actionId);
    const bug = getDb()
      .prepare('SELECT character_id, text, action_id FROM bug_reports ORDER BY id DESC LIMIT 1')
      .get() as { character_id: number; text: string; action_id: number | null };
    expect(bug.action_id).toBe(actionRow.id);
    expect(bug.character_id).toBe(ctx.charId);

    // An off-action report (no id) leaves the FK NULL.
    ctx.engine.submitFeedback(ctx.charId, 'general thoughts');
    const fb = getDb()
      .prepare('SELECT action_id FROM feedback ORDER BY id DESC LIMIT 1')
      .get() as { action_id: number | null };
    expect(fb.action_id).toBeNull();
  });

  it('refunds the roll on an auto-finished no-op and flags it for the footer', async () => {
    ctx = setup(() => 15);
    const before = ctx.engine.getCharacter(USER_ID)!;

    ctx.llm.setDecision(autoFinishNoop());
    const first = await ctx.engine.startAction(ctx.charId, 'look at the key');

    expect(first.outcome).toBeDefined();
    if (!first.outcome) return;
    expect(first.outcome.outcome).toBe('done');
    // Free no-op: roll kept, flagged so the footer can say "(refunded)".
    expect(first.outcome.rollRefunded).toBe(true);
    expect(first.outcome.rollsDelta).toBe(0);
    expect(ctx.engine.getCharacter(USER_ID)!.rollsRemaining).toBe(before.rollsRemaining);

    // Second no-op the same day: the daily grace is spent, so it's charged — and reported as such.
    ctx.llm.setDecision(autoFinishNoop());
    const second = await ctx.engine.startAction(ctx.charId, 'look again');
    if (!second.outcome) return;
    expect(second.outcome.rollRefunded).toBe(false);
    expect(second.outcome.rollsDelta).toBe(-1);
    expect(ctx.engine.getCharacter(USER_ID)!.rollsRemaining).toBe(before.rollsRemaining - 1);
  });

  it('charges an action that grants a roll, so a +1 grant nets to zero (not a free roll)', async () => {
    ctx = setup(() => 15);
    const before = ctx.engine.getCharacter(USER_ID)!;

    ctx.llm.setDecision(autoFinishRollGrant());
    const res = await ctx.engine.startAction(ctx.charId, 'rest a moment');

    expect(res.outcome).toBeDefined();
    if (!res.outcome) return;
    // A roll gain is world-changing → charged, not refunded.
    expect(res.outcome.rollRefunded).toBe(false);
    // +1 grant offset by the −1 action charge → net 0.
    expect(res.outcome.rollsDelta).toBe(0);
    expect(ctx.engine.getCharacter(USER_ID)!.rollsRemaining).toBe(before.rollsRemaining);
  });

  it('reports the spent roll on a bail (drained at start, never refunded)', async () => {
    ctx = setup(() => 15);
    const before = ctx.engine.getCharacter(USER_ID)!;

    ctx.llm.setDecision(firstDecision(12));
    await ctx.engine.startAction(ctx.charId, 'investigate the noise');
    const step = await ctx.engine.stepAction(ctx.charId, 'Step back');

    expect(step.resolved).toBe(true);
    if (!step.resolved) return;
    expect(step.outcome.outcome).toBe('bailed');
    // The footer must show the −1 (previously omitted for playerRolled-null bails).
    expect(step.outcome.rollsDelta).toBe(-1);
    expect(step.outcome.rollRefunded).toBeFalsy();
    expect(ctx.engine.getCharacter(USER_ID)!.rollsRemaining).toBe(before.rollsRemaining - 1);
  });

  it('resumeAction rehydrates the pending decision from the DB without a new LLM call', async () => {
    ctx = setup(() => 15);

    ctx.llm.setDecision(firstDecision(12));
    const start = await ctx.engine.startAction(ctx.charId, 'hunt the wolf');
    expect(start.outcome).toBeUndefined();
    const callsAfterStart = ctx.llm.calls.length;

    const resumed = ctx.engine.resumeAction(ctx.charId);

    expect(resumed.nextDecision.prompt).toBe(start.firstDecision.prompt);
    expect(resumed.nextDecision.options.map((o) => o.label)).toEqual(
      start.firstDecision.options.map((o) => o.label),
    );
    // Resume is a pure rehydrate — no gateway round-trip.
    expect(ctx.llm.calls.length).toBe(callsAfterStart);
  });
});
