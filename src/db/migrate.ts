import type Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS } from './migrations/index.js';
import type { Migration } from './migrations/types.js';
import { loadAndValidate, validateLocationSeed, validateEdgeSeed } from '../assets/asset-schemas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORLD_DIR = path.join(__dirname, '..', '..', 'assets', 'world');

/** A seed location node (assets/world/locations.yml). */
export interface LocationSeed {
  name: string;
  description: string;
  tags: string;
  is_safe: 0 | 1;
  node_tier: 0 | 1 | 2;
  region: string;
  emoji: string;
}

/** A seed edge (assets/world/edges.yml); `to: null` is a frontier exit. */
export interface EdgeSeed {
  from: string;
  to: string | null;
  direction: string;
  difficulty: 1 | 2 | 3;
  flavour?: string | null;
  teaser?: string | null;
}

/** Thrown when a migration batch fails and is rolled back. Carries the original
 *  error as `cause` and names it in the message so the admin alert is actionable. */
export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/**
 * Bring the database up to date: run any pending schema migrations, then seed
 * the optional world data (skipped under tests to avoid colliding with fixtures).
 */
export function migrate(db: Database.Database): void {
  runMigrations(db);

  // Seed the world (locations + edges) and NPCs (skip in test environments to
  // avoid collision with fixtures). The Oak row + meta keys are seeded by
  // schema.sql; seedWorld layers geometry + edges on top idempotently.
  if (!process.env.VITEST) {
    seedLocations(db);
    seedNpcs(db);

    // One-shot prod backfill: must run AFTER seedWorld so the home-cluster
    // geometry + names exist to distinguish seed nodes from legacy off-map ones.
    // Idempotent in effect, but meta-flagged so it scrapes the action log only
    // once (and never re-flags an enriched node). On a fresh DB it's a clean
    // no-op (no characters/actions) and simply records the flag.
    if (!isWorldBackfillDone(db)) {
      backfillLegacyWorld(db, SEEDED_LOCATIONS.map((l) => l.name));
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('world_backfill_done', '1')").run();
    }
  }
}

function isWorldBackfillDone(db: Database.Database): boolean {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'world_backfill_done'").get() as
    | { value: string }
    | undefined;
  return row?.value === '1';
}

/**
 * Apply every migration whose id isn't already recorded in `schema_migrations`,
 * in declared (chronological) order. Each migration is idempotent on its own
 * (existing production DBs predate this runner), so running the full set against
 * an already-migrated DB is a safe no-op that simply backfills the ledger.
 *
 * The whole pending batch runs in ONE transaction: SQLite supports transactional
 * DDL, so if any migration throws, the entire batch — including the ledger
 * inserts — is rolled back and the DB is left exactly as it was. A failed deploy
 * can never leave a half-migrated schema; the bot restarts and retries cleanly.
 * On failure a `MigrationError` is thrown so the caller can alert the admin.
 *
 * @param migrations - override the migration set (used by tests); defaults to MIGRATIONS.
 */
export function runMigrations(db: Database.Database, migrations: Migration[] = MIGRATIONS): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>).map(r => r.id),
  );
  const pending = migrations.filter(m => !applied.has(m.id));
  if (pending.length === 0) return;

  const record = db.prepare('INSERT INTO schema_migrations (id) VALUES (?)');
  const runBatch = db.transaction(() => {
    for (const m of pending) {
      m.up(db);
      record.run(m.id);
    }
  });

  try {
    runBatch();
  } catch (err) {
    const ids = pending.map(m => m.id).join(', ');
    const cause = err instanceof Error ? err.message : String(err);
    throw new MigrationError(
      `Migration batch failed and was rolled back (pending: ${ids}). Cause: ${cause}`,
      { cause: err },
    );
  }

  // Log only after a successful commit — never claim a rolled-back migration applied.
  for (const m of pending) console.log(`[migrate] applied ${m.id}`);
}

/**
 * The seed world, loaded + validated from `assets/world/*.yml` at module load.
 * Exported as the single source of truth so the cross-file asset checks
 * (`checkDayJobLocations`, `checkEdgeReferences`) validate against the same data
 * `seedWorld` writes. The eager load is fail-fast: a malformed asset throws at
 * import, crashing boot loudly rather than seeding a broken world.
 *
 * NOTE: the cross-file checks are TEST-gate assertions, not boot fail-fast — they
 * run in `tests/assets/asset-schemas.test.ts`. Only the per-file shape validators
 * (`loadAndValidate`) run at boot/import.
 */
