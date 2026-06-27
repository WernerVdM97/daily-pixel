import type Database from 'better-sqlite3';
import type { LocationEdgeRow } from './types.js';

export type { LocationEdgeRow };

/** A traversable neighbour reachable from a node (either edge direction). */
export interface Neighbour {
  name: string;
  difficulty: number;
  direction: string;
  flavour: string | null;
}

/** A dangling frontier exit — a road with no node on the far side yet. */
export interface FrontierExit {
  direction: string;
  teaser: string | null;
  flavour: string | null;
  difficulty: number;
}

/**
 * The shared world graph. Edges are stored once per connection (parent → child)
 * but adjacency is SYMMETRIC for routing — you can walk a road back — so
 * `neighbours` unions both directions. A frontier exit is a row with
 * `to_location IS NULL`.
 */
export class LocationEdgeRepository {
  constructor(private db: Database.Database) {}

  /** Charted neighbours of `name`, both directions, for routing/rendering. */
  neighbours(name: string): Neighbour[] {
    return this.db
      .prepare(
        `SELECT to_location   AS name, direction, difficulty, flavour FROM location_edges WHERE from_location = @name AND to_location IS NOT NULL
         UNION ALL
         SELECT from_location AS name, direction, difficulty, flavour FROM location_edges WHERE to_location = @name`,
      )
      .all({ name }) as Neighbour[];
  }

  /** Unexplored exits radiating from `name` (the invitation to explore). */
  frontierExits(name: string): FrontierExit[] {
    return this.db
      .prepare(
        'SELECT direction, teaser, flavour, difficulty FROM location_edges WHERE from_location = ? AND to_location IS NULL',
      )
      .all(name) as FrontierExit[];
  }

  /** Every edge in the shared graph (tiny — fine to read whole for masking). */
  all(): LocationEdgeRow[] {
    return this.db.prepare('SELECT * FROM location_edges').all() as LocationEdgeRow[];
  }

  /** The full edge row for one direction off a node (incl. an unbound frontier). */
  find(fromLocation: string, direction: string): LocationEdgeRow | undefined {
    return this.db
      .prepare('SELECT * FROM location_edges WHERE from_location = ? AND direction = ?')
      .get(fromLocation, direction) as LocationEdgeRow | undefined;
  }

  /**
   * Insert a shared edge. Idempotent on PK `(from_location, direction)` — an
   * existing edge in that direction is left untouched (never silently rewritten).
   */
  recordEdge(data: {
    from: string;
    to: string | null;
    direction: string;
    difficulty: number;
    flavour?: string | null;
    teaser?: string | null;
    createdByActionId?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO location_edges
           (from_location, to_location, direction, difficulty, flavour, teaser, created_by_action_id)
         VALUES (@from, @to, @direction, @difficulty, @flavour, @teaser, @created_by_action_id)`,
      )
      .run({
        from: data.from,
        to: data.to ?? null,
        direction: data.direction,
        difficulty: data.difficulty,
        flavour: data.flavour ?? null,
        teaser: data.teaser ?? null,
        created_by_action_id: data.createdByActionId ?? null,
      });
  }

  /**
   * Bind a dangling frontier exit to its newly-minted destination. Guarded on
   * `to_location IS NULL` so a second crosser can never rebind an exit the first
   * crosser already settled (the shared-rebind invariant, spec §3). Returns true
   * if this call performed the binding.
   */
  bindFrontier(fromLocation: string, direction: string, destination: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE location_edges SET to_location = @dest WHERE from_location = @from AND direction = @direction AND to_location IS NULL',
      )
      .run({ dest: destination, from: fromLocation, direction });
    return result.changes > 0;
  }
}
