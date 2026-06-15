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
  }): LocationRow {
    const stmt = this.db.prepare(`
      INSERT INTO locations (name, description, tags, is_safe)
      VALUES (@name, @description, @tags, @is_safe)
    `);
    const result = stmt.run({
      name: data.name,
      description: data.description ?? null,
      tags: data.tags ?? null,
      is_safe: data.isSafe ?? 0,
    });
    return this.db
      .prepare('SELECT * FROM locations WHERE id = ?')
      .get(result.lastInsertRowid) as LocationRow;
  }
}
