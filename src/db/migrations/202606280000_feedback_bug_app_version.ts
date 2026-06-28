import type { Migration } from './types.js';

/**
 * Stamp `app_version` on feedback + bug_reports — the app build (VERSION file) that produced
 * the report, for the same data-mining attribution `actions`/`llm_calls` already carry. Nullable:
 * rows written before this migration (and any future off-version writer) leave it NULL. Guarded
 * for idempotency on production DBs.
 */
export const migration: Migration = {
  id: '202606280000_feedback_bug_app_version',
  up(db) {
    for (const table of ['feedback', 'bug_reports']) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'app_version')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN app_version TEXT`);
      }
    }
  },
};
