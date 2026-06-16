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

  /**
   * Remove `quantity` units of a stacked item. Decrements the stack and only
   * deletes the row when it reaches zero — so trading 1 of 2 leaves 1.
   * Returns the remaining quantity (0 if the row was removed or absent).
   */
  decrementByName(characterId: number, name: string, quantity = 1): number {
    const row = this.db
      .prepare('SELECT id, quantity FROM items WHERE character_id = ? AND name = ?')
      .get(characterId, name) as { id: number; quantity: number } | undefined;
    if (!row) return 0;

    const remaining = row.quantity - quantity;
    if (remaining > 0) {
      this.db.prepare('UPDATE items SET quantity = ? WHERE id = ?').run(remaining, row.id);
      return remaining;
    }
    this.db.prepare('DELETE FROM items WHERE id = ?').run(row.id);
    return 0;
  }

  countByCharacterId(characterId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM items WHERE character_id = ?')
      .get(characterId) as { count: number };
    return row.count;
  }
}
