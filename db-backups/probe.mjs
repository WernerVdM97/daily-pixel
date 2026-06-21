import { openDb } from './_db.mjs';

const { db, dir } = openDb(process.argv[2]);
console.log(`Snapshot: ${dir}\n`);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
console.log('Tables and row counts:');
for (const t of tables) {
  const n = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n;
  console.log(`  ${t.padEnd(22)} ${n}`);
}

console.log('\nmeta key/values:');
for (const r of db.prepare('SELECT key, value FROM meta ORDER BY key').all()) {
  console.log(`  ${String(r.key).padEnd(28)} ${r.value}`);
}

const span = db.prepare("SELECT MIN(created_at) a, MAX(created_at) b FROM actions").get();
console.log(`\nactions time span: ${span.a}  ->  ${span.b}`);
const fspan = db.prepare("SELECT MIN(created_at) a, MAX(created_at) b FROM feedback").get();
console.log(`feedback time span: ${fspan.a}  ->  ${fspan.b}`);
