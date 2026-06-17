import type Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations/index.js';
import type { Migration } from './migrations/types.js';

/** Thrown when a migration batch fails and is rolled back. Carries the original
 *  error as `cause` and names it in the message so the admin alert is actionable. */
export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/**
 * Bring the database up to date: run any pending schema migrations, then seed
 * the optional world data (skipped under tests to avoid colliding with fixtures).
 */
export function migrate(db: Database.Database): void {
  runMigrations(db);

  // Seed locations and NPCs (skip in test environments to avoid collision with
  // test fixtures). The Oak location + meta keys are seeded by schema.sql itself.
  if (!process.env.VITEST) {
    seedLocations(db);
    seedNpcs(db);
  }
}

/**
 * Apply every migration whose id isn't already recorded in `schema_migrations`,
 * in declared (chronological) order. Each migration is idempotent on its own
 * (existing production DBs predate this runner), so running the full set against
 * an already-migrated DB is a safe no-op that simply backfills the ledger.
 *
 * The whole pending batch runs in ONE transaction: SQLite supports transactional
 * DDL, so if any migration throws, the entire batch — including the ledger
 * inserts — is rolled back and the DB is left exactly as it was. A failed deploy
 * can never leave a half-migrated schema; the bot restarts and retries cleanly.
 * On failure a `MigrationError` is thrown so the caller can alert the admin.
 *
 * @param migrations - override the migration set (used by tests); defaults to MIGRATIONS.
 */
export function runMigrations(db: Database.Database, migrations: Migration[] = MIGRATIONS): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>).map(r => r.id),
  );
  const pending = migrations.filter(m => !applied.has(m.id));
  if (pending.length === 0) return;

  const record = db.prepare('INSERT INTO schema_migrations (id) VALUES (?)');
  const runBatch = db.transaction(() => {
    for (const m of pending) {
      m.up(db);
      record.run(m.id);
    }
  });

  try {
    runBatch();
  } catch (err) {
    const ids = pending.map(m => m.id).join(', ');
    const cause = err instanceof Error ? err.message : String(err);
    throw new MigrationError(
      `Migration batch failed and was rolled back (pending: ${ids}). Cause: ${cause}`,
      { cause: err },
    );
  }

  // Log only after a successful commit — never claim a rolled-back migration applied.
  for (const m of pending) console.log(`[migrate] applied ${m.id}`);
}

