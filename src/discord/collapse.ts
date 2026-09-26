/**
 * Collapse notices fire only on the transition to 0 (was above, now at/below) — 0 is a floor, not a
 * game-over, so a character already there is not re-announced.
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

/** Both health and stamina can cross on one step, so the notice can carry two lines. */
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

/** Posts the notice to the world, best-effort: a throw cannot break the outcome flow, and with no
 *  broadcaster registered this is a no-op (a channel-less dev setup). */
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
