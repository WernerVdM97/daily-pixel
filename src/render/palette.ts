// Colour vocabulary for AnsiRenderer frames — the module of record for
// `Role` and the role->SGR mappings a frame can select between (a "palette").
//
// Settled by the ANSI-A live probe (2026-07-11): Discord's `ansi` palette is
// the Solarized-custom set, NOT standard ANSI. Colour-matching hex (reference
// only — Discord honours SGR codes, nothing here reads hex at render):
//   30 #4f545c · 31 #dc322f · 32 #859900 · 33 #b58900 (gold, not lemon)
//   34 #268bd2 (azure) · 35 #d33682 · 36 #2aa198 · 37 ≈ cream (#fdf6e3-ish)
// Also settled: bright fg 90-97 render NO colour anywhere (plain default
// text), and bg 40-47 are desktop-only (invisible on mobile).
//
// `chrome` sits at 37 (white) rather than the historical 30 (black, invisible
// on Discord's dark code-block background). This is final, not interim: the
// once-planned reconciliation to bright 90 is dead — 90-97 don't render.
// That parks `chrome` on the same code as `emphasis` in the house palette;
// `emphasis` (and `warmth`) are not yet emitted by any segment builder, so the
// collision is inert — the first frame to wire `emphasis` must split them
// (the 90-reconciliation naturally does).
//
// A missed dynamic lookup (`PALETTES['typo']` -> undefined) falls back to the
// house palette via renderFrame's default parameter; only an explicit `null`
// would bypass it. Don't pass null.

// `status` added for ANSI-F's REST_STOP register (magenta 35 "reserved: magic/status" per the
// classification framework §6) — no existing segment builder needed a role distinct from
// `threat`/`life`/`warmth`/`player`/`emphasis` until the opening frame's sleep glyphs (`z Z`).
export type Role = 'chrome' | 'threat' | 'life' | 'warmth' | 'player' | 'emphasis' | 'status';

export interface Palette {
  name: string;
  sgr: Record<Role, number>;
}

// Matches today's pre-standardisation SGR map (AnsiRenderer.ts) except
// `chrome`, which moves off black per ANSI-B — see AnsiRenderer.ts.
const house: Palette = {
  name: 'house',
  sgr: {
    chrome: 37,
    threat: 31,
    life: 32,
    warmth: 33,
    player: 34,
    emphasis: 37,
    status: 35,
  },
};

// Warm-shifted mood variant: pushes `player`/`emphasis` toward yellow/warm
// tones for a fireside/celebratory register. Plausible starting values —
// tuning against a live render is deferred to whichever frame first adopts it.
const ember: Palette = {
  name: 'ember',
  sgr: {
    chrome: 37,
    threat: 31,
    life: 33,
    warmth: 33,
    player: 35,
    emphasis: 33,
    status: 35,
  },
};

// Cool/dim-shifted mood variant: for a grim, low-light register (dungeons,
// dread beats). Plausible starting values, tuning deferred per `ember`.
const gloom: Palette = {
  name: 'gloom',
  sgr: {
    chrome: 37,
    threat: 35,
    life: 36,
    warmth: 34,
    player: 36,
    emphasis: 37,
    status: 35,
  },
};

export const PALETTES: Record<string, Palette> = { house, ember, gloom };
