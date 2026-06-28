import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorldEngineImpl } from '../../src/engine/WorldEngineImpl.js';
import { MockLlmGateway } from '../../src/llm/MockLlmGateway.js';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { migrate, seedWorld, SEEDED_LOCATIONS, SEEDED_EDGES } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import { ItemRepository } from '../../src/db/repositories/item.js';
import { ActionRepository } from '../../src/db/repositories/action.js';
import { NpcRepository } from '../../src/db/repositories/npc.js';
import { CharacterLocationRepository } from '../../src/db/repositories/characterLocation.js';

describe('WorldEngineImpl — getDiscoveredGraph + routeBetween', () => {
  let engine: WorldEngineImpl;
  let charRepo: CharacterRepository;
  let charLoc: CharacterLocationRepository;
  let characterId: number;

  beforeEach(() => {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES); // VITEST skips auto-seed; do it explicitly
    const userRepo = new UserRepository(getDb());
    charRepo = new CharacterRepository(getDb());
    charLoc = new CharacterLocationRepository(getDb());
    engine = new WorldEngineImpl({
      db: getDb(),
      llm: new MockLlmGateway(),
      userRepo,
      charRepo,
      itemRepo: new ItemRepository(getDb()),
      actionRepo: new ActionRepository(getDb()),
      npcRepo: new NpcRepository(getDb()),
      rollD20: () => 15,
    });
    const user = userRepo.create('u1');
    const char = charRepo.create(user.id, {
      name: 'Kael', class: 'Hunter', upbringing: 'Outskirts',
      race: 'Human', alignment: 'Neutral', day_job: 'Forager', stats: '{}',
    });
    characterId = char.id;
  });

  afterEach(() => closeDb());

  describe('routeBetween', () => {
    it('costs Σ difficulty over the seeded graph', () => {
      // Oak →N Town Square (1) →E Town Forge (1) = 2
      expect(engine.routeBetween("The Warden's Oak", 'The Town Forge')).toEqual({
        path: ["The Warden's Oak", 'Town Square', 'The Town Forge'],
        cost: 2,
      });
    });

    it('weights harsh terrain (Oak →S Forest Edge →S Dark Pines = 2 + 3)', () => {
      expect(engine.routeBetween("The Warden's Oak", 'The Dark Pines')?.cost).toBe(5);
    });

    it('returns null for an uncharted destination', () => {
      expect(engine.routeBetween("The Warden's Oak", 'Atlantis')).toBeNull();
    });
  });

  describe('getDiscoveredGraph', () => {
    it('masks the shared graph to what the player has discovered', () => {
      charLoc.recordVisit(characterId, "The Warden's Oak");
      charLoc.recordVisit(characterId, 'Town Square');

      const g = engine.getDiscoveredGraph(characterId);
      const names = g.nodes.map((n) => n.name).sort();
      expect(names).toEqual(["The Warden's Oak", 'Town Square']);

      // The Oak→Town Square edge is between two discovered nodes → included.
      expect(g.edges.some((e) => e.from === "The Warden's Oak" && e.to === 'Town Square')).toBe(true);
      // Town Square→Town Forge is NOT (Forge undiscovered) → excluded.
      expect(g.edges.some((e) => e.to === 'The Town Forge')).toBe(false);
    });

    it('always includes the current location even before it is recorded', () => {
      // No recordVisit calls; character still starts at the Oak.
      const g = engine.getDiscoveredGraph(characterId);
      expect(g.current).toBe("The Warden's Oak");
      expect(g.nodes.map((n) => n.name)).toContain("The Warden's Oak");
    });

    it('surfaces frontier exits from discovered nodes', () => {
      charLoc.recordVisit(characterId, 'The East Road');
      const g = engine.getDiscoveredGraph(characterId);
      const frontier = g.frontiers.find((f) => f.from === 'The East Road');
      expect(frontier).toBeDefined();
      expect(frontier?.teaser).toContain('eastern town');
    });

    it('carries node geometry (emoji, tier, region, safety) for the render', () => {
      charLoc.recordVisit(characterId, "The Warden's Oak");
      const oak = engine.getDiscoveredGraph(characterId).nodes.find((n) => n.name === "The Warden's Oak");
      expect(oak).toMatchObject({ emoji: '🌳', nodeTier: 0, region: 'The Vale', isSafe: true });
    });
  });
});
