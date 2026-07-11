// Presentation-side composers for the two combat-card registers (ANSI-D + border-redesign):
// CONTINUE (between decisions) and TERMINAL (fight-over reveal). Both compose from
// AnsiRenderer's line-composition primitives — no engine-side imports (ANSI-C boundary).
//
// The authority for the visual target is docs/vision/visual-craft.md (exact width-validated
// frames, colour-role mapping, escalation rules). The wireframes in assets/ansi/wireframes/
// are the mandatory inspiration input; this code mirrors them.
//
// Unlike FrameSpec (shaped for nameplate/HP-bar combat frames), these cards render their own
// typographic data-card shapes — the CONTINUE card keeps enemy/player HP bars, the TERMINAL
// card drops them entirely (the embed's stats footer carries that info).

import {
  composeLine,
  borderTop,
  borderMid,
  borderBottom,
  BORDERS,
  hpBar,
  escapeBackticks,
  PALETTES,
  INTERIOR_WIDTH,
  type BorderStyle,
  type Palette,
  type Role,
  type Segment,
} from './AnsiRenderer.js';

// ─── Shared helpers ──────────────────────────────────────────────────

const BLANK = ' '.repeat(INTERIOR_WIDTH);

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
 * with the gap computed exactly so the line already lands at `INTERIOR_WIDTH` before
 * `composeLine`'s `fitSegments` ever has to pad or truncate.
 */
function twoColumnLine(left: Segment[], right: Segment[]): Segment[] {
  const leftLen = left.reduce((n, s) => n + s.text.length, 0);
  const rightLen = right.reduce((n, s) => n + s.text.length, 0);
  const gap = Math.max(0, INTERIOR_WIDTH - leftLen - rightLen);
  return [...left, { text: ' '.repeat(gap) }, ...right];
}

// ─── Band-colour ladder ──────────────────────────────────────────────

/** Map a combat band to its favourability colour role. Monochrome-safe:
 *  the band word itself and the `+`/`−` sign carry the meaning when colour
 *  is stripped (mobile). */
export function bandColor(band: string): Role {
  switch (band.toLowerCase()) {
    case 'clean':
    case 'glanced': return 'life';
    case 'trade': return 'warmth';
    case 'heavy': return 'threat';
    default: return 'chrome';
  }
}

// ─── CONTINUE card ───────────────────────────────────────────────────

export interface ContinueCardInput {
  enemyName: string;
  woundWord: string;
  pips: { filled: number; total: number };
  playerHp: number;
  playerMaxHp: number;
  playerHpDelta: number;
  /** The last round's maths. Undefined = first beat (no rolls yet), render HP bars only. */
  lastRound?: {
    d20: number;
    bonus: number;
    dc: number;
    margin: number;
    band: string;
  };
}

function buildContinueLines(input: ContinueCardInput): Segment[][] {
  const bar = '▓'.repeat(input.pips.filled) + '░'.repeat(input.pips.total - input.pips.filled);
  const lines: Segment[][] = [];

  // Enemy nameplate
  lines.push([plain(`  ${escapeBackticks(input.enemyName)}`)]);
  // Enemy banded HP bar
  {
    const label = '  HP [';
    const suffix = input.woundWord ? ` ${escapeBackticks(input.woundWord)}` : '';
    lines.push([{ text: label }, coloured(bar, 'threat'), { text: ']' }, { text: suffix }]);
  }

  // Player nameplate
  lines.push([plain('  YOU')]);

  // Player HP bar (computed fill)
  {
    const label = '  HP [';
    const clampedMax = Math.max(input.playerMaxHp, 0);
    const clampedHp = Math.min(Math.max(input.playerHp, 0), clampedMax);
    const fraction = clampedMax > 0 ? clampedHp / clampedMax : 0;
    const fillRole: Role = fraction < 0.4 ? 'threat' : 'life';
    // Re-use the INTERIOR_WIDTH budget maths from AnsiRenderer's old hpLineSegments.
    const suffix = ` ${Math.round(clampedHp)}/${Math.round(clampedMax)}`;
    const MIN_BAR = 6;
    const barWidth = Math.max(MIN_BAR, INTERIOR_WIDTH - (label.length + 1 + suffix.length));
    const barStr = hpBar(input.playerHp, input.playerMaxHp, barWidth);
    const emptyIndex = barStr.indexOf('░');
    const filledPart = emptyIndex === -1 ? barStr : barStr.slice(0, emptyIndex);
    const emptyPart = emptyIndex === -1 ? '' : barStr.slice(emptyIndex);
    lines.push([
      { text: label },
      { text: filledPart, role: fillRole },
      { text: emptyPart, role: 'chrome' },
      { text: ']' },
      { text: suffix },
    ]);
  }

  return lines;
}

