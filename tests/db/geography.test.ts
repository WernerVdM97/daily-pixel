import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  runMigrations,
  seedWorld,
  backfillLegacyWorld,
  SEEDED_LOCATIONS,
  SEEDED_EDGES,
} from '../../src/db/migrate.js';

const SEED_NAMES = SEEDED_LOCATIONS.map((l) => l.name);

/** Insert a character (with its user) and return its id. */
function makeChar(db: Database.Database, discord: string, name: string, location: string): number {
  const u = db.prepare('INSERT INTO users (discord_user_id) VALUES (?)').run(discord);
  const c = db
    .prepare(
      `INSERT INTO player_characters (user_id, name, class, upbringing, race, alignment, day_job, stats, location)
       VALUES (?, ?, 'Hunter', 'Outskirts', 'Human', 'Neutral', 'Forager', '{}', ?)`,
    )
    .run(u.lastInsertRowid, name, location);
  return Number(c.lastInsertRowid);
}

/** Append an action whose applied_mutations is a single set_location to `to`. */
function addMove(db: Database.Database, charId: number, to: string): void {
  db.prepare(
    `INSERT INTO actions (character_id, raw_input, type, decisions_json, final_dc, outcome, applied_mutations)
     VALUES (?, 'go', 'travel', '[]', 0, 'success', ?)`,
  ).run(charId, JSON.stringify([{ type: 'set_location', name: to }]));
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db); // structural only; seeding is skipped under VITEST in migrate()
});

afterEach(() => db.close());

