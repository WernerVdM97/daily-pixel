/**
 * The agent→engine type seam (DC-S4, M8.5). The harness plays through the protocol and
 * observes the world through exactly this surface — the QA-OBSERVER path: the invariant
 * checks (checkInvariants), the day-line label (endDay's pre-rest read), and the nightly
 * world cron (`tick` — the engine advances the world for everyone; a user never runs it).
 * It is NEVER the play path: "the PLAY path is seam-only and structurally enforced; the
 * QA-OBSERVER path is engine-direct, explicitly declared, and never on the play path. A
 * finding that needs an engine read is an observer result, not a player action." The law
 * governs play, not observation.
 *
 * The engine satisfies this interface STRUCTURALLY (WorldEngineImpl → AgentObserver) — no
 * adapter, no wrapper; the assignment is verified at the src-side call sites (play.ts passes
 * `agentEngine.engine`) at typecheck time. Exactly these three members, nothing more: a read
 * the harness needs beyond them would be a NEW observer surface and a record-worthy change.
 */
export interface AgentObserver {
  /** Read a character by its discord id (the engine's only character key). */
  getCharacter(userId: string): CharacterData | null;
  /** Read a meta key — the harness needs only 'day_number'. */
  getMeta(key: 'day_number'): string | null;
  /** The nightly world cron: advance the world (admin), return the new day number. */
  tick(admin: true): { dayNumber: number };
}

// Type-only import + re-export — the type seam (DC-S4). The local import is REQUIRED so the
// interface above resolves CharacterData/CharCreateData to the engine's types (a bare
// `export type { … } from` re-export does not create a local binding — the interface would
// silently resolve to the DOM lib's global CharacterData instead). Consumers import the
// engine types through this module ('./observer.js'), so './harness.ts' imports zero
// WorldEngine types.
import type { CharacterData, CharCreateData } from '../engine/WorldEngine.js';
export type { CharacterData, CharCreateData };