/**
 * Render the combat CONTINUE card: enemy/player HP bars plus, when a round has been fought,
 * a diced readout (floated calc left, boxed DC right; band-coloured margin + band word).
 * `style` is chosen by the caller (action.ts) via escalation rules — this function just
 * draws the border tier it's told to.
 */
export function renderCombatContinueCard(
  input: ContinueCardInput,
  palette: Palette = PALETTES.house,
  style: BorderStyle = BORDERS.standard,
): string {
  const body: string[] = [];
  if (style.crest) body.push(style.crest(palette));
  body.push(borderTop(style, palette));

  const nameplateLines = buildContinueLines(input);
  for (const segments of nameplateLines) {
    body.push(composeLine(segments, palette, style.side));
  }

  if (input.lastRound) {
    body.push(borderMid(style, palette));

    const { d20, bonus, dc, margin, band } = input.lastRound;
    const bandRole = bandColor(band);
    const dcLabel = `[DC ${dc}]`;

    // Readout line 1: "  {d20} +{bonus} = {total}"  |  "[DC N]"
    body.push(composeLine(
      twoColumnLine(
        [plain(`  ${d20} ${signed(bonus)} = ${d20 + bonus}`)],
        [coloured(dcLabel, 'warmth')],
      ),
      palette,
      style.side,
    ));

    // Readout line 2: "  hit {+/-margin} margin"  |  "{BAND}"
    const marginStr = margin >= 0 ? `+${margin}` : `${margin}`;
    const marginRole: Role = margin >= 0 ? 'life' : 'threat';
    body.push(composeLine(
      twoColumnLine(
        [plain('  hit '), coloured(`${marginStr} margin`, marginRole)],
        [coloured(band.toUpperCase(), bandRole)],
      ),
      palette,
      style.side,
    ));
  }

  body.push(borderBottom(style, palette));
  if (style.crestBottom) body.push(style.crestBottom(palette));

  return '```ansi\n' + body.join('\n') + '\n```';
}

// ─── TERMINAL card ───────────────────────────────────────────────────

/** Structural mirror of `engine/OutcomeRenderer.ts`'s `CombatTerminalCard` — kept as a local
 *  shape rather than importing the engine's type (ANSI-C boundary). */
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

function buildTerminalLines(card: CombatTerminalCard): Segment[][] {
  const outcomeRole: Role = card.marker === '+' ? 'life' : 'threat';

  return [
    [plain(`  ${card.label}`)],
    [plain(BLANK)],
    // Focal line: left = d20 (gold), right = [DC N] (gold) — no "d20" label.
    twoColumnLine(
      [plain('  '), coloured(String(card.playerD20), 'warmth')],
      [coloured(`[DC ${card.dc}]`, 'warmth')],
    ),
    // Calc line: "{+/-bonus} = {total}" left, nothing right.
    twoColumnLine(
      [plain(`  ${signed(card.bonus)} = ${card.total}`)],
      [],
    ),
    // Outcome line: "{+ WIN / x LOSS}" left (coloured by success/failure), "margin {+/-N}" right.
    twoColumnLine(
      [plain('  '), coloured(`${card.marker} ${card.verdict}`, outcomeRole)],
      [plain(`margin ${signed(card.margin)}`)],
    ),
    [plain(`  ${card.flavour}`)],
  ];
}

/**
 * Render the combat TERMINAL data card: a fenced ```ansi block, no enemy nameplate/HP
 * bar/sprite — pure typographic reveal of the fight's deciding roll. `style` controls the
 * border register (crit for nat-20, heavy for nat-1, standard otherwise).
 */
export function renderCombatTerminalCard(
  card: CombatTerminalCard,
  palette: Palette = PALETTES.house,
  style: BorderStyle = BORDERS.standard,
): string {
  const lines = buildTerminalLines(card);
  const body: string[] = [];
  if (style.crest) body.push(style.crest(palette));
  body.push(borderTop(style, palette));
  for (const segments of lines) {
    body.push(composeLine(segments, palette, style.side));
  }
  body.push(borderBottom(style, palette));
  if (style.crestBottom) body.push(style.crestBottom(palette));

  return '```ansi\n' + body.join('\n') + '\n```';
}
