import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function migrate(db: Database.Database): void {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(sql);

  // v2 migration: add prompt_version column to existing actions table
  const cols = db.prepare("PRAGMA table_info('actions')").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'prompt_version')) {
    db.exec("ALTER TABLE actions ADD COLUMN prompt_version TEXT NOT NULL DEFAULT 'v1'");
  }

  // v2 migration: allow seed NPCs (not created by any action)
  const npcCols = db.prepare("PRAGMA table_info('npcs')").all() as Array<{ name: string; notnull: number }>;
  const createdByCol = npcCols.find(c => c.name === 'created_by_action_id');
  if (createdByCol && createdByCol.notnull === 1) {
    // SQLite doesn't support ALTER COLUMN, so we must recreate
    db.exec(`
      CREATE TABLE IF NOT EXISTS npcs_v2 (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        name                  TEXT    NOT NULL,
        class                 TEXT,
        race                  TEXT,
        day_job               TEXT,
        stats                 TEXT,
        health                INTEGER,
        stamina               INTEGER,
        wealth                INTEGER DEFAULT 0,
        location              TEXT,
        description           TEXT,
        created_by_action_id  INTEGER REFERENCES actions(id)
      );
      INSERT INTO npcs_v2 SELECT * FROM npcs;
      DROP TABLE npcs;
      ALTER TABLE npcs_v2 RENAME TO npcs;
    `);
  }

  // v2: seed locations and NPCs (skip in test environments to avoid collision with test fixtures)
  if (!process.env.VITEST) {
    seedLocations(db);
    seedNpcs(db);
  }

  // v3: add llm_request and llm_response columns to actions table for audit
  for (const col of ['llm_request', 'llm_response']) {
    try { db.exec(`ALTER TABLE actions ADD COLUMN ${col} TEXT`); } catch { /* already exists */ }
  }
}

function seedLocations(db: Database.Database): void {
  const locations = [
    { name: 'The Forest Edge', description: 'Where the farmland yields to the treeline. The Oak is still visible behind you, but the canopy ahead swallows the light.', tags: 'forest,edge,trees,field,boundary,wilderness', is_safe: 0 },
    { name: 'The Dark Pines', description: 'Dense ancient forest where the canopy blocks the sky. Roots twist like old bones. Something moves between the trunks — too large for a deer.', tags: 'forest,trees,wilderness,dark,canopy', is_safe: 0 },
    { name: 'The River Crossing', description: 'A broad, shallow ford where the Stonebrook runs clear over worn pebbles. Tracks of every creature that drinks here press into the soft bank.', tags: 'river,water,stream,crossing,bank,wilderness', is_safe: 0 },
    { name: 'Town Square', description: 'Cobblestones gleaming with last night\'s rain. Market stalls crowd the edges — fish, cloth, old copper. A fountain gurgles in the centre.', tags: 'town,square,buildings,cobblestone,market', is_safe: 1 },
    { name: 'The Shrine of the First Flame', description: 'A low stone temple at the edge of town. One candle burns in the alcove — it has never gone out. The silence here is heavier than it should be.', tags: 'shrine,temple,holy,stone,quiet', is_safe: 1 },
    { name: 'The Broken Keep', description: 'Ruins of something older than the Oak. Walls lean at angles that shouldn\'t hold. Locals say the stones whisper on moonless nights.', tags: 'ruins,ancient,stone,broken,old,wilderness', is_safe: 0 },
    { name: 'The East Road', description: 'A dirt track running east from the Oak, past farmland and into the treeline. The ruts are deeper than last season. Fewer carts come back.', tags: 'road,travel,open,path,horizon', is_safe: 0 },
    { name: 'The Weary Lantern Inn', description: 'Smoke-stained beams and a fire that never quite warms the corners. The barman pours before you ask. Someone in the far booth is watching.', tags: 'tavern,interior,fire,crowd,drink', is_safe: 1 },
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
