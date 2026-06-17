import type { Migration } from './types.js';

/**
 * Two columns supporting the goodnight/rest features:
 *
 * - `player_characters.last_played_at` — timestamp of the player's last
 *   interaction, used by the absence penalty (3+ days idle loses health).
 * - `actions.narrative` — the LLM's outcome text saved as a narrative snippet
 *   so the journal can show recent story beats.
 *
 * Both are idempotent column adds (existing production DBs predate this runner).
 */
export const migration: Migration = {
  id: '202606171400_player_last_played_and_narrative',
  up(db) {
    try {
      db.exec('ALTER TABLE player_characters ADD COLUMN last_played_at TEXT');
    } catch {
      /* already exists */
    }
    try {
      db.exec('ALTER TABLE actions ADD COLUMN narrative TEXT');
    } catch {
      /* already exists */
    }
  },
};
