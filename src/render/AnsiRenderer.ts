// Rendering of coloured ANSI frames for Discord `ansi` blocks: the fence honours only SGR 0/1, fg
// 30-37 and bg 40-47, and only on desktop — mobile shows plain monochrome, so colour is decoration and never the only signal.

import { PALETTES, type Palette, type Role } from './palette.js';

// Re-exported so existing importers don't churn — `./palette.js` is the module of record.
export type { Role, Palette };
export { PALETTES };

// ─── Border-style ladder ────────────────────────────────────────────

export interface BorderStyle {
  top: [string, string, string];      // left corner, fill, right corner
  mid: [string, string, string];       // divider
  bottom: [string, string, string];
  side: string;                        // vertical
  /** Full-width crest line ABOVE the top border (crit only). */
  crest?: (palette: Palette) => string;
  /** Full-width crest line BELOW the bottom border (crit only). */
  crestBottom?: (palette: Palette) => string;
}

/** Border intensity/rarity ladder — chrome as a signal: a heavier border marks a punishing round
 *  or a critical hit before a word is read. Every glyph is single-width, safe on mobile. */
export const BORDERS: Record<string, BorderStyle> = {
  standard: { top: ['┌','─','┐'], mid: ['├','─','┤'], bottom: ['└','─','┘'], side: '│' },
  heavy:    { top: ['╔','═','╗'], mid: ['╠','═','╣'], bottom: ['╚','═','╝'], side: '║' },
  crit: {
    top: ['╔','═','╗'],
    mid: ['╠','═','╣'],
    bottom: ['╚','═','╝'],
    side: '║',
    crest: (p: Palette) => {
      const fill = '═'.repeat(10);
      const rim = `o${fill} ╡@╞ ${fill}o`;
      return paint('chrome', rim, p).replace(/@/, paint('warmth', '@', p));
    },
    crestBottom: (p: Palette) => paint('chrome', `o${'═'.repeat(INTERIOR_WIDTH + 2)}o`, p),
  },
};

export interface CombatantLine {
  name: string;
  level?: number;
  hp: number;
  maxHp: number;
  /** Signed damage/heal floater for THIS combatant, e.g. "-6" / "+4". Optional. */
  floater?: string;
  /** Pre-rendered bar glyphs shown INSTEAD of the computed hp/maxHp fill (e.g. a banded pip run).
   *  When set, hp/maxHp still supply the numeric suffix unless `hpText` replaces it. */
  bar?: string;
  /** Text shown INSTEAD of "hp/maxHp" (e.g. a wound word); "" hides the number entirely. Only
   *  read when `bar` is set. */
  hpText?: string;
}

export interface FrameSpec {
  header?: CombatantLine;   // typically the enemy (top nameplate + HP bar)
  sprite?: string[];        // colour-free fragment lines (optional; omitted for the combat card)
  floater?: string;         // frame-level floater for single-beat non-combat frames (optional)
  message?: string[];       // message-box lines below the frame (optional)
  footer?: CombatantLine;   // typically the player (bottom nameplate + HP bar)
}

// Total frame width including the borders.
export const FRAME_WIDTH = 30;
export const INTERIOR_WIDTH = FRAME_WIDTH - 2;
// Message box: 2 lines x 26 chars — the 2-char left indent eats into the 28-wide interior.
const MESSAGE_TEXT_WIDTH = 26;
const MESSAGE_MAX_LINES = 2;
// Floor for the adaptive HP bar: a long "hp/maxHp" suffix can shrink it but not erase it.
const MIN_HP_BAR_WIDTH = 6;
// Below this fraction of max HP the filled bar reads as threat, not life — the design doc's
// "<40%" convention, duplicated in OpeningFrameRenderer because this constant isn't exported.
const LOW_HP_THRESHOLD = 0.4;

const FILLED_GLYPH = '█';
const EMPTY_GLYPH = '░';

/** Wrap text in a role's SGR code + reset. Empty text is skipped: escapes count against
 *  Discord's 2 000-char budget, so spending them on a colourless span is pure waste. */
function paint(role: Role, text: string, palette: Palette): string {
  if (text.length === 0) return '';
  return `\x1b[${palette.sgr[role]}m${text}\x1b[0m`;
}

// Exported for the opening-frame family, which composes its own per-type lines from these
// primitives rather than through `FrameSpec` (shaped for the combat card's slots alone).
export interface Segment {
  text: string;
  role?: Role;
}

/** Pad or truncate a segment list to exactly `width` plain-text chars. Truncation takes from the
 *  END: left-aligned names and labels carry the meaning, so a trailing space or digit loses least. */
