import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorldEngineImpl } from '../../src/engine/WorldEngineImpl.js';
import { MockPipelineGateway } from '../helpers/MockPipelineGateway.js';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { migrate, seedWorld, SEEDED_LOCATIONS, SEEDED_EDGES } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import { ItemRepository } from '../../src/db/repositories/item.js';
import { ActionRepository } from '../../src/db/repositories/action.js';
import { NpcRepository } from '../../src/db/repositories/npc.js';
import { CharacterLocationRepository } from '../../src/db/repositories/characterLocation.js';

describe('WorldEngineImpl — commuteToWorkplace (M0)', () => {
  let engine: WorldEngineImpl;
  let charRepo: CharacterRepository;
  let charLoc: CharacterLocationRepository;
  let characterId: number;

  const WORKPLACE = 'The Forest Edge';

  beforeEach(() => {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    const pipelineGateway = new MockPipelineGateway();
    charRepo = new CharacterRepository(getDb());
    charLoc = new CharacterLocationRepository(getDb());
    engine = new WorldEngineImpl({
      db: getDb(),
      userRepo: new UserRepository(getDb()),
      charRepo,
      itemRepo: new ItemRepository(getDb()),
      actionRepo: new ActionRepository(getDb()),
      npcRepo: new NpcRepository(getDb()),
      pipelineLlmGateway: pipelineGateway,
      rollD20: () => 15,
    });
    const char = engine.createCharacter('u1', {
      name: 'Kael', class: 'Hunter', upbringing: 'Outskirts',
      race: 'Human', alignment: 'Neutral', dayJob: 'Forager',
    });
    characterId = char.id;
  });

  afterEach(() => closeDb());

  it('moves from the Oak to the workplace for -1 stamina and records the visit', () => {
    const before = engine.getCharacter('u1')!;
    expect(before.location).toBe("The Warden's Oak");
    expect(before.stamina).toBe(10);

    const result = engine.commuteToWorkplace(characterId, WORKPLACE);

    expect(result).toEqual({ to: WORKPLACE, stamina: 9 });
    const after = engine.getCharacter('u1')!;
    expect(after.location).toBe(WORKPLACE);
    expect(after.stamina).toBe(9);
    expect(charLoc.hasDiscovered(characterId, WORKPLACE)).toBe(true);
  });

  it('floors stamina at 0 rather than going negative', () => {
    charRepo.update(characterId, { stamina: 0 });

    const result = engine.commuteToWorkplace(characterId, WORKPLACE);

    expect(result).toEqual({ to: WORKPLACE, stamina: 0 });
    const after = engine.getCharacter('u1')!;
    expect(after.location).toBe(WORKPLACE);
    expect(after.stamina).toBe(0);
  });

  it('is a no-op when not standing at the Oak', () => {
    charRepo.update(characterId, { location: 'Town Square' });

    const result = engine.commuteToWorkplace(characterId, WORKPLACE);

    expect(result).toBeNull();
    const after = engine.getCharacter('u1')!;
    expect(after.location).toBe('Town Square');
    expect(after.stamina).toBe(10);
  });

  it('is a no-op when workplace is null', () => {
    const result = engine.commuteToWorkplace(characterId, null);

    expect(result).toBeNull();
    const after = engine.getCharacter('u1')!;
    expect(after.location).toBe("The Warden's Oak");
    expect(after.stamina).toBe(10);
  });

  it('is a no-op when the workplace equals the current location (the Oak)', () => {
    const result = engine.commuteToWorkplace(characterId, "The Warden's Oak");

    expect(result).toBeNull();
    const after = engine.getCharacter('u1')!;
    expect(after.location).toBe("The Warden's Oak");
    expect(after.stamina).toBe(10);
  });
});
