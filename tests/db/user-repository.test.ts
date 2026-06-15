import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';

let db: Database.Database;
let repo: UserRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  repo = new UserRepository(db);
});

afterAll(() => {
  db.close();
});

describe('UserRepository', () => {
  it('creates a user and returns the row', () => {
    const user = repo.create('1234567890');
    expect(user.id).toBe(1);
    expect(user.discord_user_id).toBe('1234567890');
    expect(user.created_at).toBeTruthy();
  });

  it('finds a user by Discord ID', () => {
    repo.create('abc');
    const found = repo.findByDiscordId('abc');
    expect(found).toBeDefined();
    expect(found!.discord_user_id).toBe('abc');
  });

  it('returns undefined for unknown Discord ID', () => {
    expect(repo.findByDiscordId('nope')).toBeUndefined();
  });

  it('finds a user by internal ID', () => {
    const created = repo.create('xyz');
    const found = repo.findById(created.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });

  it('returns undefined for unknown internal ID', () => {
    expect(repo.findById(999)).toBeUndefined();
  });

  it('enforces unique discord_user_id', () => {
    repo.create('dup');
    expect(() => repo.create('dup')).toThrow();
  });
});
