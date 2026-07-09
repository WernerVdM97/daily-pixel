// Pure rendering of coloured ANSI frames for Discord `ansi` code blocks.
//
// Discord's ansi fence only honours SGR 0/1, fg 30-37, bg 40-47, and ONLY on
// desktop/browser clients — mobile strips every escape and shows plain
// monochrome text. Two consequences drive this file:
//   1. Colour is decoration, never the only signal — every colour-bearing
//      span (name, HP fraction, floater sign) must also be legible as plain
//      text (see the HP numeric suffix and the sign-based floater text).
//   2. Escape codes count against the 2 000-char message budget, so colour
//      wraps are applied to the smallest meaningful span (e.g. just the
//      filled portion of an HP bar, not the whole line) and skipped
//      entirely for empty segments.
//
// See docs/sparks/mvp+ansi-art.md §2-3 for the colour-role convention and
// the frame/slot layout this module implements.

export type Role = 'chrome' | 'threat' | 'life' | 'warmth' | 'player' | 'emphasis';

export interface CombatantLine {
  name: string;
  level?: number;
  hp: number;
  maxHp: number;
  /** Signed damage/heal floater for THIS combatant, e.g. "-6" / "+4". Optional. */
  floater?: string;
}

export interface FrameSpec {
  header?: CombatantLine;   // typically the enemy (top nameplate + HP bar)
  sprite?: string[];        // colour-free fragment lines (optional; omitted for the combat card)
  floater?: string;         // frame-level floater for single-beat non-combat frames (optional)
  message?: string[];       // message-box lines below the frame (optional)
  footer?: CombatantLine;   // typically the player (bottom nameplate + HP bar)
}

// Total frame width including the `|`...`|` borders (design doc §3).
const FRAME_WIDTH = 30;
// Content width between the two border chars.
const INTERIOR_WIDTH = FRAME_WIDTH - 2;
// Message-box budget: 2 lines x 26 chars, with a 2-char left indent eating
// into the 28-wide interior (design doc §3).
const MESSAGE_TEXT_WIDTH = 26;
const MESSAGE_MAX_LINES = 2;
// Fits label ("HP [") + bracket + a typical 2-3 digit "hp/maxHp" suffix
// inside the 28-wide interior; see hpLineSegments' truncation note below
// for what happens with unusually large HP values.
const HP_BAR_WIDTH = 14;
// Below this fraction of max HP, the filled bar segment reads as threat
// (red) rather than life (green) — chosen per the design doc's "e.g. <40%"
// suggestion.
const LOW_HP_THRESHOLD = 0.4;

const FILLED_GLYPH = '█';
const EMPTY_GLYPH = '░';

const SGR: Record<Role, number> = {
  chrome: 30,
  threat: 31,
  life: 32,
  warmth: 33,
  player: 34,
  emphasis: 37,
};

/** Wrap text in a role's SGR code + reset. Skips empty text so blank
 *  segments don't spend chars on escape codes that colour nothing. */
function paint(role: Role, text: string): string {
  if (text.length === 0) return '';
  return `\x1b[${SGR[role]}m${text}\x1b[0m`;
}

interface Segment {
  text: string;
  role?: Role;
}

/**
 * Pad or truncate a segment list so the sum of its plain-text lengths is
 * exactly `width`. Truncation removes from the END of the segment list
 * (dropping whole trailing segments, then cutting into the last one that
 * still overflows) since left-aligned content — names, labels, message
 * openers — carries the meaning; a clipped trailing space or a shortened
 * numeric suffix loses least.
 */
function fitSegments(segments: Segment[], width: number): Segment[] {
  const total = segments.reduce((sum, s) => sum + s.text.length, 0);
  if (total === width) return segments;
  if (total < width) {
    return [...segments, { text: ' '.repeat(width - total) }];
  }
  let over = total - width;
  const result: Segment[] = [];
  for (const seg of segments) {
    if (over <= 0) {
      result.push(seg);
      continue;
    }
    if (seg.text.length <= over) {
      over -= seg.text.length;
      continue;
    }
    result.push({ text: seg.text.slice(0, seg.text.length - over), role: seg.role });
    over = 0;
  }
  return result;
}

/** Render one interior-width line between chrome-coloured `|` borders. */
function composeLine(segments: Segment[]): string {
  const fitted = fitSegments(segments, INTERIOR_WIDTH);
  const body = fitted.map((s) => (s.role ? paint(s.role, s.text) : s.text)).join('');
  return paint('chrome', '|') + body + paint('chrome', '|');
}

/** A full-width `+----...----+` border/divider row. */
function borderLine(): string {
  return paint('chrome', '+' + '-'.repeat(INTERIOR_WIDTH) + '+');
}

