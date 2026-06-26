import type { Migration } from './types.js';

/**
 * Add `llm_calls.call_kind` — tags each call by pipeline stage (`decision` | `critic`) so the
 * coherence critic can be mined separately from the decision call. Its own dated migration on
 * purpose: the column was first introduced alongside the v9 critic, and the baseline migration
 * is already recorded on every existing DB (so an ALTER appended there would never re-run and the
 * column would be missing on prod, breaking every `llm_calls` insert). Guarded for idempotency.
 */
export const migration: Migration = {
  id: '202606250001_llm_call_kind',
  up(db) {
    const cols = db.prepare('PRAGMA table_info(llm_calls)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'call_kind')) {
      db.exec("ALTER TABLE llm_calls ADD COLUMN call_kind TEXT NOT NULL DEFAULT 'decision'");
    }
  },
};
