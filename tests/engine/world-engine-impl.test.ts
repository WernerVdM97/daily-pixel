import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorldEngineImpl } from '../../src/engine/WorldEngineImpl.js';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { migrate, seedWorld, SEEDED_LOCATIONS, SEEDED_EDGES } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import { ItemRepository } from '../../src/db/repositories/item.js';
import { ActionRepository } from '../../src/db/repositories/action.js';
import { NpcRepository } from '../../src/db/repositories/npc.js';
import { RelationRepository } from '../../src/db/repositories/relation.js';
import { LocationRepository } from '../../src/db/repositories/location.js';
import type { CartographerGateway, CartographerResult } from '../../src/llm/LlmGateway.js';
import type {
  ClassifyHit,
  PipelineDecideResult,
  PipelineLlmGateway,
  PipelineResolveMutateResult,
  PipelineResolveNarrateResult,
  PipelineStageResult,
} from '../../src/llm/pipeline/types.js';
import { ENEMY_HP_MIN } from '../../src/engine/action/combat-dc.js';
// ── T6 concurrent step serialisation ──

/** Minimal scriptable `PipelineLlmGateway` double for B#3's auto-resolve-start tests (mirrors
 *  `pipeline-machine.test.ts`'s MockPipelineLlmGateway, trimmed to the 4 stages these tests
 *  need). `decide()` returning `decision: []` is what routes `start()` into the same-call
 *  resolve pipeline (the "auto-resolve" path under test), not a per-test heuristic hit —
 *  `classify()` is scripted directly so the test doesn't depend on heuristicClassify's table. */
class AutoResolveMockGateway implements PipelineLlmGateway {
  constructor(private readonly resolveMutations: PipelineResolveMutateResult['mutations']) {}

  async classify(): Promise<PipelineStageResult<ClassifyHit>> {
    const result: ClassifyHit = {
      kind: 'hit',
      actionType: 'rest',
      flags: { unsafe_location: false, needs_roll: false, target_present: false },
    };
    return { result, callId: 0 };
  }

  async decide(): Promise<PipelineStageResult<PipelineDecideResult>> {
    const result: PipelineDecideResult = {
      distilledType: 'rest',
      stat: 'physical',
      baseDc: 10,
      required: false,
      decision: [], // empty decision → start() auto-resolves inline (§2 v12 QA)
    };
    return { result, callId: 0 };
  }

  async resolveMutate(): Promise<PipelineStageResult<PipelineResolveMutateResult>> {
    return { result: { mutations: this.resolveMutations }, callId: 0 };
  }

  async resolveNarrate(): Promise<PipelineStageResult<PipelineResolveNarrateResult>> {
    return { result: { outcomeText: 'You rest for a while.' }, callId: 0 };
  }
}

describe('WorldEngineImpl — pipeline path step() serialisation (T6)', () => {
  function makeMockFetch(hangOnThird: boolean) {
    let callCount = 0;
    return vi.fn<typeof fetch>().mockImplementation(async (_url, _init) => {
      callCount++;
      if (hangOnThird && callCount === 3) {
        // Hang forever — the test will race a second stepAction against this.
        return new Promise<Response>(() => {});
      }
      // All pipeline calls are decide calls — heuristic classify (PipelineActionStateMachine.start)
      // handles classification server-side at zero LLM cost, so no fetch for classify ever fires.
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ distilledType: 'combat', stat: 'physical', baseDc: 12, required: true, decision: [{ label: 'Attack', dcModifier: 0, stat: 'physical' }] }) } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
  }

  it('rejects concurrent step() calls on the same action', async () => {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    const userRepo = new UserRepository(getDb());
    const charRepo = new CharacterRepository(getDb());

    const user = userRepo.create('999999999');
    const characterId = charRepo.create(user.id, {
      name: 'Garrick',
      class: 'Fighter',
      upbringing: 'Village',
      race: 'Human',
      alignment: 'lawful good',
      day_job: 'Guard',
      stats: JSON.stringify({ physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }),
      health: 10,
      max_health: 10,
      max_stamina: 10,
      stamina: 10,
      rolls_remaining: 3,
      location: "The Warden's Oak",
      wealth: 5,
      last_action_state: null,
    }).id;

    const mockFetch = makeMockFetch(true);
    const engine = new WorldEngineImpl({
      db: getDb(),
      llm: { decide: async () => ({ distilledType: '__divine__', stat: 'physical', baseDc: 10, required: false, done: true, decision: [], outcomeText: '' }) },
      userRepo,
      charRepo,
      itemRepo: new ItemRepository(getDb()),
      actionRepo: new ActionRepository(getDb()),
      npcRepo: new NpcRepository(getDb()),
      pipelineLlm: { apiKey: 'test-key', model: 'test-model', fetch: mockFetch as unknown as typeof fetch },
      rollD20: () => 15,
    });

    // Start: classify + decide resolve immediately (calls 1 and 2) → returns firstDecision.
    const startResult = await engine.startAction(characterId, 'attack the goblin');
    expect(startResult.firstDecision).toBeDefined();
    expect(startResult.outcome).toBeUndefined();

    // Fire stepAction — the step's decide call (call 3) hangs. Don't await it.
    const stepPromise = engine.stepAction(characterId, 'Attack');

    // While the first step is hung, fire a second stepAction concurrently.
    // The serialisation guard must throw.
    await expect(engine.stepAction(characterId, 'Attack')).rejects.toThrow(
      'A step is already being processed',
    );

    // Clean up: the hung promise is still pending — closeDb will clean up.
    stepPromise.catch(() => {});
    closeDb();
  });
});

