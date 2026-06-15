import type Database from 'better-sqlite3';
import type { ItemRow } from './types.js';

export type { ItemRow };

export class ItemRepository {
  constructor(private db: Database.Database) {}

  findByCharacterId(characterId: number): ItemRow[] {
    return this.db
      .prepare('SELECT * FROM items WHERE character_id = ?')
      .all(characterId) as ItemRow[];
  }

  create(characterId: number, data: {
    name: string;
    emoji: string;
    stat: string;
    modifier: number;
    quantity: number;
  }): ItemRow {
    const stmt = this.db.prepare(`
      INSERT INTO items (character_id, name, emoji, stat, modifier, quantity)
      VALUES (@character_id, @name, @emoji, @stat, @modifier, @quantity)
    `);
    const result = stmt.run({ character_id: characterId, ...data });
    return {
      id: result.lastInsertRowid as number,
      character_id: characterId,
      ...data,
    };
  }

  deleteByName(characterId: number, name: string): number {
    const result = this.db
      .prepare('DELETE FROM items WHERE character_id = ? AND name = ?')
      .run(characterId, name);
    return result.changes;
  }

  countByCharacterId(characterId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM items WHERE character_id = ?')
      .get(characterId) as { count: number };
    return row.count;
  }
}
