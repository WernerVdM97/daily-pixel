/**
 * 30-minute timeout auto-fail runtime hook (S7).
 *
 * Validates that mid-action state older than 30 minutes is auto-failed
 * on resumeAction() and stepAction(), and that sub-threshold state is
 * left intact.
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

const DISCORD_USER_ID = 'timeout-test-user';

function huntDecision1(): LlmDecision {
  return {
    prompt: 'You spot deer tracks heading east into the thicket.',
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: false,
    decision: [
      { label: 'Follow deer', dcModifier: 0 },
      { label: 'Track the wolf', dcModifier: 2 },
      { label: 'Bail', dcModifier: null },
    ],
  };
}

function huntDecisionFinal(): LlmDecision {
  return {
    prompt: 'The deer rounds a bend.',
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: true,
    decision: [{ label: 'Attack!', dcModifier: 0 }],
    mutations: [],
    outcomeText: 'The deer escapes into the thicket.',
  };
}

describe('30-min action timeout', () => {
  let engine: WorldEngineImpl;
  let llm: MockLlmGateway;
  let actionRepo: ActionRepository;
  let charRepo: CharacterRepository;
  let characterId: number;

  beforeEach(() => {
    initDb(':memory:');
    migrate(getDb());
    llm = new MockLlmGateway();
    const userRepo = new UserRepository(getDb());
    charRepo = new CharacterRepository(getDb());
    const itemRepo = new ItemRepository(getDb());
    actionRepo = new ActionRepository(getDb());
    const npcRepo = new NpcRepository(getDb());

    engine = new WorldEngineImpl({
      db: getDb(),
      llm,
      userRepo,
      charRepo,
      itemRepo,
      actionRepo,
      npcRepo,
      rollD20: () => 15,
      dayJobIncome: { Blacksmith: 10 },
    });

    // Create character
    const char = engine.createCharacter(DISCORD_USER_ID, {
      name: 'TimeoutTest',
      class: 'Warrior',
      upbringing: 'Soldier',
      race: 'Human',
      alignment: 'lawful good',
      dayJob: 'Blacksmith',
    });
    characterId = char.id;
  });

  afterEach(() => {
    closeDb();
  });

  it('allows non-stale action in resumeAction', async () => {
    llm.setDecision(huntDecision1());
    await engine.startAction(characterId, 'hunt a deer');

    // State was just persisted — should not be stale
    const resume = engine.resumeAction(characterId);
    expect(resume.state.rawInput).toBe('hunt a deer');
    expect(resume.nextDecision.options).toHaveLength(3);
  });

  it('allows non-stale action in stepAction', async () => {
    llm.setDecision(huntDecision1());
    await engine.startAction(characterId, 'hunt a deer');

    llm.setDecision(huntDecisionFinal());
    const step = await engine.stepAction(characterId, 'Follow deer');
    expect(step.resolved).toBe(true);
    if (step.resolved) {
      expect(step.outcome.outcome).toBe('success');
    }
  });

  /** Rewind the persisted action state past the 30-min stale threshold. */
  function makeStale(): void {
    const row = charRepo.findById(characterId);
    const state = JSON.parse(row!.last_action_state!);
    state.lastActionAt = Date.now() - 31 * 60 * 1000; // 31 minutes ago
    charRepo.update(characterId, { last_action_state: JSON.stringify(state) });
  }

  it('D2: resumeAction surfaces an in-voice server-timeout message and refunds the roll', async () => {
    llm.setDecision(huntDecision1());
    await engine.startAction(characterId, 'hunt a deer');
    const spent = charRepo.findById(characterId)!.rolls_remaining; // 3 → 2

    makeStale();

    // The throw carries the player-facing message (not a bare "timed out") and
    // names it as a server-side delay.
    expect(() => engine.resumeAction(characterId)).toThrow(/slipped away/i);

    // Recorded as timed_out with the in-voice narrative.
    const recent = actionRepo.findRecentByCharacterId(characterId, 1);
    expect(recent).toHaveLength(1);
    expect(recent[0].outcome).toBe('timed_out');

    const updatedRow = charRepo.findById(characterId)!;
    expect(updatedRow.last_action_state).toBeNull();
    // First timeout of the day → roll refunded + day stamped.
    expect(updatedRow.rolls_remaining).toBe(spent + 1);
    expect(updatedRow.last_timeout_refund_day).toBe(1);
  });

  it('D2: stepAction returns a resolved timed_out outcome (no throw) and refunds once/day', async () => {
    llm.setDecision(huntDecision1());
    await engine.startAction(characterId, 'hunt a deer');
    const spent = charRepo.findById(characterId)!.rolls_remaining; // 2

    makeStale();

    const result = await engine.stepAction(characterId, 'Follow deer');
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.outcome.outcome).toBe('timed_out');
      expect(result.outcome.mutations).toEqual([]); // no mutations applied
      expect(result.outcome.outcomeText).toMatch(/slipped away/i);
      expect(result.outcome.outcomeText).toMatch(/refunded/i);
      // Refunded → net zero, footer shows "(refunded)".
      expect(result.outcome.rollRefunded).toBe(true);
      expect(result.outcome.rollsDelta).toBe(0);
    }

    const recent = actionRepo.findRecentByCharacterId(characterId, 1);
    expect(recent[0].outcome).toBe('timed_out');

    const updatedRow = charRepo.findById(characterId)!;
    expect(updatedRow.last_action_state).toBeNull();
    expect(updatedRow.rolls_remaining).toBe(spent + 1); // refunded
    expect(updatedRow.last_timeout_refund_day).toBe(1);
  });

  it('D2: a second timeout the same day keeps the roll spent', async () => {
    // First timeout — refunded.
    llm.setDecision(huntDecision1());
    await engine.startAction(characterId, 'hunt a deer');
    makeStale();
    await engine.stepAction(characterId, 'Follow deer');
    const afterFirst = charRepo.findById(characterId)!.rolls_remaining;

    // Second action + timeout, same day — the freebie is gone, roll stays spent.
    llm.setDecision(huntDecision1());
    await engine.startAction(characterId, 'hunt again'); // drains 1
    const spentAgain = charRepo.findById(characterId)!.rolls_remaining;
    makeStale();
    const result = await engine.stepAction(characterId, 'Follow deer');

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.outcome.outcome).toBe('timed_out');
      expect(result.outcome.outcomeText).toMatch(/spent/i);
      // Not refunded → the start-drained roll stays spent, reported as −1.
      expect(result.outcome.rollRefunded).toBe(false);
      expect(result.outcome.rollsDelta).toBe(-1);
    }
    // No refund this time.
    expect(charRepo.findById(characterId)!.rolls_remaining).toBe(spentAgain);
    expect(afterFirst).toBeGreaterThan(spentAgain); // sanity: first was refunded
  });

  it('does not fail state without lastActionAt (pre-S7 backward compat)', async () => {
    llm.setDecision(huntDecision1());
    await engine.startAction(characterId, 'hunt a deer');

    // Remove lastActionAt from persisted state — simulates pre-S7 state
    const row = charRepo.findById(characterId);
    const state = JSON.parse(row!.last_action_state!);
    delete state.lastActionAt;
    charRepo.update(characterId, { last_action_state: JSON.stringify(state) });

    // Should NOT throw — backward-compatible with old state
    const resume = engine.resumeAction(characterId);
    expect(resume.state.rawInput).toBe('hunt a deer');
  });

  it('does not fail state just under 30 minutes old', async () => {
    llm.setDecision(huntDecision1());
    await engine.startAction(characterId, 'hunt a deer');

    // Set lastActionAt to 29 minutes ago — should not be stale
    const row = charRepo.findById(characterId);
    const state = JSON.parse(row!.last_action_state!);
    state.lastActionAt = Date.now() - 29 * 60 * 1000; // 29 minutes ago
    charRepo.update(characterId, { last_action_state: JSON.stringify(state) });

    // Should succeed
    const resume = engine.resumeAction(characterId);
    expect(resume.state.rawInput).toBe('hunt a deer');
  });
});
