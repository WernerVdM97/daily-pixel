/**
 * The agent→engine type seam — the QA-OBSERVER surface the harness reads the world through, never the
 * play path. The engine satisfies it structurally: a fourth member would be a new, record-worthy surface.
 */
export interface AgentObserver {
  /** Read a character by its discord id (the engine's only character key). */
  getCharacter(userId: string): CharacterData | null;
  /** Read a meta key — the harness needs only 'day_number'. */
  getMeta(key: 'day_number'): string | null;
  /** The nightly world cron: advance the world (admin), return the new day number. */
  tick(admin: true): { dayNumber: number };
}

// Type-only import + re-export. The local import is REQUIRED: the interface above resolves
// CharacterData to the engine's type, where a bare re-export would silently resolve the DOM lib's.
import type { CharacterData, CharCreateData } from '../engine/WorldEngine.js';
export type { CharacterData, CharCreateData };
