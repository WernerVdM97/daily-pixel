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
      if (m.id !== message.id && m.content.startsWith(marker)) {
        await m.unpin().catch(() => {});
      }
    }
  } catch {
    // Can't read the channel's pins (likely missing Manage Messages) — skip the
    // cleanup and still try to pin the new one below.
  }
  await pinMessage(message, label);
}
