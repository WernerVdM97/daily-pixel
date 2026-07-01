import type { Migration } from './types.js';

/**
 * `player_characters.last_bail_refund_day` (INTEGER game `day_number`, same pattern
 * as `last_noop_refund_day` / `last_timeout_refund_day`): the day on which the player
 * last received the once-per-day free refund for bailing out of a decision. A separate
 * column so the bail grace never burns — or is burned by — the no-op/timeout graces.
 *
 * Guarded ALTER so existing production DBs pick it up idempotently.
 */
export const migration: Migration = {
  id: '202606300000_player_last_bail_refund_day',
  up(db) {
    try {
      db.exec('ALTER TABLE player_characters ADD COLUMN last_bail_refund_day INTEGER');
    } catch {
      /* already exists */
    }
  },
};
