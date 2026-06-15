-- S0 schema: 9 tables + meta seed
-- better-sqlite3, sync API, single-writer

CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id  TEXT    UNIQUE NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS player_characters (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER UNIQUE NOT NULL REFERENCES users(id),
  name              TEXT    NOT NULL,
  class             TEXT    NOT NULL,
  upbringing        TEXT    NOT NULL,
  race              TEXT    NOT NULL,
  alignment         TEXT    NOT NULL,
  day_job           TEXT    NOT NULL,
  stats             TEXT    NOT NULL,  -- JSON {"physical","wisdom","intelligence","charisma"}
  health            INTEGER NOT NULL DEFAULT 10,
  max_health        INTEGER NOT NULL DEFAULT 10,
  stamina           INTEGER NOT NULL DEFAULT 10,
  rolls_remaining   INTEGER NOT NULL DEFAULT 2,
  location          TEXT    NOT NULL DEFAULT "The Warden's Oak",
  wealth            INTEGER NOT NULL DEFAULT 0,
  last_action_state TEXT,              -- JSON ActionState | NULL
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS actions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id    INTEGER NOT NULL REFERENCES player_characters(id),
  raw_input       TEXT    NOT NULL,
  type            TEXT    NOT NULL,
  decisions_json  TEXT    NOT NULL,  -- JSON ActionDecisionRecord[]
  final_dc        INTEGER NOT NULL,
  player_rolled   INTEGER,           -- NULL if skipped/timed out
  outcome         TEXT    NOT NULL,  -- success|failure|skipped|timed_out
  prompt_version  TEXT    NOT NULL DEFAULT 'v1',
  llm_request     TEXT,             -- full user prompt sent to LLM (for audit)
  llm_response    TEXT,             -- raw JSON response from LLM (for audit)
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id  INTEGER NOT NULL REFERENCES player_characters(id),
  name          TEXT    NOT NULL,
  emoji         TEXT    NOT NULL,
  stat          TEXT    NOT NULL,
  modifier      INTEGER NOT NULL,
  quantity      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS npcs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT    NOT NULL,
  class                 TEXT,
  race                  TEXT,
  day_job               TEXT,
  stats                 TEXT,    -- JSON
  health                INTEGER,
  stamina               INTEGER,
  wealth                INTEGER DEFAULT 0,
  location              TEXT,
  description           TEXT,
  created_by_action_id  INTEGER REFERENCES actions(id)
);

CREATE TABLE IF NOT EXISTS locations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    UNIQUE NOT NULL,
  description TEXT,
  tags        TEXT,            -- comma-separated
  is_safe     INTEGER NOT NULL DEFAULT 0  -- boolean 0|1
);

CREATE TABLE IF NOT EXISTS feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id  INTEGER NOT NULL REFERENCES player_characters(id),
  text          TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bug_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id  INTEGER NOT NULL REFERENCES player_characters(id),
  text          TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes for FK lookups

CREATE INDEX IF NOT EXISTS idx_player_characters_user_id ON player_characters(user_id);
CREATE INDEX IF NOT EXISTS idx_actions_character_id       ON actions(character_id);
CREATE INDEX IF NOT EXISTS idx_items_character_id         ON items(character_id);
CREATE INDEX IF NOT EXISTS idx_npcs_location              ON npcs(location);
CREATE INDEX IF NOT EXISTS idx_npcs_created_by_action     ON npcs(created_by_action_id);

-- Seed data

INSERT OR IGNORE INTO locations (name, description, tags, is_safe) VALUES (
  'The Warden''s Oak',
  'A massive ancient oak tree that serves as the heart of the territory. Its branches stretch wide, offering shelter to all who gather beneath.',
  'oak,interior,fire,sanctuary',
  1
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('day_number',         '1');
INSERT OR IGNORE INTO meta (key, value) VALUES ('last_cron_date',     '');
INSERT OR IGNORE INTO meta (key, value) VALUES ('llm_fallback_count', '0');