describe('geography migration — structure', () => {
  it('adds geometry columns to locations', () => {
    const cols = (db.prepare("PRAGMA table_info('locations')").all() as { name: string }[]).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['node_tier', 'region', 'emoji', 'created_by_action_id']));
  });

  it('adds location_name to actions', () => {
    const cols = (db.prepare("PRAGMA table_info('actions')").all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('location_name');
  });

  it('creates location_edges keyed by (from_location, direction)', () => {
    const pk = (db.prepare("PRAGMA table_info('location_edges')").all() as { name: string; pk: number }[])
      .filter(c => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map(c => c.name);
    expect(pk).toEqual(['from_location', 'direction']);
  });

  it('creates character_locations keyed by (character_id, location_name)', () => {
    const pk = (db.prepare("PRAGMA table_info('character_locations')").all() as { name: string; pk: number }[])
      .filter(c => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map(c => c.name);
    expect(pk).toEqual(['character_id', 'location_name']);
  });
});

describe('seedWorld — the home Vale', () => {
  beforeEach(() => seedWorld(db, SEEDED_LOCATIONS, SEEDED_EDGES));

  it('roots the Vale at the Oak (node_tier 0)', () => {
    const oak = db.prepare('SELECT node_tier, region, emoji FROM locations WHERE name = ?').get("The Warden's Oak") as
      { node_tier: number; region: string; emoji: string };
    expect(oak.node_tier).toBe(0);
    expect(oak.region).toBe('The Vale');
    expect(oak.emoji).toBe('🌳');
  });

  it('gives every seed node geometry (tier/region/emoji set, none NULL)', () => {
    const missing = db
      .prepare('SELECT name FROM locations WHERE region IS NULL OR emoji IS NULL OR node_tier IS NULL')
      .all() as { name: string }[];
    expect(missing).toEqual([]);
  });

  it('wires edges off the Oak', () => {
    const fromOak = db.prepare('SELECT COUNT(*) AS n FROM location_edges WHERE from_location = ?').get("The Warden's Oak") as { n: number };
    expect(fromOak.n).toBeGreaterThanOrEqual(5);
  });

  it('seeds exactly three named frontier exits (to_location IS NULL, with a teaser)', () => {
    const frontiers = db.prepare('SELECT from_location, direction, teaser FROM location_edges WHERE to_location IS NULL').all() as
      { from_location: string; direction: string; teaser: string }[];
    expect(frontiers).toHaveLength(3);
    expect(frontiers.every(f => f.teaser && f.teaser.trim() !== '')).toBe(true);
  });
});

describe('seedWorld — idempotency', () => {
  it('re-running inserts nothing new', () => {
    seedWorld(db, SEEDED_LOCATIONS, SEEDED_EDGES);
    const count = () => ({
      locs: (db.prepare('SELECT COUNT(*) AS n FROM locations').get() as { n: number }).n,
      edges: (db.prepare('SELECT COUNT(*) AS n FROM location_edges').get() as { n: number }).n,
    });
    const first = count();
    seedWorld(db, SEEDED_LOCATIONS, SEEDED_EDGES);
    expect(count()).toEqual(first);
  });

  it('does not reset a frontier exit already bound by a crosser', () => {
    seedWorld(db, SEEDED_LOCATIONS, SEEDED_EDGES);
    // Simulate a player crossing the eastern-town frontier: bind its destination.
    db.prepare("UPDATE location_edges SET to_location = 'Eastvale' WHERE from_location = 'The East Road' AND to_location IS NULL")
      .run();
    seedWorld(db, SEEDED_LOCATIONS, SEEDED_EDGES); // re-seed must not clobber the binding
    const bound = db.prepare("SELECT to_location FROM location_edges WHERE from_location = 'The East Road' AND direction = 'NE'").get() as { to_location: string | null };
    expect(bound.to_location).toBe('Eastvale');
  });

  it('sets geometry on a pre-existing bare row without clobbering its description', () => {
    // The Oak is seeded bare by schema.sql (node_tier defaults to 2); seedWorld
    // must promote it to tier 0 while leaving its original description intact.
    const before = db.prepare('SELECT node_tier FROM locations WHERE name = ?').get("The Warden's Oak") as { node_tier: number };
    expect(before.node_tier).toBe(2); // default from the ALTER, geometry not yet applied

    seedWorld(db, SEEDED_LOCATIONS, SEEDED_EDGES);

    const oak = db.prepare('SELECT description, node_tier FROM locations WHERE name = ?').get("The Warden's Oak") as
      { description: string; node_tier: number };
    expect(oak.node_tier).toBe(0);
    expect(oak.description).toContain('ancient oak');
  });
});

describe('backfillLegacyWorld — prod one-shot', () => {
  beforeEach(() => {
    seedWorld(db, SEEDED_LOCATIONS, SEEDED_EDGES);
    // Two legacy off-map locations, lazily created in prod (name only, no geometry).
    db.prepare("INSERT INTO locations (name) VALUES ('Wolf Hollow')").run();
    db.prepare("INSERT INTO locations (name) VALUES ('The Sunken Road')").run();
  });

  it('reconstructs a character visited set + off-map geometry + shared edges', () => {
    const kael = makeChar(db, 'u1', 'Kael', 'Wolf Hollow'); // current location is off-map
    addMove(db, kael, 'The Forest Edge'); // seed node (Oak→Forest Edge already a seeded edge)
    addMove(db, kael, 'Wolf Hollow'); // off-map
    addMove(db, kael, 'The Sunken Road'); // off-map

    backfillLegacyWorld(db, SEED_NAMES);

    // Discovery: home cluster (all seed) + the two off-map nodes.
    const discovered = (db.prepare('SELECT location_name FROM character_locations WHERE character_id = ?').all(kael) as
      { location_name: string }[]).map((r) => r.location_name).sort();
    for (const n of SEED_NAMES) expect(discovered).toContain(n);
    expect(discovered).toContain('Wolf Hollow');
    expect(discovered).toContain('The Sunken Road');

    // Off-map node flagged for cartographer; seed node untouched.
    const wolf = db.prepare('SELECT node_tier, emoji, enrichment_pending FROM locations WHERE name = ?').get('Wolf Hollow') as
      { node_tier: number; emoji: string; enrichment_pending: number };
    expect(wolf).toMatchObject({ node_tier: 2, emoji: '📍', enrichment_pending: 1 });
    const forest = db.prepare('SELECT emoji, enrichment_pending FROM locations WHERE name = ?').get('The Forest Edge') as
      { emoji: string; enrichment_pending: number };
    expect(forest).toMatchObject({ emoji: '🌿', enrichment_pending: 0 });

    // Scraped transitions become shared edges (Forest Edge→Wolf Hollow→Sunken Road).
    const connects = (a: string, b: string) =>
      db.prepare('SELECT 1 FROM location_edges WHERE from_location = ? AND to_location = ?').get(a, b);
    expect(connects('The Forest Edge', 'Wolf Hollow')).toBeDefined();
    expect(connects('Wolf Hollow', 'The Sunken Road')).toBeDefined();
  });

  it('does not duplicate an already-seeded edge (Oak→Forest Edge)', () => {
    const kael = makeChar(db, 'u1', 'Kael', "The Warden's Oak");
    addMove(db, kael, 'The Forest Edge'); // Oak→Forest Edge is already seeded (S, difficulty 2)
    backfillLegacyWorld(db, SEED_NAMES);

    const rows = db.prepare("SELECT direction, difficulty FROM location_edges WHERE from_location = ? AND to_location = ?")
      .all("The Warden's Oak", 'The Forest Edge') as { direction: string; difficulty: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'S', difficulty: 2 }); // the seeded edge, not a backfill dupe
  });

  it('is a clean no-op on a DB with no characters', () => {
    expect(() => backfillLegacyWorld(db, SEED_NAMES)).not.toThrow();
    const visits = db.prepare('SELECT COUNT(*) AS n FROM character_locations').get() as { n: number };
    expect(visits.n).toBe(0);
  });
});
