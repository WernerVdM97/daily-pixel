/**
 * "A soul has bottomed out" notices — fired when an action, rest, or nightly
 * tick drops a character's health or stamina to 0.
 *
 * There is no death mechanic: 0 is a floor, not a game-over. The notice is a
 * *public* world event — posted to the announcement channel so the whole table
 * sees who fell — and fires only on the *transition* to 0 (was above, now
 * at/below) so a character already at 0 isn't re-announced every action.
 *
 * The actual posting is delegated to a broadcaster the bot wires up at startup
 * (see `setCollapseBroadcaster`), so this module stays free of discord.js and
 * the channel plumbing.
 */

interface Vitals {
  health: number;
  stamina: number;
}

type CollapseBroadcaster = (content: string) => void | Promise<void>;

let _broadcast: CollapseBroadcaster | null = null;

/** Register (or clear) the sink that posts collapse notices to the world. */
export function setCollapseBroadcaster(fn: CollapseBroadcaster | null): void {
  _broadcast = fn;
}

/**
 * Build the public collapse notice for a vitals transition, or null if nothing
 * crossed to 0 this step. Both health and stamina can fire at once. Written in
 * third person — this is broadcast for everyone to read.
 */
export function collapseNotice(
  name: string,
  prev: Vitals | null | undefined,
  next: Vitals | null | undefined,
): string | null {
  if (!prev || !next) return null;
  const lines: string[] = [];
  if (prev.health > 0 && next.health <= 0) {
    lines.push(
      `💔 **${name} has collapsed.** Their wounds drop them to **0 HP** — far ` +
        "from the warden's fire. The wilds are patient, and they are not kind.",
    );
  }
  if (prev.stamina > 0 && next.stamina <= 0) {
    lines.push(
      `🥵 **${name} is spent.** Their stamina hits **0** — every step now leaden. ` +
        "They'll need to rest by the Oak before the day turns.",
    );
  }
  return lines.length > 0 ? lines.join("\n\n") : null;
}

/**
 * Broadcast the collapse notice (if any) to the world. Best-effort — never
 * throws, so it can't break the surrounding outcome flow. No-op if no
 * broadcaster is registered (e.g. a channel-less dev setup).
 */
export async function announceCollapse(
  name: string,
  prev: Vitals | null | undefined,
  next: Vitals | null | undefined,
): Promise<void> {
  const notice = collapseNotice(name, prev, next);
  if (!notice || !_broadcast) return;
  try {
    await _broadcast(notice);
  } catch {
    /* best-effort */
  }
}
