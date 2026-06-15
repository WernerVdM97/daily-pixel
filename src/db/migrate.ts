import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function migrate(db: Database.Database): void {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(sql);
}
