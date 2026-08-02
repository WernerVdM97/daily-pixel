import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorldEngineImpl } from '../../src/engine/WorldEngineImpl.js';
import { MockPipelineGateway } from '../helpers/MockPipelineGateway.js';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { migrate, seedWorld, SEEDED_LOCATIONS, SEEDED_EDGES } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import { ItemRepository } from '../../src/db/repositories/item.js';
import { ActionRepository } from '../../src/db/repositories/action.js';
import { NpcRepository } from '../../src/db/repositories/npc.js';

describe('WorldEngineImpl — resolvePendingChoice (M3.2a, DC-A)', () => {
  let engine: WorldEngineImpl;
  let charRepo: CharacterRepository;
  let characterId: number;

  beforeEach(() => {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    const pipelineGateway = new MockPipelineGateway();
    charRepo = new CharacterRepository(getDb());
    engine = new WorldEngineImpl({
      db: getDb(),
      userRepo: new UserRepository(getDb()),
      charRepo,
      itemRepo: new ItemRepository(getDb()),
      actionRepo: new ActionRepository(getDb()),
      npcRepo: new NpcRepository(getDb()),
      pipelineLlmGateway: pipelineGateway,
      rollD20: () => 15,
    });
    const char = engine.createCharacter('u1', {
      name: 'Kael', class: 'Hunter', upbringing: 'Outskirts',
      race: 'Human', alignment: 'Neutral', dayJob: 'Forager',
    });
    characterId = char.id;
  });

  afterEach(() => closeDb());

  function setPendingOptions(options: unknown[]): void {
    charRepo.update(characterId, {
      last_action_state: JSON.stringify({ pendingDecision: { prompt: 'What do you do?', options } }),
    });
  }

  it('resolves an option index to that option\'s label', () => {
    setPendingOptions([
      { label: 'Advance carefully', dcModifier: 0 },
      { label: 'Charge in', dcModifier: 2 },
      { label: 'Retreat', dcModifier: null },
    ]);

    const label = engine.resolvePendingChoice(characterId, { kind: 'option', index: 1 });

    expect(label).toBe('Charge in');
  });

  it('resolves bail to the option with dcModifier === null', () => {
    setPendingOptions([
      { label: 'Advance carefully', dcModifier: 0 },
      { label: 'Retreat', dcModifier: null },
    ]);

    const label = engine.resolvePendingChoice(characterId, { kind: 'bail' });

    expect(label).toBe('Retreat');
  });

  it('normalises empty options to a synthetic Continue, index 0 for option and Bail for bail', () => {
    setPendingOptions([]);

    expect(engine.resolvePendingChoice(characterId, { kind: 'option', index: 0 })).toBe('Continue');
    expect(engine.resolvePendingChoice(characterId, { kind: 'bail' })).toBe('Bail');
  });

  it('returns null (option) / Bail (bail) when there is no action state at all', () => {
    // characterId was just created — no action ever started, so last_action_state is null.
    expect(engine.resolvePendingChoice(characterId, { kind: 'option', index: 0 })).toBeNull();
    expect(engine.resolvePendingChoice(characterId, { kind: 'bail' })).toBe('Bail');
  });

  it('returns null for an out-of-range option index', () => {
    setPendingOptions([{ label: 'Advance carefully', dcModifier: 0 }]);

    const label = engine.resolvePendingChoice(characterId, { kind: 'option', index: 5 });

    expect(label).toBeNull();
  });
});
