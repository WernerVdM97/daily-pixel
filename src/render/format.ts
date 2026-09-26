/**
 * Display vocabulary shared by the presentation and composition layers: the section separator
 * sentinel, compass helpers and the boot-populated name→emoji lookups. None of it is transport.
 */

/** Sentinel used in command output to mark section boundaries for splitting. */
export const SEPARATOR = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

/** Compass emoji per canonical direction — the sole direction indicator on /look and
 *  /map paths (no letter, no ASCII arrow). */
const DIRECTION_ARROW: Record<string, string> = {
  N: '⬆️', NE: '↗️', E: '➡️', SE: '↘️', S: '⬇️', SW: '↙️', W: '⬅️', NW: '↖️',
};
const DIRECTION_ORDER = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function directionArrow(dir: string): string {
  return DIRECTION_ARROW[dir] ?? '🧭';
}
/** Clockwise-from-north sort key (N, NE, E … NW); unknowns sort last. */
export function directionRank(dir: string): number {
  const i = DIRECTION_ORDER.indexOf(dir);
  return i === -1 ? DIRECTION_ORDER.length : i;
}

const OPPOSITE_DIRECTION: Record<string, string> = {
  N: 'S', S: 'N', E: 'W', W: 'E', NE: 'SW', SW: 'NE', NW: 'SE', SE: 'NW',
};
/** The reverse heading of an edge: edges store one canonical direction, so a node on the `to`
 *  side sees its neighbour reversed. Unknowns pass through unchanged. */
export function oppositeDirection(dir: string): string {
  return OPPOSITE_DIRECTION[dir] ?? dir;
}

export const CLASS_EMOJI_FALLBACK = '🔹';
export const DAYJOB_EMOJI_FALLBACK = '🔨';

/** name→emoji lookups, seeded at boot from the YAML defs by `registerEmoji`. The /join wizard
 *  reads its emoji off the defs directly, so it does not depend on these. */
const emojiByName = {
  class: new Map<string, string>(),
  dayJob: new Map<string, string>(),
} as const;

export type EmojiCategory = keyof typeof emojiByName;

export function registerEmoji(category: EmojiCategory, defs: Array<{ name: string; emoji?: string }>): void {
  const map = emojiByName[category];
  map.clear();
  for (const d of defs) if (d.emoji) map.set(d.name, d.emoji);
}

export function classEmoji(charClass: string | null | undefined): string {
  return (charClass && emojiByName.class.get(charClass)) || CLASS_EMOJI_FALLBACK;
}

export function dayJobEmoji(job: string | null | undefined): string {
  return (job && emojiByName.dayJob.get(job)) || DAYJOB_EMOJI_FALLBACK;
}
