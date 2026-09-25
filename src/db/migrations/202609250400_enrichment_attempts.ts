import type { Migration } from './types.js';

/**
 * `locations.enrichment_attempts` (INTEGER, default 0): failed cartographer `enrich()`
 * attempts on a still-provisional row. The nightly sweep re-fires such rows, and the
 * engine gives up at its cap by settling the row with the placeholder text — without
 * the counter an unmappable name would be retried on every tick for ever.
 */
export const migration: Migration = {
  id: '202609250400_enrichment_attempts',
  up(db) {
    try {
      db.exec('ALTER TABLE locations ADD COLUMN enrichment_attempts INTEGER NOT NULL DEFAULT 0');
    } catch (err) {
      // Already-exists is the only case a guarded ALTER should swallow.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(msg)) throw err;
    }
  },
};