function fitSegments(segments: Segment[], width: number): Segment[] {
  const total = segments.reduce((sum, s) => sum + s.text.length, 0);
  if (total === width) return segments;
  if (total < width) {
    return [...segments, { text: ' '.repeat(width - total) }];
  }
  let over = total - width;
  const result: Segment[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (over <= 0) {
      result.unshift(seg);
      continue;
    }
    if (seg.text.length <= over) {
      over -= seg.text.length;
      continue;
    }
    result.unshift({ text: seg.text.slice(0, seg.text.length - over), role: seg.role });
    over = 0;
  }
  return result;
}

/** Render one interior-width line between chrome border glyphs. `sideGlyph` defaults to `│`; the
 *  border ladder swaps in `║`. Exported so other composers share the width contract. */
export function composeLine(segments: Segment[], palette: Palette, sideGlyph = '│'): string {
  const fitted = fitSegments(segments, INTERIOR_WIDTH);
  const body = fitted.map((s) => (s.role ? paint(s.role, s.text, palette) : s.text)).join('');
  return paint('chrome', sideGlyph + body + sideGlyph, palette);
}

/** A full-width top border row for the given style. */
export function borderTop(style: BorderStyle, palette: Palette): string {
  const [L, fill, R] = style.top;
  return paint('chrome', L + fill.repeat(INTERIOR_WIDTH) + R, palette);
}

/** Divider row (header-body split) for the given style. */
export function borderMid(style: BorderStyle, palette: Palette): string {
  const [L, fill, R] = style.mid;
  return paint('chrome', L + fill.repeat(INTERIOR_WIDTH) + R, palette);
}

/** A full-width bottom border row for the given style. */
export function borderBottom(style: BorderStyle, palette: Palette): string {
  const [L, fill, R] = style.bottom;
  return paint('chrome', L + fill.repeat(INTERIOR_WIDTH) + R, palette);
}

/** Monochrome fill of exactly `width` glyphs, no brackets or label — the caller paints it. hp is
 *  clamped to [0, maxHp] so no out-of-range value can yield NaN/Infinity or a broken glyph count. */
export function hpBar(hp: number, maxHp: number, width: number): string {
  if (width <= 0) return '';
  if (maxHp <= 0) return EMPTY_GLYPH.repeat(width);
  const clampedHp = Math.min(Math.max(hp, 0), maxHp);
  const rawFilled = Math.round((clampedHp / maxHp) * width);
  const filled = Math.min(Math.max(rawFilled, 0), width);
  return FILLED_GLYPH.repeat(filled) + EMPTY_GLYPH.repeat(width - filled);
}

/** Nameplate line: "  {name}{gap}Lv {level}  " (level suffix omitted if absent). */
function nameplateSegments(line: CombatantLine, nameRole: Role): Segment[] {
  const indent = '  ';
  const rightRaw = line.level !== undefined ? `Lv ${line.level}` : '';
  const right = rightRaw ? `${rightRaw}  ` : '';
  const availForLeft = Math.max(0, INTERIOR_WIDTH - right.length);
  const availForName = Math.max(0, availForLeft - indent.length);
  const name = line.name.length > availForName ? line.name.slice(0, availForName) : line.name;
  const gapLen = Math.max(0, availForLeft - indent.length - name.length);
  return [
    { text: indent },
    { text: name, role: nameRole },
    { text: ' '.repeat(gapLen) },
    { text: right },
  ];
}

/**
 * HP-bar line: "  HP [{bar}]{ hp/maxHp}". The filled and empty runs are coloured separately at the
 * first EMPTY_GLYPH, and the width comes from the real suffix so the line is exactly INTERIOR_WIDTH.
 */
function hpLineSegments(line: CombatantLine, nameRole: Role): Segment[] {
  const clampedMax = Math.max(line.maxHp, 0);
  const clampedHp = Math.min(Math.max(line.hp, 0), clampedMax);
  const label = '  HP [';

  if (line.bar !== undefined) {
    // Banded HP has no fraction to split on, so the whole bar takes one colour keyed to its owner.
    const suffix = line.hpText !== undefined
      ? (line.hpText ? ` ${line.hpText}` : '')
      : ` ${Math.round(clampedHp)}/${Math.round(clampedMax)}`;
    return [
      { text: label },
      { text: line.bar, role: nameRole },
      { text: ']' },
      { text: suffix },
    ];
  }

  const fraction = clampedMax > 0 ? clampedHp / clampedMax : 0;
  const fillRole: Role = fraction < LOW_HP_THRESHOLD ? 'threat' : 'life';

  const suffix = ` ${Math.round(clampedHp)}/${Math.round(clampedMax)}`;
  const barWidth = Math.max(MIN_HP_BAR_WIDTH, INTERIOR_WIDTH - (label.length + 1 + suffix.length));

  const bar = hpBar(line.hp, line.maxHp, barWidth);
  const emptyIndex = bar.indexOf(EMPTY_GLYPH);
  const filledPart = emptyIndex === -1 ? bar : bar.slice(0, emptyIndex);
  const emptyPart = emptyIndex === -1 ? '' : bar.slice(emptyIndex);

  return [
    { text: label },
    { text: filledPart, role: fillRole },
    { text: emptyPart, role: 'chrome' },
    { text: ']' },
    { text: suffix },
  ];
}

