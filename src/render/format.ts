/**
 * Display vocabulary shared across the presentation and composition layers: the section
 * separator sentinel, compass direction helpers, and the boot-populated name→emoji lookups.
 *
 * Rehomed out of `src/discord/format.ts` at M10.1 (DC-M10.7). None of it is transport: the
 * controller screens, `src/view/`, `src/render/map-render.ts` and `src/index.ts` all read it,
 * and while it sat in the Discord layer every one of those was importing downward-inverted
 * from an adapter. The Components V2 payload/button builders it used to sit beside are
 * genuinely Discord-shaped and stayed behind.
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
/** The reverse heading of an edge — edges store one canonical direction, so a node on the
 *  `to` side sees its neighbour in the opposite direction. Unknowns pass through unchanged. */
export function oppositeDirection(dir: string): string {
  return OPPOSITE_DIRECTION[dir] ?? dir;
}

/** Fallback emoji for an unknown class. */
export const CLASS_EMOJI_FALLBACK = '🔹';
/** Fallback emoji for an unknown day job. */
export const DAYJOB_EMOJI_FALLBACK = '🔨';

/**
 * name→emoji lookups, populated once at boot from the YAML defs via `registerEmoji`.
 * Surfaces that hold only a character row (a class/job name, not the loaded defs) —
 * /stats, /hi, /action, outcome broadcasts — read their glyph from here instead of
 * duplicating the asset catalog in a hardcoded map. The /join wizard reads emoji
 * straight off the defs, so it doesn't depend on this.
 */
const emojiByName = {
  class: new Map<string, string>(),
  dayJob: new Map<string, string>(),
} as const;

export type EmojiCategory = keyof typeof emojiByName;

/** Seed a category's name→emoji lookup from loaded YAML defs (called at boot). */
export function registerEmoji(category: EmojiCategory, defs: Array<{ name: string; emoji?: string }>): void {
  const map = emojiByName[category];
  map.clear();
  for (const d of defs) if (d.emoji) map.set(d.name, d.emoji);
}

/** Emoji for a player class, falling back to a neutral marker for unknown classes. */
export function classEmoji(charClass: string | null | undefined): string {
  return (charClass && emojiByName.class.get(charClass)) || CLASS_EMOJI_FALLBACK;
}

/** Emoji for a day job, hammer fallback for unmapped jobs. */
export function dayJobEmoji(job: string | null | undefined): string {
  return (job && emojiByName.dayJob.get(job)) || DAYJOB_EMOJI_FALLBACK;
}