describe('WorldEngineImpl — pipeline decide timeout (v12 QA §1)', () => {
  it('resolves step as timed_out when the pipeline decide call throws AbortError', async () => {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    const userRepo = new UserRepository(getDb());
    const charRepo = new CharacterRepository(getDb());

    const user = userRepo.create('999999999');
    const characterId = charRepo.create(user.id, {
      name: 'Garrick',
      class: 'Fighter',
      upbringing: 'Village',
      race: 'Human',
      alignment: 'lawful good',
      day_job: 'Guard',
      stats: JSON.stringify({ physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }),
      health: 10,
      max_health: 10,
      max_stamina: 10,
      stamina: 10,
      rolls_remaining: 3,
      location: "The Warden's Oak",
      wealth: 5,
      last_action_state: null,
    }).id;

    let callCount = 0;
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
      callCount++;
      if (callCount >= 2) {
        // Second fetch call (stepAction's decide) throws AbortError.
        const error = new Error('AbortError') as Error & { name: string };
        error.name = 'AbortError';
        throw error;
      }
      // First fetch call (startAction's decide) succeeds.
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ distilledType: 'combat', stat: 'physical', baseDc: 12, required: true, decision: [{ label: 'Attack', dcModifier: 0, stat: 'physical' }] }) } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const engine = new WorldEngineImpl({
      db: getDb(),
      llm: { decide: async () => ({ distilledType: '__divine__', stat: 'physical', baseDc: 10, required: false, done: true, decision: [], outcomeText: '' }) },
      userRepo,
      charRepo,
      itemRepo: new ItemRepository(getDb()),
      actionRepo: new ActionRepository(getDb()),
      npcRepo: new NpcRepository(getDb()),
      pipelineLlm: { apiKey: 'test-key', model: 'test-model', fetch: mockFetch as unknown as typeof fetch },
      rollD20: () => 15,
    });

    // Start succeeds — heuristic classify hits, decide returns mock response, roll drained, state persisted.
    const startResult = await engine.startAction(characterId, 'attack the goblin');
    expect(startResult.firstDecision).toBeDefined();
    expect(startResult.outcome).toBeUndefined();

    // Roll was drained: 3 → 2.
    const before = charRepo.findById(characterId)!;
    expect(before.rolls_remaining).toBe(2);
    expect(before.last_action_state).not.toBeNull();

    // StepAction's decide call throws AbortError → resolves as timed_out.
    const result = await engine.stepAction(characterId, 'Attack');

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.outcome.outcome).toBe('timed_out');
      // Roll is refunded on the first timeout: net 0 change from the drained start.
      expect(result.outcome.rollsDelta).toBe(0);
      expect(result.outcome.rollRefunded).toBe(true);
    }
    // State is cleared.
    expect(charRepo.findById(characterId)!.last_action_state).toBeNull();

    closeDb();
  });
});


describe('WorldEngineImpl — classify-stage throw → divine intervention (F#21)', () => {
  it('refunds the roll, authors no mutations, and resolves as a flagged system fault', async () => {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    const userRepo = new UserRepository(getDb());
    const charRepo = new CharacterRepository(getDb());

    const user = userRepo.create('999999999');
    const characterId = charRepo.create(user.id, {
      name: 'Garrick',
      class: 'Fighter',
      upbringing: 'Village',
      race: 'Human',
      alignment: 'lawful good',
      day_job: 'Guard',
      stats: JSON.stringify({ physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }),
      health: 10,
      max_health: 10,
      max_stamina: 10,
      stamina: 10,
      rolls_remaining: 3,
      location: "The Warden's Oak",
      wealth: 5,
      last_action_state: null,
    }).id;

    // The rawInput must MISS heuristicClassify (zero category matches) so the pipeline falls
    // through to the LLM classify stage; a heuristic hit would classify server-side and never
    // reach the gateway. The classify fetch then rejects, and PipelineActionStateMachine.start's
    // catch routes to resolveDivineIntervention. `mockRejectedValue` covers any call, but only
    // classify ever fires here — divine intervention resolves outright, so no decide call follows.
    const mockFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('classify transport failure'));

    const engine = new WorldEngineImpl({
      db: getDb(),
      llm: { decide: async () => ({ distilledType: '__divine__', stat: 'physical', baseDc: 10, required: false, done: true, decision: [], outcomeText: '' }) },
      userRepo,
      charRepo,
      itemRepo: new ItemRepository(getDb()),
      actionRepo: new ActionRepository(getDb()),
      npcRepo: new NpcRepository(getDb()),
      pipelineLlm: { apiKey: 'test-key', model: 'test-model', fetch: mockFetch as unknown as typeof fetch },
      rollD20: () => 15,
    });

    const startResult = await engine.startAction(characterId, 'flibbertigibbet wobble');

    // Resolved outright (no decision screen), with the divine-intervention outcome.
    expect(startResult.outcome).toBeDefined();
    const outcome = startResult.outcome!;

    // Names itself a system fault — the `isDivineIntervention` flag is exactly what
    // action.ts:262-273 keys the grey "⚠️ System" embed off (empty-option firstDecision below).
    expect(outcome.isDivineIntervention).toBe(true);
    expect(outcome.outcome).toBe('done');

    // No mutations authored on the outcome.
    expect(outcome.mutations).toEqual([]);

    // ⚠️ System presentation contract: firstDecision carries no options (→ action.ts's
    // `options.length === 0` divine branch) and the system-fault prompt.
    expect(startResult.firstDecision).toBeDefined();
    expect(startResult.firstDecision!.options).toHaveLength(0);
    expect(startResult.firstDecision!.prompt).toContain('refunded');

    // Refunded roll: the DB count is untouched (system fault is not a real action), no stuck
    // decision state persisted, and no world mutation landed on the character's resources.
    const after = charRepo.findById(characterId)!;
    expect(after.rolls_remaining).toBe(3);
    expect(after.last_action_state).toBeNull();
    expect(after.health).toBe(10);
    expect(after.stamina).toBe(10);
    expect(after.wealth).toBe(5);

    // Heuristic missed → exactly one LLM classify attempt, no retry, no follow-on decide.
    expect(mockFetch).toHaveBeenCalledTimes(1);

    closeDb();
  });
});


describe('WorldEngineImpl — auto-resolve start-path rolls accounting (B#3)', () => {
  function seedCharacter(charRepo: CharacterRepository, userRepo: UserRepository): number {
    const user = userRepo.create('999999999');
    return charRepo.create(user.id, {
      name: 'Garrick',
      class: 'Fighter',
      upbringing: 'Village',
      race: 'Human',
      alignment: 'lawful good',
      day_job: 'Guard',
      stats: JSON.stringify({ physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }),
      health: 10,
      max_health: 10,
      max_stamina: 10,
      stamina: 10,
      rolls_remaining: 3,
      location: "The Warden's Oak",
      wealth: 5,
      last_action_state: null,
    }).id;
  }

  it('nets drain + grant correctly when the auto-resolved outcome carries a modify_rolls_remaining grant', async () => {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    const userRepo = new UserRepository(getDb());
    const charRepo = new CharacterRepository(getDb());
    const characterId = seedCharacter(charRepo, userRepo);

    const engine = new WorldEngineImpl({
      db: getDb(),
      llm: { decide: async () => ({ distilledType: '__divine__', stat: 'physical', baseDc: 10, required: false, done: true, decision: [], outcomeText: '' }) },
      userRepo,
      charRepo,
      itemRepo: new ItemRepository(getDb()),
      actionRepo: new ActionRepository(getDb()),
      npcRepo: new NpcRepository(getDb()),
      pipelineLlmGateway: new AutoResolveMockGateway([{ type: 'modify_rolls_remaining', amount: 1 }]),
      rollD20: () => 15,
    });

    const startResult = await engine.startAction(characterId, 'rest by the fire');

    expect(startResult.outcome).toBeDefined();
    // Pre-fix: applyResolution's baseCtx used the stale pre-drain count (3), so its own write
    // landed 3+1=4 and clobbered the drain — this is the regression B#3 fixes.
    expect(charRepo.findById(characterId)!.rolls_remaining).toBe(3);
    // Reported delta must match the true net (spent 1, granted 1 → 0), not a hard-coded -1.
    expect(startResult.outcome!.rollsDelta).toBe(0);

    closeDb();
  });

  it('companion: leaves the no-grant auto-resolve path unregressed (drain-only, delta -1)', async () => {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    const userRepo = new UserRepository(getDb());
    const charRepo = new CharacterRepository(getDb());
    const characterId = seedCharacter(charRepo, userRepo);

    const engine = new WorldEngineImpl({
      db: getDb(),
      llm: { decide: async () => ({ distilledType: '__divine__', stat: 'physical', baseDc: 10, required: false, done: true, decision: [], outcomeText: '' }) },
      userRepo,
      charRepo,
      itemRepo: new ItemRepository(getDb()),
      actionRepo: new ActionRepository(getDb()),
      npcRepo: new NpcRepository(getDb()),
      pipelineLlmGateway: new AutoResolveMockGateway([]),
      rollD20: () => 15,
    });

    const startResult = await engine.startAction(characterId, 'rest by the fire');

    expect(startResult.outcome).toBeDefined();
    expect(charRepo.findById(characterId)!.rolls_remaining).toBe(2);
    expect(startResult.outcome!.rollsDelta).toBe(-1);

    closeDb();
  });
});

