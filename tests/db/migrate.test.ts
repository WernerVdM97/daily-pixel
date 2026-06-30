import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, runMigrations, MigrationError } from '../../src/db/migrate.js';

let db: Database.Database;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterAll(() => {
  db.close();
});

describe('migrate', () => {
  it('creates all tables in an empty database', () => {
    migrate(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];

    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual([
      'actions',
      'bug_reports',
      'character_locations',
      'feedback',
      'items',
      'llm_calls',
      'location_edges',
      'locations',
      'meta',
      'npcs',
      'player_characters',
      'schema_migrations',
      'users',
    ]);
  });

  it('is idempotent — running a second time does not error', () => {
    expect(() => migrate(db)).not.toThrow();
  });

  it('records every migration once in schema_migrations (no duplicates on re-run)', () => {
    migrate(db); // third run — must not re-insert ledger rows
    const ids = db
      .prepare('SELECT id FROM schema_migrations ORDER BY id')
      .all() as { id: string }[];
    const names = ids.map((r) => r.id);
    // Each id is unique and the baseline sorts first.
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('202606170000_baseline');
    expect(names).toContain('202606171200_action_applied_mutations');
    expect(names[0]).toBe('202606170000_baseline');
  });

  it('adds the applied_mutations column to actions', () => {
    const cols = db.prepare("PRAGMA table_info('actions')").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('applied_mutations');
  });

  it("seeds the default location (The Warden's Oak)", () => {
    const row = db.prepare("SELECT * FROM locations WHERE name = ?").get("The Warden's Oak") as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.name).toBe("The Warden's Oak");
    expect(row.tags).toBe('oak,interior,fire,sanctuary');
    expect(row.is_safe).toBe(1);
  });

  it('seeds meta keys: day_number, last_cron_date, llm_fallback_count', () => {
    const meta = db.prepare('SELECT key, value FROM meta ORDER BY key').all() as { key: string; value: string }[];
    expect(meta).toHaveLength(3);
    expect(meta[0]).toEqual({ key: 'day_number', value: '1' });
    expect(meta[1]).toEqual({ key: 'last_cron_date', value: '' });
    expect(meta[2]).toEqual({ key: 'llm_fallback_count', value: '0' });
  });

  it('has all required columns on player_characters', () => {
    const cols = db.prepare("PRAGMA table_info('player_characters')").all() as { name: string }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'alignment',
      'class',
      'created_at',
      'day_job',
      'health',
      'id',
      'last_action_state',
      'last_bail_refund_day',
      'last_noop_refund_day',
      'last_played_at',
      'last_rested_day',
      'last_timeout_refund_day',
      'location',
      'max_health',
      'max_stamina',
      'name',
      'race',
      'rolls_remaining',
      'stamina',
      'stats',
      'upbringing',
      'user_id',
      'wealth',
    ]);
  });

  it('adds the enrichment_pending column to locations (default 0)', () => {
    const cols = db.prepare("PRAGMA table_info('locations')").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('enrichment_pending');
    const row = db.prepare("SELECT enrichment_pending FROM locations WHERE name = ?").get("The Warden's Oak") as { enrichment_pending: number };
    expect(row.enrichment_pending).toBe(0);
  });

  it('adds the app_version column to feedback and bug_reports', () => {
    for (const table of ['feedback', 'bug_reports']) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain('app_version');
    }
  });
});

