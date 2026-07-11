import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorldEngineImpl } from '../../src/engine/WorldEngineImpl.js';
import { MockPipelineGateway } from '../helpers/MockPipelineGateway.js';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import { ItemRepository } from '../../src/db/repositories/item.js';
import { ActionRepository } from '../../src/db/repositories/action.js';
import { NpcRepository } from '../../src/db/repositories/npc.js';
import { LocationRepository } from '../../src/db/repositories/location.js';
import { MetaRepository } from '../../src/db/repositories/meta.js';
import type { NpcRow } from '../../src/db/repositories/types.js';

// ── Helpers ──

function createTestChar(
  charRepo: CharacterRepository,
  userRepo: UserRepository,
  overrides?: {
    location?: string;
    rolls_remaining?: number;
    stamina?: number;
    max_stamina?: number;
    health?: number;
    max_health?: number;
    wealth?: number;
    day_job?: string;
    /** Set last_played_at after creation. Use raw date string 'YYYY-MM-DD HH:MM:SS'. */
    last_played_at?: string;
  },
): { userId: number; characterId: number } {
  const user = userRepo.create('123456789');
  const char = charRepo.create(user.id, {
    name: 'Aldric',
    class: 'Warrior',
    upbringing: 'Village',
    race: 'Human',
    alignment: 'lawful good',
    day_job: overrides?.day_job ?? 'Blacksmith',
    stats: JSON.stringify({ physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }),
    health: overrides?.health ?? 12,
    max_health: overrides?.max_health ?? 12,
    stamina: overrides?.stamina ?? 10,
    max_stamina: overrides?.max_stamina ?? 10,
    rolls_remaining: overrides?.rolls_remaining ?? 2,
    location: overrides?.location ?? "The Warden's Oak",
    wealth: overrides?.wealth ?? 5,
    last_action_state: null,
  });

  // Post-creation: stamp last_played_at if provided
  if (overrides?.last_played_at !== undefined) {
    charRepo.update(char.id, { last_played_at: overrides.last_played_at });
  }

  return { userId: user.id, characterId: char.id };
}

function createNpc(npcRepo: NpcRepository, actionRepo: ActionRepository, characterId: number, overrides?: {
  name?: string;
  class?: string;
  location?: string;
  wealth?: number;
}): NpcRow {
  const action = actionRepo.create({
    characterId,
    rawInput: 'spawn',
    type: 'spawn',
    decisionsJson: '[]',
    finalDc: 0,
    playerRolled: null,
    outcome: 'success',
  });
  return npcRepo.create({
    name: overrides?.name ?? 'Test NPC',
    class: overrides?.class ?? 'Hunter',
    location: overrides?.location ?? 'The Warden\'s Oak',
    wealth: overrides?.wealth ?? 10,
    createdByActionId: action.id,
  });
}

function makeEngine(overrides?: { dayJobIncome?: Record<string, number> }) {
  const pipelineGateway = new MockPipelineGateway();
  const userRepo = new UserRepository(getDb());
  const charRepo = new CharacterRepository(getDb());
  const itemRepo = new ItemRepository(getDb());
  const actionRepo = new ActionRepository(getDb());
  const npcRepo = new NpcRepository(getDb());
  const locationRepo = new LocationRepository(getDb());
  const metaRepo = new MetaRepository(getDb());

  const engine = new WorldEngineImpl({
    db: getDb(),
    pipelineLlmGateway: pipelineGateway,
    userRepo,
    charRepo,
    itemRepo,
    actionRepo,
    npcRepo,
    rollD20: () => 15,
    dayJobIncome: overrides?.dayJobIncome ?? { Blacksmith: 10 },
  });

  return { engine, pipelineGateway, userRepo, charRepo, itemRepo, actionRepo, npcRepo, locationRepo, metaRepo };
}

// ── Tests ──

