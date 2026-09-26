import type { Message } from "discord.js";

/**
 * Pinning is best-effort: it needs the bot to hold **Manage Messages** there, and without it Discord
 * rejects the calls — logged and carried on, since the message itself still posted. Nothing throws.
 */

/** Pins a freshly-sent message, leaving earlier pins alone. Used for release notes; the pin helpers
 *  below build on it. */
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
 * Pins `message` and unpins every older pinned message starting with `marker` — the Saturday threat
 * and the leaderboard. Matching the header itself needs no bookkeeping, and cleans up pre-feature pins.
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
 * Pins `message`, then keeps only the `keep` newest of the same kind: Discord caps a channel at 50
 * pins, so an archive of every week's header would start failing (error 30003) once full.
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
