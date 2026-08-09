/**
 * DC-M9.6: every command the dispatcher welds a nav bar onto hands its `facts.nav` back
 * through the `onNav` parameter, sourced from its own router response. `/ping` is the one
 * registered command with no seam event to ride — it is a liveness check, not a game action
 * — so its nav facts are supplied by the composition root instead.
 *
 * This lives here rather than inline in `index.ts` because the test harness registers the
 * same command and would otherwise hold a second copy: two copies drift, and the copy the
 * golden transcripts exercise would not be the copy production runs (the first fresh-context
 * M9.3 review caught exactly that). The engine import is type-only, so the Home rule holds.
 */

import type { CharacterData } from "../engine/WorldEngine.js";
import type { CommandHandler } from "./CommandRegistry.js";

type CharacterReader = { getCharacter(userId: string): CharacterData | null };

/** Wraps a seamless handler so it still reports nav facts, matching the dispatcher's own
 *  pre-M9.3 `if (char)` gate exactly — no character, no bar. */
export function withEngineNav(engine: CharacterReader, handler: CommandHandler): CommandHandler {
  return async (interaction, onNav) => {
    const char = engine.getCharacter((interaction as { user: { id: string } }).user.id);
    if (char) {
      onNav?.({
        rollsRemaining: char.rollsRemaining,
        hasPendingAction: char.lastActionState !== null,
        hasRestedToday: char.hasRestedToday ?? false,
      });
    }
    return handler(interaction, onNav);
  };
}
