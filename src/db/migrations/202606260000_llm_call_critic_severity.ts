import type { Migration } from './types.js';

/**
 * Add `llm_calls.critic_severity` — the coherence critic's verdict, surfaced as a queryable
 * column instead of buried in `response_json`. Values: `ok` | `minor` | `major` on critic calls
 * (NULL on decision calls and on critic calls that failed before producing a verdict). Lets you
 * mine "how often / how badly does the critic flag a beat" with a plain WHERE clause. Guarded for
 * idempotency.
 */
export const migration: Migration = {
  id: '202606260000_llm_call_critic_severity',
  up(db) {
    const cols = db.prepare('PRAGMA table_info(llm_calls)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'critic_severity')) {
      db.exec('ALTER TABLE llm_calls ADD COLUMN critic_severity TEXT');
    }
  },
};
