// Ad-hoc read-only query runner against a DB snapshot.
//
//   node db-backups/q.mjs "SELECT name, health FROM player_characters ORDER BY health"
//   node db-backups/q.mjs "SELECT COUNT(*) FROM actions WHERE outcome='done'"
//   DB_SNAPSHOT=warden-20260621-145324 node db-backups/q.mjs "SELECT * FROM meta"
//
// With no SQL arg it lists the tables. Only SELECT/EXPLAIN/PRAGMA run — the
// connection is opened read-only, so writes fail by construction anyway.
import { openDb } from './_db.mjs';

const sql = process.argv[2];
const { db, dir } = openDb(process.env.DB_SNAPSHOT);

if (!sql) {
  console.log(`Snapshot: ${dir}\nTables:`);
  for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
    const n = db.prepare(`SELECT COUNT(*) n FROM "${r.name}"`).get().n;
    console.log(`  ${r.name.padEnd(22)} ${n}`);
  }
  console.log('\nPass a SQL string as the first arg to run a query.');
  process.exit(0);
}

const rows = db.prepare(sql).all();
console.log(JSON.stringify(rows, null, 2));
console.log(`\n(${rows.length} row${rows.length === 1 ? '' : 's'})`);
