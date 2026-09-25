import type { Migration } from './types.js';

/**
 * `locations.enrichment_attempts` (INTEGER, default 0): failed cartographer `enrich()` attempts
 * on a still-provisional row, so an unmappable name cannot be retried on every tick.
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
