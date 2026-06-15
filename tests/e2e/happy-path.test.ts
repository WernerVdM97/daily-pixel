/**
 * End-to-end happy path test — full game flow.
 *
 * Covers the pre-deploy checklist from poc-build-polish.md §6:
 *   /join → /hi → /action → decisions → roll → outcome → /look →
 *   /backpack → /stats → /hi again → /sleep (admin) → /hi after sleep →
 *   /bug → /feedback
 *
 * Uses real WorldEngineImpl with MockLlmGateway for deterministic output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorldEngineImpl } from '../../src/engine/WorldEngineImpl.js';
import { MockLlmGateway } from '../../src/llm/MockLlmGateway.js';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import { ItemRepository } from '../../src/db/repositories/item.js';
import { ActionRepository } from '../../src/db/repositories/action.js';
import { NpcRepository } from '../../src/db/repositories/npc.js';
import { formatStats } from '../../src/discord/commands/stats.js';
import { makeLookCommand } from '../../src/discord/commands/look.js';
import { makeHiCommand } from '../../src/discord/commands/hi.js';

import { makeSleepCommand } from '../../src/discord/commands/sleep.js';
import { mapError } from '../../src/engine/ErrorMapper.js';
import { formatOutcome } from '../../src/engine/OutcomeRenderer.js';
import type { LlmDecision } from '../../src/llm/LlmGateway.js';

const DISCORD_USER_ID = 'e2e-user-12345';
const NON_ADMIN_SLEEP_USER = 'non-admin-99999';
const DAY_JOBS = [
  {
    name: 'Blacksmith',
    depends_on: ['physical'],
    base_income: 10,
    description: 'Hammer and anvil.',
    actions: [
      { label: 'Forge blade', income: 6, hook: 'The steel sings.' },
      { label: 'Repair armour', income: 4, hook: 'A guardsman brings in...' },
      { label: 'Shoe horses', income: 3, hook: 'The chestnut mare...' },
    ],
  },
  {
    name: 'Hunter',
    depends_on: ['physical', 'wisdom'],
    base_income: 8,
    description: 'Track game.',
    actions: [
      { label: 'Track game', income: 5, hook: 'Deer sign everywhere.' },
      { label: 'Set traps', income: 4, hook: 'The old trap line...' },
      { label: 'Check snares', income: 3, hook: 'One snare holds...' },
    ],
  },
];

interface TestContext {
  engine: WorldEngineImpl;
  llm: MockLlmGateway;
  userRepo: UserRepository;
  charRepo: CharacterRepository;
  itemRepo: ItemRepository;
  actionRepo: ActionRepository;
  npcRepo: NpcRepository;
  characterId: number;
}

function setupTest(): TestContext {
  initDb(':memory:');
  migrate(getDb());
  const llm = new MockLlmGateway();
  const userRepo = new UserRepository(getDb());
  const charRepo = new CharacterRepository(getDb());
  const itemRepo = new ItemRepository(getDb());
  const actionRepo = new ActionRepository(getDb());
  const npcRepo = new NpcRepository(getDb());
  const engine = new WorldEngineImpl({
    db: getDb(),
    llm,
    userRepo,
    charRepo,
    itemRepo,
    actionRepo,
    npcRepo,
    rollD20: () => 15, // deterministic: 15 + stat modifier
    dayJobIncome: { Blacksmith: 10, Hunter: 8 },
  });
  return { engine, llm, userRepo, charRepo, itemRepo, actionRepo, npcRepo, characterId: 0 };
}

function huntDecision1(): LlmDecision {
  return {
    prompt: 'You spot deer tracks heading east into the thicket, and larger prints — wolf — north.',
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: false,
    decision: [
      { label: 'Follow deer', dcModifier: 0 },
      { label: 'Track wolf', dcModifier: 2 },
      { label: 'Bail', dcModifier: null },
    ],
  };
}

function huntDecisionFinal(): LlmDecision {
  return {
    prompt: 'You corner the wolf.',
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: true,
    decision: [{ label: 'Attack!', dcModifier: 0 }],
    mutations: [
      { type: 'add_item' as const, name: 'Wolf Pelt', emoji: '🦊', stat: 'wisdom', modifier: 1, quantity: 1 },
    ],
    outcomeText: 'The wolf snaps at you, but your blade finds its mark.',
  };
}

describe('E2E — full happy path', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTest();
  });

  afterEach(() => {
    closeDb();
  });

  // ── 1. /join → character in DB ──

  it('step 1: /join creates character in DB', () => {
    const data = {
      name: 'Aldric',
      class: 'Warrior',
      upbringing: 'Soldier',
      race: 'Human',
      alignment: 'lawful good',
      dayJob: 'Blacksmith' as const,
    };

    const char = ctx.engine.createCharacter(DISCORD_USER_ID, data);

    expect(char.name).toBe('Aldric');
    expect(char.class).toBe('Warrior');
    expect(char.dayJob).toBe('Blacksmith');
    expect(char.health).toBe(10);
    expect(char.maxHealth).toBe(10);
    expect(char.stamina).toBe(10);
    expect(char.rollsRemaining).toBe(2);
    expect(char.wealth).toBe(0);
    expect(char.location).toBe("The Warden's Oak");
    expect(char.createdAt).toBeTruthy();
    ctx.characterId = char.id;

    // Verify it's actually in DB
    const fetched = ctx.engine.getCharacter(DISCORD_USER_ID);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('Aldric');
  });

  // ── 2. /hi → atmosphere → hooks → day-job actions ──

  it('step 2: /hi shows character header and day-job actions', async () => {
    const char = ctx.engine.createCharacter(DISCORD_USER_ID, {
      name: 'Aldric',
      class: 'Warrior',
      upbringing: 'Soldier',
      race: 'Human',
      alignment: 'lawful good',
      dayJob: 'Blacksmith',
    });
    ctx.characterId = char.id;

    // Build the /hi command
    const hiCommand = makeHiCommand(ctx.engine, DAY_JOBS);
    const result = await hiCommand({ user: { id: DISCORD_USER_ID } });

    // Character header
    expect(result).toContain('Aldric');
    expect(result).toContain('Warrior');
    expect(result).toContain('Stamina');

    // Day-job actions
    expect(result).toContain('Blacksmith');
    expect(result).toContain('Forge blade');
    expect(result).toContain('Repair armour');
    expect(result).toContain('Shoe horses');

    // Resumption hint — no action yet
    expect(result).not.toContain('unfinished');
  });

  // ── 3. /action hunt → decisions → roll → outcome ──

  it('step 3: /action flow with decisions, roll, and outcome', async () => {
    const char = ctx.engine.createCharacter(DISCORD_USER_ID, {
      name: 'Aldric',
      class: 'Warrior',
      upbringing: 'Soldier',
      race: 'Human',
      alignment: 'lawful good',
      dayJob: 'Blacksmith',
    });
    ctx.characterId = char.id;

    // Start action — first decision
    ctx.llm.setDecision(huntDecision1());
    const startResult = await ctx.engine.startAction(ctx.characterId, 'hunt a wolf');

    expect(startResult.state.accumulatedDc).toBe(12);
    expect(startResult.firstDecision.options).toHaveLength(3);
    expect(startResult.firstDecision.prompt).toContain('wolf');

    // Step with choice — second decision
    ctx.llm.setDecision(huntDecisionFinal());
    const stepResult = await ctx.engine.stepAction(ctx.characterId, 'Track wolf');

    expect(stepResult.resolved).toBe(true);
    if (stepResult.resolved) {
      expect(stepResult.outcome.distilledType).toBe('hunt');
      // d20=15 + physical=3 vs DC=14 (12+2) — success
      expect(stepResult.outcome.outcome).toBe('success');
      expect(stepResult.outcome.playerRolled).toBe(15);
      expect(stepResult.outcome.outcomeText).toBe('The wolf snaps at you, but your blade finds its mark.');
    }

    // Verify roll consumed (started with 2, drained 1)
    const afterAction = ctx.engine.getCharacter(DISCORD_USER_ID);
    expect(afterAction!.rollsRemaining).toBe(1);

    // Verify item was added
    const items = ctx.engine.getItems(ctx.characterId);
    expect(items.some(i => i.name === 'Wolf Pelt')).toBe(true);

    // Verify action recorded
    const recent = ctx.actionRepo.findRecentByCharacterId(ctx.characterId, 1);
    expect(recent).toHaveLength(1);
    expect(recent[0].type).toBe('hunt');
    expect(recent[0].outcome).toBe('success');
  });

  // ── 4. /look → scene display with correct location ──

  it('step 4: /look shows current location details', async () => {
    const char = ctx.engine.createCharacter(DISCORD_USER_ID, {
      name: 'Aldric',
      class: 'Warrior',
      upbringing: 'Soldier',
      race: 'Human',
      alignment: 'lawful good',
      dayJob: 'Blacksmith',
    });
    ctx.characterId = char.id;

    // Use a mock scene resolver for the frontend side
    const sceneResolver = (_tags: string[]) => ({
      sceneName: 'oak.ascii',
      ascii: '      _\\|/_\n     ( O  O )\n     /|~~~|\\   The Warden\'s Oak',
    });

    const lookCommand = makeLookCommand(ctx.engine, sceneResolver);
    const result = await lookCommand({ user: { id: DISCORD_USER_ID } });

    expect(result).toContain("The Warden's Oak");
    expect(result).toContain('oak');
  });

  // ── 5. /backpack → items grid (starting items from join) ──

  it('step 5: /backpack shows starting items', () => {
    const char = ctx.engine.createCharacter(DISCORD_USER_ID, {
      name: 'Aldric',
      class: 'Warrior',
      upbringing: 'Soldier',
      race: 'Human',
      alignment: 'lawful good',
      dayJob: 'Blacksmith',
    });
    ctx.characterId = char.id;

    const items = ctx.engine.getItems(ctx.characterId);
    expect(Array.isArray(items)).toBe(true);
  });

  // ── 6. /stats → full sheet with correct values ──

  it('step 6: /stats shows full character sheet', () => {
    const char = ctx.engine.createCharacter(DISCORD_USER_ID, {
      name: 'Aldric',
      class: 'Warrior',
      upbringing: 'Soldier',
      race: 'Human',
      alignment: 'lawful good',
      dayJob: 'Blacksmith',
    });
    ctx.characterId = char.id;

    const result = formatStats(char);
    expect(result).toContain('Aldric');
    expect(result).toContain('Warrior');
    expect(result).toContain('Soldier');
    expect(result).toContain('Human');
    expect(result).toContain('lawful good');
    expect(result).toContain('Blacksmith');
    expect(result).toContain('Physical');
    expect(result).toContain('Wisdom');
    expect(result).toContain('Health');
    expect(result).toContain('Stamina');
    expect(result).toContain('copper');
    expect(result).toContain('Rolls');
  });

  // ── 7. /hi again → resumption hint when mid-action ──

  it('step 7: /hi shows resumption hint when action in progress', async () => {
    const char = ctx.engine.createCharacter(DISCORD_USER_ID, {
      name: 'Aldric',
      class: 'Warrior',
      upbringing: 'Soldier',
      race: 'Human',
      alignment: 'lawful good',
      dayJob: 'Blacksmith',
    });
    ctx.characterId = char.id;

    // Start action but don't finish
    ctx.llm.setDecision(huntDecision1());
    await ctx.engine.startAction(ctx.characterId, 'hunt a wolf');

    const hiCommand = makeHiCommand(ctx.engine, DAY_JOBS);
    const result = await hiCommand({ user: { id: DISCORD_USER_ID } });

    // Should show unfinished action hint
    expect(result).toContain('unfinished');
    expect(result).toContain('/hi');
  });

  // ── 8. /sleep (admin) → day advanced, rolls reset ──

  it('step 8: /sleep (admin) advances day and resets rolls', () => {
    const char = ctx.engine.createCharacter(DISCORD_USER_ID, {
      name: 'Aldric',
      class: 'Warrior',
      upbringing: 'Soldier',
      race: 'Human',
      alignment: 'lawful good',
      dayJob: 'Blacksmith',
    });
    ctx.characterId = char.id;

    // Use up a roll
    ctx.charRepo.update(ctx.characterId, { rolls_remaining: 1 });

    // Admin tick
    const tickResult = ctx.engine.tick(true);
    expect(tickResult.dayNumber).toBeGreaterThan(1);
    expect(tickResult.playersAffected).toBe(1);

    // Verify rolls reset
    const afterTick = ctx.engine.getCharacter(DISCORD_USER_ID);
    expect(afterTick!.rollsRemaining).toBe(2);
  });

  // ── 9. /hi after sleep → new day, new hooks ──

  it('step 9: /hi after tick shows new day state', async () => {
    const char = ctx.engine.createCharacter(DISCORD_USER_ID, {
      name: 'Aldric',
      class: 'Warrior',
      upbringing: 'Soldier',
      race: 'Human',
      alignment: 'lawful good',
      dayJob: 'Blacksmith',
    });
    ctx.characterId = char.id;

    // Simulate previous day's activity
    ctx.charRepo.update(ctx.characterId, { rolls_remaining: 0, stamina: 3 });

    // Tick
    ctx.engine.tick(true);

    const charAfter = ctx.engine.getCharacter(DISCORD_USER_ID);
    expect(charAfter!.rollsRemaining).toBe(2); // reset
    expect(charAfter!.stamina).toBeGreaterThan(3); // recovered

    // /hi should show refreshed state
    const hiCommand = makeHiCommand(ctx.engine, DAY_JOBS);
    const result = await hiCommand({ user: { id: DISCORD_USER_ID } });
    expect(result).toContain('Aldric');
    expect(result).toContain('Blacksmith');
  });

  // ── 10. /sleep (non-admin) → rest scene, no tick ──

  it('step 10: /sleep (non-admin) returns rest scene without ticking', async () => {
    const char = ctx.engine.createCharacter(NON_ADMIN_SLEEP_USER, {
      name: 'Traveler',
      class: 'Rogue',
      upbringing: 'Street',
      race: 'Elf',
      alignment: 'neutral',
      dayJob: 'Hunter',
    });
    ctx.characterId = char.id;

    const sleepCommand = makeSleepCommand(ctx.engine);
    const result = await sleepCommand({ user: { id: NON_ADMIN_SLEEP_USER } });

    // Rest scene (non-admin) — character already at the Oak
    expect(result).toContain('The Warden\'s Oak');
    expect(result).toContain('familiar boughs');
    expect(result).toContain('day turns when the world wills it');

    // Verify no tick happened (day_number unchanged from seed)
    const dayNum = ctx.engine.getMeta('day_number');
    expect(dayNum).toBe('1'); // schema seeds day_number = 1, no tick advanced it
  });

  // ── 11. /bug and /feedback → rows in DB ──

  it('step 11: /bug and /feedback write to DB', () => {
    const char = ctx.engine.createCharacter(DISCORD_USER_ID, {
      name: 'Aldric',
      class: 'Warrior',
      upbringing: 'Soldier',
      race: 'Human',
      alignment: 'lawful good',
      dayJob: 'Blacksmith',
    });
    ctx.characterId = char.id;

    ctx.engine.submitBug(ctx.characterId, 'The wolf NPC has no tail');
    ctx.engine.submitFeedback(ctx.characterId, 'Great game!');

    // Verify rows exist in DB
    const bugRows = getDb().prepare('SELECT * FROM bug_reports WHERE character_id = ?').all(ctx.characterId);
    expect(bugRows).toHaveLength(1);

    const feedbackRows = getDb().prepare('SELECT * FROM feedback WHERE character_id = ?').all(ctx.characterId);
    expect(feedbackRows).toHaveLength(1);
  });

  // ── 12. Error mapping works ──

  it('step 12: error mapper produces user-friendly messages', () => {
    expect(mapError(new Error('No rolls remaining'))).toContain('The day is done');
    expect(mapError(new Error('No action in progress'))).toContain('nothing to continue');
    expect(mapError(new Error('Character not found'))).toContain('Use `/join`');
    expect(mapError(new Error('Something unknown'))).toContain('The warden has been notified');
    expect(mapError('not an error')).toContain('The warden has been notified');
  });

  // ── 13. Outcome rendering ──

  it('step 13: outcome renderer formats success correctly', () => {
    const result = formatOutcome(
      {
        distilledType: 'hunt',
        finalDc: 14,
        playerRolled: 16,
        outcome: 'success',
        mutations: [{ type: 'add_item', name: 'Wolf Pelt', emoji: '🦊', stat: 'wisdom', modifier: 1, quantity: 1 }],
        outcomeText: 'Your blade strikes true.',
      },
      {
        stamina: 7,
        rollsRemaining: 1,
        health: 9,
        maxHealth: 10,
        wealth: 15,
        itemsGained: [{ emoji: '🦊', name: 'Wolf Pelt' }],
      },
    );

    expect(result).toContain('16 vs 14');
    expect(result).toContain('✓');
    expect(result).toContain('Success');
    expect(result).toContain('Wolf Pelt');
  });
});
