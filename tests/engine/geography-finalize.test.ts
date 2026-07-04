import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, seedWorld, SEEDED_LOCATIONS, SEEDED_EDGES } from '../../src/db/migrate.js';
import { LocationRepository } from '../../src/db/repositories/location.js';
import { LocationEdgeRepository } from '../../src/db/repositories/locationEdge.js';
import { createGeographyFinalize } from '../../src/engine/geography-finalize.js';
import type { MutationContext } from '../../src/engine/action/mutations.js';
import type { WorldMutation } from '../../src/engine/WorldEngine.js';

// Stage 2 T5a — standalone factory test over a real `:memory:` seeded world, mirroring
// tests/db/repos-geography.test.ts's setup. Proves the extraction is behaviour-preserving by
// exercising the same mint/route/validate logic that used to live inline on WorldEngineImpl.

let db: Database.Database;
let locationRepo: LocationRepository;
let edgeRepo: LocationEdgeRepository;
let finalize: ReturnType<typeof createGeographyFinalize>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  seedWorld(db, SEEDED_LOCATIONS, SEEDED_EDGES);
  locationRepo = new LocationRepository(db);
  edgeRepo = new LocationEdgeRepository(db);
  finalize = createGeographyFinalize({ locationRepo, edgeRepo });
});
afterEach(() => db.close());

const KNOWN = SEEDED_LOCATIONS.map((l) => l.name);

function baseCtx(location: string, knownLocations: string[] = KNOWN): MutationContext {
  return {
    currentHealth: 10,
    maxHealth: 10,
    stamina: 10,
    maxStamina: 10,
    wealth: 0,
    rollsRemaining: 1,
    location,
    knownLocations,
  };
}

describe('createGeographyFinalize', () => {
  it('keeps a move_to a charted, reachable neighbour', () => {
    const proposed: WorldMutation[] = [{ type: 'move_to', name: 'Town Square' }];
    const result = finalize(proposed, baseCtx("The Warden's Oak"));

    expect(result.mutations).toEqual([{ type: 'move_to', name: 'Town Square' }]);
    expect(result.minted).toEqual([]);
  });

  it('drops an unreachable/unknown move_to with a console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const proposed: WorldMutation[] = [{ type: 'move_to', name: 'Nowhereville' }];
    const result = finalize(proposed, baseCtx("The Warden's Oak"));

    expect(result.mutations).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping move_to to unreachable/unknown "Nowhereville"'),
    );
    warnSpy.mockRestore();
  });

  it('mints and binds a cross_frontier on a real unbound frontier exit', () => {
    // "The East Road" NE is a real unbound frontier (assets/world/edges.yml).
    const proposed: WorldMutation[] = [{ type: 'cross_frontier', direction: 'NE', name: 'Eastvale' }];
    const result = finalize(proposed, baseCtx('The East Road'));

    expect(result.minted).toEqual(['Eastvale']);
    expect(result.mutations).toEqual([{ type: 'cross_frontier', direction: 'NE', name: 'Eastvale' }]);

    expect(locationRepo.findByName('Eastvale')).toBeDefined();
    expect(edgeRepo.find('The East Road', 'NE')?.to_location).toBe('Eastvale');
  });

  it('still runs collapse+validate — a malformed mutation is dropped', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const proposed: WorldMutation[] = [
      { type: 'modify_stamina', amount: -1 }, // valid — kept
      { type: 'remove_npc', npcId: 0 }, // shape-invalid — dropped
    ];
    const result = finalize(proposed, baseCtx("The Warden's Oak"));

    expect(result.mutations).toEqual([{ type: 'modify_stamina', amount: -1 }]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[engine] Dropping invalid mutations:',
      expect.stringContaining('remove_npc requires a positive integer'),
    );
    warnSpy.mockRestore();
  });
});
