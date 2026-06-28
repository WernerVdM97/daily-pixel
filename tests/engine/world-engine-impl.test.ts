import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorldEngineImpl } from '../../src/engine/WorldEngineImpl.js';
import { MockLlmGateway } from '../../src/llm/MockLlmGateway.js';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { migrate, seedWorld, SEEDED_LOCATIONS, SEEDED_EDGES } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import { ItemRepository } from '../../src/db/repositories/item.js';
import { ActionRepository } from '../../src/db/repositories/action.js';
import { NpcRepository } from '../../src/db/repositories/npc.js';
import { LocationRepository } from '../../src/db/repositories/location.js';
import { LocationEdgeRepository } from '../../src/db/repositories/locationEdge.js';
import type { LlmDecision } from '../../src/llm/LlmGateway.js';
import { APP_VERSION } from '../../src/version.js';

// RED: tests fail because WorldEngineImpl doesn't exist yet

function huntFirstDecision(): LlmDecision {
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

function huntSecondDecision(): LlmDecision {
  return {
    prompt: 'The thicket is dense and dry. Move slow and quiet, or push through?',
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: false,
    decision: [
      { label: 'Stalk', dcModifier: -1 },
      { label: 'Rush', dcModifier: 2 },
      { label: 'Bail', dcModifier: null },
    ],
  };
}

function huntFinalDecision(): LlmDecision {
  return {
    prompt: 'You corner your prey.',
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: true,
    decision: [{ label: 'Attack!', dcModifier: 0 }],
    mutations: [
      { type: 'modify_health' as const, amount: -2 },
    ],
    outcomeText: 'The wolf snaps at you, but your blade finds its mark.',
  };
}

function createTestChar(
  userRepo: UserRepository,
  charRepo: CharacterRepository,
): { userId: number; characterId: number } {
  const user = userRepo.create('123456789');
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
    rolls_remaining: 2,
    location: "The Warden's Oak",
    wealth: 5,
    last_action_state: null,
  });
  return { userId: user.id, characterId: char.id };
}