/** Floater line "  {text}", coloured by the sign of the number rather than whose combatant it sits
 *  on: a damage number reads as threat and a heal as life on either line. */
function floaterSegments(text: string): Segment[] {
  const trimmed = text.trim();
  const role: Role = trimmed.startsWith('-') ? 'threat' : trimmed.startsWith('+') ? 'life' : 'chrome';
  return [{ text: '  ' }, { text, role }];
}

/** Sprite fragment line, rendered verbatim and uncoloured; fitSegments clamps over-wide art. */
function spriteSegments(line: string): Segment[] {
  return [{ text: line }];
}

// Stand-in for a backtick in caller text: a literal one would close the ```ansi fence early and
// leak the rest of the frame as raw markdown, so no caller string may ever contain one.
const BACKTICK_SUBSTITUTE = "ʼ";

/** Strip fence-breaking backticks from one piece of caller text. Exported so other register
 *  composers sanitize free-text slot values the same way. */
export function escapeBackticks(text: string): string {
  return text.replace(/`/g, BACKTICK_SUBSTITUTE);
}

/** Backtick-safe copy of a combatant line. Name, floater and hpText are the free-text fields;
 *  `bar` is always glyph-only. */
function sanitizeCombatant(line: CombatantLine): CombatantLine {
  return {
    ...line,
    name: escapeBackticks(line.name),
    floater: line.floater !== undefined ? escapeBackticks(line.floater) : line.floater,
    hpText: line.hpText !== undefined ? escapeBackticks(line.hpText) : line.hpText,
  };
}

/** Message line: 2-space indent + up to 26 chars, truncated rather than wrapped — a hard budget,
 *  so callers pre-wrap their flavour text. */
function messageSegments(line: string): Segment[] {
  const truncated = line.length > MESSAGE_TEXT_WIDTH ? line.slice(0, MESSAGE_TEXT_WIDTH) : line;
  return [{ text: '  ' }, { text: truncated }];
}

/** Render a full fenced ```ansi block. Layout: [crest,] top border, header nameplate/HP/floater,
 *  sprite, frame floater, footer nameplate/HP/floater, a message box if there is one, [crest-bottom]. */
export function renderFrame(
  spec: FrameSpec,
  palette: Palette = PALETTES.house,
  style: BorderStyle = BORDERS.standard,
): string {
  const lines: string[] = [];

  if (style.crest) lines.push(style.crest(palette));
  lines.push(borderTop(style, palette));

  // Sanitize every caller string up front so nothing below carries a fence-breaking backtick.
  const header = spec.header && sanitizeCombatant(spec.header);
  const footer = spec.footer && sanitizeCombatant(spec.footer);
  const sprite = spec.sprite?.map(escapeBackticks);
  const message = spec.message?.map(escapeBackticks);
  const floater = spec.floater !== undefined ? escapeBackticks(spec.floater) : spec.floater;

  if (header) {
    lines.push(composeLine(nameplateSegments(header, 'threat'), palette, style.side));
    lines.push(composeLine(hpLineSegments(header, 'threat'), palette, style.side));
    if (header.floater) lines.push(composeLine(floaterSegments(header.floater), palette, style.side));
  }

  if (sprite) {
    for (const fragment of sprite) {
      lines.push(composeLine(spriteSegments(fragment), palette, style.side));
    }
  }

  if (floater) {
    lines.push(composeLine(floaterSegments(floater), palette, style.side));
  }

  if (footer) {
    lines.push(composeLine(nameplateSegments(footer, 'player'), palette, style.side));
    lines.push(composeLine(hpLineSegments(footer, 'player'), palette, style.side));
    if (footer.floater) lines.push(composeLine(floaterSegments(footer.floater), palette, style.side));
  }

  lines.push(borderBottom(style, palette));

  if (message && message.length > 0) {
    const capped = message.slice(0, MESSAGE_MAX_LINES);
    for (const messageLine of capped) {
      lines.push(composeLine(messageSegments(messageLine), palette, style.side));
    }
    lines.push(borderBottom(style, palette));
  }

  if (style.crestBottom) lines.push(style.crestBottom(palette));

  return '```ansi\n' + lines.join('\n') + '\n```';
}
