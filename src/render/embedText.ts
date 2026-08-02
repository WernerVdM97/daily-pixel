// Neutral text helpers for the Discord embed medium step (JSON-seam M3). `render/*` is "pure
// DTO in, string out" — these are pure (`string→string`, a const, `string→hex-number`) and
// import nothing from `discord.js`. Relocated out of `action.ts` to break its import cycle with
// `viewToDiscord.ts` (M3.0): `viewToDiscord.ts` was importing these back from `action.ts`, which
// in turn imports the `*ViewToDiscord` fns from `viewToDiscord.ts` — a two-file cycle.

/** Discord caps an embed description at 4096 chars. Exported: the medium step
 *  (`viewToDiscord.ts`) owns the embed-length degradation ladder and needs this cap. */
export const MAX_EMBED_DESC = 4096;

/** Clip to `max` chars with a trailing ellipsis. Exported: the medium step
 *  (`viewToDiscord.ts`) owns the embed-length degradation ladder and needs this helper. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** Exported: `viewToDiscord.ts`'s colour-intent→hex mapping delegates to this exact switch
 *  for every intent except 'decision' (which has no `outcome` counterpart). */
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
