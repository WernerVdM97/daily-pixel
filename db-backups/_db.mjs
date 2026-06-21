// Shared helper for the db-backups analysis scripts.
//
// Resolves which snapshot to open and returns a read-only better-sqlite3 handle.
// The DB files themselves are gitignored; only these helpers are committed.
//
// Snapshot resolution order (first hit wins):
//   1. CLI arg / env DB_SNAPSHOT  — a snapshot dir name or absolute path
//   2. db-backups/.latest          — pointer written by the scp pull (if present)
//   3. newest db-backups/warden-*  — most recent snapshot on disk
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const backupsDir = import.meta.dirname;

/** Resolve a snapshot directory (absolute path) without opening it. */
export function resolveSnapshotDir(override = process.env.DB_SNAPSHOT) {
  // 1. Explicit override (dir name relative to db-backups/, or an absolute path).
  if (override) {
    const abs = path.isAbsolute(override) ? override : path.join(backupsDir, override);
    if (fs.existsSync(path.join(abs, 'warden.db'))) return abs;
    throw new Error(`No warden.db under override snapshot: ${abs}`);
  }

  // 2. .latest pointer (written by the pull; may be absent on a fresh clone).
  const latest = path.join(backupsDir, '.latest');
  if (fs.existsSync(latest)) {
    const rel = fs.readFileSync(latest, 'utf8').trim();
    // .latest may hold a path relative to the repo root ("db-backups/warden-…") or to here.
    for (const cand of [path.resolve(backupsDir, '..', rel), path.join(backupsDir, path.basename(rel))]) {
      if (fs.existsSync(path.join(cand, 'warden.db'))) return cand;
    }
  }

  // 3. Newest warden-* directory by name (timestamps sort lexicographically).
  const snaps = fs
    .readdirSync(backupsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('warden-'))
    .map((d) => d.name)
    .sort();
  if (snaps.length) return path.join(backupsDir, snaps[snaps.length - 1]);

  throw new Error(
    'No DB snapshot found. Pull one first (see db-backups/README.md), ' +
      'or pass a snapshot dir as the first arg / DB_SNAPSHOT env var.',
  );
}

/** Open the resolved snapshot read-only. Pass a dir name/path to override. */
export function openDb(override) {
  const dir = resolveSnapshotDir(override);
  const db = new Database(path.join(dir, 'warden.db'), { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON'); // belt-and-braces: this connection cannot write
  return { db, dir };
}
