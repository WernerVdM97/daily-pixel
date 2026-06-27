import type { Message } from "discord.js";

/**
 * Pinning helpers. All best-effort: pinning requires the bot to hold the
 * **Manage Messages** permission in the target channel. Without it Discord
 * rejects `pin()`/`unpin()`/`fetchPinned()` and we log + carry on — the message
 * itself still posted, it just isn't pinned. None of these throw into callers.
 */

/** Pin a freshly-sent message. Used for release notes and Saturday threats,
 *  which all stay pinned (no unpinning of prior ones). */
export async function pinMessage(message: Message, label: string): Promise<void> {
  try {
    await message.pin();
  } catch (err) {
    console.warn(
      `[pin] Could not pin ${label} (does the bot have Manage Messages?):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Pin `message` and unpin every *older* pinned message in the same channel whose
 * content starts with `marker` — so only the latest of that kind stays pinned.
 * Used for the leaderboard (only the most recent board should remain). Matching
 * on the message's own header keeps it self-contained: no meta bookkeeping, and
 * it cleans up any boards pinned before this feature existed too.
 */
export async function pinReplacing(
  message: Message,
  marker: string,
  label: string,
): Promise<void> {
  try {
    const pinned = await message.channel.messages.fetchPinned();
    for (const [, m] of pinned) {
      // Own messages only: a user message that happens to start with the marker must not be unpinned.
      if (m.id !== message.id && m.author?.id === message.author.id && m.content.startsWith(marker)) {
        await m.unpin().catch(() => {});
      }
    }
  } catch {
    // Can't read the channel's pins (likely missing Manage Messages) — skip the
    // cleanup and still try to pin the new one below.
  }
  await pinMessage(message, label);
}

/**
 * Pin `message`, then keep only the `keep` NEWEST pinned messages of the same kind (own
 * messages whose content starts with `marker`) pinned, unpinning the older ones. Discord caps
 * a channel at 50 pins, so an unbounded "pin every week's header" archive would silently start
 * failing (error 30003) once full. Bounding it keeps pinning working; an unpinned header survives
 * as an ordinary message (its thread persists) — only the pin is dropped. The trim is logged so
 * the cap isn't a silent truncation.
 */
export async function pinKeepingNewest(
  message: Message,
  marker: string,
  keep: number,
  label: string,
): Promise<void> {
  await pinMessage(message, label);
  try {
    const pinned = await message.channel.messages.fetchPinned();
    const mine = [...pinned.values()]
      .filter((m) => m.author?.id === message.author.id && m.content.startsWith(marker))
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    const stale = mine.slice(keep);
    if (stale.length > 0) {
      console.log(`[pin] Trimming ${stale.length} old ${label} pin(s), keeping newest ${keep} (Discord's 50-pin cap).`);
      for (const m of stale) await m.unpin().catch(() => {});
    }
  } catch {
    // Can't read the channel's pins (likely missing Manage Messages) — the new one is
    // pinned best-effort; skip trimming.
  }
}
