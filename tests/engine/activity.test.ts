import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorldEngineImpl } from '../../src/engine/WorldEngineImpl.js';
import { MockPipelineGateway } from '../helpers/MockPipelineGateway.js';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import { ItemRepository } from '../../src/db/repositories/item.js';
import { ActionRepository } from '../../src/db/repositories/action.js';
import { NpcRepository } from '../../src/db/repositories/npc.js';

// ── Helpers (same setup pattern as world-tick.test.ts) ──

function createTestChar(
  charRepo: CharacterRepository,
  userRepo: UserRepository,
  discordUserId: string,
  /** Raw date string 'YYYY-MM-DD HH:MM:SS'. Omit to leave last_played_at NULL. */
  lastPlayedAt?: string,
): number {
  const user = userRepo.create(discordUserId);
  const char = charRepo.create(user.id, {
    name: 'Aldric',
    class: 'Warrior',
    upbringing: 'Village',
    race: 'Human',
    alignment: 'lawful good',
    day_job: 'Blacksmith',
    stats: JSON.stringify({ physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }),
    health: 12,
    max_health: 12,
    stamina: 10,
    max_stamina: 10,
    rolls_remaining: 2,
    location: "The Warden's Oak",
    wealth: 5,
    last_action_state: null,
  });

  if (lastPlayedAt !== undefined) {
    charRepo.update(char.id, { last_played_at: lastPlayedAt });
  }
  return char.id;
}

function makeEngine(): {
  engine: WorldEngineImpl;
  userRepo: UserRepository;
  charRepo: CharacterRepository;
} {
  const userRepo = new UserRepository(getDb());
  const charRepo = new CharacterRepository(getDb());
  const itemRepo = new ItemRepository(getDb());
  const actionRepo = new ActionRepository(getDb());
  const npcRepo = new NpcRepository(getDb());

  const engine = new WorldEngineImpl({
    db: getDb(),
    pipelineLlmGateway: new MockPipelineGateway(),
    userRepo,
    charRepo,
    itemRepo,
    actionRepo,
    npcRepo,
    rollD20: () => 15,
  });

  return { engine, userRepo, charRepo };
}

// ── Tests ──

describe('countActivePlayersSince', () => {
  beforeEach(() => {
    initDb(':memory:');
    migrate(getDb());
  });

  afterEach(() => {
    closeDb();
  });

  it('is 0 with no characters at all', () => {
    const { engine } = makeEngine();
    expect(engine.countActivePlayersSince('2026-08-05')).toBe(0);
  });

  it('counts a character who played today', () => {
    const { engine, charRepo, userRepo } = makeEngine();
    createTestChar(charRepo, userRepo, '111111111', '2026-08-05 10:30:00');

    expect(engine.countActivePlayersSince('2026-08-05')).toBe(1);
  });

  it('counts the day boundary — a stamp exactly at 00:00:00 belongs to the day', () => {
    const { engine, charRepo, userRepo } = makeEngine();
    createTestChar(charRepo, userRepo, '111111111', '2026-08-05 00:00:00');

    expect(engine.countActivePlayersSince('2026-08-05')).toBe(1);
  });

  it('excludes yesterday — a stamp one second before the boundary does not count', () => {
    const { engine, charRepo, userRepo } = makeEngine();
    createTestChar(charRepo, userRepo, '111111111', '2026-08-04 23:59:59');

    expect(engine.countActivePlayersSince('2026-08-05')).toBe(0);
  });

  it('is 0 for a character who has never played (NULL last_played_at)', () => {
    const { engine, charRepo, userRepo } = makeEngine();
    createTestChar(charRepo, userRepo, '111111111');

    expect(engine.countActivePlayersSince('2026-08-05')).toBe(0);
  });

  it('counts only today when the roster mixes today and yesterday', () => {
    const { engine, charRepo, userRepo } = makeEngine();
    createTestChar(charRepo, userRepo, '111111111', '2026-08-05 10:30:00');
    createTestChar(charRepo, userRepo, '222222222', '2026-08-04 23:59:59');

    expect(engine.countActivePlayersSince('2026-08-05')).toBe(1);
  });
});
