// Dev/testing tool: spawn a hostile "event" NPC directly into the npcs table so
// you can playtest hunting/combat against it right now — before the Saturday
// special-event system exists (it's MVP-deferred in TODO.md: "spawn an evil npc
// somewhere with a hint. Incentivise hunting it/them and add npc death mutation").
//
// This is NOT the event system. It's a manual seed you point at a DB to drop one
// hostile NPC at a chosen location, so the world already has something to fight
// while the real cron/engine wiring is unbuilt.
//
// Location resolution (the "where you currently are"): a script has no player, so
//   --location "<name>"   explicit override, spawns exactly there
//   --char "<name>"       reads that character's player_characters.location
//   (neither)             uses the sole character if exactly one exists, else errors
//
//   node scripts/spawn-event-npc.mjs                          # sole char's location, local DB
//   node scripts/spawn-event-npc.mjs --char Ulrich            # at Ulrich's current location
//   node scripts/spawn-event-npc.mjs --location "The Forest Edge"
//   node scripts/spawn-event-npc.mjs --name "The Gore-Tusk"   # override the NPC
//   node scripts/spawn-event-npc.mjs --dry-run                # preview, write nothing
//   node scripts/spawn-event-npc.mjs --despawn                # delete the spawned NPC(s) by name
//   node scripts/spawn-event-npc.mjs --db /path/to/warden.db  # pick the DB explicitly
//
// Re-runnable: a spawn first deletes any existing NPC with the same name (so you
// can respawn freely and it never trips the seed-name unique index).
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const val = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);

const dryRun = flag('--dry-run');
const despawn = flag('--despawn');
const dbPath = path.resolve(val('--db', path.join(ROOT, 'data', 'warden.db')));
const charName = val('--char', null);
const locationOverride = val('--location', null);

// The evil NPC preset. Beefy physical for a real fight; the hint lives in the
// description (the "somewhere with a hint" from the TODO) so players discovering
// the location get a nudge to hunt it. Override --name to spawn a variant.
const npc = {
  name: val('--name', 'The Blighted Stag'),
  class: 'Beast',
  race: 'Corrupted Elk',
  day_job: null,
  stats: JSON.stringify({ physical: 8, wisdom: 2, intelligence: -2, charisma: -3 }),
  health: 24,
  stamina: 12,
  wealth: 0,
  description:
    'A stag the size of a warhorse, antlers weeping black sap, eyes like cold coals. ' +
    'The grass withers where it treads. HINT: it is drawn to the scent of blood — ' +
    'those who hunt near here may bring it down, but it will not fall easily.',
};

console.log(`DB: ${dbPath}`);
console.log(`Mode: ${dryRun ? 'dry-run (no writes)' : despawn ? 'DESPAWN' : 'SPAWN (will write)'}\n`);

const db = new Database(dbPath, { readonly: dryRun, fileMustExist: true });

try {
  // --- Despawn path: delete any NPC with this name and exit. -----------------
  if (despawn) {
    const doomed = db.prepare('SELECT id, name, location FROM npcs WHERE name = ?').all(npc.name);
    if (doomed.length === 0) {
      console.log(`No NPC named "${npc.name}" found — nothing to despawn.`);
    } else {
      console.table(doomed);
      if (!dryRun) db.prepare('DELETE FROM npcs WHERE name = ?').run(npc.name);
      console.log(`\n${doomed.length} NPC(s) ${dryRun ? 'would be deleted' : 'deleted'}.`);
    }
    process.exit(0);
  }

  // --- Resolve the target location. ------------------------------------------
  let location = locationOverride;
  if (!location) {
    const chars = charName
      ? db.prepare('SELECT id, name, location FROM player_characters WHERE name = ?').all(charName)
      : db.prepare('SELECT id, name, location FROM player_characters').all();

    if (chars.length === 0) {
      console.error(
        charName
          ? `No character named "${charName}". Pass --location to spawn at an explicit place.`
          : 'No characters in this DB. Pass --location "<name>" to spawn somewhere explicit.',
      );
      process.exit(1);
    }
    if (chars.length > 1) {
      console.error('Multiple characters — disambiguate with --char <name> or --location <name>:');
      console.table(chars);
      process.exit(1);
    }
    location = chars[0].location;
    console.log(`Resolved location from character "${chars[0].name}": ${location}\n`);
  }

  // Warn (don't block) if the location isn't a known row — procedural/unexplored
  // places legitimately have no locations row yet.
  const known = db.prepare('SELECT name, is_safe FROM locations WHERE name = ?').get(location);
  if (!known) {
    console.log(`⚠️  "${location}" is not in the locations table (procedural/unexplored?) — spawning anyway.`);
  }

  // Re-runnable: clear a prior spawn of the same name so respawns never trip the
  // seed-name unique index (created_by_action_id IS NULL).
  const existing = db.prepare('SELECT id FROM npcs WHERE name = ?').all(npc.name);

  console.log('Spawning:');
  console.table([{ name: npc.name, location, health: npc.health, stamina: npc.stamina, stats: npc.stats }]);
  if (existing.length) console.log(`(replaces ${existing.length} existing NPC(s) with the same name)`);

  if (dryRun) {
    console.log('\nDry-run — nothing written. Re-run without --dry-run to spawn.');
    process.exit(0);
  }

  const spawn = db.transaction(() => {
    db.prepare('DELETE FROM npcs WHERE name = ?').run(npc.name);
    // home_location = current location so the lifecycle treats this place as its origin.
    return db
      .prepare(
        `INSERT INTO npcs (name, class, race, day_job, stats, health, stamina, wealth, location, home_location, description, created_by_action_id)
         VALUES (@name, @class, @race, @day_job, @stats, @health, @stamina, @wealth, @location, @home_location, @description, NULL)`,
      )
      .run({ ...npc, location, home_location: location });
  });

  const res = spawn();
  console.log(`\n✅ Spawned "${npc.name}" (npc id ${res.lastInsertRowid}) at "${location}".`);
  console.log(`   Despawn with: node scripts/spawn-event-npc.mjs --despawn${npc.name !== 'The Blighted Stag' ? ` --name "${npc.name}"` : ''}`);
} finally {
  db.close();
}
