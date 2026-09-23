// Neutral text helpers for the Discord embed medium: pure, and importing nothing from
// `discord.js`. Relocated out of `action.ts` to break its two-file cycle with `viewToDiscord.ts`.

/** Discord caps an embed description at 4096 chars; exported for `viewToDiscord.ts`'s embed ladder. */
export const MAX_EMBED_DESC = 4096;

/** Clip to `max` chars with a trailing ellipsis; exported for `viewToDiscord.ts`'s length ladder. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** `viewToDiscord.ts` delegates its colour-intent mapping here, except for 'decision'. */
export function outcomeColor(outcome: string): number {
  switch (outcome) {
    case 'success': return 0x2ecc71; // green
    case 'failure': return 0xe74c3c; // red
    case 'skipped': return 0xf39c12; // amber
    case 'bailed': return 0xf39c12;  // amber — neutral retreat, not a failure
    case 'done': return 0x95a5a6;    // grey — neutral finish (travel/rest resolved)
    case 'timed_out': return 0x95a5a6;
    default: return 0x3498db;
  }
}
