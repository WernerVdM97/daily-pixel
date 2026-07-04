import type Database from 'better-sqlite3';
import type { RelationRow } from './types.js';

export type { RelationRow };

/** Polymorphic node kind (Stage 2 decision 4) — not a new FK scheme. */
export type NodeType = 'pc' | 'npc' | 'location';

/** The unique key of a `relations` edge — mirrors the table's UNIQUE constraint. */
export interface RelationKey {
  fromType: NodeType;
  fromRef: string;
  toType: NodeType;
  toRef: string;
  relType: string;
}

/** A scalar prop bag — the generic edge shape; per-`relType` schemas belong to writers (Stage 3+). */
export type RelationProps = Record<string, number | string | boolean>;

export interface RelationEdge extends RelationKey {
  props?: RelationProps;
  createdByActionId?: number | null;
  updatedDay?: number | null;
}

/**
 * The scene-state graph. Edges are typed, directed, and keyed by
 * `(from_type, from_ref, to_type, to_ref, rel_type)`. Additive-only in this
 * pass — nothing reads/writes it yet (T3 wires it into the pipeline).
 */
export class RelationRepository {
  constructor(private db: Database.Database) {}

  /** Upsert by the unique key: insert a new edge, or overwrite an existing edge's props/day. */
  set(edge: RelationEdge): void {
    this.db
      .prepare(
        `INSERT INTO relations
           (from_type, from_ref, to_type, to_ref, rel_type, props, created_by_action_id, updated_day)
         VALUES (@from_type, @from_ref, @to_type, @to_ref, @rel_type, @props, @created_by_action_id, @updated_day)
         ON CONFLICT(from_type, from_ref, to_type, to_ref, rel_type)
         DO UPDATE SET props = excluded.props, updated_day = excluded.updated_day`,
      )
      .run({
        from_type: edge.fromType,
        from_ref: edge.fromRef,
        to_type: edge.toType,
        to_ref: edge.toRef,
        rel_type: edge.relType,
        props: JSON.stringify(edge.props ?? {}),
        created_by_action_id: edge.createdByActionId ?? null,
        updated_day: edge.updatedDay ?? null,
      });
  }

  /**
   * Merge `propDeltas` onto an existing edge and return whether one existed
   * (`false` — no write — if missing). Numeric keys already present as numbers
   * are summed (the delta semantics `update_relation` needs, e.g. `enemyHp -5`);
   * any other key (new, or an absolute value like a posture string) overwrites,
   * matching T2's "props carry deltas/sets" op shape.
   */
  updateProps(key: RelationKey, propDeltas: RelationProps, updatedDay?: number | null): boolean {
    const existing = this.find(key);
    if (!existing) return false;

    const current = JSON.parse(existing.props) as RelationProps;
    for (const [k, v] of Object.entries(propDeltas)) {
      const base = current[k];
      current[k] = typeof base === 'number' && typeof v === 'number' ? base + v : v;
    }

    this.db
      .prepare(
        `UPDATE relations SET props = @props, updated_day = @updated_day
         WHERE from_type = @from_type AND from_ref = @from_ref
           AND to_type = @to_type AND to_ref = @to_ref AND rel_type = @rel_type`,
      )
      .run({
        props: JSON.stringify(current),
        updated_day: updatedDay ?? existing.updated_day,
        from_type: key.fromType,
        from_ref: key.fromRef,
        to_type: key.toType,
        to_ref: key.toRef,
        rel_type: key.relType,
      });
    return true;
  }

  find(key: RelationKey): RelationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM relations
         WHERE from_type = ? AND from_ref = ? AND to_type = ? AND to_ref = ? AND rel_type = ?`,
      )
      .get(key.fromType, key.fromRef, key.toType, key.toRef, key.relType) as RelationRow | undefined;
  }

  /** Every edge touching `(type, ref)`, in EITHER direction — the D1 subgraph read for context assembly. */
  forNode(type: NodeType, ref: string): RelationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM relations
         WHERE (from_type = @type AND from_ref = @ref) OR (to_type = @type AND to_ref = @ref)`,
      )
      .all({ type, ref }) as RelationRow[];
  }

  remove(key: RelationKey): void {
    this.db
      .prepare(
        `DELETE FROM relations
         WHERE from_type = ? AND from_ref = ? AND to_type = ? AND to_ref = ? AND rel_type = ?`,
      )
      .run(key.fromType, key.fromRef, key.toType, key.toRef, key.relType);
  }
}