function seedLocations(db: Database.Database): void {
  const locations = [
    { name: "The Warden's Oak", description: 'A massive ancient oak tree that serves as the heart of the territory. Its branches stretch wide, offering shelter to all who gather beneath.', tags: 'oak,interior,fire,sanctuary', is_safe: 1 },
    { name: 'The Forest Edge', description: 'Where the farmland yields to the treeline. The Oak is still visible behind you, but the canopy ahead swallows the light.', tags: 'forest,edge,trees,field,boundary,wilderness', is_safe: 0 },
    { name: 'The Dark Pines', description: 'Dense ancient forest where the canopy blocks the sky. Roots twist like old bones. Something moves between the trunks — too large for a deer.', tags: 'forest,trees,wilderness,dark,canopy', is_safe: 0 },
    { name: 'The River Crossing', description: 'A broad, shallow ford where the Stonebrook runs clear over worn pebbles. Tracks of every creature that drinks here press into the soft bank.', tags: 'river,water,stream,crossing,bank,wilderness', is_safe: 0 },
    { name: 'Town Square', description: 'Cobblestones gleaming with last night\'s rain. Market stalls crowd the edges — fish, cloth, old copper. A fountain gurgles in the centre.', tags: 'town,square,buildings,cobblestone,market', is_safe: 1 },
    { name: 'The Shrine of the First Flame', description: 'A low stone temple at the edge of town. One candle burns in the alcove — it has never gone out. The silence here is heavier than it should be.', tags: 'shrine,temple,holy,stone,quiet', is_safe: 1 },
    { name: 'The Broken Keep', description: 'Ruins of something older than the Oak. Walls lean at angles that shouldn\'t hold. Locals say the stones whisper on moonless nights.', tags: 'ruins,ancient,stone,broken,old,wilderness', is_safe: 0 },
    { name: 'The East Road', description: 'A dirt track running east from the Oak, past farmland and into the treeline. The ruts are deeper than last season. Fewer carts come back.', tags: 'road,travel,open,path,horizon', is_safe: 0 },
    { name: 'The Weary Lantern Inn', description: 'Smoke-stained beams and a fire that never quite warms the corners. The barman pours before you ask. Someone in the far booth is watching.', tags: 'tavern,interior,fire,crowd,drink', is_safe: 1 },
    { name: 'The Town Forge', description: 'Heat and iron. A stone smithy near the square where the bellows never rest. The walls are black with years of soot.', tags: 'forge,smithy,town,fire,building', is_safe: 1 },
    { name: "The Warden's Library", description: "Shelves climb the walls of a round stone room. Dust motes float in the lantern light. Not all the books are in a language you know.", tags: 'library,study,scrolls,quiet,building', is_safe: 1 },
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO locations (name, description, tags, is_safe)
    VALUES (@name, @description, @tags, @is_safe)
  `);

  const seed = db.transaction(() => {
    for (const loc of locations) {
      stmt.run(loc);
    }
  });
  seed();
}

function seedNpcs(db: Database.Database): void {
  const npcs = [
    { name: 'The Warden', class: 'Warden', race: null, description: 'A quiet figure wrapped in a travel-worn cloak, tending the fire beneath the Oak. Their face stays hidden in the shadow of a deep hood. They offer bowls of stew without being asked, and answer questions with a silence that somehow says more than words.', location: "The Warden's Oak" },
    { name: 'Elder Bram', class: 'Herbalist', race: 'Human', description: 'A bent old man with earth under his nails and eyes that see too much. He tends a garden of plants most people can\'t name.', location: "The Warden's Oak" },
    { name: 'Kara', class: 'Hunter', race: 'Human', description: 'Lean and watchful, with a bow that\'s seen more seasons than most rangers. She doesn\'t trust easy — but she respects skill.', location: "The Warden's Oak" },
    { name: 'Marta', class: 'Blacksmith', race: 'Dwarf', description: 'Arms like tree roots and a face set in permanent disapproval. Her steel is the best east of Stonebridge and she knows it.', location: 'Town Square' },
    { name: 'The Caravan Master', class: 'Merchant', race: 'Human', description: 'A woman with quick hands and quicker eyes. She\'s been trying to offload cargo all week — says she\'s "travelling light," but her hands shake when she says "east."', location: 'Town Square' },
    { name: 'Brother Aldric', class: 'Acolyte', race: 'Human', description: 'Young, earnest, and fighting a crisis of faith. The candle in the shrine alcove won\'t go out — and he doesn\'t know if that\'s a blessing or a warning.', location: 'The Shrine of the First Flame' },
    { name: 'Grey Wolf', class: 'Beast', race: null, description: 'A massive she-wolf, grey as storm-light, limping from a wound in her flank. Her eyes track you with an intelligence that feels wrong.', location: 'The Forest Edge' },
    { name: 'A Hooded Figure', class: 'Wanderer', race: null, description: 'Face lost in a deep cowl. Pays in old copper no one\'s minted in generations. Never speaks above a whisper. Always sits with their back to the wall.', location: 'The Weary Lantern Inn' },
    { name: 'Shadow Stag', class: 'Beast', race: null, description: 'A stag of impossible size, its antlers tangled with mist that doesn\'t burn off in sunlight. Hunters speak of it in whispers. No one has drawn a bow.', location: 'The Dark Pines' },
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO npcs (name, class, race, description, location)
    VALUES (@name, @class, @race, @description, @location)
  `);

  const seed = db.transaction(() => {
    for (const npc of npcs) {
      stmt.run(npc);
    }
  });
  seed();
}
