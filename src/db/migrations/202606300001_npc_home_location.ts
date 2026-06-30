import type { Migration } from './types.js';

/**
 * `npcs.home_location TEXT` — the NPC's canonical origin, distinct from the mutable
 * current `location`. Set at creation via `add_npc`; not updated by `update_npc`.
 * Directly supports the lifecycle added in mutation-vocabulary-refinement §2a.
 * Additive guarded ALTER (idempotent on existing prod DBs).
 */
export const migration: Migration = {
  id: '202606300001_npc_home_location',
  up(db) {
    try {
      db.exec('ALTER TABLE npcs ADD COLUMN home_location TEXT');
    } catch {
      /* already exists */
    }
  },
};
