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
  max_stamina       INTEGER NOT NULL DEFAULT 10,
  rolls_remaining   INTEGER NOT NULL DEFAULT 3,
  location          TEXT    NOT NULL DEFAULT "The Warden's Oak",
  wealth            INTEGER NOT NULL DEFAULT 0,
  last_action_state TEXT,              -- JSON ActionState | NULL
  last_rested_day   INTEGER,           -- game day_number the player last rested at the Oak | NULL
  last_noop_refund_day    INTEGER,     -- game day_number the player last got the free no-op refund (D1) | NULL
  last_timeout_refund_day INTEGER,     -- game day_number the player last got the free timeout refund (D2) | NULL
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
  app_version     TEXT,              -- app build (VERSION file) that produced this row
  prompt_version  TEXT    NOT NULL DEFAULT 'v1',
  -- Per-call LLM audit lives in the llm_calls table (linked via action_id), not here.
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

-- Per-attempt LLM audit log (POC instrumentation). One row per call to the
-- gateway, including failed/retry attempts — captures what's volatile and
-- diagnostic, not the reconstructable prompt boilerplate.
CREATE TABLE IF NOT EXISTS llm_calls (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id            INTEGER REFERENCES actions(id),  -- linked after resolution (NULL for failures/retries)
  app_version          TEXT,                             -- app build (VERSION) that produced this row
  prompt_version       TEXT    NOT NULL,
  call_kind            TEXT    NOT NULL DEFAULT 'decision', -- 'decision' | 'critic' — for mining the critic separately
  critic_severity      TEXT,                             -- critic verdict: 'ok'|'minor'|'major' (NULL on decision calls)
  model                TEXT    NOT NULL,
  temperature          REAL,
  tier                 INTEGER NOT NULL DEFAULT 0,       -- 0 = primary, 1 = stripped retry
  player_input         TEXT,                             -- the volatile signal, verbatim
  context_digest       TEXT,                             -- compact JSON snapshot (deduped, no boilerplate)
  raw_prompt           TEXT,                             -- full user message; diagnostic calls only (error/parse-fail/retry)
  reasoning            TEXT,                             -- full LLM thinking; diagnostic calls only
  response_json        TEXT,                             -- raw LLM content (success only)
  parse_ok             INTEGER NOT NULL DEFAULT 0,       -- 0|1
  validation_warnings  TEXT,                             -- JSON array; '[]' when clean
  error                TEXT,                             -- error message on failure, else NULL
  http_status          INTEGER,                          -- HTTP status when known
  prompt_tokens        INTEGER,                          -- token-waste ground truth
  completion_tokens    INTEGER,
  total_tokens         INTEGER,
  reasoning_chars      INTEGER,                          -- length of reasoning_content (gauge, not stored noise)
  latency_ms           INTEGER,
  finish_reason        TEXT,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    UNIQUE NOT NULL,
  description TEXT,
  tags        TEXT,            -- comma-separated
  is_safe     INTEGER NOT NULL DEFAULT 0,  -- boolean 0|1
  enrichment_pending INTEGER NOT NULL DEFAULT 0  -- 1 while a provisional (D3) location awaits async cartographer enrichment
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
CREATE INDEX IF NOT EXISTS idx_llm_calls_action_id        ON llm_calls(action_id);

-- Seed NPCs are unique by name; makes the INSERT OR IGNORE re-seed idempotent
-- (without this, every startup re-inserted all seed NPCs — see migrate.ts dedup).
CREATE UNIQUE INDEX IF NOT EXISTS idx_npcs_seed_name_unique
  ON npcs(name) WHERE created_by_action_id IS NULL;

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
