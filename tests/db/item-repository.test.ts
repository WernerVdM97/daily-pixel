import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import { ItemRepository } from '../../src/db/repositories/item.js';

let db: Database.Database;
let itemRepo: ItemRepository;
let charId: number;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  const userRepo = new UserRepository(db);
  const charRepo = new CharacterRepository(db);
  const userId = userRepo.create('123').id;
  charId = charRepo.create(userId, {
    name: 'Aldric', class: 'Warrior', upbringing: 'Village', race: 'Human',
    alignment: 'lawful good', day_job: 'Blacksmith',
    stats: JSON.stringify({ physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }),
    health: 12, max_health: 12, stamina: 10, rolls_remaining: 2,
    location: "The Warden's Oak", wealth: 5, last_action_state: null,
  }).id;
  itemRepo = new ItemRepository(db);
});

describe('ItemRepository.decrementByName', () => {
  it('decrements a stack and keeps the row when units remain (trade 1 of 2)', () => {
    itemRepo.create(charId, { name: 'Steel Ingot', emoji: '⚙️', stat: 'physical', modifier: 1, quantity: 2 });

    const remaining = itemRepo.decrementByName(charId, 'Steel Ingot', 1);

    expect(remaining).toBe(1);
    const rows = itemRepo.findByCharacterId(charId);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(1);
  });

  it('deletes the row when the stack hits zero', () => {
    itemRepo.create(charId, { name: 'Torch', emoji: '🔥', stat: 'physical', modifier: 0, quantity: 1 });

    const remaining = itemRepo.decrementByName(charId, 'Torch', 1);

    expect(remaining).toBe(0);
    expect(itemRepo.findByCharacterId(charId)).toHaveLength(0);
  });

  it('removes the row when asked to drop more than the stack holds', () => {
    itemRepo.create(charId, { name: 'Arrow', emoji: '🏹', stat: 'physical', modifier: 0, quantity: 3 });

    expect(itemRepo.decrementByName(charId, 'Arrow', 10)).toBe(0);
    expect(itemRepo.findByCharacterId(charId)).toHaveLength(0);
  });

  it('is a no-op for an item the character does not have', () => {
    expect(itemRepo.decrementByName(charId, 'Ghost Item', 1)).toBe(0);
  });
});