export const SEEDED_LOCATIONS = loadAndValidate<LocationSeed>(
  path.join(WORLD_DIR, 'locations.yml'),
  validateLocationSeed,
);
export const SEEDED_EDGES = loadAndValidate<EdgeSeed>(
  path.join(WORLD_DIR, 'edges.yml'),
  validateEdgeSeed,
);

/**
 * Seed the shared world graph idempotently. New rows get full geometry; existing
 * rows (the Oak from schema.sql, or prod locations) get their geometry columns
 * set without clobbering enriched `description`/`is_safe`. Edges are INSERT OR
 * IGNORE on PK `(from_location, direction)` — so a frontier exit already bound by
 * a crosser is never reset back to NULL.
 *
 * Pure over its inputs (no fs) so tests can drive it with fixtures.
 */
export function seedWorld(db: Database.Database, nodes: LocationSeed[], edges: EdgeSeed[]): void {
  const insertNode = db.prepare(`
    INSERT OR IGNORE INTO locations (name, description, tags, is_safe, node_tier, region, emoji)
    VALUES (@name, @description, @tags, @is_safe, @node_tier, @region, @emoji)
  `);
  const setGeometry = db.prepare(
    'UPDATE locations SET node_tier = @node_tier, region = @region, emoji = @emoji WHERE name = @name',
  );
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO location_edges (from_location, to_location, direction, flavour, teaser, difficulty)
    VALUES (@from, @to, @direction, @flavour, @teaser, @difficulty)
  `);

  const seed = db.transaction(() => {
    for (const n of nodes) {
      insertNode.run(n);
      setGeometry.run({ name: n.name, node_tier: n.node_tier, region: n.region, emoji: n.emoji });
    }
    for (const e of edges) {
      insertEdge.run({
        from: e.from,
        to: e.to ?? null,
        direction: e.direction,
        flavour: e.flavour ?? null,
        teaser: e.teaser ?? null,
        difficulty: e.difficulty,
      });
    }
  });
  seed();
}

function seedLocations(db: Database.Database): void {
  seedWorld(db, SEEDED_LOCATIONS, SEEDED_EDGES);
}

/** Cardinal pool for arbitrary backfill directions (the real direction is unknown). */
const BACKFILL_CARDINALS = ['N', 'E', 'S', 'W', 'NE', 'NW', 'SE', 'SW'] as const;

/**
 * One-shot backfill for the soon-offlined POC prod DB. Brings legacy data into
 * the geographic model without an LLM pass; everything self-corrects on real
 * visits going forward (spec §8). THREE tiers of confidence:
 *
 *  1. Off-map legacy locations (any row not in the seed set) → `node_tier = 2`,
 *     a placeholder `emoji`, and `enrichment_pending = 1` so the existing
 *     cartographer fills `region`/proper geometry on next visit.
 *  2. Shared edges scraped from each character's `set_location` history
 *     (oldest-first, starting at the Oak). Direction is genuinely unknown, so we
 *     assign an arbitrary free cardinal per node (the PK is `(from, direction)`
 *     and the Oak fans out to many nodes — a literal `'unknown'` would collide).
 *     Already-connected pairs and saturated nodes (>8 neighbours) are skipped.
 *  3. Per-player discovery: every existing character is seeded with the home
 *     cluster + their current location + their scraped visited set.
 *
 * Honest caveat: the home spine is exact (YAML); these off-map edges/regions are
 * approximate and self-correct as real visits record real direction/difficulty.
 *
 * Pure over its inputs (takes the seed name list) so tests can drive it with a
 * fixture action log.
 */
export function backfillLegacyWorld(db: Database.Database, seedNames: string[]): void {
  const SEED = new Set(seedNames);
  const OAK = "The Warden's Oak";

  const stubGeometry = db.prepare(
    "UPDATE locations SET node_tier = 2, emoji = COALESCE(emoji, '📍'), enrichment_pending = 1 WHERE name = @name",
  );
  const visit = db.prepare(
    'INSERT OR IGNORE INTO character_locations (character_id, location_name) VALUES (@cid, @name)',
  );
  const actionsOf = db.prepare(
    'SELECT applied_mutations FROM actions WHERE character_id = ? ORDER BY id ASC',
  );
  const edgeExists = db.prepare(
    'SELECT 1 FROM location_edges WHERE (from_location = @a AND to_location = @b) OR (from_location = @b AND to_location = @a) LIMIT 1',
  );
  const dirsUsed = db.prepare('SELECT direction FROM location_edges WHERE from_location = ?');
  const insertEdge = db.prepare(
    'INSERT OR IGNORE INTO location_edges (from_location, to_location, direction, difficulty) VALUES (@from, @to, @dir, 1)',
  );

  const recordEdge = (from: string, to: string): void => {
    if (from === to) return;
    if (edgeExists.get({ a: from, b: to })) return;
    const used = new Set((dirsUsed.all(from) as { direction: string }[]).map((d) => d.direction));
    const dir = BACKFILL_CARDINALS.find((c) => !used.has(c));
    if (!dir) return; // node already has 8 edges — skip (approximate)
    insertEdge.run({ from, to, dir });
  };

  const run = db.transaction(() => {
    for (const loc of db.prepare('SELECT name FROM locations').all() as { name: string }[]) {
      if (!SEED.has(loc.name)) stubGeometry.run({ name: loc.name });
    }

    const chars = db.prepare('SELECT id, location FROM player_characters').all() as
      { id: number; location: string | null }[];

    for (const ch of chars) {
      for (const name of seedNames) visit.run({ cid: ch.id, name }); // home cluster, pre-discovered
      if (ch.location) visit.run({ cid: ch.id, name: ch.location });

      let prev = OAK;
      for (const r of actionsOf.all(ch.id) as { applied_mutations: string | null }[]) {
        if (!r.applied_mutations) continue;
        let muts: unknown;
        try {
          muts = JSON.parse(r.applied_mutations);
        } catch {
          continue;
        }
        if (!Array.isArray(muts)) continue;
        for (const m of muts) {
          if (m && m.type === 'set_location' && typeof m.name === 'string' && m.name.trim()) {
            const to = m.name.trim();
            visit.run({ cid: ch.id, name: to });
            recordEdge(prev, to);
            prev = to;
          }
        }
      }
    }
  });
  run();
}

function seedNpcs(db: Database.Database): void {
  // `health` is the NPC's combat max-HP, seeded from character rather than the encounter
  // DC (0.3.2 C3). Kept in sync with the backfill map in
  // migrations/202607112100_npc_combat_health.ts, which populates DBs seeded before health
  // existed. Values are within [ENEMY_HP_MIN, ENEMY_HP_MAX] = [6, 40].
  const npcs = [
    { name: 'The Warden', class: 'Warden', race: null, health: 30, description: 'A quiet figure wrapped in a travel-worn cloak, tending the fire beneath the Oak. Their face stays hidden in the shadow of a deep hood. They offer bowls of stew without being asked, and answer questions with a silence that somehow says more than words.', location: "The Warden's Oak" },
    { name: 'Elder Bram', class: 'Herbalist', race: 'Human', health: 10, description: 'A bent old man with earth under his nails and eyes that see too much. He tends a garden of plants most people can\'t name.', location: "The Warden's Oak" },
    { name: 'Kara', class: 'Hunter', race: 'Human', health: 16, description: 'Lean and watchful, with a bow that\'s seen more seasons than most rangers. She doesn\'t trust easy — but she respects skill.', location: "The Warden's Oak" },
    { name: 'Marta', class: 'Blacksmith', race: 'Dwarf', health: 18, description: 'Arms like tree roots and a face set in permanent disapproval. Her steel is the best east of Stonebridge and she knows it.', location: 'Town Square' },
    { name: 'The Caravan Master', class: 'Merchant', race: 'Human', health: 12, description: 'A woman with quick hands and quicker eyes. She\'s been trying to offload cargo all week — says she\'s "travelling light," but her hands shake when she says "east."', location: 'Town Square' },
    { name: 'Brother Aldric', class: 'Acolyte', race: 'Human', health: 10, description: 'Young, earnest, and fighting a crisis of faith. The candle in the shrine alcove won\'t go out — and he doesn\'t know if that\'s a blessing or a warning.', location: 'The Shrine of the First Flame' },
    { name: 'Grey Wolf', class: 'Beast', race: null, health: 16, description: 'A massive she-wolf, grey as storm-light, limping from a wound in her flank. Her eyes track you with an intelligence that feels wrong.', location: 'The Forest Edge' },
    { name: 'Shadow Stag', class: 'Beast', race: null, health: 24, description: 'A stag of impossible size, its antlers tangled with mist that doesn\'t burn off in sunlight. Hunters speak of it in whispers. No one has drawn a bow.', location: 'The Dark Pines' },
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO npcs (name, class, race, health, description, location)
    VALUES (@name, @class, @race, @health, @description, @location)
  `);

  const seed = db.transaction(() => {
    for (const npc of npcs) {
      stmt.run(npc);
    }
  });
  seed();
}
