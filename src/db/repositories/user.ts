import type Database from 'better-sqlite3';
import type { UserRow } from './types.js';

export type { UserRow };

export class UserRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(discordUserId: string): UserRow {
    const stmt = this.db.prepare(
      'INSERT INTO users (discord_user_id) VALUES (?)'
    );
    const result = stmt.run(discordUserId);
    return {
      id: result.lastInsertRowid as number,
      discord_user_id: discordUserId,
      created_at: expectTimestamp(this.db, result.lastInsertRowid as number, 'users'),
    };
  }

  findByDiscordId(discordUserId: string): UserRow | undefined {
    return this.db
      .prepare('SELECT id, discord_user_id, created_at FROM users WHERE discord_user_id = ?')
      .get(discordUserId) as UserRow | undefined;
  }

  findById(id: number): UserRow | undefined {
    return this.db
      .prepare('SELECT id, discord_user_id, created_at FROM users WHERE id = ?')
      .get(id) as UserRow | undefined;
  }
}

function expectTimestamp(
  db: Database.Database,
  id: number,
  table: string
): string {
  const row = db.prepare(`SELECT created_at FROM ${table} WHERE id = ?`).get(id) as { created_at: string };
  return row.created_at;
}
