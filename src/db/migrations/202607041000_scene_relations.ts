import type { Migration } from './types.js';

/**
 * Stage 2 T1 — the typed scene-state graph (docs/engine/stage-2-scene-state-spine-plan.md).
 *
 * `relations` is a typed, directed edge between two polymorphic nodes
 * `(type, ref)` — `type ∈ 'pc' | 'npc' | 'location'`; `pc` ref = character_id,
 * `npc` ref = the resolved npc id, `location` ref = location name (matching
 * `location_edges`' existing name-keyed convention, decision 4). `props` is a
 * JSON scalar bag whose per-`relType` shape is owned by each writer (Stage 3+),
 * NOT this migration.
 *
 * Additive + structural only: nothing reads or writes this table yet (T2 stops
 * at the pure mutation layer; T3 wires persistence into the pipeline). Not
 * added to schema.sql/baseline — this is pipeline-only infra (decision 1).
 */
export const migration: Migration = {
  id: '202607041000_scene_relations',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS relations (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        from_type             TEXT    NOT NULL CHECK (from_type IN ('pc', 'npc', 'location')),
        from_ref              TEXT    NOT NULL,
        to_type               TEXT    NOT NULL CHECK (to_type IN ('pc', 'npc', 'location')),
        to_ref                TEXT    NOT NULL,
        rel_type              TEXT    NOT NULL,
        props                 TEXT    NOT NULL DEFAULT '{}',  -- JSON object of clamped scalars
        created_by_action_id  INTEGER,
        updated_day           INTEGER,
        UNIQUE (from_type, from_ref, to_type, to_ref, rel_type)
      )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_type, to_ref)');
  },
};
