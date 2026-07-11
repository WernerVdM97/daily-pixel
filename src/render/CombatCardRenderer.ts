// Presentation-side composer for the combat TERMINAL data card (ANSI-D; ansi-frames skill §2
// "data cards" / [[mvp+ansi-art]] §12's roll-card reference): the fight-over reveal shown once a
// combat action resolves. Mirrors OpeningFrameRenderer.ts's composer pattern — builds straight
// from AnsiRenderer's line-composition primitives rather than through FrameSpec (shaped for the
// nameplate/HP-bar combat frame this card deliberately drops).
//
// The wireframe (`assets/ansi/wireframes/combat-terminal.ascii`) is the mandatory inspiration
// input; see the DELIBERATE DEVIATIONS recorded on the ANSI-D task for the two places this
// composer departs from the mock's literal colour/spacing (both settled, not open questions).

import {
  composeLine,
  borderLine,
  escapeBackticks,
  PALETTES,
  INTERIOR_WIDTH,
  type Palette,
  type Role,
  type Segment,
} from './AnsiRenderer.js';

/** Structural mirror of `engine/OutcomeRenderer.ts`'s `CombatTerminalCard` — kept as a local
 *  shape rather than importing the engine's type so this module's only dependency is
 *  AnsiRenderer's primitives (ANSI-C's render/engine boundary runs both ways: engine code never
 *  imports `src/render/`, and this presentation module has no reason to reach back into
 *  `src/engine/` either). */
export interface CombatTerminalCard {
  label: string;
  playerD20: number;
  bonus: number;
  total: number;
  dc: number;
  marker: string;
  verdict: string;
  margin: number;
  flavour: string;
}

const BLANK = ' '.repeat(INTERIOR_WIDTH);

/** Bare signed number, e.g. "+4" / "-6" — duplicated from OutcomeRenderer's own (unexported)
 *  helper rather than imported, so this render-side module keeps zero engine-side imports. */
function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function plain(t: string): Segment {
  return { text: escapeBackticks(t) };
}

function coloured(t: string, role: Role): Segment {
  return { text: escapeBackticks(t), role };
}

/**
 * Compose a two-column body line: left segments hug the left edge, right segments the right,
 * with the gap between computed exactly so the line already lands at `INTERIOR_WIDTH` before
 * `composeLine`'s `fitSegments` ever has to pad or truncate — same approach as
 * `OpeningFrameRenderer.ts`'s `nameplateSegments` (ANSI-F), reused here for the card's
 * focal/calc/outcome lines. Overflow (left+right wider than the interior) is left to
 * `fitSegments`'s own truncate-from-the-end contract rather than re-implemented here.
 */
function twoColumnLine(left: Segment[], right: Segment[]): Segment[] {
  const leftLen = left.reduce((n, s) => n + s.text.length, 0);
  const rightLen = right.reduce((n, s) => n + s.text.length, 0);
  const gap = Math.max(0, INTERIOR_WIDTH - leftLen - rightLen);
  return [...left, { text: ' '.repeat(gap) }, ...right];
}

/** The card's six content lines, per the wireframe's layout (label, blank, focal roll, calc,
 *  outcome verdict, flavour) — see the module doc comment for the mock this mirrors. */
function buildLines(card: CombatTerminalCard): Segment[][] {
  // A win/loss role split keyed off `marker` (not re-parsing `verdict`) since the card builder
  // already resolved that ambiguity once — re-deriving it here from the verdict string would
  // risk disagreeing with the engine's own success/failure call on an unforeseen outcome value.
  const outcomeRole: Role = card.marker === '+' ? 'life' : 'threat';

  return [
    [plain(`  ${card.label}`)],
    [plain(BLANK)],
    twoColumnLine(
      [plain('  '), coloured(String(card.playerD20), 'warmth')],
      [plain('d20')],
    ),
    twoColumnLine(
      [plain(`  ${signed(card.bonus)} = ${card.total}`)],
      [plain(`vs DC ${card.dc}`)],
    ),
    twoColumnLine(
      [plain('  '), coloured(`${card.marker} ${card.verdict}`, outcomeRole)],
      [plain(`margin ${signed(card.margin)}`)],
    ),
    [plain(`  ${card.flavour}`)],
  ];
}

/**
 * Render the combat TERMINAL data card: a fenced ```ansi block, no enemy nameplate/HP bar/sprite
 * — pure typographic reveal of the fight's deciding roll (ANSI-D). Same fence/border shape as
 * every other AnsiRenderer output so it shares the width/budget invariants the rest of the
 * renderer is tested against.
 */
export function renderCombatTerminalCard(
  card: CombatTerminalCard,
  palette: Palette = PALETTES.house,
): string {
  const lines = buildLines(card);
  const body = [borderLine(palette), ...lines.map((segments) => composeLine(segments, palette)), borderLine(palette)];
  return '```ansi\n' + body.join('\n') + '\n```';
}
