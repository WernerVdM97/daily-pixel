/**
 * /sleep — rest or advance the world.
 *
 * Admin (ADMIN_USER_ID env var): triggers the daily tick.
 * Non-admin: returns to the Oak — location is moved, no tick.
 */
import type { WorldEngine } from "../../engine/WorldEngine.js";
import { mapError } from "../../engine/ErrorMapper.js";
import { SEPARATOR } from "../format.js";
import { announceCollapse } from "../collapse.js";
import { getWorkplaceLocation, type DayJobDef } from "./hi.js";

export function makeSleepCommand(engine: WorldEngine, dayJobs?: DayJobDef[]) {
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

        // Scaling flavor text per day range
        const flavor =
          result.dayNumber <= 3
            ? "The warden watches the horizon. The fire crackles, steady and low."
            : "The smoke on the eastern horizon has thickened. The warden hasn't spoken since yesterday.";

        const lines: string[] = [];
        lines.push(`🌅 **Day ${result.dayNumber} begins.**`);
        lines.push("");
        lines.push(flavor);
        lines.push("");
        lines.push(`The Oak awaits. \`/hi\` to begin.`);

        if (result.playersAffected > 0 || result.npcMovements.length > 0) {
          lines.push("");
          lines.push(
            `─ ${result.playersAffected} soul(s) stirred, ${result.npcMovements.length} NPC(s) on the move.`,
          );
        }

        return lines.join("\n");
      } catch (e) {
        console.error("[sleep] tick failed:", e);
        return mapError(e);
      }
    }

    // Rest at the Oak (admin without tick, or non-admin)
    const character = engine.getCharacter(interaction.user.id);
    if (!character) {
      return "You don't have a character yet. Type `/join` to create one.";
    }

    // Guard: can't sleep mid-action
    if (character.lastActionState !== null) {
      return [
        "⛔ **Cannot rest now**",
        SEPARATOR,
        "",
        "You are mid-action — finish what you started before bedding down.",
        "",
        "Use `/action continue` to resume, or let it time out after 30 minutes.",
      ].join("\n");
    }

    // Guard: must spend all actions before resting
    if (character.rollsRemaining > 0) {
      return [
        "⛔ **Cannot rest now**",
        SEPARATOR,
        "",
        "The day is still young — you have actions left to take.",
        "Spend your remaining rolls before bedding down beneath the Oak.",
      ].join("\n");
    }

    const alreadyThere = character.location === "The Warden's Oak";
    const currentLoc = engine.getLocation(character.location);
    // H1: treat sleeping at your own workplace as safe (no HP penalty for doing your job)
    const dayNumber = Number(engine.getMeta("day_number") ?? "1");
    const workplace = dayJobs
      ? getWorkplaceLocation(character.dayJob, dayJobs, {
          characterId: character.id,
          dayNumber,
        })
      : null;
    const atWorkplace = workplace !== null && character.location === workplace;
    const wasUnsafe =
      currentLoc !== null &&
      !currentLoc.isSafe &&
      !alreadyThere &&
      !atWorkplace;

    engine.restAtOak(interaction.user.id);

    let penaltyLine = "";
    if (wasUnsafe) {
      const updated = engine.modifyHealth(interaction.user.id, -1);
      penaltyLine = `⚠️ The night was rough — you lost **1 HP**. ${updated ? `(${updated.health}/${updated.maxHealth} ❤️)` : ""}`;
      // A collapse from the penalty is announced publicly (not just to the actor).
      if (updated) {
        await announceCollapse(
          character.name,
          { health: character.health, stamina: character.stamina },
          { health: updated.health, stamina: updated.stamina },
        );
      }
    }

    const locationLine = alreadyThere
      ? "The Oak's familiar boughs cradle you once more."
      : "You bank the fire and bed down beneath the Oak.";

    const lines: string[] = [
      "🏕️ **The Warden's Oak**",
      SEPARATOR,
      "",
      locationLine,
    ];
    if (penaltyLine) {
      lines.push("");
      lines.push(penaltyLine);
    }

    lines.push("");
    lines.push("The day turns when the world wills it — not when you do.");
    lines.push("");
    lines.push("*The ember glows. The Oak stands watch. Rest, for now.*");

    return lines.join("\n");
  };
}
