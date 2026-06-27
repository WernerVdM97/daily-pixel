import type Database from 'better-sqlite3';
import type { Migration } from './types.js';

/**
 * Map & Exploration foundation (docs/engine/per-player-map-exploration.md, §1).
 *
 * Turns the flat `locations` list into a shared, tiered, edge-connected world
 * masked per player by fog-of-war:
 *
 * - `locations` gains `node_tier` (0 Oak / 1 hub / 2 leaf — named to avoid the
 *   retry-`tier` on the LLM path, which lives on `llm_calls`), `region`, `emoji`,
 *   and `created_by_action_id` provenance. Default `node_tier = 2` so any
 *   pre-existing off-map row reads as a leaf until corrected.
 * - `location_edges` — the shared graph. `to_location IS NULL` is a frontier exit
 *   (a road with no node yet). PK `(from_location, direction)`.
 * - `character_locations` — the per-player discovery mask (NOT a private tree;
 *   the real adjacency lives on the shared edges).
 * - `actions.location_name` — a deliberate snapshot (not FK) of where the player
 *   stood when they acted (§6); the schema keys locations by name and `actions`
 *   is an audit table, so a rename must not rewrite history.
 *
 * This migration is structural + idempotent ONLY. The home-cluster GEOMETRY is seeded
 * from `assets/world/*.yml` by `seedWorld` in `migrate.ts`, and the one-shot prod backfill
 * (off-map edges scraped from `applied_mutations` + per-player discovery) runs there too —
 * in `migrate()`, AFTER seeding and gated by the `world_backfill_done` meta flag, NOT in
 * this `up()`. (It needs the seeded names to tell seed nodes from legacy off-map ones.)
 */

function addColumn(db: Database.Database, table: string, columnDdl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`);
  } catch {
    /* column already exists — idempotent on production DBs that predate this */
  }
}

export const migration: Migration = {
  id: '202606270000_geography',
  up(db) {
    // ── locations: geometry columns ──
    addColumn(db, 'locations', 'node_tier INTEGER NOT NULL DEFAULT 2');
    addColumn(db, 'locations', 'region TEXT');
    addColumn(db, 'locations', 'emoji TEXT');
    addColumn(db, 'locations', 'created_by_action_id INTEGER');

    // ── actions: origin-location snapshot (§6) ──
    addColumn(db, 'actions', 'location_name TEXT');

    // ── the shared world graph ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS location_edges (
        from_location        TEXT    NOT NULL,           -- locations.name
        to_location          TEXT,                        -- NULL = unexplored frontier exit
        direction            TEXT    NOT NULL,            -- canonical cardinal N/S/E/W/NE/...
        flavour              TEXT,                         -- prose hint ("downriver")
        teaser               TEXT,                         -- frontier vibe shown before crossing
        difficulty           INTEGER NOT NULL DEFAULT 1,  -- terrain band 1/2/3 (stamina weight)
        distance             INTEGER NOT NULL DEFAULT 1,  -- DORMANT; reserved for the time mechanic (§7)
        created_by_action_id INTEGER,                      -- provenance; NULL for hand-seeded edges
        PRIMARY KEY (from_location, direction)
      )
    `);

    // ── the per-player fog-of-war mask ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS character_locations (
        character_id     INTEGER NOT NULL REFERENCES player_characters(id),
        location_name    TEXT    NOT NULL,
        first_visited_at TEXT    NOT NULL DEFAULT (datetime('now')),
        last_visited_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (character_id, location_name)
      )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_location_edges_to ON location_edges(to_location)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_character_locations_char ON character_locations(character_id)');
  },
};
