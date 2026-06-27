import type Database from 'better-sqlite3';
import type { CharacterLocationRow } from './types.js';

export type { CharacterLocationRow };

/**
 * The per-player fog-of-war mask over the shared world graph (spec §1). A row
 * means "this character has been here". It is a MASK, not a private tree — the
 * adjacency lives on the shared `location_edges`.
 */
export class CharacterLocationRepository {
  constructor(private db: Database.Database) {}

  /**
   * Mark a location discovered (or refresh recency). First visit stamps both
   * timestamps; a repeat visit only bumps `last_visited_at` (which drives the
   * /map recency ordering, §5). Idempotent on PK `(character_id, location_name)`.
   */
  recordVisit(characterId: number, locationName: string): void {
    this.db
      .prepare(
        `INSERT INTO character_locations (character_id, location_name)
         VALUES (@cid, @name)
         ON CONFLICT(character_id, location_name)
         DO UPDATE SET last_visited_at = datetime('now')`,
      )
      .run({ cid: characterId, name: locationName });
  }

  /** Every location this character has discovered, most-recently-visited first. */
  findByCharacter(characterId: number): CharacterLocationRow[] {
    return this.db
      .prepare(
        'SELECT * FROM character_locations WHERE character_id = ? ORDER BY last_visited_at DESC, location_name',
      )
      .all(characterId) as CharacterLocationRow[];
  }

  /** Whether this character has discovered `locationName`. */
  hasDiscovered(characterId: number, locationName: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM character_locations WHERE character_id = ? AND location_name = ?')
        .get(characterId, locationName) !== undefined
    );
  }
}
