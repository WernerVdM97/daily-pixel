import { describe, it, expect, vi } from 'vitest';
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
});
