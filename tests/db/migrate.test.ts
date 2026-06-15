import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';

let db: Database.Database;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterAll(() => {
  db.close();
});

describe('migrate', () => {
  it('creates all 9 tables in an empty database', () => {
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
      'locations',
      'meta',
      'npcs',
      'player_characters',
      'users',
    ]);
  });

  it('is idempotent — running a second time does not error', () => {
    expect(() => migrate(db)).not.toThrow();
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
      'location',
      'max_health',
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
