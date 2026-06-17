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
      'feedback',
      'items',
      'llm_calls',
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
      'last_played_at',
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
