import type { Migration } from './types.js';

/**
 * Persist the world mutations actually applied by each resolved action — i.e.
 * the post-validation, post-failure-strip set — as a JSON array on the action
 * row. The raw LLM proposal already lives in `llm_calls.response_json`; this
 * captures the *net effect* so the applied mutations are queryable without
 * re-deriving them (e.g. "did any action hand back a roll?").
 */
export const migration: Migration = {
  id: '202606171200_action_applied_mutations',
  up(db) {
    try {
      db.exec('ALTER TABLE actions ADD COLUMN applied_mutations TEXT');
    } catch {
      /* already exists */
    }
  },
};