describe('WorldEngineImpl — action state machine integration', () => {
  let engine: WorldEngineImpl;
  let llm: MockLlmGateway;
  let userRepo: UserRepository;
  let charRepo: CharacterRepository;
  let itemRepo: ItemRepository;
  let actionRepo: ActionRepository;
  let characterId: number;

  beforeEach(() => {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES); // VITEST skips auto-seed; movement is now graph-validated
    llm = new MockLlmGateway();
    userRepo = new UserRepository(getDb());
    charRepo = new CharacterRepository(getDb());
    itemRepo = new ItemRepository(getDb());
    actionRepo = new ActionRepository(getDb());
    const npcRepo = new NpcRepository(getDb());
    engine = new WorldEngineImpl({
      db: getDb(),
      llm,
      userRepo,
      charRepo,
      itemRepo,
      actionRepo,
      npcRepo,
      rollD20: () => 15, // deterministic: 15 + bonus
    });
    const { characterId: cid } = createTestChar(userRepo, charRepo);
    characterId = cid;
  });

  afterEach(() => {
    closeDb();
  });

  describe('startAction', () => {
    it('returns the first decision from the LLM', async () => {
      llm.setDecision(huntFirstDecision());

      const result = await engine.startAction(characterId, 'go hunt a wolf');

      expect(result.state.rawInput).toBe('go hunt a wolf');
      expect(result.state.decisions).toEqual([]);
      expect(result.state.accumulatedDc).toBe(12);
      expect(result.firstDecision.options).toHaveLength(3);
    });

    it('auto-finishes a done, choice-less action: logs an action row and applies mutations', async () => {
      llm.setDecision({
        distilledType: 'travel', stat: 'physical', baseDc: 10,
        required: false, done: true, decision: [],
        mutations: [
          { type: 'set_location', name: 'The Forest Edge' },
          { type: 'modify_stamina', amount: 2 },
        ],
        outcomeText: 'You arrive at the forest edge.',
      });

      const result = await engine.startAction(characterId, 'walk to the forest edge');

      // Outcome returned for direct rendering (no buttons), and no mid-action state left
      expect(result.outcome).toBeDefined();
      expect(result.outcome?.outcome).toBe('done');
      expect(charRepo.findById(characterId)?.last_action_state).toBeNull();

      // Logged to the DB as a normal action row
      const actions = actionRepo.findRecentByCharacterId(characterId, 5);
      expect(actions).toHaveLength(1);
      expect(actions[0].outcome).toBe('done');
      expect(actions[0].type).toBe('travel');

      // Mutations applied (stamina clamped at 10) + a roll drained
      const char = charRepo.findById(characterId);
      expect(char?.location).toBe('The Forest Edge');
      expect(char?.stamina).toBe(10);
      expect(char?.rolls_remaining).toBe(1);
    });

    // ── D1 roll economy: charge only when the world changes; refund the first
    //    no-op per day (ADR roll-economy-timeouts-and-world-growth §D1) ──
    describe('D1 roll economy (no-op refund)', () => {
      const noopDecision = (): LlmDecision => ({
        distilledType: 'wait', stat: 'wisdom', baseDc: 10,
        required: false, done: true, decision: [],
        mutations: [],
        outcomeText: 'The moment passes.',
      });

      it('refunds the roll on the first no-op auto-resolve of the day', async () => {
        llm.setDecision(noopDecision());
        const before = charRepo.findById(characterId)!.rolls_remaining; // 2

        const result = await engine.startAction(characterId, 'stand around');

        expect(result.outcome?.outcome).toBe('done');
        const after = charRepo.findById(characterId)!;
        expect(after.rolls_remaining).toBe(before); // refunded — unchanged
        expect(after.last_noop_refund_day).toBe(1); // stamped on the current day
      });

      it('charges the roll on the second no-op of the same day', async () => {
        // First no-op — refunded, stamps the day.
        llm.setDecision(noopDecision());
        await engine.startAction(characterId, 'stand around');
        const afterFirst = charRepo.findById(characterId)!.rolls_remaining; // 2

        // Second no-op same day — the freebie is spent, so this one costs a roll.
        llm.setDecision(noopDecision());
        await engine.startAction(characterId, 'stand around again');

        expect(charRepo.findById(characterId)!.rolls_remaining).toBe(afterFirst - 1);
      });

      it('charges a world-changing auto-resolve every time (not a no-op)', async () => {
        // A wealth gain genuinely changes the world → always costs a roll, and
        // must NOT consume the no-op freebie.
        llm.setDecision({
          distilledType: 'forage', stat: 'wisdom', baseDc: 10,
          required: false, done: true, decision: [],
          mutations: [{ type: 'modify_wealth', amount: 5 }],
          outcomeText: 'You find a few coins in the dirt.',
        });
        const before = charRepo.findById(characterId)!.rolls_remaining; // 2

        await engine.startAction(characterId, 'search the ground');

        const after = charRepo.findById(characterId)!;
        expect(after.rolls_remaining).toBe(before - 1); // charged
        expect(after.last_noop_refund_day ?? null).toBeNull(); // freebie untouched
      });

      it('refunds an auto-resolve whose only changes are stamina and/or rolls', async () => {
        // A "shrug" that merely tires the character (or fiddles rolls) is still a
        // no-op for the player — they got nothing for it — so the first per day
        // is refunded, exactly like an empty resolution.
        llm.setDecision({
          distilledType: 'wait', stat: 'wisdom', baseDc: 10,
          required: false, done: true, decision: [],
          mutations: [{ type: 'modify_stamina', amount: -1 }],
          outcomeText: 'You mill about a while, getting nowhere.',
        });
        const before = charRepo.findById(characterId)!.rolls_remaining; // 2

        await engine.startAction(characterId, 'mill about');

        const after = charRepo.findById(characterId)!;
        expect(after.rolls_remaining).toBe(before); // refunded — unchanged
        expect(after.last_noop_refund_day).toBe(1); // freebie spent on this no-op
      });
    });

    // ── Graph-validated movement (per-player-map-exploration §2): set_location only
    //    reaches charted nodes; new ground is born ONLY via cross_frontier. No
    //    lazy-create from arbitrary names anymore. ──
    describe('graph-validated movement', () => {
      let locationRepo: LocationRepository;
      beforeEach(() => {
        locationRepo = new LocationRepository(getDb());
      });

      it('drops a set_location to an unknown/unreachable name — no row, no move', async () => {
        llm.setDecision({
          distilledType: 'travel', stat: 'physical', baseDc: 10,
          required: false, done: true, decision: [],
          mutations: [{ type: 'set_location', name: 'The Hidden Grotto' }], // not on the graph
          outcomeText: 'You push past the falls into a hidden grotto.',
        });

        await engine.startAction(characterId, 'explore behind the waterfall');

        // No lazy-create: the phantom name never becomes a row…
        expect(locationRepo.findByName('The Hidden Grotto')).toBeUndefined();
        // …and the player stays put (the illegal move was dropped).
        expect(charRepo.findById(characterId)!.location).toBe("The Warden's Oak");
      });

      it('mints new ground via cross_frontier across a real frontier exit', async () => {
        charRepo.update(characterId, { location: 'The East Road' }); // has the NE frontier
        llm.setDecision({
          distilledType: 'travel', stat: 'physical', baseDc: 10,
          required: false, done: true, decision: [],
          mutations: [{ type: 'cross_frontier', direction: 'NE', name: 'Eastvale' }],
          outcomeText: 'The road crests a rise and Eastvale opens below.',
        });

        await engine.startAction(characterId, 'follow the road east');

        const loc = locationRepo.findByName('Eastvale');
        expect(loc).toBeDefined();
        expect(loc!.enrichment_pending).toBe(1);     // awaiting the cartographer
        expect(loc!.region).toBe('The Vale');         // seeded from the crossing region (never region-less)
        expect(charRepo.findById(characterId)!.location).toBe('Eastvale');
        // The frontier exit is now bound (shared thereafter).
        const edge = new LocationEdgeRepository(getDb()).find('The East Road', 'NE');
        expect(edge!.to_location).toBe('Eastvale');
      });

      it('reuses an existing location (case-insensitive) — no new row, snaps to canonical', async () => {
        locationRepo.create({ name: 'Town Square', isSafe: 1, description: 'The square.' });
        const countBefore = locationRepo.findAll().length;

        llm.setDecision({
          distilledType: 'travel', stat: 'physical', baseDc: 10,
          required: false, done: true, decision: [],
          mutations: [{ type: 'set_location', name: 'town square' }], // lower-case
          outcomeText: 'You head to the square.',
        });

        await engine.startAction(characterId, 'go to the square');

        // No new row created…
        expect(locationRepo.findAll().length).toBe(countBefore);
        // …and the player is snapped to the canonical casing so getLocation resolves.
        expect(charRepo.findById(characterId)!.location).toBe('Town Square');
        // Existing row untouched (still safe, not flagged provisional).
        const loc = locationRepo.findByName('Town Square')!;
        expect(loc.is_safe).toBe(1);
        expect(loc.enrichment_pending).toBe(0);
      });
    });

    it('persists mid-action state in last_action_state', async () => {
      llm.setDecision(huntFirstDecision());

      await engine.startAction(characterId, 'go hunt a wolf');

      const char = charRepo.findById(characterId);
      expect(char?.last_action_state).not.toBeNull();
      const saved = JSON.parse(char!.last_action_state!);
      expect(saved.rawInput).toBe('go hunt a wolf');
      expect(saved.accumulatedDc).toBe(12);
      expect(saved.pendingDecision).toBeDefined();
    });

    it('drains a roll when starting', async () => {
      llm.setDecision(huntFirstDecision());

      await engine.startAction(characterId, 'go hunt a wolf');

      const char = charRepo.findById(characterId);
      expect(char?.rolls_remaining).toBe(1);
    });

    it('throws if character has no rolls remaining', async () => {
      charRepo.update(characterId, { rolls_remaining: 0 });
      llm.setDecision(huntFirstDecision());

      await expect(
        engine.startAction(characterId, 'go hunt'),
      ).rejects.toThrow('No rolls remaining');
    });

    it('throws if character does not exist', async () => {
      llm.setDecision(huntFirstDecision());

      await expect(
        engine.startAction(999, 'go hunt'),
      ).rejects.toThrow('Character not found');
    });
  });

  describe('stepAction', () => {
    it('continues the loop for a regular choice', async () => {
      llm.setDecision(huntFirstDecision());
      await engine.startAction(characterId, 'go hunt a wolf');

      llm.setDecision(huntSecondDecision());
      const result = await engine.stepAction(characterId, 'Track wolf');

      expect(result.resolved).toBe(false);
      if (!result.resolved) {
        expect(result.state.decisions).toHaveLength(1);
        expect(result.state.decisions[0].chosen).toBe('Track wolf');
        expect(result.state.accumulatedDc).toBe(14); // 12 + 2
        expect(result.nextDecision.options).toHaveLength(3);
      }
    });

    it('updates persisted state after each step', async () => {
      llm.setDecision(huntFirstDecision());
      await engine.startAction(characterId, 'go hunt a wolf');

      llm.setDecision(huntSecondDecision());
      await engine.stepAction(characterId, 'Track wolf');

      const char = charRepo.findById(characterId);
      const saved = JSON.parse(char!.last_action_state!);
      expect(saved.accumulatedDc).toBe(14);
      expect(saved.decisions).toHaveLength(1);
    });

    it('resolves as bailed on bail', async () => {
      llm.setDecision(huntFirstDecision());
      await engine.startAction(characterId, 'go hunt a wolf');

      const result = await engine.stepAction(characterId, 'Bail');

      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.outcome.outcome).toBe('bailed');
        expect(result.outcome.playerRolled).toBeNull();
      }
    });

    it('clears last_action_state on resolution', async () => {
      llm.setDecision(huntFirstDecision());
      await engine.startAction(characterId, 'go hunt a wolf');

      const result = await engine.stepAction(characterId, 'Bail');

      expect(result.resolved).toBe(true);
      const char = charRepo.findById(characterId);
      expect(char?.last_action_state).toBeNull();
    });

    it('resolves with outcome when LLM says done', async () => {
      llm.setDecision(huntFinalDecision());
      await engine.startAction(characterId, 'hunt');

      const result = await engine.stepAction(characterId, 'Attack!');

      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.outcome.distilledType).toBe('hunt');
        expect(result.outcome.outcome).toBe('success'); // d20=15 + no items >= DC 12
        expect(result.outcome.playerRolled).toBe(15);
        expect(result.outcome.mutations).toEqual([
          { type: 'modify_health', amount: -2 },
        ]);
      }
    });

    it('inserts an actions row on completion', async () => {
      llm.setDecision(huntFinalDecision());
      await engine.startAction(characterId, 'hunt');

      await engine.stepAction(characterId, 'Attack!');

      const recent = actionRepo.findRecentByCharacterId(characterId, 1);
      expect(recent).toHaveLength(1);
      expect(recent[0].type).toBe('hunt');
      expect(recent[0].outcome).toBe('success');
      expect(recent[0].raw_input).toBe('hunt');
      expect(recent[0].player_rolled).toBe(15);
    });

    it('applies mutations on resolution', async () => {
      llm.setDecision({
        ...huntFinalDecision(),
        mutations: [
          { type: 'modify_health' as const, amount: -3 },
        ],
      });
      await engine.startAction(characterId, 'hunt');

      await engine.stepAction(characterId, 'Attack!');

      const char = charRepo.findById(characterId);
      expect(char?.health).toBe(9); // 12 - 3
    });

    it('does not drain a second roll on step (already drained on start)', async () => {
      llm.setDecision({
        ...huntFinalDecision(),
        decision: [{ label: 'Attack!', dcModifier: 0 }],
      });
      await engine.startAction(characterId, 'hunt');
      const afterStart = charRepo.findById(characterId);
      expect(afterStart?.rolls_remaining).toBe(1);

      await engine.stepAction(characterId, 'Attack!');

      const afterStep = charRepo.findById(characterId);
      expect(afterStep?.rolls_remaining).toBe(1); // unchanged
    });

    it('throws if no action in progress', async () => {
      await expect(
        engine.stepAction(characterId, 'Attack!'),
      ).rejects.toThrow('No action in progress');
    });
  });

  describe('divine intervention', () => {
    it('startAction returns a Resolve option on divine intervention', async () => {
      // Both LLM calls fail — triggers divine
      vi.spyOn(llm, 'decide').mockRejectedValue(new Error('API error'));

      const result = await engine.startAction(characterId, 'go hunt');

      // Should still get a result with one option
      expect(result.firstDecision.options).toHaveLength(1);
      expect(result.firstDecision.options[0].label).toBe('Resolve');
      expect(result.firstDecision.prompt).toContain("The Warden's hand");
    });

    it('startAction drains a roll on divine', async () => {
      vi.spyOn(llm, 'decide').mockRejectedValue(new Error('API error'));

      await engine.startAction(characterId, 'go hunt');

      const char = charRepo.findById(characterId);
      expect(char?.rolls_remaining).toBe(1); // drained from 2
    });

    it('stepAction resolves divine state without LLM call', async () => {
      const spy = vi.spyOn(llm, 'decide').mockRejectedValue(new Error('API error'));

      const { firstDecision } = await engine.startAction(characterId, 'go hunt');
      spy.mockClear(); // reset call count

      const result = await engine.stepAction(characterId, firstDecision.options[0].label);

      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.outcome.distilledType).toBe('__divine__');
        expect(result.outcome.playerRolled).toBeNull();
        expect(result.outcome.mutations).toEqual([]);
      }
      // No LLM calls were made during step
      expect(spy).not.toHaveBeenCalled();
    });

    it('stepAction clears last_action_state on divine', async () => {
      vi.spyOn(llm, 'decide').mockRejectedValue(new Error('API error'));

      const { firstDecision } = await engine.startAction(characterId, 'go hunt');

      await engine.stepAction(characterId, firstDecision.options[0].label);

      const char = charRepo.findById(characterId);
      expect(char?.last_action_state).toBeNull();
    });

    it('no action row is inserted on divine', async () => {
      vi.spyOn(llm, 'decide').mockRejectedValue(new Error('API error'));

      const { firstDecision } = await engine.startAction(characterId, 'go hunt');

      await engine.stepAction(characterId, firstDecision.options[0].label);

      const recent = actionRepo.findRecentByCharacterId(characterId, 1);
      expect(recent).toHaveLength(0);
    });
  });

  describe('resumeAction', () => {
    it('returns saved state with pending decision', async () => {
      llm.setDecision(huntFirstDecision());
      const { state } = await engine.startAction(characterId, 'hunt');

      const result = engine.resumeAction(characterId);

      expect(result.state.rawInput).toBe(state.rawInput);
      expect(result.state.decisions).toEqual([]);
      expect(result.nextDecision.options).toHaveLength(3);
    });

    it('throws if no saved state', () => {
      expect(() => engine.resumeAction(characterId)).toThrow('No action to resume');
    });

    it('resumes mid-action after disconnect', async () => {
      // Start + step once, simulating disconnect before resolution
      llm.setDecision(huntFirstDecision());
      await engine.startAction(characterId, 'go hunt a wolf');

      llm.setDecision(huntSecondDecision());
      const r1 = await engine.stepAction(characterId, 'Track wolf');
      expect(r1.resolved).toBe(false);

      // Simulate resume (would be a new HTTP request in split architecture)
      const resumed = engine.resumeAction(characterId);
      expect(resumed.state.decisions).toHaveLength(1);
      expect(resumed.state.decisions[0].chosen).toBe('Track wolf');
      expect(resumed.state.accumulatedDc).toBe(14);
      expect(resumed.nextDecision.options).toHaveLength(3);

      // Continue from resumed state — pick a choice from the resumed pendingDecision
      llm.setDecision(huntFinalDecision());
      const r2 = await engine.stepAction(characterId, 'Stalk');  // from huntSecondDecision
      expect(r2.resolved).toBe(true);
    });
  });

  describe('feedback & bug reports', () => {
    it('stamps the app version on a submitted feedback row', () => {
      engine.submitFeedback(characterId, 'The warden is wise');
      const row = getDb()
        .prepare('SELECT character_id, text, action_id, app_version FROM feedback ORDER BY id DESC LIMIT 1')
        .get() as { character_id: number; text: string; action_id: number | null; app_version: string | null };
      expect(row.character_id).toBe(characterId);
      expect(row.text).toBe('The warden is wise');
      expect(row.action_id).toBeNull(); // off-action /feedback — no link
      expect(row.app_version).toBe(APP_VERSION);
    });

    it('stamps the app version on a submitted bug row', () => {
      engine.submitBug(characterId, 'crash on /look');
      const row = getDb()
        .prepare('SELECT app_version FROM bug_reports ORDER BY id DESC LIMIT 1')
        .get() as { app_version: string | null };
      expect(row.app_version).toBe(APP_VERSION);
    });
  });
});