describe('WorldEngineImpl — cartographer fires on the auto-resolve frontier-crossing path (N2)', () => {
  // Let the fire-and-forget enrichment IIFE (await enrich → sync enrichProvisional write) settle.
  async function flush(times = 5): Promise<void> {
    for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
  }

  it('enriches a provisional location minted by a single-beat cross_frontier', async () => {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    const userRepo = new UserRepository(getDb());
    const charRepo = new CharacterRepository(getDb());
    const locationRepo = new LocationRepository(getDb());

    const user = userRepo.create('888888888');
    // "The East Road" NE is a real unbound frontier (assets/world/edges.yml), so a
    // cross_frontier NE from here mints a fresh provisional row.
    const characterId = charRepo.create(user.id, {
      name: 'Mira',
      class: 'Ranger',
      upbringing: 'Village',
      race: 'Human',
      alignment: 'neutral good',
      day_job: 'Hunter',
      stats: JSON.stringify({ physical: 2, wisdom: 2, intelligence: 0, charisma: 0 }),
      health: 10,
      max_health: 10,
      max_stamina: 10,
      stamina: 10,
      rolls_remaining: 3,
      location: 'The East Road',
      wealth: 0,
      last_action_state: null,
    }).id;

    let enrichedName: string | undefined;
    const cartographer: CartographerGateway = {
      enrich: async (input): Promise<CartographerResult> => {
        enrichedName = input.newName;
        return {
          is_safe: 0,
          description: 'A green valley of terraced farms below the eastern ridge.',
          tags: 'valley,farmland,dusk',
          region: 'Eastreach',
          emoji: '🏞️',
          node_tier: 2,
          onwardFrontiers: [],
        };
      },
    };

    const engine = new WorldEngineImpl({
      db: getDb(),
      llm: { decide: async () => ({ distilledType: 'travel', stat: 'physical', baseDc: 10, required: false, done: true, decision: [], outcomeText: '' }) },
      userRepo,
      charRepo,
      itemRepo: new ItemRepository(getDb()),
      actionRepo: new ActionRepository(getDb()),
      npcRepo: new NpcRepository(getDb()),
      pipelineLlmGateway: new AutoResolveMockGateway([{ type: 'cross_frontier', direction: 'NE', name: 'Eastvale' }]),
      cartographer,
      rollD20: () => 15,
    });

    await engine.startAction(characterId, 'cross the frontier to the north-east');
    await flush();

    // Pre-fix, this branch minted the row but never called the cartographer, so the
    // placeholder ("(Mapping…)") stuck forever. It must now fire for the minted name…
    expect(enrichedName).toBe('Eastvale');
    // …and the enrichment must persist the real description + scene tags, clearing the placeholder.
    const row = locationRepo.findByName('Eastvale');
    expect(row?.description).toBe('A green valley of terraced farms below the eastern ridge.');
    expect(row?.tags).toContain('valley');
    expect(row?.enrichment_pending).toBe(0);

    closeDb();
  });
});
describe('WorldEngineImpl — startAction surfaces a persisted enemy condition on re-entry (0.3.2 C4)', () => {
  /** Scripted decide() with a fixed non-empty option, so start() always lands on the
   *  non-resolved (real firstDecision) return path — the only one `combatEnemyCondition` is
   *  computed on. `classify()` is never expected to fire: every rawInput used below
   *  (`heuristicClassify`) hits on its own keyword table. */
  class ScriptedGateway implements PipelineLlmGateway {
    constructor(
      private readonly distilledType: string,
      private readonly combatEnemy?: { name: string; anchor: 'npc' | 'location' },
    ) {}

    async classify(): Promise<PipelineStageResult<ClassifyHit>> {
      throw new Error("unexpected classify() call — this test's rawInput should heuristic-hit");
    }

    async decide(): Promise<PipelineStageResult<PipelineDecideResult>> {
      const result: PipelineDecideResult = {
        distilledType: this.distilledType,
        stat: 'physical',
        baseDc: 12,
        required: true,
        decision: [{ label: 'Attack', dcModifier: 0, stat: 'physical' }],
        ...(this.combatEnemy ? { combatEnemy: this.combatEnemy } : {}),
      };
      return { result, callId: 0 };
    }

    async resolveMutate(): Promise<PipelineStageResult<PipelineResolveMutateResult>> {
      throw new Error('not exercised — decide() always returns a non-empty option here');
    }

    async resolveNarrate(): Promise<PipelineStageResult<PipelineResolveNarrateResult>> {
      throw new Error('not exercised — decide() always returns a non-empty option here');
    }
  }

  function seedCharacter(): { userRepo: UserRepository; charRepo: CharacterRepository; characterId: number } {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    const userRepo = new UserRepository(getDb());
    const charRepo = new CharacterRepository(getDb());
    const user = userRepo.create('999999999');
    const characterId = charRepo.create(user.id, {
      name: 'Garrick',
      class: 'Fighter',
      upbringing: 'Village',
      race: 'Human',
      alignment: 'lawful good',
      day_job: 'Guard',
      stats: JSON.stringify({ physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }),
      health: 10,
      max_health: 10,
      max_stamina: 10,
      stamina: 10,
      rolls_remaining: 3,
      location: "The Warden's Oak",
      wealth: 5,
      last_action_state: null,
    }).id;
    return { userRepo, charRepo, characterId };
  }

  /** Persists the `in_combat` edge a prior bail would have left behind (anchored at the pc's
   *  current location, mirroring `combat-state.ts`'s location-anchor shape). */
  function seedInCombatEdge(
    characterId: number,
    props: { enemyName: string; enemyHp: number; enemyMaxHp: number; round: number },
  ): void {
    new RelationRepository(getDb()).set({
      fromType: 'pc',
      fromRef: String(characterId),
      toType: 'location',
      toRef: "The Warden's Oak",
      relType: 'in_combat',
      props,
    });
  }

  function makeEngine(
    userRepo: UserRepository,
    charRepo: CharacterRepository,
    gateway: PipelineLlmGateway,
  ): WorldEngineImpl {
    return new WorldEngineImpl({
      db: getDb(),
      llm: { decide: async () => ({ distilledType: '__divine__', stat: 'physical', baseDc: 10, required: false, done: true, decision: [], outcomeText: '' }) },
      userRepo,
      charRepo,
      itemRepo: new ItemRepository(getDb()),
      actionRepo: new ActionRepository(getDb()),
      npcRepo: new NpcRepository(getDb()),
      pipelineLlmGateway: gateway,
      rollD20: () => 15,
    });
  }

  it('surfaces a banded condition for a persisted damaged edge matching the current foe', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    seedInCombatEdge(characterId, { enemyName: 'Goblin', enemyHp: 5, enemyMaxHp: 20, round: 2 });

    const engine = makeEngine(userRepo, charRepo, new ScriptedGateway('combat', { name: 'Goblin', anchor: 'location' }));
    const startResult = await engine.startAction(characterId, 'attack the goblin');

    // 5/20 = 0.25 → filled = round(0.25*5) = 1 (Math.round), woundWord: >=0.15 and <0.4 → 'Battered'.
    expect(startResult.combatEnemyCondition).toEqual({ woundWord: 'Battered', filled: 1, total: 5 });

    closeDb();
  });

  it('leaves combatEnemyCondition undefined when the persisted edge names a different foe', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    seedInCombatEdge(characterId, { enemyName: 'Wolf', enemyHp: 5, enemyMaxHp: 20, round: 2 });

    const engine = makeEngine(userRepo, charRepo, new ScriptedGateway('combat', { name: 'Goblin', anchor: 'location' }));
    const startResult = await engine.startAction(characterId, 'attack the goblin');

    expect(startResult.combatEnemyCondition).toBeUndefined();

    closeDb();
  });

  it('leaves combatEnemyCondition undefined for a full-HP persisted edge (no real re-entry condition to show)', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    seedInCombatEdge(characterId, { enemyName: 'Goblin', enemyHp: 20, enemyMaxHp: 20, round: 1 });

    const engine = makeEngine(userRepo, charRepo, new ScriptedGateway('combat', { name: 'Goblin', anchor: 'location' }));
    const startResult = await engine.startAction(characterId, 'attack the goblin');

    expect(startResult.combatEnemyCondition).toBeUndefined();

    closeDb();
  });

  it('leaves combatEnemyCondition undefined for a non-combat action even with a matching persisted edge', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    seedInCombatEdge(characterId, { enemyName: 'Goblin', enemyHp: 5, enemyMaxHp: 20, round: 2 });

    const engine = makeEngine(userRepo, charRepo, new ScriptedGateway('rest'));
    const startResult = await engine.startAction(characterId, 'rest by the fire');

    expect(startResult.combatEnemyCondition).toBeUndefined();

    closeDb();
  });

  it('leaves combatEnemyCondition undefined for a genuinely fresh fight (no persisted edge at all)', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    // No seedInCombatEdge: this is the common case — a brand-new combat with nothing persisted.
    const engine = makeEngine(userRepo, charRepo, new ScriptedGateway('combat', { name: 'Goblin', anchor: 'location' }));
    const startResult = await engine.startAction(characterId, 'attack the goblin');

    expect(startResult.combatEnemyCondition).toBeUndefined();

    closeDb();
  });

  it('matches the remembered foe case-insensitively (the guard is a safety valve, not an exact-string trap)', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    // Persisted edge names the foe 'Goblin'; the new action's DECIDE names it 'goblin'.
    seedInCombatEdge(characterId, { enemyName: 'Goblin', enemyHp: 5, enemyMaxHp: 20, round: 2 });

    const engine = makeEngine(userRepo, charRepo, new ScriptedGateway('combat', { name: 'goblin', anchor: 'location' }));
    const startResult = await engine.startAction(characterId, 'attack the goblin');

    expect(startResult.combatEnemyCondition).toEqual({ woundWord: 'Battered', filled: 1, total: 5 });

    closeDb();
  });

  // ── C4 follow-up: vague re-engage ("resume fight") gives the LLM no combatEnemy hint, so the
  // persisted `in_combat` edge must carry BOTH the foe's name and its condition, not just the
  // condition (readPersistedCombatFoe / combatAnchorIsHere).
  it('surfaces the remembered foe\'s name and condition when the LLM gives no combatEnemy hint (the reported "Unknown foe" bug)', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    seedInCombatEdge(characterId, { enemyName: 'Goblin', enemyHp: 5, enemyMaxHp: 20, round: 2 });

    // No combatEnemy passed to ScriptedGateway — mirrors the LLM staying silent on vague input.
    const engine = makeEngine(userRepo, charRepo, new ScriptedGateway('combat'));
    const startResult = await engine.startAction(characterId, 'resume fight');

    // 5/20 = 0.25 → filled = round(0.25*5) = 1 (Math.round), woundWord: >=0.15 and <0.4 → 'Battered'.
    expect(startResult.combatEnemyName).toBe('Goblin');
    expect(startResult.combatEnemyCondition).toEqual({ woundWord: 'Battered', filled: 1, total: 5 });

    closeDb();
  });

  it('does not leak a stale persisted foe from elsewhere when the LLM is silent and the anchor is a different location', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    // Anchored at 'Eastvale', not the character's current location ("The Warden's Oak") — the
    // anchor-guarded fallback must refuse to attribute this edge to the current re-engage.
    new RelationRepository(getDb()).set({
      fromType: 'pc',
      fromRef: String(characterId),
      toType: 'location',
      toRef: 'Eastvale',
      relType: 'in_combat',
      props: { enemyName: 'Goblin', enemyHp: 5, enemyMaxHp: 20, round: 2 },
    });

    const engine = makeEngine(userRepo, charRepo, new ScriptedGateway('combat'));
    const startResult = await engine.startAction(characterId, 'resume fight');

    expect(startResult.combatEnemyName).toBeUndefined();
    expect(startResult.combatEnemyCondition).toBeUndefined();

    closeDb();
  });

  it('still name-gates a differently-named remembered foe when the LLM does name one, surfacing the LLM name with no condition', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    seedInCombatEdge(characterId, { enemyName: 'Wolf', enemyHp: 5, enemyMaxHp: 20, round: 2 });

    const engine = makeEngine(userRepo, charRepo, new ScriptedGateway('combat', { name: 'Goblin', anchor: 'location' }));
    const startResult = await engine.startAction(characterId, 'attack the goblin');

    // The LLM's own hint always wins the name — only the condition is gated on it matching the
    // persisted edge, which it doesn't here (Wolf remembered, Goblin named).
    expect(startResult.combatEnemyName).toBe('Goblin');
    expect(startResult.combatEnemyCondition).toBeUndefined();

    closeDb();
  });

  // ── npc-anchor coverage: `seedInCombatEdge` above only ever anchors at a `location`, so the
  // `anchor.node === 'npc'` branch of `combatAnchorIsHere` (id-as-name lookup against
  // `npcRepo.findByLocation`) has never actually run in this suite.
  it('surfaces the remembered foe when the LLM is silent and the persisted edge is npc-anchored, not location-anchored', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    const npc = new NpcRepository(getDb()).create({ name: 'Shadow Stag', location: "The Warden's Oak" });
    new RelationRepository(getDb()).set({
      fromType: 'pc',
      fromRef: String(characterId),
      toType: 'npc',
      toRef: String(npc.id),
      relType: 'in_combat',
      props: { enemyName: 'Shadow Stag', enemyHp: 5, enemyMaxHp: 20, round: 2 },
    });

    // No combatEnemy passed to ScriptedGateway — the anchor check is the only route to the name.
    const engine = makeEngine(userRepo, charRepo, new ScriptedGateway('combat'));
    const startResult = await engine.startAction(characterId, 'resume fight');

    // 5/20 = 0.25 → filled = round(0.25*5) = 1 (Math.round), woundWord: >=0.15 and <0.4 → 'Battered'.
    expect(startResult.combatEnemyName).toBe('Shadow Stag');
    expect(startResult.combatEnemyCondition).toEqual({ woundWord: 'Battered', filled: 1, total: 5 });

    closeDb();
  });

  it('does not leak an npc-anchored foe when the LLM is silent and the anchored npc is not at the current location', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    // Npc lives in Eastvale, not "The Warden's Oak" — findByLocation() on the current location
    // will never return this npc, so the anchor guard must refuse to attribute the edge.
    const npc = new NpcRepository(getDb()).create({ name: 'Shadow Stag', location: 'Eastvale' });
    new RelationRepository(getDb()).set({
      fromType: 'pc',
      fromRef: String(characterId),
      toType: 'npc',
      toRef: String(npc.id),
      relType: 'in_combat',
      props: { enemyName: 'Shadow Stag', enemyHp: 5, enemyMaxHp: 20, round: 2 },
    });

    const engine = makeEngine(userRepo, charRepo, new ScriptedGateway('combat'));
    const startResult = await engine.startAction(characterId, 'resume fight');

    expect(startResult.combatEnemyName).toBeUndefined();
    expect(startResult.combatEnemyCondition).toBeUndefined();

    closeDb();
  });
});

