import type Database from 'better-sqlite3';
import type { MetaRow } from './types.js';

export type { MetaRow };

export class MetaRepository {
  constructor(private db: Database.Database) {}

  get(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(key) as MetaRow | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(key, value);
  }
}
