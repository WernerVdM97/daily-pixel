import { describe, it, expect, vi } from 'vitest';
import { WorldEngineImpl } from '../../src/engine/WorldEngineImpl.js';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { migrate, seedWorld, SEEDED_LOCATIONS, SEEDED_EDGES } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import { ItemRepository } from '../../src/db/repositories/item.js';
import { ActionRepository } from '../../src/db/repositories/action.js';
import { NpcRepository } from '../../src/db/repositories/npc.js';
// ── T6 concurrent step serialisation ──

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