describe('feedback/bug app_version migration — existing DB backfill', () => {
  it('adds app_version to a DB that predates it, idempotently (guarded ALTER)', async () => {
    const old = new Database(':memory:');
    runMigrations(old);
    old.exec('ALTER TABLE feedback DROP COLUMN app_version');
    old.exec('ALTER TABLE bug_reports DROP COLUMN app_version');

    const { migration } = await import('../../src/db/migrations/202606280000_feedback_bug_app_version.js');
    migration.up(old);

    for (const table of ['feedback', 'bug_reports']) {
      const cols = (old.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain('app_version');
    }
    // Re-running is a clean no-op (the PRAGMA guard skips the ALTER).
    expect(() => migration.up(old)).not.toThrow();

    old.close();
  });
});

describe('roll-refund + enrichment migration — existing DB backfill', () => {
  it('adds the new columns to a DB that predates them (guarded ALTERs)', async () => {
    // Build a real DB, then DROP the three new columns to simulate a production
    // DB that predates this migration, and confirm the migration backfills them.
    const old = new Database(':memory:');
    runMigrations(old);
    old.exec('ALTER TABLE player_characters DROP COLUMN last_noop_refund_day');
    old.exec('ALTER TABLE player_characters DROP COLUMN last_timeout_refund_day');
    old.exec('ALTER TABLE locations DROP COLUMN enrichment_pending');

    const { migration } = await import('../../src/db/migrations/202606210000_roll_refund_and_enrichment.js');
    migration.up(old);

    const pcCols = (old.prepare("PRAGMA table_info('player_characters')").all() as { name: string }[]).map(c => c.name);
    expect(pcCols).toContain('last_noop_refund_day');
    expect(pcCols).toContain('last_timeout_refund_day');

    const locCols = (old.prepare("PRAGMA table_info('locations')").all() as { name: string }[]).map(c => c.name);
    expect(locCols).toContain('enrichment_pending');

    // Re-running the up() is a clean no-op (guarded ALTERs swallow "duplicate column").
    expect(() => migration.up(old)).not.toThrow();

    old.close();
  });
});

describe('llm_calls call_kind / critic_severity — existing-DB backfill (v0.2.4 → v9)', () => {
  it('adds call_kind via a standalone migration even though baseline is already recorded', () => {
    // Reproduce a v0.2.4 prod DB: baseline (and earlier) recorded, but the v9 columns absent.
    // Regression guard: call_kind must NOT live only in baseline.up() — baseline never re-runs
    // once recorded, so the column would be missing on every upgraded DB and every llm_calls
    // INSERT would throw "no such column: call_kind".
    const old = new Database(':memory:');
    runMigrations(old);

    // Roll back to the pre-v9 state: forget the three newest migrations and drop their columns.
    old.exec(`DELETE FROM schema_migrations WHERE id IN (
      '202606250000_drop_legacy_action_llm_columns',
      '202606250001_llm_call_kind',
      '202606260000_llm_call_critic_severity'
    )`);
    old.exec('ALTER TABLE llm_calls DROP COLUMN call_kind');
    old.exec('ALTER TABLE llm_calls DROP COLUMN critic_severity');

    const before = (old.prepare("PRAGMA table_info('llm_calls')").all() as { name: string }[]).map(c => c.name);
    expect(before).not.toContain('call_kind');

    // The upgrade: baseline stays skipped (already recorded); the standalone migrations run.
    runMigrations(old);

    const after = (old.prepare("PRAGMA table_info('llm_calls')").all() as { name: string }[]).map(c => c.name);
    expect(after).toContain('call_kind');
    expect(after).toContain('critic_severity');

    // The INSERT the repo issues must now succeed.
    expect(() =>
      old
        .prepare("INSERT INTO llm_calls (prompt_version, call_kind, model, parse_ok) VALUES ('v9','decision','deepseek',1)")
        .run(),
    ).not.toThrow();

    old.close();
  });
});

describe('runMigrations — atomic batch', () => {
  it('rolls the whole batch back when any migration throws', () => {
    const fresh = new Database(':memory:');
    const good = { id: 'test_good', up: (d: Database.Database) => d.exec('CREATE TABLE canary (id INTEGER)') };
    const bad = { id: 'test_bad', up: () => { throw new Error('boom'); } };

    expect(() => runMigrations(fresh, [good, bad])).toThrow(MigrationError);

    // The good migration's table must NOT survive — it rolled back with the batch.
    const table = fresh
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canary'")
      .get();
    expect(table).toBeUndefined();

    // And no ledger rows were committed.
    expect(fresh.prepare('SELECT id FROM schema_migrations').all()).toEqual([]);

    fresh.close();
  });

  it('commits and records a clean batch', () => {
    const fresh = new Database(':memory:');
    const m = { id: 'test_ok', up: (d: Database.Database) => d.exec('CREATE TABLE canary (id INTEGER)') };

    runMigrations(fresh, [m]);

    const table = fresh
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canary'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('canary');
    const ids = (fresh.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map(r => r.id);
    expect(ids).toEqual(['test_ok']);

    fresh.close();
  });
});