describe('WorldEngineImpl — RA-3 bounded: mint the foe the world named but never had (SL-4/SL-7)', () => {
  /** A decide()-only queue gateway — `classify()` is never expected to fire (every rawInput
   *  below hits `heuristicClassify`'s own keyword table), and `resolveMutate`/`resolveNarrate`
   *  are fixed (RA-3 bounded is engine-authored `add_npc`, not LLM-authored, so nothing here
   *  needs to script loot/prose). Each `decide()` call consumes the next queued result, holding
   *  on the last entry once exhausted (continue rounds after the scripted ones reuse it). */
  class QueueGateway implements PipelineLlmGateway {
    private i = 0;
    constructor(private readonly decideQueue: PipelineDecideResult[]) {}

    async classify(): Promise<PipelineStageResult<ClassifyHit>> {
      throw new Error("unexpected classify() call — this test's rawInput should heuristic-hit");
    }

    async decide(): Promise<PipelineStageResult<PipelineDecideResult>> {
      const result = this.decideQueue[Math.min(this.i, this.decideQueue.length - 1)];
      this.i++;
      return { result, callId: 0 };
    }

    async resolveMutate(): Promise<PipelineStageResult<PipelineResolveMutateResult>> {
      return { result: { mutations: [] }, callId: 0 };
    }

    async resolveNarrate(): Promise<PipelineStageResult<PipelineResolveNarrateResult>> {
      return { result: { outcomeText: 'The fight ends.' }, callId: 0 };
    }
  }

  const LOCATION = "The Warden's Oak";

  function seedCharacter(): { userRepo: UserRepository; charRepo: CharacterRepository; characterId: number } {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    const userRepo = new UserRepository(getDb());
    const charRepo = new CharacterRepository(getDb());
    const user = userRepo.create('999999999');
    const characterId = charRepo.create(user.id, {
      name: 'Garrick',
      class: 'Fighter',
      upbringing: 'Village',
      race: 'Human',
      alignment: 'lawful good',
      day_job: 'Guard',
      stats: JSON.stringify({ physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }),
      health: 10,
      max_health: 10,
      max_stamina: 10,
      stamina: 10,
      rolls_remaining: 3,
      location: LOCATION,
      wealth: 5,
      last_action_state: null,
    }).id;
    return { userRepo, charRepo, characterId };
  }

  function makeEngine(
    userRepo: UserRepository,
    charRepo: CharacterRepository,
    gateway: PipelineLlmGateway,
    rolls: number[],
  ): WorldEngineImpl {
    let i = 0;
    return new WorldEngineImpl({
      db: getDb(),
      llm: { decide: async () => ({ distilledType: '__divine__', stat: 'physical', baseDc: 10, required: false, done: true, decision: [], outcomeText: '' }) },
      userRepo,
      charRepo,
      itemRepo: new ItemRepository(getDb()),
      actionRepo: new ActionRepository(getDb()),
      npcRepo: new NpcRepository(getDb()),
      pipelineLlmGateway: gateway,
      rollD20: () => rolls[i++],
    });
  }

  // baseDc=6 -> deriveEnemyMaxHp(6)=ENEMY_HP_MIN=6 for the unresolved/ambient establish paths
  // below; rolls [20, 1] force a player nat-20 (clean, amplified enemyHpDelta -8), which kills a
  // 6-HP foe outright in round 1 regardless of stats/items (resolveCombatRound's crit branch is
  // dice-only) — so every scenario reaches the fatal-blow interstitial after exactly one step().
  function unresolvedNpcDecide(name: string): PipelineDecideResult {
    return {
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 6,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      combatEnemy: { name, anchor: 'npc' },
    };
  }

  it('an anchor: npc foe whose name fails to resolve, then spared, mints exactly one NPC row with that name, a non-empty description, and health equal to its surviving HP', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    const engine = makeEngine(
      userRepo, charRepo,
      new QueueGateway([unresolvedNpcDecide('Raider')]),
      [20, 1],
    );

    await engine.startAction(characterId, 'attack the raider');
    const interstitial = await engine.stepAction(characterId, 'Press the attack');
    expect(interstitial.resolved).toBe(false);

    const spared = await engine.stepAction(characterId, 'Show mercy');
    expect(spared.resolved).toBe(true);

    const npcRepo = new NpcRepository(getDb());
    const minted = npcRepo.findByLocation(LOCATION).filter((n) => n.name === 'Raider');
    expect(minted).toHaveLength(1);
    expect(minted[0].description).toBeTruthy();
    expect(minted[0].health).toBe(1); // the spare's nominal surviving HP (SL-7)

    closeDb();
  });

  it('the same fight ending in a kill mints nothing', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    const engine = makeEngine(
      userRepo, charRepo,
      new QueueGateway([unresolvedNpcDecide('Raider')]),
      [20, 1],
    );

    await engine.startAction(characterId, 'attack the raider');
    const interstitial = await engine.stepAction(characterId, 'Press the attack');
    expect(interstitial.resolved).toBe(false);

    const killed = await engine.stepAction(characterId, 'Finish it');
    expect(killed.resolved).toBe(true);

    const npcRepo = new NpcRepository(getDb());
    expect(npcRepo.findByLocation(LOCATION).filter((n) => n.name === 'Raider')).toHaveLength(0);

    closeDb();
  });

  it('an anchor: location (ambient) foe mints nothing even when spared and even though DECIDE still supplies a name', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    const ambientDecide: PipelineDecideResult = {
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 6,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      combatEnemy: { name: 'a wolf', anchor: 'location' },
    };
    const engine = makeEngine(userRepo, charRepo, new QueueGateway([ambientDecide]), [20, 1]);

    await engine.startAction(characterId, 'attack the wolf');
    const interstitial = await engine.stepAction(characterId, 'Press the attack');
    expect(interstitial.resolved).toBe(false);

    const spared = await engine.stepAction(characterId, 'Show mercy');
    expect(spared.resolved).toBe(true);

    const npcRepo = new NpcRepository(getDb());
    expect(npcRepo.findByLocation(LOCATION).filter((n) => n.name.toLowerCase() === 'a wolf')).toHaveLength(0);

    closeDb();
  });

  it('a resolved NPC fight, spared, mints no duplicate row and writes no health to the existing row', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    const npcRepo = new NpcRepository(getDb());
    // health: 8 (not Kara's usual 16) so the same nat-20-vs-1 crit that one-shots the other
    // scenarios also one-shots her here (8-8=0) — keeping this fight a single WIN round, since a
    // CONTINUE round against a RESOLVED npc anchor would exercise a separate, pre-existing gap in
    // `persistAuthoredRelations` (it re-resolves the anchor's id-as-name against nearbyNpcs by
    // NAME, which a numeric id never matches — documented in `combat-state.ts`'s `toAnchor` and
    // worked around everywhere else by hand-writing the edge; out of RA-3 bounded's scope). This
    // test only cares about the NPC ROW, not the edge, so it sidesteps that gap entirely.
    const kara = npcRepo.create({ name: 'Kara', description: 'A lean, watchful hunter.', health: 8, location: LOCATION });

    const engine = makeEngine(userRepo, charRepo, new QueueGateway([unresolvedNpcDecide('Kara')]), [20, 1]);

    await engine.startAction(characterId, 'attack kara');
    const interstitial = await engine.stepAction(characterId, 'Press the attack');
    expect(interstitial.resolved).toBe(false);

    const spared = await engine.stepAction(characterId, 'Show mercy');
    expect(spared.resolved).toBe(true);

    // No duplicate row — the name resolved against Kara's own (pre-existing) row, so
    // `unresolvedNpcMint` was never set and nothing was minted.
    expect(npcRepo.findByLocation(LOCATION).filter((n) => n.name === 'Kara')).toHaveLength(1);
    // No health write either — SL-7 is explicit that a spared RESOLVED npc's row is untouched
    // (nothing in the nightly tick heals NPCs, so writing 1 here would permanently cripple her).
    expect(npcRepo.findById(kara.id)?.health).toBe(8);

    closeDb();
  });

  it('the minted NPC is visible to getNearbyNpcs and resolves as anchor: npc on a second encounter, seeding enemyMaxHp from the persisted row (clamped to ENEMY_HP_MIN) — and re-engaging creates no duplicate row', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    // Fight 1: establish (unresolved) -> spare -> mint 'Raider' at health 1. Fight 2's own
    // NEW_ACTION decide call (queue index 1) also names 'Raider' — this time nearbyNpcsAt CAN
    // see it (non-empty description), so resolution succeeds and the establish path reads its
    // real (1 HP) health off the row (clamped to ENEMY_HP_MIN) rather than re-deriving from
    // baseDc. Both fights are kept to a single WIN round (rolls [20,1] each) — a CONTINUE round
    // against this now-RESOLVED npc anchor would hit a separate, pre-existing gap in
    // `persistAuthoredRelations` (documented on the other test above), so this reads the seeded
    // HP off the terminal outcome's `combatFrame` instead of the mid-fight edge.
    const engine = makeEngine(
      userRepo, charRepo,
      new QueueGateway([unresolvedNpcDecide('Raider'), unresolvedNpcDecide('Raider')]),
      [20, 1, 20, 1],
    );

    await engine.startAction(characterId, 'attack the raider');
    const interstitial = await engine.stepAction(characterId, 'Press the attack');
    expect(interstitial.resolved).toBe(false);
    const spared = await engine.stepAction(characterId, 'Show mercy');
    expect(spared.resolved).toBe(true);

    const npcRepo = new NpcRepository(getDb());
    const minted = npcRepo.findByLocation(LOCATION).filter((n) => n.name === 'Raider');
    expect(minted).toHaveLength(1);
    expect(minted[0].health).toBe(1);

    // Re-engage: a second fight against the same name. The edge closed on the spare (SL-7), so
    // this establishes fresh rather than continuing — and this time resolution succeeds against
    // the minted row instead of falling back to an unresolved/ambient foe.
    await engine.startAction(characterId, 'attack the raider again');
    const reengageInterstitial = await engine.stepAction(characterId, 'Press the attack');
    expect(reengageInterstitial.resolved).toBe(false);
    const reengageSpared = await engine.stepAction(characterId, 'Show mercy');
    expect(reengageSpared.resolved).toBe(true);
    if (!reengageSpared.resolved) throw new Error('expected resolved step');

    expect(reengageSpared.outcome.combatFrame?.enemyName).toBe('Raider');
    // The row's health (1) clamped up to ENEMY_HP_MIN — weakened, not a 1-HP punchbag (SL-7).
    expect(reengageSpared.outcome.combatFrame?.enemyMaxHp).toBe(ENEMY_HP_MIN);

    // No duplicate row from the second encounter, resolved and spared again.
    expect(npcRepo.findByLocation(LOCATION).filter((n) => n.name === 'Raider')).toHaveLength(1);

    closeDb();
  });

  it('carries the mint intent across an action boundary: a bailed-then-re-engaged unresolved-npc fight still mints exactly once when the foe is finally spared', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    const engine = makeEngine(
      userRepo, charRepo,
      new QueueGateway([unresolvedNpcDecide('Raider')]),
      // Round 1 (action 1): playerD20=8, enemyD20=8 -> margin (8+3)-(8+0)=3 -> 'glanced'
      // (enemyHpDelta -3, playerHpDelta 0) — a non-lethal CONTINUE, 6 HP foe down to 3, no
      // player damage (never risks the hpZero floor). Round 2 (action 2, after the bail):
      // playerD20=20 forces a player-crit clean kill (enemyHpDelta -8), taking the 3-HP
      // survivor straight to the fatal-blow interstitial in a single round.
      [8, 8, 20, 5],
    );

    await engine.startAction(characterId, 'attack the raider');
    const round1 = await engine.stepAction(characterId, 'Press the attack');
    expect(round1.resolved).toBe(false); // CONTINUE, not yet the fatal-blow interstitial

    const bailed = await engine.stepAction(characterId, 'Flee the fight');
    expect(bailed.resolved).toBe(true);
    if (!bailed.resolved) throw new Error('expected resolved step');
    expect(bailed.outcome.outcome).toBe('bailed');

    // Re-engage in a BRAND-NEW action. `PipelineInternalActionState` — and its per-action
    // `unresolvedNpcMint` marker — was discarded the instant the bail above resolved; the
    // `in_combat` edge (still at 3/6 HP) is the only place the mint intent can still live.
    await engine.startAction(characterId, 'attack the raider again');
    const round2 = await engine.stepAction(characterId, 'Press the attack');
    expect(round2.resolved).toBe(false); // the fatal-blow interstitial

    const spared = await engine.stepAction(characterId, 'Show mercy');
    expect(spared.resolved).toBe(true);

    const npcRepo = new NpcRepository(getDb());
    const minted = npcRepo.findByLocation(LOCATION).filter((n) => n.name === 'Raider');
    expect(minted).toHaveLength(1);
    expect(minted[0].description).toBeTruthy();

    closeDb();
  });

  it('mints nothing for an anchor: location (ambient) foe put through the same bail-then-re-engage sequence — the edge prop is not a name-presence gate (SL-4)', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    const ambientDecide: PipelineDecideResult = {
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 6,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      combatEnemy: { name: 'a wolf', anchor: 'location' },
    };
    const engine = makeEngine(userRepo, charRepo, new QueueGateway([ambientDecide]), [8, 8, 20, 5]);

    await engine.startAction(characterId, 'attack the wolf');
    const round1 = await engine.stepAction(characterId, 'Press the attack');
    expect(round1.resolved).toBe(false);

    const bailed = await engine.stepAction(characterId, 'Flee the fight');
    expect(bailed.resolved).toBe(true);

    await engine.startAction(characterId, 'attack the wolf again');
    const round2 = await engine.stepAction(characterId, 'Press the attack');
    expect(round2.resolved).toBe(false);

    const spared = await engine.stepAction(characterId, 'Show mercy');
    expect(spared.resolved).toBe(true);

    const npcRepo = new NpcRepository(getDb());
    expect(npcRepo.findByLocation(LOCATION).filter((n) => n.name.toLowerCase() === 'a wolf')).toHaveLength(0);

    closeDb();
  });

  it('mints the foe at the FIGHT location, not the post-travel-gate destination, when the travel gate relocates the player mid-resolution — so a second encounter there resolves it instead of minting a duplicate', async () => {
    const { userRepo, charRepo, characterId } = seedCharacter();
    const decideWithSceneMove: PipelineDecideResult = {
      ...unresolvedNpcDecide('Raider'),
      // Diverges from char.location ("The Warden's Oak") with no relocate mutation authored —
      // applyTravelCoherenceGate injects a set_location into this same resolution, so the
      // applier's `applied.location` fallback (post-mutation) would place the mint in Town
      // Square while `homeLocation` (pre-mutation) stays at the fight's location.
      sceneLocation: 'Town Square',
    };
    // Second fight's decide carries no sceneLocation, so it doesn't re-trigger the gate —
    // this test isolates the mint-location bug to the first encounter only.
    const engine = makeEngine(
      userRepo, charRepo,
      new QueueGateway([decideWithSceneMove, unresolvedNpcDecide('Raider')]),
      [20, 5, 20, 5], // both fights one-shot-kill via a player nat-20 (see unresolvedNpcDecide's doc comment)
    );

    await engine.startAction(characterId, 'attack the raider');
    const interstitial = await engine.stepAction(characterId, 'Press the attack');
    expect(interstitial.resolved).toBe(false);

    const spared = await engine.stepAction(characterId, 'Show mercy');
    expect(spared.resolved).toBe(true);

    // The travel gate relocated the player mid-resolution — confirms the bug's precondition.
    const charRow = charRepo.findById(characterId);
    expect(charRow?.location).toBe('Town Square');

    const npcRepo = new NpcRepository(getDb());
    const minted = npcRepo.findByLocation(LOCATION).filter((n) => n.name === 'Raider');
    expect(minted).toHaveLength(1);
    expect(minted[0].location).toBe(LOCATION);
    expect(minted[0].home_location).toBe(LOCATION);

    // Return to the fight's location for a second encounter — it must resolve the minted row
    // (nearbyNpcsAt(LOCATION) now sees it) rather than falling back to unresolved-npc again and
    // minting a duplicate.
    charRepo.update(characterId, { location: LOCATION });
    await engine.startAction(characterId, 'attack the raider again');
    const reengage = await engine.stepAction(characterId, 'Press the attack');
    expect(reengage.resolved).toBe(false);
    const reengageSpared = await engine.stepAction(characterId, 'Show mercy');
    expect(reengageSpared.resolved).toBe(true);
    if (!reengageSpared.resolved) throw new Error('expected resolved step');

    expect(reengageSpared.outcome.combatFrame?.enemyName).toBe('Raider');
    expect(npcRepo.findByLocation(LOCATION).filter((n) => n.name === 'Raider')).toHaveLength(1);

    closeDb();
  });
});

