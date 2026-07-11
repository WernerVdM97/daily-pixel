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

// F#6 — getJournal derives player-facing "intel gathered" facts from the applied_mutations
// column already sitting on the action row (no new tracking), so a discovered location or a
// met NPC surfaces in the journal without a new table/column.
describe('WorldEngineImpl — journal discoveries (F#6)', () => {
  let engine: WorldEngineImpl;
  let pipelineGateway: MockPipelineGateway;
  let characterId: number;

  function setDecideEmpty(): void {
    pipelineGateway.setDecideResponse(() => ({
      result: { distilledType: 'explore', stat: 'physical', baseDc: 10, required: false, decision: [] },
      callId: 0,
    }));
  }

  function setResolveMutate(mutations: unknown[]): void {
    pipelineGateway.setResolveMutateResponse(() => ({ result: { mutations }, callId: 0 }));
  }

  function setResolveNarrate(outcomeText: string): void {
    pipelineGateway.setResolveNarrateResponse(() => ({ result: { outcomeText }, callId: 0 }));
  }

  beforeEach(() => {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    pipelineGateway = new MockPipelineGateway();
    engine = new WorldEngineImpl({
      db: getDb(),
      userRepo: new UserRepository(getDb()),
      charRepo: new CharacterRepository(getDb()),
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

  it('surfaces a reveal_location mutation as a discovery on that action', async () => {
    setDecideEmpty();
    setResolveMutate([{ type: 'reveal_location', name: 'Whispering Vale', direction: 'N' }]);
    setResolveNarrate('You spot a hidden vale to the north.');

    await engine.startAction(characterId, 'scout north');

    const journal = engine.getJournal(characterId);
    expect(journal.recentActions[0].discoveries).toEqual(['🗺️ Discovered **Whispering Vale**']);
  });

  it('surfaces an add_npc mutation as a discovery on that action', async () => {
    setDecideEmpty();
    setResolveMutate([{ type: 'add_npc', name: 'Old Tom', class: 'Hermit' }]);
    setResolveNarrate('An old hermit steps out of the brush.');

    await engine.startAction(characterId, 'investigate the noise');

    const journal = engine.getJournal(characterId);
    expect(journal.recentActions[0].discoveries).toEqual(['🤝 Met **Old Tom**']);
  });

  it('reports both discoveries when an action produces more than one', async () => {
    setDecideEmpty();
    setResolveMutate([
      { type: 'reveal_location', name: 'Whispering Vale', direction: 'N' },
      { type: 'add_npc', name: 'Old Tom', class: 'Hermit' },
    ]);
    setResolveNarrate('You find both a hidden vale and its keeper.');

    await engine.startAction(characterId, 'scout north');

    const journal = engine.getJournal(characterId);
    expect(journal.recentActions[0].discoveries).toEqual([
      '🗺️ Discovered **Whispering Vale**',
      '🤝 Met **Old Tom**',
    ]);
  });

  it('leaves discoveries empty for mutations that are not intel (e.g. modify_wealth)', async () => {
    setDecideEmpty();
    setResolveMutate([{ type: 'modify_wealth', amount: 5 }]);
    setResolveNarrate('You find a few coins.');

    await engine.startAction(characterId, 'search the ground');

    const journal = engine.getJournal(characterId);
    expect(journal.recentActions[0].discoveries).toEqual([]);
  });

  it('leaves discoveries empty when the action applied no mutations', async () => {
    setDecideEmpty();
    setResolveMutate([]);
    setResolveNarrate('Nothing comes of it.');

    await engine.startAction(characterId, 'wait quietly');

    const journal = engine.getJournal(characterId);
    expect(journal.recentActions[0].discoveries).toEqual([]);
  });
});