describe('world tick', () => {
  beforeEach(() => {
    initDb(':memory:');
    migrate(getDb());
    vi.useFakeTimers();
  });

  afterEach(() => {
    closeDb();
    vi.useRealTimers();
  });

  describe('day_number advancement', () => {
    it('increments day_number from 1 to 2 on admin tick', () => {
      const { engine, metaRepo } = makeEngine();
      expect(metaRepo.get('day_number')).toBe('1');

      const result = engine.tick(true);

      expect(result.dayNumber).toBe(2);
      expect(metaRepo.get('day_number')).toBe('2');
    });

    it('increments day_number repeatedly on multiple admin ticks', () => {
      const { engine, metaRepo } = makeEngine();

      engine.tick(true);
      expect(metaRepo.get('day_number')).toBe('2');

      engine.tick(true);
      expect(metaRepo.get('day_number')).toBe('3');

      engine.tick(true);
      expect(metaRepo.get('day_number')).toBe('4');
    });

    it('reports the new day number in TickResult', () => {
      const { engine } = makeEngine();
      const result = engine.tick(true);
      expect(result.dayNumber).toBe(2);
    });
  });

  describe('cron idempotency', () => {
    it('cron (isAdmin=false) runs tick if last_cron_date is empty', () => {
      vi.setSystemTime(new Date('2026-06-15T03:30:00Z'));
      const { engine, metaRepo } = makeEngine();
      expect(metaRepo.get('last_cron_date')).toBe('');

      const result = engine.tick(false);

      expect(metaRepo.get('day_number')).toBe('2');
      expect(metaRepo.get('last_cron_date')).toBe('2026-06-15');
      expect(result.dayNumber).toBe(2);
    });

    it('cron is a no-op if last_cron_date is already today', () => {
      vi.setSystemTime(new Date('2026-06-15T03:30:00Z'));
      const { engine, metaRepo } = makeEngine();

      // Admin ticks first
      engine.tick(true);
      expect(metaRepo.get('last_cron_date')).toBe('2026-06-15');
      expect(metaRepo.get('day_number')).toBe('2');

      // Cron fires — should skip
      const result = engine.tick(false);

      // Day did NOT advance again
      expect(metaRepo.get('day_number')).toBe('2');
      expect(result.dayNumber).toBe(2);
      expect(result.playersAffected).toBe(0);
      expect(result.npcMovements).toEqual([]);
    });

    it('cron runs normally on a new day', () => {
      // Day 1: admin ticks
      vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
      const { engine, metaRepo } = makeEngine();
      engine.tick(true);
      expect(metaRepo.get('day_number')).toBe('2');

      // Next day: cron fires
      vi.setSystemTime(new Date('2026-06-16T03:30:00Z'));
      const result = engine.tick(false);

      expect(metaRepo.get('day_number')).toBe('3');
      expect(result.dayNumber).toBe(3);
    });

    it('admin tick always advances regardless of last_cron_date', () => {
      vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
      const { engine, metaRepo } = makeEngine();

      engine.tick(true);
      expect(metaRepo.get('day_number')).toBe('2');

      // Admin ticks again on same day — advances
      engine.tick(true);
      expect(metaRepo.get('day_number')).toBe('3');
    });
  });

  describe('player effects', () => {
    // Pin to a Monday so the Saturday bonus-roll path doesn't perturb the
    // baseline roll-reset expectations (the suite otherwise runs at real "now").
    beforeEach(() => {
      vi.setSystemTime(new Date('2026-06-15T03:30:00Z'));
    });

    it('resets rolls_remaining to 3 after tick', () => {
      const { engine, charRepo, userRepo } = makeEngine();
      createTestChar(charRepo, userRepo, { rolls_remaining: 1 });

      engine.tick(true);

      const char = charRepo.findByUserId(1);
      expect(char!.rolls_remaining).toBe(3);
    });

    it('resets rolls_remaining to 3 even when player had 0 rolls', () => {
      const { engine, charRepo, userRepo } = makeEngine();
      createTestChar(charRepo, userRepo, { rolls_remaining: 0 });

      engine.tick(true);

      const char = charRepo.findByUserId(1);
      expect(char!.rolls_remaining).toBe(3);
    });

    it('grants a bonus roll on the Saturday tick (3 + 1 = 4)', () => {
      vi.setSystemTime(new Date('2026-06-20T03:30:00Z')); // a Saturday
      const { engine, charRepo, userRepo } = makeEngine();
      createTestChar(charRepo, userRepo, { rolls_remaining: 0 });

      engine.tick(true);

      expect(charRepo.findByUserId(1)!.rolls_remaining).toBe(4);
    });

    it('recovers stamina +5 at safe location (capped at 10)', () => {
      const { engine, charRepo, userRepo } = makeEngine();
      createTestChar(charRepo, userRepo, {
        stamina: 3,
        location: "The Warden's Oak", // safe location (is_safe=1)
      });

      engine.tick(true);

      const char = charRepo.findByUserId(1);
      expect(char!.stamina).toBe(8); // 3 + 5 = 8
    });

    it('caps stamina recovery at 10', () => {
      const { engine, charRepo, userRepo } = makeEngine();
      createTestChar(charRepo, userRepo, {
        stamina: 7,
        location: "The Warden's Oak", // safe
      });

      engine.tick(true);

      const char = charRepo.findByUserId(1);
      expect(char!.stamina).toBe(10); // 7 + 5 = 12 → capped at 10
    });

    it('recovers health +3 at safe location (capped at max_health)', () => {
      const { engine, charRepo, userRepo } = makeEngine();
      createTestChar(charRepo, userRepo, {
        health: 5,
        max_health: 12,
        location: "The Warden's Oak",
      });

      engine.tick(true);

      const char = charRepo.findByUserId(1);
      expect(char!.health).toBe(8); // 5 + 3 = 8
    });

    it('caps health recovery at max_health', () => {
      const { engine, charRepo, userRepo } = makeEngine();
      createTestChar(charRepo, userRepo, {
        health: 11,
        max_health: 12,
        location: "The Warden's Oak",
      });

      engine.tick(true);

      const char = charRepo.findByUserId(1);
      expect(char!.health).toBe(12); // 11 + 3 = 14 → capped
    });

    it('decays stamina by 1 in non-safe locations (floored at 0)', () => {
      const { engine, charRepo, userRepo, locationRepo } = makeEngine();
      locationRepo.create({ name: 'Dark Forest', tags: 'forest,wilderness', isSafe: 0 });
      createTestChar(charRepo, userRepo, {
        stamina: 5,
        location: 'Dark Forest',
      });

      engine.tick(true);

      const char = charRepo.findByUserId(1);
      expect(char!.stamina).toBe(4); // 5 - 1 = 4
    });

    it('floors stamina decay at 0 in wilds', () => {
      const { engine, charRepo, userRepo, locationRepo } = makeEngine();
      locationRepo.create({ name: 'Dark Forest', tags: 'forest,wilderness', isSafe: 0 });
      createTestChar(charRepo, userRepo, {
        stamina: 0,
        location: 'Dark Forest',
      });

      engine.tick(true);

      const char = charRepo.findByUserId(1);
      expect(char!.stamina).toBe(0); // floored
    });

    it('adds base_income from day_job to wealth', () => {
      const { engine, charRepo, userRepo } = makeEngine({ dayJobIncome: { Blacksmith: 10 } });
      createTestChar(charRepo, userRepo, {
        wealth: 5,
        day_job: 'Blacksmith',
        location: "The Warden's Oak",
      });

      engine.tick(true);

      const char = charRepo.findByUserId(1);
      expect(char!.wealth).toBe(15); // 5 + 10
    });

    it('uses correct income per day_job', () => {
      const { engine, charRepo, userRepo } = makeEngine({
        dayJobIncome: { 'Town Guard': 10, 'Hunter': 8, 'Merchant': 14 },
      });
      const user = userRepo.create('user2');
      charRepo.create(user.id, {
        name: 'Mara',
        class: 'Ranger',
        upbringing: 'Village',
        race: 'Elf',
        alignment: 'neutral',
        day_job: 'Merchant',
        stats: JSON.stringify({ physical: 1, wisdom: 2, intelligence: 0, charisma: 0 }),
        health: 10,
        max_health: 10,
        stamina: 10,
        max_stamina: 10,
        rolls_remaining: 2,
        location: "The Warden's Oak",
        wealth: 20,
        last_action_state: null,
      });

      engine.tick(true);

      const char = charRepo.findByUserId(user.id);
      expect(char!.wealth).toBe(34); // 20 + 14
    });

    it('applies all effects to multiple characters', () => {
      const { engine, charRepo, userRepo, locationRepo } = makeEngine({
        dayJobIncome: { Blacksmith: 10, Hunter: 8 },
      });
      locationRepo.create({ name: 'Dark Forest', tags: 'forest,wilderness', isSafe: 0 });

      // Character 1: at safe location
      createTestChar(charRepo, userRepo, {
        stamina: 3,
        health: 5,
        wealth: 10,
        rolls_remaining: 0,
        location: "The Warden's Oak",
      });

      // Character 2: in wilds
      const user2 = userRepo.create('user2');
      charRepo.create(user2.id, {
        name: 'Mara',
        class: 'Ranger',
        upbringing: 'Village',
        race: 'Elf',
        alignment: 'neutral',
        day_job: 'Hunter',
        stats: JSON.stringify({ physical: 1, wisdom: 2, intelligence: 0, charisma: 0 }),
        health: 8,
        max_health: 10,
        stamina: 2,
        max_stamina: 10,
        rolls_remaining: 1,
        location: 'Dark Forest',
        wealth: 20,
        last_action_state: null,
      });

      const result = engine.tick(true);

      expect(result.playersAffected).toBe(2);

      // Check char 1 (safe)
      const char1 = charRepo.findByUserId(1);
      expect(char1!.stamina).toBe(8);  // 3 + 5 = 8
      expect(char1!.health).toBe(8);   // 5 + 3 = 8
      expect(char1!.wealth).toBe(20);  // 10 + 10
      expect(char1!.rolls_remaining).toBe(3);

      // Check char 2 (wilds)
      const char2 = charRepo.findByUserId(user2.id);
      expect(char2!.stamina).toBe(1);  // 2 - 1 = 1
      expect(char2!.health).toBe(8);   // wilds: no health change
      expect(char2!.wealth).toBe(28);  // 20 + 8
      expect(char2!.rolls_remaining).toBe(3);
    });

    it('does not modify health in wilds (no decay)', () => {
      const { engine, charRepo, userRepo, locationRepo } = makeEngine();
      locationRepo.create({ name: 'Dark Forest', tags: 'forest,wilderness', isSafe: 0 });
      createTestChar(charRepo, userRepo, {
        health: 7,
        location: 'Dark Forest',
      });

      engine.tick(true);

      const char = charRepo.findByUserId(1);
      expect(char!.health).toBe(7); // unchanged
    });

    it('reports playersAffected in TickResult', () => {
      const { engine, charRepo, userRepo } = makeEngine();
      createTestChar(charRepo, userRepo);

      const user2 = userRepo.create('user2-discord');
      charRepo.create(user2.id, {
        name: 'Mara',
        class: 'Ranger',
        upbringing: 'Village',
        race: 'Elf',
        alignment: 'neutral',
        day_job: 'Hunter',
        stats: JSON.stringify({ physical: 1, wisdom: 2, intelligence: 0, charisma: 0 }),
        health: 10,
        max_health: 10,
        stamina: 10,
        max_stamina: 10,
        rolls_remaining: 2,
        location: "The Warden's Oak",
        wealth: 10,
        last_action_state: null,
      });

      const result = engine.tick(true);
      expect(result.playersAffected).toBe(2);
    });

    describe('five-day absence warning', () => {
      beforeEach(() => {
        vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
      });
      afterEach(() => {
        vi.useRealTimers();
        vi.useFakeTimers();
      });

      it('never penalizes health for absence (full safe recovery regardless)', () => {
        const { engine, charRepo, userRepo } = makeEngine();
        createTestChar(charRepo, userRepo, {
          health: 4,
          max_health: 10,
          last_played_at: '2026-06-10 12:00:00', // 5 days absent
        });

        engine.tick(true);

        const char = charRepo.findByUserId(1);
        // Safe recovery: +3 → 7, NO absence penalty (penalty was removed)
        expect(char!.health).toBe(7);
      });

      it('warns the player who crosses exactly 5 days of absence', () => {
        const { engine, charRepo, userRepo } = makeEngine();
        createTestChar(charRepo, userRepo, {
          health: 10,
          max_health: 10,
          last_played_at: '2026-06-10 12:00:00', // exactly 5 days before 06-15
        });

        const result = engine.tick(true);

        expect(result.absentWarnings).toEqual(['123456789']);
        // Health untouched by absence — full safe recovery, capped.
        expect(charRepo.findByUserId(1)!.health).toBe(10);
      });

      it('does not warn before 5 days', () => {
        const { engine, charRepo, userRepo } = makeEngine();
        createTestChar(charRepo, userRepo, {
          last_played_at: '2026-06-11 12:00:00', // 4 days
        });

        expect(engine.tick(true).absentWarnings).toEqual([]);
      });

      it('warns only on the 5-day mark, not afterwards (no nightly spam)', () => {
        const { engine, charRepo, userRepo } = makeEngine();
        createTestChar(charRepo, userRepo, {
          last_played_at: '2026-06-09 12:00:00', // 6 days — already past the mark
        });

        expect(engine.tick(true).absentWarnings).toEqual([]);
      });

      it('does not warn when last_played_at is null (new character)', () => {
        const { engine, charRepo, userRepo } = makeEngine();
        createTestChar(charRepo, userRepo, { health: 10, max_health: 10 });

        const result = engine.tick(true);

        expect(result.absentWarnings).toEqual([]);
        // Full safe recovery still applies.
        expect(charRepo.findByUserId(1)!.health).toBe(10);
      });
    });

    describe('collapse — stamina bottoming out', () => {
      it('flags the player whose stamina drops to 0 in an unsafe location', () => {
        const { engine, charRepo, userRepo } = makeEngine();
        createTestChar(charRepo, userRepo, {
          location: 'The Dark Pines', // unsafe → -1 stamina
          stamina: 1,
        });

        const result = engine.tick(true);

        expect(charRepo.findByUserId(1)!.stamina).toBe(0);
        expect(result.collapsedNames).toEqual(['Aldric']);
      });

      it('does not flag a player who recovers in a safe location', () => {
        const { engine, charRepo, userRepo } = makeEngine();
        createTestChar(charRepo, userRepo, {
          location: "The Warden's Oak", // safe → +5 stamina
          stamina: 1,
        });

        expect(engine.tick(true).collapsedNames).toEqual([]);
      });

      it('does not re-flag a player already at 0 stamina', () => {
        const { engine, charRepo, userRepo } = makeEngine();
        createTestChar(charRepo, userRepo, {
          location: 'The Dark Pines',
          stamina: 0, // already bottomed — no transition this tick
        });

        expect(engine.tick(true).collapsedNames).toEqual([]);
      });
    });

    describe('countSoulsInUnsafe (live goodnight count)', () => {
      it('counts a player at an unsafe location', () => {
        const { engine, charRepo, userRepo, locationRepo } = makeEngine();
        locationRepo.create({ name: 'Dark Forest', tags: 'forest,wilderness', isSafe: 0 });
        createTestChar(charRepo, userRepo, { location: 'Dark Forest' });

        expect(engine.countSoulsInUnsafe()).toBe(1);
      });

      it('is zero when everyone rests at a safe location', () => {
        const { engine, charRepo, userRepo } = makeEngine();
        createTestChar(charRepo, userRepo, { location: "The Warden's Oak" });

        expect(engine.countSoulsInUnsafe()).toBe(0);
      });
    });

    describe('getLeaderboards', () => {
      it('ranks a player on both the wealth and might boards', () => {
        const { engine, charRepo, userRepo } = makeEngine();
        createTestChar(charRepo, userRepo, { wealth: 99 });

        const boards = engine.getLeaderboards(5);

        expect(boards.wealth[0]).toMatchObject({ name: 'Aldric', value: 99 });
        // Seeded stats are physical:3 (highest), wisdom:-1, intelligence:0, charisma:0.
        expect(boards.might[0]).toMatchObject({ name: 'Aldric', stat: 'physical', value: 3 });
      });

      it('ranks the might board on effective scores — gear bonuses count', () => {
        const { engine, charRepo, userRepo, itemRepo } = makeEngine();
        const { characterId } = createTestChar(charRepo, userRepo);
        // Base stats: physical 3 (highest), charisma 0. A +4 charisma item lifts
        // effective charisma to 4, so the board must report charisma/4, not physical/3.
        itemRepo.create(characterId, {
          name: 'Silver Tongue Charm', emoji: '💬', stat: 'charisma', modifier: 4, quantity: 1,
        });

        const boards = engine.getLeaderboards(5);

        expect(boards.might[0]).toMatchObject({ name: 'Aldric', stat: 'charisma', value: 4 });
      });

      it('returns empty boards when there are no characters', () => {
        const { engine } = makeEngine();
        expect(engine.getLeaderboards(5)).toEqual({ wealth: [], might: [] });
      });
    });

    describe('getActionsBetween (weekly recap window)', () => {
      function seedAction(actionRepo: import('../../src/db/repositories/action.js').ActionRepository, characterId: number, type: string, outcome: string) {
        actionRepo.create({
          characterId, rawInput: 'do a thing', type, decisionsJson: '[]',
          finalDc: 10, playerRolled: null, outcome, narrative: `${type} narrative`,
        });
      }

      // NB: rows are stamped with SQLite's real-time datetime('now'), which the
      // suite's fake timers don't touch — so we bound on fixed all-time / past
      // windows rather than a "today"-relative one.
      it('returns the window\'s actions joined to the character name, oldest first', () => {
        const { engine, charRepo, userRepo, actionRepo } = makeEngine();
        const { characterId } = createTestChar(charRepo, userRepo);
        seedAction(actionRepo, characterId, 'travel', 'success');
        seedAction(actionRepo, characterId, 'forage', 'failure');

        const rows = engine.getActionsBetween('2000-01-01', '9999-12-31');

        expect(rows.length).toBe(2);
        expect(rows[0]).toEqual({ character: 'Aldric', type: 'travel', outcome: 'success', narrative: 'travel narrative' });
        expect(rows[1].type).toBe('forage');
      });

      it('excludes actions outside the window', () => {
        const { engine, charRepo, userRepo, actionRepo } = makeEngine();
        const { characterId } = createTestChar(charRepo, userRepo);
        seedAction(actionRepo, characterId, 'travel', 'success');

        // A window entirely in the past — today's rows must not appear.
        expect(engine.getActionsBetween('2000-01-01', '2000-01-02')).toEqual([]);
      });
    });

    describe('spawnNpc (engine-driven)', () => {
      it('places an NPC at the given location, findable by location', () => {
        const { engine, npcRepo } = makeEngine();
        engine.spawnNpc({
          name: 'The Pale Stalker',
          class: 'Beast',
          description: 'A gaunt thing between the trunks.',
          location: 'The Dark Pines',
        });

        const here = npcRepo.findByLocation('The Dark Pines');
        expect(here.some((n) => n.name === 'The Pale Stalker')).toBe(true);
      });

      it('anchors a spawned threat to its announced location so it does not wander off on the tick (N1)', () => {
        const { engine, npcRepo, locationRepo } = makeEngine();
        // Two wilderness nodes so the wander has a real destination to drift to — otherwise the
        // test would pass even un-anchored (nowhere to move).
        locationRepo.create({ name: 'The Forest Edge', tags: 'forest,wilderness', isSafe: 0 });
        locationRepo.create({ name: 'The Dark Pines', tags: 'forest,wilderness', isSafe: 0 });
        engine.spawnNpc({ name: 'The Bramble Boar', class: 'Beast', location: 'The Forest Edge' });

        // 10 admin ticks: an un-anchored 80%-per-tick mover would almost surely have drifted by now
        // (P(stay 10×) = 0.2^10 ≈ 1e-7); the anchor keeps the threat on its announced spot.
        for (let i = 0; i < 10; i++) engine.tick(true);

        expect(npcRepo.findByLocation('The Forest Edge').map((n) => n.name)).toContain('The Bramble Boar');
      });

      it('is idempotent — re-announcing the same threat at the same spot adds no duplicate', () => {
        const { engine, npcRepo, locationRepo } = makeEngine();
        locationRepo.create({ name: 'The Forest Edge', tags: 'forest,wilderness', isSafe: 0 });
        engine.spawnNpc({ name: 'The Bramble Boar', class: 'Beast', location: 'The Forest Edge' });
        engine.spawnNpc({ name: 'The Bramble Boar', class: 'Beast', location: 'The Forest Edge' });

        const boars = npcRepo.findByLocation('The Forest Edge').filter((n) => n.name === 'The Bramble Boar');
        expect(boars).toHaveLength(1);
      });
    });
  });

  describe('NPC movement', () => {
    it('same NPC + same day_number = same destination (seeded determinism)', () => {
      const { engine, npcRepo, actionRepo, charRepo, userRepo, locationRepo } = makeEngine();
      locationRepo.create({ name: 'Alpha Wood', tags: 'forest,wilderness', isSafe: 0 });
      locationRepo.create({ name: 'Beta Square', tags: 'town,square,market', isSafe: 1 });
      const { characterId } = createTestChar(charRepo, userRepo);
      createNpc(npcRepo, actionRepo, characterId, { name: 'Gorlag', class: 'Hunter', location: 'Beta Square' });

      // First tick: NPC moves from Beta Square to somewhere
      const first = engine.tick(true);
      const firstMovement = first.npcMovements[0];
      expect(firstMovement).toBeDefined();

      // Second tick on same day advances to day 3, producing a different seed
      // — we just verify the NPC keeps moving deterministically.
      // (Full reproduciblity requires two identical starting states, which
      // means two in-memory DBs; the class-based test below covers the
      // actual movement pattern.)
      expect(firstMovement.toLocation).toBe('Alpha Wood');
    });

    it('moves hunter to forest/wilderness location', () => {
      const { engine, npcRepo, actionRepo, charRepo, userRepo, locationRepo } = makeEngine();

      // Add locations
      locationRepo.create({ name: 'Dark Forest', tags: 'forest,wilderness', isSafe: 0 });
      locationRepo.create({ name: 'Town Square', tags: 'town,square,market', isSafe: 1 });

      const { characterId } = createTestChar(charRepo, userRepo);
      const npc = createNpc(npcRepo, actionRepo, characterId, {
        name: 'Gorlag',
        class: 'Hunter',
        location: 'Town Square',
      });

      const result = engine.tick(true);

      // Hunter should move to Dark Forest (tags match wilderness/forest)
      const movedNpc = result.npcMovements.find(m => m.npcId === npc.id);
      expect(movedNpc).toBeDefined();
      if (movedNpc) {
        expect(movedNpc.fromLocation).toBe('Town Square');
        expect(movedNpc.toLocation).toBe('Dark Forest');
      }
    });

    it('moves merchant to town/market/square location', () => {
      const { engine, npcRepo, actionRepo, charRepo, userRepo, locationRepo } = makeEngine();
      locationRepo.create({ name: 'Dark Forest', tags: 'forest,wilderness', isSafe: 0 });
      locationRepo.create({ name: 'Town Square', tags: 'town,square,market', isSafe: 1 });

      const { characterId } = createTestChar(charRepo, userRepo);
      const npc = createNpc(npcRepo, actionRepo, characterId, {
        name: 'Lira',
        class: 'Merchant',
        location: 'Dark Forest',
      });

      const result = engine.tick(true);

      const movedNpc = result.npcMovements.find(m => m.npcId === npc.id);
      expect(movedNpc).toBeDefined();
      if (movedNpc) {
        expect(movedNpc.toLocation).toBe('Town Square');
      }
    });

    it('keeps blacksmith in place and adds wealth', () => {
      const { engine, npcRepo, actionRepo, charRepo, userRepo } = makeEngine();
      const { characterId } = createTestChar(charRepo, userRepo);
      const npc = createNpc(npcRepo, actionRepo, characterId, {
        name: 'Hrothgar',
        class: 'Blacksmith',
        location: "The Warden's Oak",
        wealth: 10,
      });

      const result = engine.tick(true);

      // Blacksmith should not move (and should gain wealth)
      const movedNpc = result.npcMovements.find(m => m.npcId === npc.id);
      expect(movedNpc).toBeUndefined();

      // Blacksmith wealth += 5
      const updatedNpc = npcRepo.findAll().find(n => n.id === npc.id);
      expect(updatedNpc!.wealth).toBe(15);
    });

    it('moves acolyte to shrine/temple location', () => {
      const { engine, npcRepo, actionRepo, charRepo, userRepo, locationRepo } = makeEngine();
      locationRepo.create({ name: 'Shrine of the Oak', tags: 'shrine,sacred', isSafe: 1 });
      locationRepo.create({ name: 'Dark Forest', tags: 'forest,wilderness', isSafe: 0 });

      const { characterId } = createTestChar(charRepo, userRepo);
      const npc = createNpc(npcRepo, actionRepo, characterId, {
        name: 'Brother Elyas',
        class: 'Acolyte',
        location: 'Dark Forest',
      });

      const result = engine.tick(true);

      const movedNpc = result.npcMovements.find(m => m.npcId === npc.id);
      expect(movedNpc).toBeDefined();
      if (movedNpc) {
        expect(movedNpc.toLocation).toBe('Shrine of the Oak');
      }
    });

    it('moves herbalist to forest/river location', () => {
      const { engine, npcRepo, actionRepo, charRepo, userRepo, locationRepo } = makeEngine();
      locationRepo.create({ name: 'River Bend', tags: 'river,water', isSafe: 0 });
      locationRepo.create({ name: 'Town Square', tags: 'town,square', isSafe: 1 });

      const { characterId } = createTestChar(charRepo, userRepo);
      const npc = createNpc(npcRepo, actionRepo, characterId, {
        name: 'Sage',
        class: 'Herbalist',
        location: 'Town Square',
      });

      const result = engine.tick(true);

      const movedNpc = result.npcMovements.find(m => m.npcId === npc.id);
      expect(movedNpc).toBeDefined();
      if (movedNpc) {
        expect(movedNpc.toLocation).toBe('River Bend');
      }
    });

    it('moves NPC with no class / other class to random location', () => {
      const { engine, npcRepo, actionRepo, charRepo, userRepo, locationRepo } = makeEngine();
      locationRepo.create({ name: 'Dark Forest', tags: 'forest,wilderness', isSafe: 0 });
      locationRepo.create({ name: 'Town Square', tags: 'town,square', isSafe: 1 });

      const { characterId } = createTestChar(charRepo, userRepo);
      const npc = createNpc(npcRepo, actionRepo, characterId, {
        name: 'Mystery Man',
        class: 'Wanderer', // not a recognized class
        location: "The Warden's Oak",
      });

      const result = engine.tick(true);

      const movedNpc = result.npcMovements.find(m => m.npcId === npc.id);
      expect(movedNpc).toBeDefined();
      if (movedNpc) {
        // Should move to some location
        expect(['Dark Forest', 'Town Square']).toContain(movedNpc.toLocation);
      }
    });

    it('merchant gains random wealth 5-15 on move', () => {
      // With seeded determinism, a given NPC on a given day always gets the same wealth
      const { engine, npcRepo, actionRepo, charRepo, userRepo, locationRepo } = makeEngine();
      locationRepo.create({ name: 'Town Square', tags: 'town,square,market', isSafe: 1 });
      locationRepo.create({ name: 'Dark Forest', tags: 'forest,wilderness', isSafe: 0 });

      const { characterId } = createTestChar(charRepo, userRepo);
      createNpc(npcRepo, actionRepo, characterId, {
        name: 'Lira',
        class: 'Merchant',
        location: 'Dark Forest',
        wealth: 10,
      });

      engine.tick(true);

      const updated = npcRepo.findAll().find(n => n.name === 'Lira');
      expect(updated!.wealth).toBeGreaterThanOrEqual(15);  // 10 + 5..15
      expect(updated!.wealth).toBeLessThanOrEqual(25);     // 10 + 5..15
    });

    it('updates NPC location in database on move', () => {
      const { engine, npcRepo, actionRepo, charRepo, userRepo, locationRepo } = makeEngine();
      locationRepo.create({ name: 'Dark Forest', tags: 'forest,wilderness', isSafe: 0 });
      locationRepo.create({ name: 'Town Square', tags: 'town,square,market', isSafe: 1 });

      const { characterId } = createTestChar(charRepo, userRepo);
      const npc = createNpc(npcRepo, actionRepo, characterId, {
        name: 'Gorlag',
        class: 'Hunter',
        location: 'Town Square',
      });

      engine.tick(true);

      const updated = npcRepo.findById(npc.id);
      expect(updated!.location).toBe('Dark Forest');
    });

    it('reports NPC movements in TickResult', () => {
      const { engine, npcRepo, actionRepo, charRepo, userRepo, locationRepo } = makeEngine();
      locationRepo.create({ name: 'Dark Forest', tags: 'forest,wilderness', isSafe: 0 });
      locationRepo.create({ name: 'Town Square', tags: 'town,square,market', isSafe: 1 });

      const { characterId } = createTestChar(charRepo, userRepo);
      const npc = createNpc(npcRepo, actionRepo, characterId, {
        name: 'Gorlag',
        class: 'Hunter',
        location: 'Town Square',
      });

      const result = engine.tick(true);

      expect(result.npcMovements).toHaveLength(1);
      expect(result.npcMovements[0]).toEqual({
        npcId: npc.id,
        npcName: 'Gorlag',
        fromLocation: 'Town Square',
        toLocation: 'Dark Forest',
      });
    });
  });

  describe('last_cron_date tracking', () => {
    it('sets last_cron_date on admin tick', () => {
      vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
      const { engine, metaRepo } = makeEngine();

      engine.tick(true);

      expect(metaRepo.get('last_cron_date')).toBe('2026-06-15');
    });

    it('sets last_cron_date on cron tick', () => {
      vi.setSystemTime(new Date('2026-06-15T03:30:00Z'));
      const { engine, metaRepo } = makeEngine();

      engine.tick(false);

      expect(metaRepo.get('last_cron_date')).toBe('2026-06-15');
    });
  });
});
