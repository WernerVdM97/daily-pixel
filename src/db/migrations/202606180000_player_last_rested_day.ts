import type { Migration } from './types.js';

/**
 * `player_characters.last_rested_day` — the game `day_number` on which the
 * player last rested at the Oak. Compared against the current `day_number` to
 * decide whether the Rest nav button should still show (it hides once you've
 * rested for the day). Idempotent column add for DBs that predate this column.
 */
export const migration: Migration = {
  id: '202606180000_player_last_rested_day',
  up(db) {
    try {
      db.exec('ALTER TABLE player_characters ADD COLUMN last_rested_day INTEGER');
    } catch {
      /* already exists */
    }
  },
};
