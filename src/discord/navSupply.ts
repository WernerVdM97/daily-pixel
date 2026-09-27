/**
 * `/ping` is the only handler with no seam event carrying its nav facts, so its nav report is wrapped
 * here — and the test harness reuses this wrapper rather than a copy that could drift.
 */

import type { CharacterData } from "../engine/WorldEngine.js";
import type { CommandHandler } from "./CommandRegistry.js";

type CharacterReader = { getCharacter(userId: string): CharacterData | null };

/** Wraps a seamless handler so it still reports nav facts, matching the dispatcher's pre-port
 *  `if (char)` gate exactly — no character, no bar. */
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
