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

describe('WorldEngineImpl — visit recording + location_name (§6)', () => {
  let engine: WorldEngineImpl;
  let pipelineGateway: MockPipelineGateway;
  let charLoc: CharacterLocationRepository;
  let characterId: number;

  function setTravelDecideEmpty(): void {
    pipelineGateway.setDecideResponse(() => ({
      result: { distilledType: 'travel', stat: 'physical', baseDc: 10, required: false, decision: [] },
      callId: 0,
    }));
  }

  function setResolveMutate(mutations: unknown[]): void {
    pipelineGateway.setResolveMutateResponse(() => ({ result: { mutations }, callId: 0 }));
  }

  function setResolveNarrate(outcomeText: string): void {
    pipelineGateway.setResolveNarrateResponse(() => ({ result: { outcomeText }, callId: 0 }));
  }

  beforeEach(() => {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    pipelineGateway = new MockPipelineGateway();
    charLoc = new CharacterLocationRepository(getDb());
    engine = new WorldEngineImpl({
      db: getDb(),
      userRepo: new UserRepository(getDb()),
      charRepo: new CharacterRepository(getDb()),
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

  it('seeds the home Vale as discovered for a new character', () => {
    const discovered = charLoc.findByCharacter(characterId).map((r) => r.location_name);
    expect(discovered).toContain("The Warden's Oak");
    expect(discovered).toContain('Town Square');
    expect(discovered).toContain('The Town Forge');
    // A node in another region would NOT be pre-discovered (fog-of-war).
    expect(discovered).not.toContain('Some Far Place');
  });

  it('records a visit to the destination on a resolved travel', async () => {
    setTravelDecideEmpty();
    setResolveMutate([{ type: 'set_location', name: 'The Forest Edge' }]);
    setResolveNarrate('You reach the forest edge.');

    await engine.startAction(characterId, 'head to the forest edge');

    expect(engine.getCharacter('u1')?.location).toBe('The Forest Edge');
    expect(charLoc.hasDiscovered(characterId, 'The Forest Edge')).toBe(true);
  });

  it('first crosser mints + binds; a second crosser arrives at the same shared place', async () => {
    const { CharacterRepository } = await import('../../src/db/repositories/character.js');
    const { LocationEdgeRepository } = await import('../../src/db/repositories/locationEdge.js');
    const { LocationRepository } = await import('../../src/db/repositories/location.js');
    const charRepo = new CharacterRepository(getDb());
    charRepo.update(characterId, { location: 'The East Road' });

    setTravelDecideEmpty();
    setResolveMutate([{ type: 'cross_frontier', direction: 'NE', name: 'Eastvale' }]);
    setResolveNarrate('The road opens onto Eastvale.');
    await engine.startAction(characterId, 'follow the road east');

    const edges = new LocationEdgeRepository(getDb());
    expect(edges.find('The East Road', 'NE')!.to_location).toBe('Eastvale');
    expect(new LocationRepository(getDb()).findByName('Eastvale')).toBeDefined();

    // A second character crosses the SAME (now-bound) exit with a different proposed name…
    const u2 = engine.createCharacter('u2', {
      name: 'Bryn', class: 'Hunter', upbringing: 'Outskirts', race: 'Human', alignment: 'Neutral', dayJob: 'Forager',
    });
    charRepo.update(u2.id, { location: 'The East Road' });
    setResolveMutate([{ type: 'cross_frontier', direction: 'NE', name: 'Some Other Name' }]);
    await engine.startAction(u2.id, 'follow the road east');

    // …and arrives at the shared Eastvale — NOT a duplicate.
    expect(engine.getCharacter('u2')?.location).toBe('Eastvale');
    expect(new LocationRepository(getDb()).findByName('Some Other Name')).toBeUndefined();
  });

  it('drops a cross_frontier with no exit in that direction (no mint, no move)', async () => {
    const { LocationRepository } = await import('../../src/db/repositories/location.js');
    // The Oak has no edge to the SE — nothing to cross there.
    setTravelDecideEmpty();
    setResolveMutate([{ type: 'cross_frontier', direction: 'SE', name: 'Nowhere' }]);
    setResolveNarrate('You wander off.');
    await engine.startAction(characterId, 'wander southeast');

    expect(new LocationRepository(getDb()).findByName('Nowhere')).toBeUndefined();
    expect(engine.getCharacter('u1')?.location).toBe("The Warden's Oak"); // stayed put
  });

  it('stamps actions.location_name with the ORIGIN, not the destination', async () => {
    setTravelDecideEmpty();
    setResolveMutate([{ type: 'set_location', name: 'The Forest Edge' }]);
    setResolveNarrate('You set out from the Oak.');

    await engine.startAction(characterId, 'head to the forest edge');

    const row = getDb().prepare('SELECT location_name FROM actions WHERE character_id = ? ORDER BY id DESC LIMIT 1').get(characterId) as
      { location_name: string | null };
    expect(row.location_name).toBe("The Warden's Oak"); // where they stood when they acted
  });
});
