import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, seedWorld, SEEDED_LOCATIONS, SEEDED_EDGES } from '../../src/db/migrate.js';
import { LocationRepository } from '../../src/db/repositories/location.js';
import { LocationEdgeRepository } from '../../src/db/repositories/locationEdge.js';
import { CharacterLocationRepository } from '../../src/db/repositories/characterLocation.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  seedWorld(db, SEEDED_LOCATIONS, SEEDED_EDGES);
});
afterEach(() => db.close());

function makeChar(discord: string): number {
  const u = db.prepare('INSERT INTO users (discord_user_id) VALUES (?)').run(discord);
  const c = db
    .prepare(
      `INSERT INTO player_characters (user_id, name, class, upbringing, race, alignment, day_job, stats, location)
       VALUES (?, 'Kael', 'Hunter', 'Outskirts', 'Human', 'Neutral', 'Forager', '{}', 'The Warden''s Oak')`,
    )
    .run(u.lastInsertRowid);
  return Number(c.lastInsertRowid);
}

describe('LocationEdgeRepository', () => {
  let edges: LocationEdgeRepository;
  beforeEach(() => (edges = new LocationEdgeRepository(db)));

  it('neighbours is symmetric (you can walk a road back)', () => {
    const fromOak = edges.neighbours("The Warden's Oak").map((n) => n.name);
    expect(fromOak).toEqual(expect.arrayContaining(['Town Square', 'The Forest Edge', 'The East Road']));

    // The Town Forge only appears as a child of Town Square; the reverse must surface.
    const fromForge = edges.neighbours('The Town Forge').map((n) => n.name);
    expect(fromForge).toContain('Town Square');
  });

  it('neighbours carries the edge difficulty', () => {
    const forest = edges.neighbours("The Warden's Oak").find((n) => n.name === 'The Forest Edge');
    expect(forest?.difficulty).toBe(2);
  });

  it('frontierExits returns only dangling exits with their teaser', () => {
    const exits = edges.frontierExits('The East Road');
    expect(exits).toHaveLength(1); // East Road also has a charted edge to Broken Keep — excluded
    expect(exits[0]).toMatchObject({ direction: 'NE', difficulty: 2 });
    expect(exits[0].teaser).toContain('eastern town');
  });

  it('recordEdge is idempotent on (from, direction)', () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM location_edges').get() as { n: number }).n;
    edges.recordEdge({ from: "The Warden's Oak", to: 'Somewhere Else', direction: 'N', difficulty: 1 }); // N is taken (Town Square)
    const after = (db.prepare('SELECT COUNT(*) AS n FROM location_edges').get() as { n: number }).n;
    expect(after).toBe(before);
    // The original edge is untouched.
    expect(edges.find("The Warden's Oak", 'N')?.to_location).toBe('Town Square');
  });

  it('bindFrontier binds a dangling exit exactly once (shared-rebind invariant)', () => {
    expect(edges.bindFrontier('The East Road', 'NE', 'Eastvale')).toBe(true);
    expect(edges.find('The East Road', 'NE')?.to_location).toBe('Eastvale');
    // A second crosser must NOT rebind it.
    expect(edges.bindFrontier('The East Road', 'NE', 'Somewhere Else')).toBe(false);
    expect(edges.find('The East Road', 'NE')?.to_location).toBe('Eastvale');
  });
});

describe('CharacterLocationRepository', () => {
  let cl: CharacterLocationRepository;
  let kael: number;
  beforeEach(() => {
    cl = new CharacterLocationRepository(db);
    kael = makeChar('u1');
  });

  it('recordVisit discovers a location; hasDiscovered reflects it', () => {
    expect(cl.hasDiscovered(kael, 'Town Square')).toBe(false);
    cl.recordVisit(kael, 'Town Square');
    expect(cl.hasDiscovered(kael, 'Town Square')).toBe(true);
  });

  it('a repeat visit bumps recency without duplicating the row', () => {
    cl.recordVisit(kael, 'Town Square');
    cl.recordVisit(kael, 'The Town Forge');
    // Force a distinct, far-past timestamp on Town Square, then re-visit it.
    db.prepare("UPDATE character_locations SET last_visited_at = '2000-01-01 00:00:00' WHERE character_id = ? AND location_name = 'Town Square'").run(kael);
    cl.recordVisit(kael, 'Town Square'); // must bump last_visited_at off the year-2000 value

    expect(cl.findByCharacter(kael)).toHaveLength(2); // no duplicate row
    const bumped = db.prepare("SELECT last_visited_at FROM character_locations WHERE character_id = ? AND location_name = 'Town Square'").get(kael) as { last_visited_at: string };
    expect(bumped.last_visited_at).not.toBe('2000-01-01 00:00:00'); // recency was refreshed
  });

  it('findByCharacter orders most-recently-visited first', () => {
    cl.recordVisit(kael, 'Town Square');
    cl.recordVisit(kael, 'The Town Forge');
    // Explicit timestamps so the ordering assertion is deterministic (no now() ties).
    db.prepare("UPDATE character_locations SET last_visited_at = '2026-01-01 00:00:00' WHERE character_id = ? AND location_name = 'Town Square'").run(kael);
    db.prepare("UPDATE character_locations SET last_visited_at = '2026-06-01 00:00:00' WHERE character_id = ? AND location_name = 'The Town Forge'").run(kael);

    expect(cl.findByCharacter(kael).map((r) => r.location_name)).toEqual(['The Town Forge', 'Town Square']);
  });
});

describe('LocationRepository — geometry columns', () => {
  let locs: LocationRepository;
  beforeEach(() => (locs = new LocationRepository(db)));

  it('create persists node_tier/region/emoji', () => {
    const row = locs.create({ name: 'Eastvale', nodeTier: 1, region: 'The Ashen Reach', emoji: '🏘️', isSafe: 1 });
    expect(row).toMatchObject({ node_tier: 1, region: 'The Ashen Reach', emoji: '🏘️', is_safe: 1 });
  });

  it('enrichProvisional fills geometry on a still-provisional row only', () => {
    locs.create({ name: 'Wolf Hollow', enrichmentPending: 1, emoji: '📍' });
    const ok = locs.enrichProvisional('Wolf Hollow', {
      isSafe: 0,
      description: 'A blood-soaked clearing.',
      region: 'The Ashen Reach',
      emoji: '🐺',
      nodeTier: 2,
    });
    expect(ok).toBe(true);
    const row = locs.findByName('Wolf Hollow');
    expect(row).toMatchObject({ region: 'The Ashen Reach', emoji: '🐺', node_tier: 2, enrichment_pending: 0 });

    // A second enrich is a no-op — the row is no longer provisional.
    expect(locs.enrichProvisional('Wolf Hollow', { isSafe: 1, description: 'changed' })).toBe(false);
  });
});