// ── 0.3.4: an LLM stage failure must never kill the day (0.3.3 agent smoke run) ──
//
// Two live runs died mid-day: one to a beat-1 `decide` abort thrown straight out of
// `startAction`, one to a RESOLVE-NARRATE parse failure thrown out of `stepAction`. Both are
// "DeepSeek didn't answer usefully", and both used to propagate to the adapter as a bare error.
// They now fail open at the beat that owns the roll: beat 1 → divine intervention (roll never
// drained), beat 2+ → timed_out (roll refunded).

describe('WorldEngineImpl — pipeline stage failures fail open (0.3.4)', () => {
  // Each test builds its own in-memory DB; the singleton has to go back before the next.
  afterEach(closeDb);

  const CHAR = {
    name: 'Garrick',
    class: 'Fighter',
    upbringing: 'Village',
    race: 'Human',
    alignment: 'lawful good',
    day_job: 'Guard',
    stats: JSON.stringify({ physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }),
    health: 10,
    max_health: 10,
    max_stamina: 10,
    stamina: 10,
    rolls_remaining: 3,
    location: "The Warden's Oak",
    wealth: 5,
    last_action_state: null,
  };

  function jsonResponse(content: unknown): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  /** Routes on the stage marker the pipeline puts in its own user message, so the script can't
   *  drift when a stage is added or the call order changes (call-index scripting would). */
  function stageRouter(handlers: {
    decide: (nth: number) => Response;
    resolveMutate?: () => Response;
    resolveNarrate?: () => Response;
  }) {
    let decideCalls = 0;
    return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { messages: { content: string }[] };
      const userMessage = body.messages[1].content;
      if (userMessage.includes('RESOLVE-NARRATE')) return (handlers.resolveNarrate ?? (() => jsonResponse({ outcome_text: 'It happens.' })))();
      if (userMessage.includes('RESOLVE-MUTATE')) return (handlers.resolveMutate ?? (() => jsonResponse({ mutations: [] })))();
      return handlers.decide(++decideCalls);
    });
  }

  function makeEngine(fetchFn: ReturnType<typeof stageRouter>) {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    const userRepo = new UserRepository(getDb());
    const charRepo = new CharacterRepository(getDb());
    const user = userRepo.create('999999999');
    const characterId = charRepo.create(user.id, CHAR).id;

    const engine = new WorldEngineImpl({
      db: getDb(),
      llm: { decide: async () => ({ distilledType: '__divine__', stat: 'physical', baseDc: 10, required: false, done: true, decision: [], outcomeText: '' }) },
      userRepo,
      charRepo,
      itemRepo: new ItemRepository(getDb()),
      actionRepo: new ActionRepository(getDb()),
      npcRepo: new NpcRepository(getDb()),
      pipelineLlm: { apiKey: 'test-key', model: 'test-model', fetch: fetchFn as unknown as typeof fetch },
      rollD20: () => 15,
    });
    return { engine, charRepo, characterId };
  }

  const withOneOption = {
    distilledType: 'inspection',
    stat: 'physical',
    baseDc: 12,
    required: true,
    // Two options deliberately: a single-option decide routes through `validateSingleOption`,
    // which spends another decide call and would consume the terminating script below.
    decision: [
      { label: 'Look closer', dcModifier: 0, stat: 'physical' },
      { label: 'Force the hasp', dcModifier: 3, stat: 'physical' },
    ],
  };

  it('resolves start as divine intervention (roll never drained) when the beat-1 decide aborts', async () => {
    const { engine, charRepo, characterId } = makeEngine(
      stageRouter({
        decide: () => {
          const error = new Error('This operation was aborted') as Error & { name: string };
          error.name = 'AbortError';
          throw error;
        },
      }),
    );

    // The bug: this used to reject, killing the interaction with a bare AbortError.
    const result = await engine.startAction(characterId, 'inspect the lockup');

    expect(result.outcome?.isDivineIntervention).toBe(true);
    expect(result.outcome?.rollRefunded).toBe(true);
    expect(result.outcome?.rollsDelta).toBe(0);
    // The roll was never spent — a system fault before beat 1 costs the player nothing.
    expect(charRepo.findById(characterId)!.rolls_remaining).toBe(3);
    expect(charRepo.findById(characterId)!.last_action_state).toBeNull();

  });

  it('resolves start as divine intervention when the beat-1 decide returns unparseable JSON', async () => {
    const { engine, charRepo, characterId } = makeEngine(
      stageRouter({ decide: () => jsonResponse('not json {') }),
    );

    const result = await engine.startAction(characterId, 'inspect the lockup');

    expect(result.outcome?.isDivineIntervention).toBe(true);
    expect(charRepo.findById(characterId)!.rolls_remaining).toBe(3);

  });

  it('resolves start as divine intervention when DeepSeek answers beat-1 with empty content', async () => {
    const { engine, charRepo, characterId } = makeEngine(
      stageRouter({ decide: () => jsonResponse('') }),
    );

    const result = await engine.startAction(characterId, 'inspect the lockup');

    expect(result.outcome?.isDivineIntervention).toBe(true);
    expect(charRepo.findById(characterId)!.rolls_remaining).toBe(3);

  });

  it('resolves a step as timed_out (roll refunded) when RESOLVE-NARRATE comes back unparseable', async () => {
    const { engine, charRepo, characterId } = makeEngine(
      stageRouter({
        // Beat 1 offers a real option; the continue beat returns no options, which routes
        // straight into the resolve pipeline — where narrate then fails.
        decide: (nth) => jsonResponse(nth === 1 ? withOneOption : { ...withOneOption, required: false, decision: [] }),
        resolveNarrate: () => jsonResponse('not json {'),
      }),
    );

    await engine.startAction(characterId, 'inspect the lockup');
    expect(charRepo.findById(characterId)!.rolls_remaining).toBe(2); // drained at start

    // The bug: this used to reject out of stepChoice/runWork and crash the whole day.
    const result = await engine.stepAction(characterId, 'Look closer');

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.outcome.outcome).toBe('timed_out');
      expect(result.outcome.rollRefunded).toBe(true);
      expect(result.outcome.rollsDelta).toBe(0);
    }
    // Refunded back to the pre-action count, and no stuck state left behind.
    expect(charRepo.findById(characterId)!.rolls_remaining).toBe(3);
    expect(charRepo.findById(characterId)!.last_action_state).toBeNull();

  });

  it('resolves a step as timed_out when RESOLVE-MUTATE fails', async () => {
    const { engine, charRepo, characterId } = makeEngine(
      stageRouter({
        decide: (nth) => jsonResponse(nth === 1 ? withOneOption : { ...withOneOption, required: false, decision: [] }),
        resolveMutate: () => new Response('{"error":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } }),
      }),
    );

    await engine.startAction(characterId, 'inspect the lockup');
    const result = await engine.stepAction(characterId, 'Look closer');

    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.outcome.outcome).toBe('timed_out');
    expect(charRepo.findById(characterId)!.rolls_remaining).toBe(3);

  });
});
