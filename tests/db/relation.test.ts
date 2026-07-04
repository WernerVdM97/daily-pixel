import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrate.js';
import { RelationRepository, type RelationKey } from '../../src/db/repositories/relation.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db); // structural only; T1 is additive infra with no seeded rows
});
afterEach(() => db.close());

describe('scene_relations migration — structure', () => {
  it('creates the relations table with its unique-key columns', () => {
    const cols = (db.prepare("PRAGMA table_info('relations')").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'from_type', 'from_ref', 'to_type', 'to_ref', 'rel_type', 'props',
        'created_by_action_id', 'updated_day',
      ]),
    );
  });

  it('creates the idx_relations_to reverse-lookup index', () => {
    const indexes = (db.prepare("PRAGMA index_list('relations')").all() as { name: string }[]).map((i) => i.name);
    expect(indexes).toContain('idx_relations_to');
  });

  it('is idempotent — re-running the migration does not error', () => {
    expect(() => runMigrations(db)).not.toThrow();
  });
});

describe('RelationRepository', () => {
  let relations: RelationRepository;
  const combatKey: RelationKey = { fromType: 'pc', fromRef: '1', toType: 'npc', toRef: '42', relType: 'in_combat' };

  beforeEach(() => (relations = new RelationRepository(db)));

  it('set then find round-trips the edge', () => {
    relations.set({ ...combatKey, props: { enemyHp: 10, posture: 'guarded' }, createdByActionId: 7, updatedDay: 3 });
    const row = relations.find(combatKey);
    expect(row).toMatchObject({
      from_type: 'pc', from_ref: '1', to_type: 'npc', to_ref: '42', rel_type: 'in_combat',
      created_by_action_id: 7, updated_day: 3,
    });
    expect(JSON.parse(row!.props)).toEqual({ enemyHp: 10, posture: 'guarded' });
  });

  it('find returns undefined for a missing edge', () => {
    expect(relations.find(combatKey)).toBeUndefined();
  });

  it('a second set on the same key upserts — no duplicate row', () => {
    relations.set({ ...combatKey, props: { enemyHp: 10 } });
    relations.set({ ...combatKey, props: { enemyHp: 4 }, updatedDay: 5 });

    const rows = db.prepare('SELECT * FROM relations').all() as { id: number }[];
    expect(rows).toHaveLength(1);

    const row = relations.find(combatKey);
    expect(JSON.parse(row!.props)).toEqual({ enemyHp: 4 });
    expect(row!.updated_day).toBe(5);
  });

  it('updateProps merges a numeric delta onto an existing edge', () => {
    relations.set({ ...combatKey, props: { enemyHp: 10, posture: 'guarded' } });
    const ok = relations.updateProps(combatKey, { enemyHp: -3 }, 2);
    expect(ok).toBe(true);

    const row = relations.find(combatKey);
    expect(JSON.parse(row!.props)).toEqual({ enemyHp: 7, posture: 'guarded' });
    expect(row!.updated_day).toBe(2);
  });

  it('updateProps returns false for a missing edge (no write)', () => {
    const ok = relations.updateProps(combatKey, { enemyHp: -3 });
    expect(ok).toBe(false);
    expect(relations.find(combatKey)).toBeUndefined();
  });

  it('forNode returns edges touching the node in both directions', () => {
    relations.set({ fromType: 'pc', fromRef: '1', toType: 'npc', toRef: '42', relType: 'in_combat', props: {} });
    relations.set({ fromType: 'npc', fromRef: '42', toType: 'location', toRef: 'Town Square', relType: 'knows_secret', props: {} });
    relations.set({ fromType: 'pc', fromRef: '99', toType: 'npc', toRef: '7', relType: 'trust', props: {} });

    const edges = relations.forNode('npc', '42');
    expect(edges).toHaveLength(2);
    const relTypes = edges.map((e) => e.rel_type).sort();
    expect(relTypes).toEqual(['in_combat', 'knows_secret']);
  });

  it('remove deletes the edge', () => {
    relations.set({ ...combatKey, props: {} });
    relations.remove(combatKey);
    expect(relations.find(combatKey)).toBeUndefined();
  });
});
