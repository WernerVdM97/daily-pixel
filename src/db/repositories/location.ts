import type Database from 'better-sqlite3';
import type { LocationRow } from './types.js';

export type { LocationRow };

export class LocationRepository {
  constructor(private db: Database.Database) {}

  findByName(name: string): LocationRow | undefined {
    return this.db
      .prepare('SELECT * FROM locations WHERE name = ?')
      .get(name) as LocationRow | undefined;
  }

  findAll(): LocationRow[] {
    return this.db
      .prepare('SELECT * FROM locations ORDER BY name')
      .all() as LocationRow[];
  }

  create(data: {
    name: string;
    description?: string;
    tags?: string;
    isSafe?: number;
    enrichmentPending?: number;
  }): LocationRow {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO locations (name, description, tags, is_safe, enrichment_pending)
      VALUES (@name, @description, @tags, @is_safe, @enrichment_pending)
    `);
    stmt.run({
      name: data.name,
      description: data.description ?? null,
      tags: data.tags ?? null,
      is_safe: data.isSafe ?? 0,
      enrichment_pending: data.enrichmentPending ?? 0,
    });
    // Return the row (may already exist — INSERT OR IGNORE makes this idempotent)
    return this.db
      .prepare('SELECT * FROM locations WHERE name = ?')
      .get(data.name) as LocationRow;
  }

  /**
   * D3 cartographer landing: enrich a still-provisional location with the LLM's
   * is_safe + description and clear the pending flag. Guarded on
   * `enrichment_pending = 1` so it only ever overwrites a row that is STILL
   * provisional — never one a later edit or a real seed already settled, and
   * never twice (idempotent / double-fire safe). Returns true if a row was updated.
   *
   * `tags` is only written when the cartographer supplied some — a null/undefined
   * leaves the existing value untouched (COALESCE) rather than wiping it.
   */
  enrichProvisional(
    name: string,
    data: { isSafe: number; description: string; tags?: string | null },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE locations
           SET is_safe = @is_safe,
               description = @description,
               tags = COALESCE(@tags, tags),
               enrichment_pending = 0
         WHERE name = @name AND enrichment_pending = 1`,
      )
      .run({
        name,
        is_safe: data.isSafe,
        description: data.description,
        tags: data.tags ?? null,
      });
    return result.changes > 0;
  }
}