// ── B6 · D3 async cartographer enrichment ──
describe('WorldEngineImpl — D3 cartographer enrichment', () => {
  let engine: WorldEngineImpl;
  let llm: MockLlmGateway;
  let charRepo: CharacterRepository;
  let locationRepo: LocationRepository;
  let characterId: number;

  /** A stub cartographer whose enrich() resolution the test can await. */
  function makeStubCartographer(result: {
    matchesExisting?: string;
    is_safe?: 0 | 1;
    description?: string;
    tags?: string;
    region?: string;
    emoji?: string;
    node_tier?: 1 | 2;
    onwardFrontiers?: Array<{ teaser: string; difficulty: 1 | 2 | 3 }>;
  }) {
    const calls: Array<{ newName: string; existingNames: string[]; narrative: string; knownRegions?: string[]; fromLocation?: string; fromRegion?: string | null }> = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    return {
      calls,
      done,
      gateway: {
        enrich: async (input: { newName: string; existingNames: string[]; narrative: string; knownRegions?: string[]; fromLocation?: string; fromRegion?: string | null }) => {
          calls.push(input);
          resolveDone();
          return result;
        },
      },
    };
  }

  function setup(cartographer?: { enrich: (i: { newName: string; existingNames: string[]; narrative: string }) => Promise<unknown> }) {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES); // need the seeded frontier exits to cross
    llm = new MockLlmGateway();
    const userRepo = new UserRepository(getDb());
    charRepo = new CharacterRepository(getDb());
    const itemRepo = new ItemRepository(getDb());
    const actionRepo = new ActionRepository(getDb());
    const npcRepo = new NpcRepository(getDb());
    locationRepo = new LocationRepository(getDb());
    engine = new WorldEngineImpl({
      db: getDb(), llm, userRepo, charRepo, itemRepo, actionRepo, npcRepo,
      rollD20: () => 15,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(cartographer ? { cartographer: cartographer as any } : {}),
    });
    characterId = createTestChar(userRepo, charRepo).characterId;
    // Stand at a node with an unbound frontier exit so cross_frontier can mint.
    charRepo.update(characterId, { location: 'The East Road' });
  }

  afterEach(() => { closeDb(); });

  // Crossing the NE frontier off The East Road mints "The Sunken Vault" — the new
  // ground the cartographer then charts. (The LLM coins the name on arrival.)
  const travelToNovelPlace = (): LlmDecision => ({
    distilledType: 'travel', stat: 'physical', baseDc: 10,
    required: false, done: true, decision: [],
    mutations: [{ type: 'cross_frontier', direction: 'NE', name: 'The Sunken Vault' }],
    outcomeText: 'You descend a flooded stair into a sunken vault.',
  });

  it('fires the cartographer for a new provisional location and enriches the row', async () => {
    const stub = makeStubCartographer({ is_safe: 0, description: 'A drowned hall of black stone, the water ankle-deep and cold.' });
    setup(stub.gateway);

    llm.setDecision(travelToNovelPlace());
    await engine.startAction(characterId, 'explore the flooded stair');

    await stub.done;            // wait for the fire-and-forget enrich() to run
    await Promise.resolve();    // let enrichProvisional's DB write settle

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].newName).toBe('The Sunken Vault');
    // The existing-names list excludes the fresh provisional row itself.
    expect(stub.calls[0].existingNames).not.toContain('The Sunken Vault');
    expect(stub.calls[0].narrative).toMatch(/sunken vault/i);

    const loc = locationRepo.findByName('The Sunken Vault')!;
    expect(loc.description).toMatch(/drowned hall/i);
    expect(loc.is_safe).toBe(0);
    expect(loc.enrichment_pending).toBe(0); // flag cleared after enrichment
  });

  it('persists cartographer-supplied tags onto the enriched row', async () => {
    const stub = makeStubCartographer({ is_safe: 0, description: 'A flooded vault.', tags: 'cave,underground,water,dark' });
    setup(stub.gateway);

    llm.setDecision(travelToNovelPlace());
    await engine.startAction(characterId, 'explore the flooded stair');

    await stub.done;
    await Promise.resolve();

    const loc = locationRepo.findByName('The Sunken Vault')!;
    expect(loc.tags).toBe('cave,underground,water,dark');
  });

  it('does not fire the cartographer when no provisional location was created', async () => {
    const stub = makeStubCartographer({ is_safe: 1, description: 'x' });
    setup(stub.gateway);

    // A no-op (no set_location) — nothing to chart.
    llm.setDecision({
      distilledType: 'wait', stat: 'wisdom', baseDc: 10,
      required: false, done: true, decision: [], mutations: [],
      outcomeText: 'The moment passes.',
    });
    await engine.startAction(characterId, 'stand still');
    await Promise.resolve();

    expect(stub.calls).toHaveLength(0);
  });

  it('works without a cartographer configured — row stays provisional', async () => {
    setup(); // no cartographer

    llm.setDecision(travelToNovelPlace());
    await engine.startAction(characterId, 'explore the flooded stair');
    await Promise.resolve();

    const loc = locationRepo.findByName('The Sunken Vault')!;
    expect(loc.enrichment_pending).toBe(1); // left provisional, no crash
  });

  it('charts geometry: region/emoji/node_tier written, with the crossing context passed', async () => {
    const stub = makeStubCartographer({
      is_safe: 0, description: 'A drowned hall.', region: 'The Ashen Reach', emoji: '🏚️', node_tier: 1,
    });
    setup(stub.gateway);

    llm.setDecision(travelToNovelPlace());
    await engine.startAction(characterId, 'explore the flooded stair');
    await stub.done; await Promise.resolve();

    const loc = locationRepo.findByName('The Sunken Vault')!;
    expect(loc.region).toBe('The Ashen Reach');
    expect(loc.emoji).toBe('🏚️');
    expect(loc.node_tier).toBe(1);
    // The crossing context was handed to the cartographer (parent = The East Road / The Vale).
    expect(stub.calls[0].fromLocation).toBe('The East Road');
    expect(stub.calls[0].fromRegion).toBe('The Vale');
    expect(stub.calls[0].knownRegions).toContain('The Vale');
  });

  it('falls back to 📍 + the crossing region + tier 2 when the cartographer omits geometry', async () => {
    const stub = makeStubCartographer({ is_safe: 0, description: 'A bare place.' }); // no region/emoji/tier
    setup(stub.gateway);

    llm.setDecision(travelToNovelPlace());
    await engine.startAction(characterId, 'explore the flooded stair');
    await stub.done; await Promise.resolve();

    const loc = locationRepo.findByName('The Sunken Vault')!;
    expect(loc.emoji).toBe('📍');
    expect(loc.region).toBe('The Vale'); // inherited from the crossing node
    expect(loc.node_tier).toBe(2);
  });

  it('authors onward frontier exits from the charted place', async () => {
    const stub = makeStubCartographer({
      is_safe: 0, description: 'A drowned hall.',
      onwardFrontiers: [
        { teaser: 'a stair descends into black water', difficulty: 3 },
        { teaser: 'a dry tunnel breathes warm air', difficulty: 2 },
      ],
    });
    setup(stub.gateway);

    llm.setDecision(travelToNovelPlace());
    await engine.startAction(characterId, 'explore the flooded stair');
    await stub.done; await Promise.resolve();

    const edges = new LocationEdgeRepository(getDb());
    const onward = edges.frontierExits('The Sunken Vault');
    expect(onward).toHaveLength(2);
    expect(onward.map((f) => f.teaser)).toEqual(
      expect.arrayContaining(['a stair descends into black water', 'a dry tunnel breathes warm air']),
    );
    expect(onward.map((f) => f.direction).length).toBe(new Set(onward.map((f) => f.direction)).size); // distinct dirs
  });

  it('spoke cap: never grows a node past 5 total outgoing spokes', async () => {
    const stub = makeStubCartographer({
      is_safe: 0, description: 'A hub.',
      // 3 onward (capped to ≤3 by parse) — the new node has 0 outgoing edges, so all 3 fit (< 5).
      onwardFrontiers: [
        { teaser: 'road A', difficulty: 1 }, { teaser: 'road B', difficulty: 1 }, { teaser: 'road C', difficulty: 1 },
      ],
    });
    setup(stub.gateway);
    llm.setDecision(travelToNovelPlace());
    await engine.startAction(characterId, 'explore the flooded stair');
    await stub.done; await Promise.resolve();

    const edges = new LocationEdgeRepository(getDb());
    const outgoing = edges.directionsFrom('The Sunken Vault');
    expect(outgoing.length).toBeLessThanOrEqual(5); // cap respected
    expect(outgoing.length).toBe(3); // all 3 fit under the cap here
  });
});
