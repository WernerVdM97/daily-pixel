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

// RED: tests fail because WorldEngineImpl doesn't exist yet

function huntFirstDecision(): LlmDecision {
  return {
    prompt: 'You spot deer tracks heading east into the thicket, and larger prints — wolf — north.',
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: false,
    decision: [
      { label: 'Follow deer', dcModifier: 0 },
      { label: 'Track wolf', dcModifier: 2 },
      { label: 'Bail', dcModifier: null },
    ],
  };
}

function huntSecondDecision(): LlmDecision {
  return {
    prompt: 'The thicket is dense and dry. Move slow and quiet, or push through?',
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: false,
    decision: [
      { label: 'Stalk', dcModifier: -1 },
      { label: 'Rush', dcModifier: 2 },
      { label: 'Bail', dcModifier: null },
    ],
  };
}

function huntFinalDecision(): LlmDecision {
  return {
    prompt: 'You corner your prey.',
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: true,
    decision: [{ label: 'Attack!', dcModifier: 0 }],
    mutations: [
      { type: 'modify_health' as const, amount: -2 },
    ],
    outcomeText: 'The wolf snaps at you, but your blade finds its mark.',
  };
}

function createTestChar(
  userRepo: UserRepository,
  charRepo: CharacterRepository,
): { userId: number; characterId: number } {
  const user = userRepo.create('123456789');
  const char = charRepo.create(user.id, {
    name: 'Aldric',
    class: 'Warrior',
    upbringing: 'Village',
    race: 'Human',
    alignment: 'lawful good',
    day_job: 'Blacksmith',
    stats: JSON.stringify({ physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }),
    health: 12,
    max_health: 12,
    stamina: 10,
    rolls_remaining: 2,
    location: "The Warden's Oak",
    wealth: 5,
    last_action_state: null,
  });
  return { userId: user.id, characterId: char.id };
}

