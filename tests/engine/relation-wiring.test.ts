import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrate.js';
import { RelationRepository } from '../../src/db/repositories/relation.js';
import {
  resolveRelationEndpoint,
  resolveAuthoredRelation,
  persistAuthoredRelations,
  type NearbyNpc,
} from '../../src/engine/action/relation-wiring.js';
import type { AuthoredRelation } from '../../src/engine/action/mutations.js';

const npcs: NearbyNpc[] = [
  { id: 42, name: 'Grum the Smith', description: 'A burly blacksmith.' },
];

describe('resolveRelationEndpoint', () => {
  it('resolves a pc endpoint to ("pc", String(char.id)) — no lookup needed', () => {
    expect(resolveRelationEndpoint({ node: 'pc' }, { id: 7 }, [])).toEqual({ type: 'pc', ref: '7' });
  });

  it('resolves a location endpoint to ("location", trimmed name) — name-keyed, no lookup', () => {
    expect(resolveRelationEndpoint({ node: 'location', name: '  The Old Mill  ' }, { id: 1 }, [])).toEqual({
      type: 'location',
      ref: 'The Old Mill',
    });
  });

  it('drops a location endpoint with an empty/whitespace name, warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveRelationEndpoint({ node: 'location', name: '   ' }, { id: 1 }, [])).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('resolves an npc endpoint by case-insensitive name match against the supplied nearby-npc list', () => {
    expect(resolveRelationEndpoint({ node: 'npc', name: 'grum the smith' }, { id: 1 }, npcs)).toEqual({
      type: 'npc',
      ref: '42',
    });
  });

  it('drops an npc endpoint against an empty nearby-npc list, warning (never throws)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveRelationEndpoint({ node: 'npc', name: 'grum the smith' }, { id: 1 }, [])).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('grum the smith');
    warn.mockRestore();
  });

  it('drops an npc endpoint whose name matches nobody in a non-empty list, warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveRelationEndpoint({ node: 'npc', name: 'Someone Else' }, { id: 1 }, npcs)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('resolveAuthoredRelation', () => {
  it('resolves a well-formed pc -> location relation to a full RelationKey', () => {
    const relation: AuthoredRelation = {
      from: { node: 'pc' },
      to: { node: 'location', name: 'The Old Mill' },
      relType: 'knows_secret',
      props: {},
    };
    expect(resolveAuthoredRelation(relation, { id: 3 }, [])).toEqual({
      fromType: 'pc',
      fromRef: '3',
      toType: 'location',
      toRef: 'The Old Mill',
      relType: 'knows_secret',
    });
  });

  it('resolves a pc -> npc relation when the npc is in the supplied nearby list', () => {
    const relation: AuthoredRelation = {
      from: { node: 'pc' },
      to: { node: 'npc', name: 'Grum the Smith' },
      relType: 'trust',
      props: { score: 5 },
    };
    expect(resolveAuthoredRelation(relation, { id: 3 }, npcs)).toEqual({
      fromType: 'pc',
      fromRef: '3',
      toType: 'npc',
      toRef: '42',
      relType: 'trust',
    });
  });

  it('drops the whole edge (returns null) when the npc endpoint is unresolvable against an empty list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const relation: AuthoredRelation = {
      from: { node: 'pc' },
      to: { node: 'npc', name: 'Grum the Smith' },
      relType: 'trust',
      props: {},
    };
    expect(resolveAuthoredRelation(relation, { id: 3 }, [])).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

// Stage 5 Task 0 — the shared host-wiring helper both WorldEngineImpl and PipelineSimEngine call
// from their resolution paths. Exercised against a real in-memory RelationRepository (mirrors
// tests/db/relation.test.ts's setup) rather than a mock, since the point of this helper is the
// resolve-then-persist round trip through the repo.
describe('persistAuthoredRelations', () => {
  let db: Database.Database;
  let repo: RelationRepository;
  const npcs: NearbyNpc[] = [
    { id: 42, name: 'Grum the Smith', description: 'A burly blacksmith.' },
  ];

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    repo = new RelationRepository(db);
  });
  afterEach(() => db.close());

  it('set path: a resolvable pc -> location set_relation persists a row', () => {
    const relation: AuthoredRelation = {
      from: { node: 'pc' },
      to: { node: 'location', name: 'The Old Mill' },
      relType: 'knows_secret',
      props: { learnedDay: 3 },
    };
    persistAuthoredRelations(repo, [relation], [], { id: 1 }, []);

    expect(repo.count()).toBe(1);
    const edges = repo.forNode('pc', '1');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from_type: 'pc', from_ref: '1', to_type: 'location', to_ref: 'The Old Mill', rel_type: 'knows_secret' });
    expect(JSON.parse(edges[0].props)).toEqual({ learnedDay: 3 });
  });

  it('updateProps path: a follow-up update_relation on that edge merges its prop delta', () => {
    const setRelation: AuthoredRelation = {
      from: { node: 'pc' },
      to: { node: 'npc', name: 'Grum the Smith' },
      relType: 'trust',
      props: { score: 5 },
    };
    persistAuthoredRelations(repo, [setRelation], [], { id: 1 }, npcs);

    const updateRelation: AuthoredRelation = { ...setRelation, props: { score: 2 } };
    persistAuthoredRelations(repo, [], [updateRelation], { id: 1 }, npcs);

    const edges = repo.forNode('npc', '42');
    expect(edges).toHaveLength(1);
    expect(JSON.parse(edges[0].props)).toEqual({ score: 7 });
  });

  it('updateProps path: update_relation on a MISSING edge warns and no-ops (never throws)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const relation: AuthoredRelation = {
      from: { node: 'pc' },
      to: { node: 'npc', name: 'Grum the Smith' },
      relType: 'trust',
      props: { score: 2 },
    };

    expect(() => persistAuthoredRelations(repo, [], [relation], { id: 1 }, npcs)).not.toThrow();

    expect(repo.count()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('drop path: an npc endpoint not among nearbyNpcs is dropped — no row, no throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const relation: AuthoredRelation = {
      from: { node: 'pc' },
      to: { node: 'npc', name: 'A Stranger' },
      relType: 'trust',
      props: { score: 1 },
    };

    expect(() => persistAuthoredRelations(repo, [relation], [], { id: 1 }, npcs)).not.toThrow();

    expect(repo.count()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