/**
 * Monochrome HP-bar FILL of exactly `width` glyphs. No brackets, no label,
 * no colour — renderFrame applies role colour to (a slice of) the result.
 * hp is clamped to [0, maxHp] before computing the fill fraction so out-of-
 * range input (negative hp, hp > maxHp, a non-positive maxHp) can never
 * produce NaN/Infinity or an out-of-bounds glyph count.
 */
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
 * HP-bar line: "  HP [{bar}]{ hp/maxHp}". The bar's filled run and empty
 * run are coloured separately (life/threat vs chrome) by locating the
 * filled/empty boundary in the plain bar string — hpBar always emits all
 * filled glyphs before all empty ones, so the first EMPTY_GLYPH marks it.
 * The displayed hp is clamped the same way hpBar clamps its fill, so the
 * number on screen always agrees with the bar next to it.
 */
function hpLineSegments(line: CombatantLine): Segment[] {
  const clampedMax = Math.max(line.maxHp, 0);
  const clampedHp = Math.min(Math.max(line.hp, 0), clampedMax);
  const fraction = clampedMax > 0 ? clampedHp / clampedMax : 0;
  const fillRole: Role = fraction < LOW_HP_THRESHOLD ? 'threat' : 'life';

  const bar = hpBar(line.hp, line.maxHp, HP_BAR_WIDTH);
  const emptyIndex = bar.indexOf(EMPTY_GLYPH);
  const filledPart = emptyIndex === -1 ? bar : bar.slice(0, emptyIndex);
  const emptyPart = emptyIndex === -1 ? '' : bar.slice(emptyIndex);

  return [
    { text: '  HP [' },
    { text: filledPart, role: fillRole },
    { text: emptyPart, role: 'chrome' },
    { text: ']' },
    { text: ` ${clampedHp}/${clampedMax}` },
  ];
}

/**
 * Floater line: "  {text}". Coloured by SIGN, not by whose combatant it
 * belongs to — a damage number reads as threat (red) and a heal as life
 * (green) regardless of whether it's the enemy's or the player's line,
 * matching the design doc's "damage floaters" / "healing floaters" roles.
 */
function floaterSegments(text: string): Segment[] {
  const trimmed = text.trim();
  const role: Role = trimmed.startsWith('-') ? 'threat' : trimmed.startsWith('+') ? 'life' : 'chrome';
  return [{ text: '  ' }, { text, role }];
}

/** Sprite fragment line: rendered verbatim (no colour — "colour-free
 *  fragment lines" per the spec), clamped to the interior width by
 *  fitSegments if the fragment is authored wider than 28 chars. */
function spriteSegments(line: string): Segment[] {
  return [{ text: line }];
}

/** Message line: 2-space indent + up to 26 chars of text, truncated
 *  (not wrapped) if longer — the message box is a hard budget, not a
 *  reflow target; callers are expected to pre-wrap flavour text. */
function messageSegments(line: string): Segment[] {
  const truncated = line.length > MESSAGE_TEXT_WIDTH ? line.slice(0, MESSAGE_TEXT_WIDTH) : line;
  return [{ text: '  ' }, { text: truncated }];
}

/**
 * Render a full fenced ```ansi block (opening fence, ESC-coloured body,
 * closing fence). Layout order: top border, header nameplate/HP/floater,
 * sprite lines, frame-level floater, footer nameplate/HP/floater, a
 * border (acts as the bottom border if there's no message, or a divider
 * before the message box if there is), message lines, closing border.
 */
export function renderFrame(spec: FrameSpec): string {
  const lines: string[] = [borderLine()];

  if (spec.header) {
    lines.push(composeLine(nameplateSegments(spec.header, 'threat')));
    lines.push(composeLine(hpLineSegments(spec.header)));
    if (spec.header.floater) lines.push(composeLine(floaterSegments(spec.header.floater)));
  }

  if (spec.sprite) {
    for (const fragment of spec.sprite) {
      lines.push(composeLine(spriteSegments(fragment)));
    }
  }

  if (spec.floater) {
    lines.push(composeLine(floaterSegments(spec.floater)));
  }

  if (spec.footer) {
    lines.push(composeLine(nameplateSegments(spec.footer, 'player')));
    lines.push(composeLine(hpLineSegments(spec.footer)));
    if (spec.footer.floater) lines.push(composeLine(floaterSegments(spec.footer.floater)));
  }

  lines.push(borderLine());

  if (spec.message && spec.message.length > 0) {
    const capped = spec.message.slice(0, MESSAGE_MAX_LINES);
    for (const messageLine of capped) {
      lines.push(composeLine(messageSegments(messageLine)));
    }
    lines.push(borderLine());
  }

  return '```ansi\n' + lines.join('\n') + '\n```';
}
