import type { Migration } from './types.js';

/**
 * Roll-economy + world-growth columns (ADR roll-economy-timeouts-and-world-growth).
 *
 * - `player_characters.last_noop_refund_day` / `last_timeout_refund_day`
 *   (INTEGER game `day_number`, same pattern as `last_rested_day`): the day on
 *   which the player last received the once-per-day free refund for, respectively,
 *   a no-op auto-resolve (D1) and a server-side timeout (D2). Separate columns so
 *   the two grace allowances never burn each other.
 * - `locations.enrichment_pending` (INTEGER 0|1, default 0): set to 1 on a
 *   provisionally-created location (D3 lazy creation) until the async cartographer
 *   fills in `is_safe` + description and clears it. Guards against double-firing.
 *
 * Guarded ALTERs so existing production DBs (which predate the migration runner)
 * pick up the columns idempotently.
 */
export const migration: Migration = {
  id: '202606210000_roll_refund_and_enrichment',
  up(db) {
    try {
      db.exec('ALTER TABLE player_characters ADD COLUMN last_noop_refund_day INTEGER');
    } catch {
      /* already exists */
    }
    try {
      db.exec('ALTER TABLE player_characters ADD COLUMN last_timeout_refund_day INTEGER');
    } catch {
      /* already exists */
    }
    try {
      db.exec('ALTER TABLE locations ADD COLUMN enrichment_pending INTEGER NOT NULL DEFAULT 0');
    } catch {
      /* already exists */
    }
  },
};
