import type { Migration } from './types.js';

/**
 * Backfill `npcs.health` for the seed NPCs (0.3.2 C3). The column has existed since
 * baseline but was never populated: `seedNpcs` inserted only name/class/race/description/
 * location, and `add_npc` has no `health` vocabulary — so every NPC (the Shadow Stag
 * included) carried NULL health, and a combat against a known foe fell through to the
 * DC-derived guess (`deriveEnemyMaxHp`), rendering a 24-HP stag as a generic "Minion 6/14".
 *
 * This gives the seed NPCs a real combat max-HP so C3's "seed enemyMaxHp from the NPC"
 * path actually fires against the live world. Only rows that are still NULL are touched,
 * so a prod NPC that already carries a hand-set health (or a future authored value) is
 * never clobbered — the update is idempotent and safe to re-run.
 *
 * The name→health pairs mirror the `seedNpcs` array in `migrate.ts` at authoring time
 * (kept in sync there for fresh DBs); this migration backfills DBs that already seeded
 * those rows before health existed. Values are within [ENEMY_HP_MIN, ENEMY_HP_MAX] = [6, 40].
 */
const SEED_NPC_HEALTH: Record<string, number> = {
  'The Warden': 30,
  'Elder Bram': 10,
  'Kara': 16,
  'Marta': 18,
  'The Caravan Master': 12,
  'Brother Aldric': 10,
  'Grey Wolf': 16,
  'Shadow Stag': 24,
};

export const migration: Migration = {
  id: '202607112100_npc_combat_health',
  up(db) {
    const setHealth = db.prepare('UPDATE npcs SET health = @health WHERE name = @name AND health IS NULL');
    for (const [name, health] of Object.entries(SEED_NPC_HEALTH)) {
      setHealth.run({ name, health });
    }
  },
};
