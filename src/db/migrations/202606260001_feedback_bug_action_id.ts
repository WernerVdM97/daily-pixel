import type { Migration } from './types.js';

/**
 * Add `action_id` to feedback + bug_reports — the FK of the action whose outcome the player
 * pressed the Feedback/Bug button from, captured as context for the report. Nullable: feedback
 * also arrives from non-action surfaces (the nightly/release prompts, `/feedback`, `/bug`) and
 * divine intervention writes no action row, so a missing link is expected, not an error.
 * Guarded for idempotency.
 */
export const migration: Migration = {
  id: '202606260001_feedback_bug_action_id',
  up(db) {
    for (const table of ['feedback', 'bug_reports']) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'action_id')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN action_id INTEGER REFERENCES actions(id)`);
      }
    }
  },
};
