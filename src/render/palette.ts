// Colour vocabulary for AnsiRenderer frames — the module of record for
// `Role` and the role->SGR mappings a frame can select between (a "palette").
//
// The settled palette hex (Solarized-ish vs standard ANSI terminal hex) is
// still pending the ANSI-A live probe (docs/engine/poc-plus-0.3.1-polish-plan.md
// "ANSI-A"); once settled it belongs here as a doc note. Hex is documentation
// only — Discord's `ansi` fence only honours SGR codes, so nothing in this
// file ever reads a hex value to render; roles map straight to SGR numbers.
//
// `chrome` sits at 37 (white) rather than the historical 30 (black, invisible
// on Discord's dark code-block background) — see AnsiRenderer.ts's comment on
// the same constant for the full rationale and the pending 90-role reconciliation.

export type Role = 'chrome' | 'threat' | 'life' | 'warmth' | 'player' | 'emphasis';

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
  },
};

export const PALETTES: Record<string, Palette> = { house, ember, gloom };
