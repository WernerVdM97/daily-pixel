import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Migration } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Baseline schema — everything the project shipped before the migration runner
 * existed: the full `schema.sql`, the historical v2–v7 idempotent ALTERs, and
 * the seed-NPC dedupe. Every step is idempotent, so an existing production DB
 * runs this as a near no-op and is simply stamped in `schema_migrations`; a
 * fresh DB is built from scratch.
 *
 * New schema changes do NOT go here — add a new dated migration file instead.
 */
export const migration: Migration = {
  id: '202606170000_baseline',
  up(db) {
    // Must run BEFORE schema.sql: it creates a partial unique index on seed NPC
    // names, which would fail if the duplicate rows are still present.
    dedupeSeedNpcs(db);

    const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8');
    db.exec(sql);

    // v2 migration: add prompt_version column to existing actions table
    const cols = db.prepare("PRAGMA table_info('actions')").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'prompt_version')) {
      db.exec("ALTER TABLE actions ADD COLUMN prompt_version TEXT NOT NULL DEFAULT 'v1'");
    }

    // v2 migration: allow seed NPCs (not created by any action)
    const npcCols = db.prepare("PRAGMA table_info('npcs')").all() as Array<{ name: string; notnull: number }>;
    const createdByCol = npcCols.find(c => c.name === 'created_by_action_id');
    if (createdByCol && createdByCol.notnull === 1) {
      // SQLite doesn't support ALTER COLUMN, so we must recreate
      db.exec(`
        CREATE TABLE IF NOT EXISTS npcs_v2 (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          name                  TEXT    NOT NULL,
          class                 TEXT,
          race                  TEXT,
          day_job               TEXT,
          stats                 TEXT,
          health                INTEGER,
          stamina               INTEGER,
          wealth                INTEGER DEFAULT 0,
          location              TEXT,
          description           TEXT,
          created_by_action_id  INTEGER REFERENCES actions(id)
        );
        INSERT INTO npcs_v2 SELECT * FROM npcs;
        DROP TABLE npcs;
        ALTER TABLE npcs_v2 RENAME TO npcs;
      `);
    }

    // v3: add llm_request and llm_response columns to actions table for audit
    for (const col of ['llm_request', 'llm_response']) {
      try { db.exec(`ALTER TABLE actions ADD COLUMN ${col} TEXT`); } catch { /* already exists */ }
    }

    // v4: diagnostic-only deep capture on llm_calls (raw prompt + full reasoning)
    for (const col of ['raw_prompt', 'reasoning']) {
      try { db.exec(`ALTER TABLE llm_calls ADD COLUMN ${col} TEXT`); } catch { /* already exists */ }
    }

    // v5: stamp each action with the app build (VERSION) for historic data mining
    try { db.exec('ALTER TABLE actions ADD COLUMN app_version TEXT'); } catch { /* already exists */ }

    // v6: same stamp on llm_calls (failed/retry calls have no action row to inherit it)
    try { db.exec('ALTER TABLE llm_calls ADD COLUMN app_version TEXT'); } catch { /* already exists */ }

    // v7: per-character max stamina ceiling (for training/endurance mutations)
    try { db.exec('ALTER TABLE player_characters ADD COLUMN max_stamina INTEGER NOT NULL DEFAULT 10'); } catch { /* already exists */ }
  },
};

/**
 * Collapse duplicate seed NPCs (created_by_action_id IS NULL) down to one row
 * per name, keeping the lowest id. Historically seedNpcs() ran INSERT OR IGNORE
 * with no UNIQUE constraint, so every startup re-inserted all 8 seed NPCs —
 * leaving dozens of copies that all leaked into every LLM prompt. Idempotent and
 * a no-op on a fresh database.
 */
function dedupeSeedNpcs(db: Database.Database): void {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='npcs'")
    .get();
  if (!exists) return;

  const removed = db
    .prepare(`
      DELETE FROM npcs
      WHERE created_by_action_id IS NULL
        AND id NOT IN (
          SELECT MIN(id) FROM npcs
          WHERE created_by_action_id IS NULL
          GROUP BY name
        )
    `)
    .run();

  if (removed.changes > 0) {
    console.log(`[migrate] deduped ${removed.changes} duplicate seed NPC row(s)`);
  }
}
