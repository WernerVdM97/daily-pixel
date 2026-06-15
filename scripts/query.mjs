#!/usr/bin/env node
/**
 * Quick SQLite query tool for The Warden's Oak.
 * Usage:
 *   node scripts/query.mjs "SELECT * FROM locations"
 *   node scripts/query.mjs ".tables"
 *   node scripts/query.mjs last_actions      (shorthand)
 *   node scripts/query.mjs char              (shorthand: player_characters)
 *   node scripts/query.mjs locs              (shorthand: locations)
 *   node scripts/query.mjs meta              (shorthand)
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'warden.db');

const SHORTHANDS = {
  last_actions: `SELECT a.id, pc.name, a.type, a.outcome, a.final_dc, a.player_rolled, a.prompt_version, a.created_at
FROM actions a JOIN player_characters pc ON a.character_id = pc.id
ORDER BY a.id DESC LIMIT 10`,
  char: `SELECT id, name, class, location, stamina, health, max_health, wealth, rolls_remaining, day_job, last_action_state
FROM player_characters`,
  locs: 'SELECT * FROM locations',
  npcs: 'SELECT * FROM npcs',
  items: `SELECT i.id, pc.name, i.name AS item, i.emoji, i.stat, i.modifier, i.quantity
FROM items i JOIN player_characters pc ON i.character_id = pc.id`,
  meta: 'SELECT * FROM meta',
};

const input = process.argv[2];
if (!input) {
  console.log('Usage: node scripts/query.mjs <SQL|shorthand|.tables>');
  console.log('Shorthands:', Object.keys(SHORTHANDS).join(', '));
  process.exit(1);
}

const sql = SHORTHANDS[input] ?? input;

const db = new Database(dbPath, { readonly: true });

if (sql.startsWith('.')) {
  if (sql === '.tables') {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    console.log(tables.map((/** @type {{ name: string }} */ r) => r.name).join('\n'));
  }
} else {
  const rows = db.prepare(sql).all();
  if (rows.length === 0) {
    console.log('(no rows)');
  } else {
    console.table(rows);
  }
}

db.close();