describe('WorldEngineImpl — action state machine integration', () => {
  let engine: WorldEngineImpl;
  let llm: MockLlmGateway;
  let userRepo: UserRepository;
  let charRepo: CharacterRepository;
  let itemRepo: ItemRepository;
  let actionRepo: ActionRepository;
  let characterId: number;

  beforeEach(() => {
    initDb(':memory:');
    migrate(getDb());
    llm = new MockLlmGateway();
    userRepo = new UserRepository(getDb());
    charRepo = new CharacterRepository(getDb());
    itemRepo = new ItemRepository(getDb());
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
      rollD20: () => 15, // deterministic: 15 + bonus
    });
    const { characterId: cid } = createTestChar(userRepo, charRepo);
    characterId = cid;
  });

  afterEach(() => {
    closeDb();
  });

  describe('startAction', () => {
    it('returns the first decision from the LLM', async () => {
      llm.setDecision(huntFirstDecision());

      const result = await engine.startAction(characterId, 'go hunt a wolf');

      expect(result.state.rawInput).toBe('go hunt a wolf');
      expect(result.state.decisions).toEqual([]);
      expect(result.state.accumulatedDc).toBe(12);
      expect(result.firstDecision.options).toHaveLength(3);
    });

    it('auto-finishes a done, choice-less action: logs an action row and applies mutations', async () => {
      llm.setDecision({
        distilledType: 'travel', stat: 'physical', baseDc: 10,
        required: false, done: true, decision: [],
        mutations: [
          { type: 'set_location', name: 'The Forest Edge' },
          { type: 'modify_stamina', amount: 2 },
        ],
        outcomeText: 'You arrive at the forest edge.',
      });

      const result = await engine.startAction(characterId, 'walk to the forest edge');

      // Outcome returned for direct rendering (no buttons), and no mid-action state left
      expect(result.outcome).toBeDefined();
      expect(result.outcome?.outcome).toBe('done');
      expect(charRepo.findById(characterId)?.last_action_state).toBeNull();

      // Logged to the DB as a normal action row
      const actions = actionRepo.findRecentByCharacterId(characterId, 5);
      expect(actions).toHaveLength(1);
      expect(actions[0].outcome).toBe('done');
      expect(actions[0].type).toBe('travel');

      // Mutations applied (stamina clamped at 10) + a roll drained
      const char = charRepo.findById(characterId);
      expect(char?.location).toBe('The Forest Edge');
      expect(char?.stamina).toBe(10);
      expect(char?.rolls_remaining).toBe(1);
    });

    it('persists mid-action state in last_action_state', async () => {
      llm.setDecision(huntFirstDecision());

      await engine.startAction(characterId, 'go hunt a wolf');

      const char = charRepo.findById(characterId);
      expect(char?.last_action_state).not.toBeNull();
      const saved = JSON.parse(char!.last_action_state!);
      expect(saved.rawInput).toBe('go hunt a wolf');
      expect(saved.accumulatedDc).toBe(12);
      expect(saved.pendingDecision).toBeDefined();
    });

    it('drains a roll when starting', async () => {
      llm.setDecision(huntFirstDecision());

      await engine.startAction(characterId, 'go hunt a wolf');

      const char = charRepo.findById(characterId);
      expect(char?.rolls_remaining).toBe(1);
    });

    it('throws if character has no rolls remaining', async () => {
      charRepo.update(characterId, { rolls_remaining: 0 });
      llm.setDecision(huntFirstDecision());

      await expect(
        engine.startAction(characterId, 'go hunt'),
      ).rejects.toThrow('No rolls remaining');
    });

    it('throws if character does not exist', async () => {
      llm.setDecision(huntFirstDecision());

      await expect(
        engine.startAction(999, 'go hunt'),
      ).rejects.toThrow('Character not found');
    });
  });

  describe('stepAction', () => {
    it('continues the loop for a regular choice', async () => {
      llm.setDecision(huntFirstDecision());
      await engine.startAction(characterId, 'go hunt a wolf');

      llm.setDecision(huntSecondDecision());
      const result = await engine.stepAction(characterId, 'Track wolf');

      expect(result.resolved).toBe(false);
      if (!result.resolved) {
        expect(result.state.decisions).toHaveLength(1);
        expect(result.state.decisions[0].chosen).toBe('Track wolf');
        expect(result.state.accumulatedDc).toBe(14); // 12 + 2
        expect(result.nextDecision.options).toHaveLength(3);
      }
    });

    it('updates persisted state after each step', async () => {
      llm.setDecision(huntFirstDecision());
      await engine.startAction(characterId, 'go hunt a wolf');

      llm.setDecision(huntSecondDecision());
      await engine.stepAction(characterId, 'Track wolf');

      const char = charRepo.findById(characterId);
      const saved = JSON.parse(char!.last_action_state!);
      expect(saved.accumulatedDc).toBe(14);
      expect(saved.decisions).toHaveLength(1);
    });

    it('resolves as bailed on bail', async () => {
      llm.setDecision(huntFirstDecision());
      await engine.startAction(characterId, 'go hunt a wolf');

      const result = await engine.stepAction(characterId, 'Bail');

      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.outcome.outcome).toBe('bailed');
        expect(result.outcome.playerRolled).toBeNull();
      }
    });

    it('clears last_action_state on resolution', async () => {
      llm.setDecision(huntFirstDecision());
      await engine.startAction(characterId, 'go hunt a wolf');

      const result = await engine.stepAction(characterId, 'Bail');

      expect(result.resolved).toBe(true);
      const char = charRepo.findById(characterId);
      expect(char?.last_action_state).toBeNull();
    });

    it('resolves with outcome when LLM says done', async () => {
      llm.setDecision(huntFinalDecision());
      await engine.startAction(characterId, 'hunt');

      const result = await engine.stepAction(characterId, 'Attack!');

      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.outcome.distilledType).toBe('hunt');
        expect(result.outcome.outcome).toBe('success'); // d20=15 + no items >= DC 12
        expect(result.outcome.playerRolled).toBe(15);
        expect(result.outcome.mutations).toEqual([
          { type: 'modify_health', amount: -2 },
        ]);
      }
    });

    it('inserts an actions row on completion', async () => {
      llm.setDecision(huntFinalDecision());
      await engine.startAction(characterId, 'hunt');

      await engine.stepAction(characterId, 'Attack!');

      const recent = actionRepo.findRecentByCharacterId(characterId, 1);
      expect(recent).toHaveLength(1);
      expect(recent[0].type).toBe('hunt');
      expect(recent[0].outcome).toBe('success');
      expect(recent[0].raw_input).toBe('hunt');
      expect(recent[0].player_rolled).toBe(15);
    });

    it('applies mutations on resolution', async () => {
      llm.setDecision({
        ...huntFinalDecision(),
        mutations: [
          { type: 'modify_health' as const, amount: -3 },
        ],
      });
      await engine.startAction(characterId, 'hunt');

      await engine.stepAction(characterId, 'Attack!');

      const char = charRepo.findById(characterId);
      expect(char?.health).toBe(9); // 12 - 3
    });

    it('does not drain a second roll on step (already drained on start)', async () => {
      llm.setDecision({
        ...huntFinalDecision(),
        decision: [{ label: 'Attack!', dcModifier: 0 }],
      });
      await engine.startAction(characterId, 'hunt');
      const afterStart = charRepo.findById(characterId);
      expect(afterStart?.rolls_remaining).toBe(1);

      await engine.stepAction(characterId, 'Attack!');

      const afterStep = charRepo.findById(characterId);
      expect(afterStep?.rolls_remaining).toBe(1); // unchanged
    });

    it('throws if no action in progress', async () => {
      await expect(
        engine.stepAction(characterId, 'Attack!'),
      ).rejects.toThrow('No action in progress');
    });
  });

  describe('divine intervention', () => {
    it('startAction returns a Resolve option on divine intervention', async () => {
      // Both LLM calls fail — triggers divine
      vi.spyOn(llm, 'decide').mockRejectedValue(new Error('API error'));

      const result = await engine.startAction(characterId, 'go hunt');

      // Should still get a result with one option
      expect(result.firstDecision.options).toHaveLength(1);
      expect(result.firstDecision.options[0].label).toBe('Resolve');
      expect(result.firstDecision.prompt).toContain("The warden's hand");
    });

    it('startAction drains a roll on divine', async () => {
      vi.spyOn(llm, 'decide').mockRejectedValue(new Error('API error'));

      await engine.startAction(characterId, 'go hunt');

      const char = charRepo.findById(characterId);
      expect(char?.rolls_remaining).toBe(1); // drained from 2
    });

    it('stepAction resolves divine state without LLM call', async () => {
      const spy = vi.spyOn(llm, 'decide').mockRejectedValue(new Error('API error'));

      const { firstDecision } = await engine.startAction(characterId, 'go hunt');
      spy.mockClear(); // reset call count

      const result = await engine.stepAction(characterId, firstDecision.options[0].label);

      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.outcome.distilledType).toBe('__divine__');
        expect(result.outcome.playerRolled).toBeNull();
        expect(result.outcome.mutations).toEqual([]);
      }
      // No LLM calls were made during step
      expect(spy).not.toHaveBeenCalled();
    });

    it('stepAction clears last_action_state on divine', async () => {
      vi.spyOn(llm, 'decide').mockRejectedValue(new Error('API error'));

      const { firstDecision } = await engine.startAction(characterId, 'go hunt');

      await engine.stepAction(characterId, firstDecision.options[0].label);

      const char = charRepo.findById(characterId);
      expect(char?.last_action_state).toBeNull();
    });

    it('no action row is inserted on divine', async () => {
      vi.spyOn(llm, 'decide').mockRejectedValue(new Error('API error'));

      const { firstDecision } = await engine.startAction(characterId, 'go hunt');

      await engine.stepAction(characterId, firstDecision.options[0].label);

      const recent = actionRepo.findRecentByCharacterId(characterId, 1);
      expect(recent).toHaveLength(0);
    });
  });

  describe('resumeAction', () => {
    it('returns saved state with pending decision', async () => {
      llm.setDecision(huntFirstDecision());
      const { state } = await engine.startAction(characterId, 'hunt');

      const result = engine.resumeAction(characterId);

      expect(result.state.rawInput).toBe(state.rawInput);
      expect(result.state.decisions).toEqual([]);
      expect(result.nextDecision.options).toHaveLength(3);
    });

    it('throws if no saved state', () => {
      expect(() => engine.resumeAction(characterId)).toThrow('No action to resume');
    });

    it('resumes mid-action after disconnect', async () => {
      // Start + step once, simulating disconnect before resolution
      llm.setDecision(huntFirstDecision());
      await engine.startAction(characterId, 'go hunt a wolf');

      llm.setDecision(huntSecondDecision());
      const r1 = await engine.stepAction(characterId, 'Track wolf');
      expect(r1.resolved).toBe(false);

      // Simulate resume (would be a new HTTP request in split architecture)
      const resumed = engine.resumeAction(characterId);
      expect(resumed.state.decisions).toHaveLength(1);
      expect(resumed.state.decisions[0].chosen).toBe('Track wolf');
      expect(resumed.state.accumulatedDc).toBe(14);
      expect(resumed.nextDecision.options).toHaveLength(3);

      // Continue from resumed state — pick a choice from the resumed pendingDecision
      llm.setDecision(huntFinalDecision());
      const r2 = await engine.stepAction(characterId, 'Stalk');  // from huntSecondDecision
      expect(r2.resolved).toBe(true);
    });
  });
});
