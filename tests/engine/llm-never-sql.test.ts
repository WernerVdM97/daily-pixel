import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { validateMutations, type MutationContext } from '../../src/engine/action/mutations.js';
import { WORLD_MUTATION_TYPES, type WorldMutation } from '../../src/engine/WorldEngine.js';
import { migration as sceneRelationsMigration } from '../../src/db/migrations/202607041000_scene_relations.js';
import { RelationRepository, type RelationKey } from '../../src/db/repositories/relation.js';

/**
 * Stage 2 T5c — the LLM-never-SQL proof (decision 5; risk table "LLM handed state-truth via
 * SQL"). Two focused tests hook the single write choke point (typed op → validateMutations →
 * repo, `relation.ts:51` JSON-stringifies props as a bound param): (1) the mutation vocabulary is
 * a closed whitelist — no smuggled op name, however SQL-shaped, is ever accepted; (2) a string
 * payload carrying an injection attempt is stored/read back only as inert bound-parameter data,
 * never as executed SQL.
 */

function ctx(overrides?: Partial<MutationContext>): MutationContext {
  return {
    currentHealth: 12,
    maxHealth: 12,
    stamina: 10,
    maxStamina: 10,
    wealth: 5,
    rollsRemaining: 2,
    location: "The Warden's Oak",
    ...overrides,
  };
}

describe('LLM-never-SQL proof (Stage 2 T5c, decision 5) — closed vocabulary', () => {
  it('rejects an SQL-shaped op name — only WORLD_MUTATION_TYPES-whitelisted ops are ever acted on', () => {
    const sqlShaped = { type: "'; DROP TABLE relations; --" } as unknown as WorldMutation;
    const result = validateMutations([sqlShaped], ctx());

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/Unknown mutation type/);
    // The whitelist is WORLD_MUTATION_TYPES (WorldEngine.ts) — the SQL-shaped string is not a
    // member, which is exactly why validateOne's `!MUTATION_TYPES.has(m.type)` guard fires.
    expect((WORLD_MUTATION_TYPES as readonly string[]).includes(sqlShaped.type)).toBe(false);
  });

  it('rejects a plausible-but-unwhitelisted op name — the vocabulary cannot be freely extended by the LLM', () => {
    const arbitrary = { type: 'arbitrary_op' } as unknown as WorldMutation;
    const result = validateMutations([arbitrary], ctx());

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('Unknown mutation type: "arbitrary_op"');
    expect((WORLD_MUTATION_TYPES as readonly string[]).includes(arbitrary.type)).toBe(false);
  });
});

describe('LLM-never-SQL proof (Stage 2 T5c, decision 5) — strings are inert data, not SQL', () => {
  let db: Database.Database;
  let relations: RelationRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // ONLY the relations migration — this proof is about the write choke point, not the whole
    // schema (mirrors T3's original "ONLY the relations migration" seam rationale).
    sceneRelationsMigration.up(db);
    relations = new RelationRepository(db);
  });

  afterEach(() => db.close());

  it('an injection-shaped props payload round-trips verbatim and the relations table survives', () => {
    const key: RelationKey = { fromType: 'pc', fromRef: '1', toType: 'location', toRef: "The Warden's Oak", relType: 'knows_secret' };
    const injectionPayload = {
      note: "'); DROP TABLE relations; --",
      label: "1); DELETE FROM relations WHERE ('1'='1",
    };

    relations.set({ ...key, props: injectionPayload });

    // (a) the props come back byte-identical — proof the strings were written as a bound
    // parameter (relation.ts:51's `JSON.stringify(edge.props)` param), never interpolated/executed.
    const row = relations.find(key);
    expect(row).toBeDefined();
    const roundTripped = JSON.parse(row!.props) as Record<string, unknown>;
    expect(roundTripped.note).toBe(injectionPayload.note);
    expect(roundTripped.label).toBe(injectionPayload.label);

    // (a2) `forNode` is the actual D1 subgraph-read path context assembly uses — proof the
    // production read path also returns the payload as inert data, not just `find`.
    const nodeRows = relations.forNode('pc', '1');
    const nodeRow = nodeRows.find((r) => r.rel_type === 'knows_secret');
    expect(nodeRow).toBeDefined();
    const nodeRoundTripped = JSON.parse(nodeRow!.props) as Record<string, unknown>;
    expect(nodeRoundTripped.note).toBe(injectionPayload.note);
    expect(nodeRoundTripped.label).toBe(injectionPayload.label);

    // (b) the table still exists and holds exactly the one row written — no table was dropped,
    // no extra/fewer rows from a smuggled statement.
    const count = (db.prepare('SELECT count(*) AS n FROM relations').get() as { n: number }).n;
    expect(count).toBe(1);

    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relations'")
      .get();
    expect(tableExists).toBeDefined();
  });
});
