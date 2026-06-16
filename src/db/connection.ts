import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return _db;
}

export function initDb(dbPath?: string): Database.Database {
  if (_db) return _db;
  const resolvedPath = dbPath ?? path.join(__dirname, '..', '..', 'data', 'warden.db');
  // Ensure the parent directory exists — `data/` is gitignored, so a fresh clone
  // (e.g. a new deploy) won't have it, and better-sqlite3 won't create it itself.
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  _db = new Database(resolvedPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
