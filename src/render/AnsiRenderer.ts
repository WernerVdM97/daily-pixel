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
  /** Pre-rendered bar glyphs shown INSTEAD of the computed hp/maxHp fill (e.g. a 5-pip banded
   *  condition bar). When set, hp/maxHp are still required by the type but are inert for
   *  display — only the bar string and hpText suffix are rendered. */
  bar?: string;
  /** Text shown INSTEAD of "hp/maxHp" (e.g. a wound word). "" hides the number entirely.
   *  Only meaningful alongside `bar`; ignored otherwise. */
  hpText?: string;
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
// Floor for the adaptively-sized HP bar (see hpLineSegments) so a very
// long "hp/maxHp" suffix can still shrink the bar without erasing it.
const MIN_HP_BAR_WIDTH = 6;
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
 * number on screen always agrees with the bar next to it. Displayed
 * numbers are rounded (game HP is always integer; this only guards
 * against a stray fractional value reaching the renderer).
 *
 * The bar width is sized to whatever's left of the interior after the
 * fixed "  HP [", "]", and the actual "{hp}/{maxHp}" suffix — a fixed bar
 * width would either get padded (small numbers) or, worse, force
 * fitSegments to eat into the "  HP [" label to make room for a wide
 * suffix (3+ digit HP), which silently breaks the box. Sizing it from the
 * real suffix length means the line is exactly INTERIOR_WIDTH before
 * fitSegments ever has to pad or truncate anything.
 *
 * When `line.bar` is set (banded/exact-HP-hidden combatant), that string is used verbatim
 * as the bracketed content instead of a computed fill, and `hpText ?? "hp/maxHp"` replaces
 * the numeric suffix — see the early-return branch below. fitSegments still owns final
 * width enforcement/truncation for that branch, same as every other line in the frame.
 */
function hpLineSegments(line: CombatantLine, nameRole: Role): Segment[] {
  const clampedMax = Math.max(line.maxHp, 0);
  const clampedHp = Math.min(Math.max(line.hp, 0), clampedMax);
  const label = '  HP [';

  if (line.bar !== undefined) {
    // Banded HP has no fraction to colour by fill/empty split, so (unlike the computed path
    // below) the whole bar takes one colour keyed to who it belongs to.
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

// Visual stand-in for a backtick in caller-supplied text. A literal ` would
// close the ```ansi fence early (or open a nested inline-code span),
// leaking the rest of the frame as raw Discord markdown — reachable via an
// LLM-authored enemy name or a user-supplied character name, so the
// renderer (which owns the fence) must guarantee no caller text can ever
// contain one.
const BACKTICK_SUBSTITUTE = "ʼ";

/** Strip any fence-breaking backticks out of one piece of caller text. */
function escapeBackticks(text: string): string {
  return text.replace(/`/g, BACKTICK_SUBSTITUTE);
}

/** Backtick-safe copy of a combatant line: sanitizes name, floater, and hpText —
 *  the free-text fields on a CombatantLine (bar is always glyph-only, never caller prose). */
function sanitizeCombatant(line: CombatantLine): CombatantLine {
  return {
    ...line,
    name: escapeBackticks(line.name),
    floater: line.floater !== undefined ? escapeBackticks(line.floater) : line.floater,
    hpText: line.hpText !== undefined ? escapeBackticks(line.hpText) : line.hpText,
  };
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

  // Sanitize every caller-supplied string up front so nothing composed
  // below can carry a fence-breaking backtick into the output.
  const header = spec.header && sanitizeCombatant(spec.header);
  const footer = spec.footer && sanitizeCombatant(spec.footer);
  const sprite = spec.sprite?.map(escapeBackticks);
  const message = spec.message?.map(escapeBackticks);
  const floater = spec.floater !== undefined ? escapeBackticks(spec.floater) : spec.floater;

  if (header) {
    lines.push(composeLine(nameplateSegments(header, 'threat')));
    lines.push(composeLine(hpLineSegments(header, 'threat')));
    if (header.floater) lines.push(composeLine(floaterSegments(header.floater)));
  }

  if (sprite) {
    for (const fragment of sprite) {
      lines.push(composeLine(spriteSegments(fragment)));
    }
  }

  if (floater) {
    lines.push(composeLine(floaterSegments(floater)));
  }

  if (footer) {
    lines.push(composeLine(nameplateSegments(footer, 'player')));
    lines.push(composeLine(hpLineSegments(footer, 'player')));
    if (footer.floater) lines.push(composeLine(floaterSegments(footer.floater)));
  }

  lines.push(borderLine());

  if (message && message.length > 0) {
    const capped = message.slice(0, MESSAGE_MAX_LINES);
    for (const messageLine of capped) {
      lines.push(composeLine(messageSegments(messageLine)));
    }
    lines.push(borderLine());
  }

  return '```ansi\n' + lines.join('\n') + '\n```';
}
