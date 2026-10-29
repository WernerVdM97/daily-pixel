import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorldEngineImpl } from '../../src/engine/WorldEngineImpl.js';
import { MockPipelineGateway } from '../helpers/MockPipelineGateway.js';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { migrate, seedWorld, SEEDED_LOCATIONS, SEEDED_EDGES } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import { ItemRepository } from '../../src/db/repositories/item.js';
import { ActionRepository } from '../../src/db/repositories/action.js';
import { NpcRepository } from '../../src/db/repositories/npc.js';

/** A `last_action_state` column cut off mid-value — what a corrupt or truncated write leaves
 *  behind. Every read of it must degrade to "no state" rather than throw a SyntaxError. */
const TRUNCATED_STATE = '{"actionType":"combat","lastDecideResult":';

describe('WorldEngineImpl — an unreadable persisted action state reads as no state', () => {
  let engine: WorldEngineImpl;
  let charRepo: CharacterRepository;
  let characterId: number;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    charRepo = new CharacterRepository(getDb());
    engine = new WorldEngineImpl({
      db: getDb(),
      userRepo: new UserRepository(getDb()),
      charRepo,
      itemRepo: new ItemRepository(getDb()),
      actionRepo: new ActionRepository(getDb()),
      npcRepo: new NpcRepository(getDb()),
      pipelineLlmGateway: new MockPipelineGateway(),
      rollD20: () => 15,
    });
    characterId = engine.createCharacter('u1', {
      name: 'Kael', class: 'Hunter', upbringing: 'Outskirts',
      race: 'Human', alignment: 'Neutral', dayJob: 'Forager',
    }).id;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    closeDb();
  });

  it('stepAction throws the mapped "no action" message, naming the column once', async () => {
    charRepo.update(characterId, { last_action_state: TRUNCATED_STATE });

    await expect(engine.stepAction(characterId, 'Attack')).rejects.toThrow('No action in progress');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('last_action_state');
  });

  it('resumeAction throws the mapped "no action to resume" message', () => {
    charRepo.update(characterId, { last_action_state: TRUNCATED_STATE });

    expect(() => engine.resumeAction(characterId)).toThrow('No action to resume');
  });

  it('resolvePendingChoice falls back to the no-state answers instead of throwing', () => {
    charRepo.update(characterId, { last_action_state: TRUNCATED_STATE });

    expect(engine.resolvePendingChoice(characterId, { kind: 'option', index: 0 })).toBeNull();
    expect(engine.resolvePendingChoice(characterId, { kind: 'bail' })).toBe('Bail');
  });
});
