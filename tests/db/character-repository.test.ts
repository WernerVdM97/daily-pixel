import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import type { CharacterRow } from '../../src/db/repositories/character.js';

let db: Database.Database;
let userRepo: UserRepository;
let charRepo: CharacterRepository;
let userId: number;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  userRepo = new UserRepository(db);
  charRepo = new CharacterRepository(db);
  userId = userRepo.create('123').id;
});

describe('CharacterRepository', () => {
  const charData: Omit<CharacterRow, 'id' | 'user_id' | 'created_at' | 'last_played_at' | 'last_rested_day'> = {
    name: 'Aldric',
    class: 'Warrior',
    upbringing: 'Village',
    race: 'Human',
    alignment: 'lawful good',
    day_job: 'Blacksmith',
    stats: JSON.stringify({ physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }),
    health: 12,
    max_health: 12,
    max_stamina: 10,
    stamina: 10,
    rolls_remaining: 2,
    location: "The Warden's Oak",
    wealth: 5,
    last_action_state: null,
  };

  it('creates a character linked to a user', () => {
    const char = charRepo.create(userId, charData);
    expect(char.id).toBe(1);
    expect(char.user_id).toBe(userId);
    expect(char.name).toBe('Aldric');
    expect(char.class).toBe('Warrior');
    expect(char.alignment).toBe('lawful good');
    expect(char.stats).toBe(charData.stats);
    expect(char.health).toBe(12);
    expect(char.created_at).toBeTruthy();
  });

  it('finds a character by user ID', () => {
    charRepo.create(userId, charData);
    const found = charRepo.findByUserId(userId);
    expect(found).toBeDefined();
    expect(found!.name).toBe('Aldric');
  });

  it('returns undefined when user has no character', () => {
    expect(charRepo.findByUserId(userId)).toBeUndefined();
  });

  it('finds a character by internal ID', () => {
    const created = charRepo.create(userId, charData);
    const found = charRepo.findById(created.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });

  it('updates character fields (partial update)', () => {
    const created = charRepo.create(userId, charData);
    charRepo.update(created.id, { location: 'Dark Forest', health: 8 });
    const updated = charRepo.findById(created.id);
    expect(updated!.location).toBe('Dark Forest');
    expect(updated!.health).toBe(8);
    // unchanged fields remain
    expect(updated!.name).toBe('Aldric');
  });

  it('persists max_stamina through an update', () => {
    const created = charRepo.create(userId, charData);
    charRepo.update(created.id, { max_stamina: 15 });
    const updated = charRepo.findById(created.id);
    expect(updated!.max_stamina).toBe(15);
  });

  it('enforces unique user_id (one character per user)', () => {
    charRepo.create(userId, charData);
    expect(() => charRepo.create(userId, charData)).toThrow();
  });

  it('stores default values when omitted', () => {
    const minimal = charRepo.create(userId, {
      name: 'Bran',
      class: 'Ranger',
      upbringing: 'Wilds',
      race: 'Elf',
      alignment: 'chaotic neutral',
      day_job: 'Hunter',
      stats: JSON.stringify({ physical: 1, wisdom: 2, intelligence: 0, charisma: -1 }),
    });
    expect(minimal.health).toBe(10);
    expect(minimal.max_health).toBe(10);
    expect(minimal.stamina).toBe(10);
    expect(minimal.rolls_remaining).toBe(3);
    expect(minimal.location).toBe("The Warden's Oak");
    expect(minimal.wealth).toBe(0);
    expect(minimal.last_action_state).toBeNull();
  });

  it('returns undefined for unknown internal ID', () => {
    expect(charRepo.findById(999)).toBeUndefined();
  });
});
