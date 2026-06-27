import type { Migration } from './types.js';

/**
 * Drop the legacy `actions.llm_request` / `actions.llm_response` columns. They were
 * superseded by the dedicated `llm_calls` table (per-call `response_json`, `raw_prompt`,
 * `reasoning`, tokens, latency, linked via `action_id`) and have been written NULL on every
 * action since v4 — dead weight on the hot table. SQLite 3.35+ supports `ALTER TABLE DROP
 * COLUMN`; guarded on column presence so the migration is idempotent and a no-op on DBs that
 * never had them.
 */
export const migration: Migration = {
  id: '202606250000_drop_legacy_action_llm_columns',
  up(db) {
    const cols = db.prepare('PRAGMA table_info(actions)').all() as Array<{ name: string }>;
    const has = (c: string) => cols.some((col) => col.name === c);
    for (const col of ['llm_request', 'llm_response']) {
      if (has(col)) {
        db.exec(`ALTER TABLE actions DROP COLUMN ${col}`);
      }
    }
  },
};
