// Colour vocabulary for AnsiRenderer frames — the module of record for `Role` and the
// role->SGR mappings a frame can select between (a "palette").

/** `status` covers the opening frame's sleep glyphs: magenta, a role no other frame needed. */
export type Role = 'chrome' | 'threat' | 'life' | 'warmth' | 'player' | 'emphasis' | 'status';

/** Role -> SGR code. Discord's `ansi` palette is Solarized-custom, not standard ANSI: `chrome` is
 *  37, not black 30 (unreadable on dark code blocks), and bright 90-97 render no colour at all. */
export interface Palette {
  name: string;
  sgr: Record<Role, number>;
}

// Mirrors the pre-standardisation SGR map bar `chrome`, which moves off black 30. `chrome` and
// `emphasis` both sit at 37 here; nothing emits `emphasis` yet, so the collision is inert until the first frame to wire it splits them.
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

// Warm variant for a fireside/celebratory register: `life` and `emphasis` shift to gold, `player`
// to magenta. Plausible starting values — tuning waits on the first frame that adopts one.
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

// Cool/dim variant for a grim, low-light register (dungeons, dread beats); plausible starting
// values like `ember`, tuning deferred.
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

/** A missed key (`PALETTES['typo']` -> undefined) falls back to `house` via renderFrame's default
 *  parameter; only an explicit `null` bypasses it. */
export const PALETTES: Record<string, Palette> = { house, ember, gloom };
