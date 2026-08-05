/**
 * /sleep — rest or advance the world.
 *
 * Admin (ADMIN_USER_ID env var): triggers the daily tick. Stays adapter-direct until M9
 * (flagged M7.1 watch item — the engine-direct `tick(true)` cron call is engine-owned).
 * Non-admin: the player goodnight crosses the JSON seam as `rest.begin` (M7.1, DC-M7.1.5) —
 * this handler is translate + paint only. The unsafe-rest −1 HP rule moved into
 * `engine.restAtOak` (DC-M7.1.1); the reply copy moved to the router (DC-P4); the collapse
 * announcement crosses back as the `restUnsafe` fact (DC-M7.1.4).
 */
import type { WorldEngine } from "../../engine/WorldEngine.js";
import { mapError } from "../../engine/ErrorMapper.js";
import { announceCollapse } from "../collapse.js";
import { buildMorningAnnouncement } from "../announcements.js";
import { noticeViewToDiscord } from "../viewToDiscord.js";
import type { GameRouter } from "../../protocol/router.js";
import type { NoticeViewState } from "../../view/viewState.js";

export function makeSleepCommand(engine: WorldEngine, router: GameRouter) {
  /** Warn once at first call if ADMIN_USER_ID is unset (deploy-time safety net). */
  const adminUserId = process.env.ADMIN_USER_ID ?? "";
  if (!adminUserId) {
    console.warn(
      "[sleep] WARNING: ADMIN_USER_ID is not set. Admin `/sleep` will be unreachable —",
      "the world can only advance via nightly cron. Set this env var to enable admin tick.",
    );
  }

  return async (interaction: { user: { id: string } }): Promise<string> => {
    const isAdmin = interaction.user.id === adminUserId;
    const adminTick = isAdmin && process.env.SLEEP_ADMIN_TICK === "true";

    if (adminTick) {
      try {
        const result = engine.tick(true);

        // Shares the morning builder with the live cron post (index.ts) so the two never
        // drift — same day, same prose, whichever path advances the world.
        return buildMorningAnnouncement({
          day: result.dayNumber,
          playersAffected: result.playersAffected,
          npcMovementCount: result.npcMovements.length,
        });
      } catch (e) {
        console.error("[sleep] tick failed:", e);
        return mapError(e);
      }
    }

    // Player path — translate + paint. The router owns the guards, the rest screen, and
    // the penalty copy; its error.message IS the string the dispatcher paints.
    const response = await router.dispatch({
      type: "rest.begin",
      playerId: interaction.user.id,
    });

    if (!response.ok) {
      return response.error.message;
    }

    // The collapse announcement crosses as the `restUnsafe` fact (DC-M7.1.4) — announce it
    // publicly before painting the actor's own goodnight. announceCollapse is best-effort.
    const restUnsafe = response.facts?.restUnsafe as
      | { name: string; prev: { health: number; stamina: number }; updated: { health: number; stamina: number } }
      | undefined;
    if (restUnsafe) {
      await announceCollapse(restUnsafe.name, restUnsafe.prev, restUnsafe.updated);
    }

    const view = response.view as NoticeViewState | undefined;
    return view ? noticeViewToDiscord(view).content : "Something went wrong.";
  };
}
