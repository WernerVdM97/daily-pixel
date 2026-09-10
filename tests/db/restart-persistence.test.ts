/**
 * Restart persistence test — verifies SQLite data survives bot restart.
 *
 * Simulates a "restart" by closing and reopening the database connection
 * to the same file, then checking that data written before the restart
 * is still readable after.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import { ItemRepository } from '../../src/db/repositories/item.js';
import { ActionRepository } from '../../src/db/repositories/action.js';
import { MetaRepository } from '../../src/db/repositories/meta.js';

describe('Restart persistence', () => {
  const dbPath = path.join(os.tmpdir(), `warden-test-${crypto.randomUUID()}.db`);

  afterEach(() => {
    closeDb();
    // Clean up temp file
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
  });

  it('survives close-and-reopen cycle with character data', () => {
    // ── "Boot" 1: init DB, create data ──
    initDb(dbPath);
    migrate(getDb());

    const userRepo = new UserRepository(getDb());
    const charRepo = new CharacterRepository(getDb());
    const metaRepo = new MetaRepository(getDb());

    const user = userRepo.create('discord-user-1');
    charRepo.create(user.id, {
      name: 'Aldric',
      class: 'Warrior',
      upbringing: 'Village',
      race: 'Human',
      alignment: 'lawful good',
      day_job: 'Blacksmith',
      stats: JSON.stringify({ physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }),
      health: 10,
      max_health: 10,
      stamina: 8,
      rolls_remaining: 1,
      location: "The Warden's Oak",
      wealth: 15,
      last_action_state: null,
    });

    // Set meta
    metaRepo.set('day_number', '3');
    metaRepo.set('last_cron_date', '2026-06-15');

    // ── "Restart" — close and reopen ──
    closeDb();
    initDb(dbPath);
    migrate(getDb()); // migrate is idempotent (IF NOT EXISTS)

    // ── "Boot" 2: verify data persists ──
    const userRepo2 = new UserRepository(getDb());
    const charRepo2 = new CharacterRepository(getDb());
    const metaRepo2 = new MetaRepository(getDb());

    const restoredUser = userRepo2.findByDiscordId('discord-user-1');
    expect(restoredUser).not.toBeNull();
    expect(restoredUser!.discord_user_id).toBe('discord-user-1');

    const restoredChar = charRepo2.findByUserId(restoredUser!.id);
    expect(restoredChar).not.toBeNull();
    expect(restoredChar!.name).toBe('Aldric');
    expect(restoredChar!.class).toBe('Warrior');
    expect(restoredChar!.stamina).toBe(8);
    expect(restoredChar!.rolls_remaining).toBe(1);
    expect(restoredChar!.wealth).toBe(15);
    expect(restoredChar!.location).toBe("The Warden's Oak");

    // Meta persists
    expect(metaRepo2.get('day_number')).toBe('3');
    expect(metaRepo2.get('last_cron_date')).toBe('2026-06-15');
  });

  it('survives close-and-reopen cycle with actions and items', () => {
    // ── "Boot" 1 ──
    initDb(dbPath);
    migrate(getDb());

    const userRepo = new UserRepository(getDb());
    const charRepo = new CharacterRepository(getDb());
    const itemRepo = new ItemRepository(getDb());
    const actionRepo = new ActionRepository(getDb());

    const user = userRepo.create('discord-user-2');
    const char = charRepo.create(user.id, {
      name: 'Borin',
      class: 'Rogue',
      upbringing: 'Street',
      race: 'Dwarf',
      alignment: 'neutral',
      day_job: 'Hunter',
      stats: JSON.stringify({ physical: 1, wisdom: 2, intelligence: 0, charisma: 1 }),
      health: 8,
      max_health: 10,
      stamina: 10,
      rolls_remaining: 2,
      location: 'The Crossroads',
      wealth: 50,
      last_action_state: null,
    });

    // Add some items
    itemRepo.create(char.id, { name: 'Wolf Pelt', emoji: '🦊', stat: 'wisdom', modifier: 1, quantity: 1 });
    itemRepo.create(char.id, { name: 'Healing Herb', emoji: '🌿', stat: 'physical', modifier: 0, quantity: 3 });

    // Add an action
    actionRepo.create({
      characterId: char.id,
      rawInput: 'hunt a wolf',
      type: 'hunt',
      decisionsJson: JSON.stringify([{ prompt: 'test', options: [], chosen: 'Attack', dcModifier: 0 }]),
      finalDc: 14,
      playerRolled: 16,
      outcome: 'success',
    });

    // ── "Restart" ──
    closeDb();
    initDb(dbPath);
    migrate(getDb());

    // ── "Boot" 2: verify ──
    const userRepo2 = new UserRepository(getDb());
    const charRepo2 = new CharacterRepository(getDb());
    const itemRepo2 = new ItemRepository(getDb());
    const actionRepo2 = new ActionRepository(getDb());

    const restoredUser = userRepo2.findByDiscordId('discord-user-2');
    expect(restoredUser).not.toBeNull();

    const restoredChar = charRepo2.findByUserId(restoredUser!.id);
    expect(restoredChar).not.toBeNull();
    expect(restoredChar!.name).toBe('Borin');

    // Items survive
    const items = itemRepo2.findByCharacterId(restoredChar!.id);
    expect(items).toHaveLength(2);
    expect(items.some(i => i.name === 'Wolf Pelt')).toBe(true);
    expect(items.some(i => i.name === 'Healing Herb')).toBe(true);

    // Actions survive
    const actions = actionRepo2.findRecentByCharacterId(restoredChar!.id, 5);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('hunt');
    expect(actions[0].outcome).toBe('success');
    expect(actions[0].player_rolled).toBe(16);
  });
});
