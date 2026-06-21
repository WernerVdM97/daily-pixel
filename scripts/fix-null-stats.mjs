// One-off data repair: recompute character ability scores corrupted by the
// incomplete `backgrounds.yml` modifier blocks (see
// docs/sparks/yaml-asset-schemas-and-tests.md and polish-pass §B1).
//
// Why a script and not a migration: this patches *existing rows* on one live
// DB. A fresh DB built from corrected assets never has the bug, so a migration
// would be a permanent no-op cluttering the ledger. This is a deliberate,
// re-runnable (idempotent) fix you point at a specific DB.
//
// It recomputes each character's full stat block from (class, upbringing, race)
// using the same rule as StatComputer BUT defaulting any missing modifier key
// to 0 — so it produces the correct result even before the YAML is fixed. It
// only writes rows whose stored stats differ (i.e. the null/NaN ones); correct
// characters are left untouched.
//
// SAFETY: dry-run by default — prints what it WOULD change and writes nothing.
// Pass --apply to actually update. Pick the DB explicitly with --db <path>.
//
//   node scripts/fix-null-stats.mjs --db data/warden.db                 # dry-run
//   node scripts/fix-null-stats.mjs --db /home/bot/app/data/warden.db --apply
//
// Against prod: stop the bot (or accept that single-row updates on a WAL DB are
// low-risk), pull a backup first, then run with --apply.
import Database from 'better-sqlite3';
import yaml from 'js-yaml';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATS = ['physical', 'wisdom', 'intelligence', 'charisma'];
const CHAR_DIR = path.join(ROOT, 'assets', 'char-creation');

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const dbArg = argv[argv.indexOf('--db') + 1];
const dbPath = argv.includes('--db') ? path.resolve(dbArg) : path.join(ROOT, 'data', 'warden.db');

// name -> {physical,wisdom,intelligence,charisma} with every key defaulted to 0.
function modifierMap(file) {
  const rows = yaml.load(fs.readFileSync(path.join(CHAR_DIR, file), 'utf-8'));
  const map = new Map();
  for (const r of rows) {
    const m = {};
    for (const s of STATS) m[s] = Number(r.modifiers?.[s] ?? 0);
    map.set(r.name, m);
  }
  return map;
}

const classes = modifierMap('classes.yml');
const backgrounds = modifierMap('backgrounds.yml');
const races = modifierMap('races.yml');

function recompute(className, upbringing, raceName) {
  const c = classes.get(className);
  const u = backgrounds.get(upbringing);
  const r = races.get(raceName);
  if (!c || !u || !r) return null; // unknown name — leave it; surfaced below
  const out = {};
  for (const s of STATS) out[s] = c[s] + u[s] + r[s];
  return out;
}

console.log(`DB: ${dbPath}`);
console.log(`Mode: ${apply ? 'APPLY (will write)' : 'dry-run (no writes)'}\n`);

const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
const chars = db
  .prepare('SELECT id, name, class, upbringing, race, stats FROM player_characters ORDER BY id')
  .all();

const update = apply
  ? db.prepare('UPDATE player_characters SET stats = @stats WHERE id = @id')
  : null;

let changed = 0;
let skipped = 0;
for (const ch of chars) {
  const stored = JSON.parse(ch.stats);
  const correct = recompute(ch.class, ch.upbringing, ch.race);
  if (!correct) {
    console.log(`  ⚠️  #${ch.id} ${ch.name}: unknown class/upbringing/race — skipped`);
    skipped++;
    continue;
  }
  const diffs = STATS.filter((s) => stored[s] !== correct[s]);
  if (diffs.length === 0) continue;

  changed++;
  const detail = diffs.map((s) => `${s}: ${JSON.stringify(stored[s])} -> ${correct[s]}`).join(', ');
  console.log(`  #${ch.id} ${ch.name} (${ch.class}/${ch.upbringing}/${ch.race}): ${detail}`);
  if (apply) update.run({ id: ch.id, stats: JSON.stringify(correct) });
}

console.log(
  `\n${changed} character(s) ${apply ? 'updated' : 'would be updated'}` +
    `${skipped ? `, ${skipped} skipped` : ''}.` +
    (!apply && changed ? '  Re-run with --apply to write.' : ''),
);
