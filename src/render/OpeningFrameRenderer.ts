// Presentation-side composer for the OPENING register family: one scene-setter frame per classified
// action type, shown right after `classify` resolves. Never touches the engine or the LLM.

import {
  composeLine,
  borderTop,
  borderBottom,
  BORDERS,
  escapeBackticks,
  hpBar,
  PALETTES,
  INTERIOR_WIDTH,
  type BorderStyle,
  type Palette,
  type Role,
  type Segment,
} from './AnsiRenderer.js';

export type OpeningActionType = 'combat' | 'travel' | 'social' | 'skill' | 'search' | 'rest' | 'other';

export interface OpeningFrameSlots {
  /** Player character's display name, drawn in the `combat` footer nameplate only — every other
   *  type's PC art is a fixed placeholder. No "Lv" suffix: `CharacterData` has no numeric level. */
  pcName?: string;
  /** Player's current/max HP for the `combat` footer bar — real data, unlike the enemy header.
   *  Omit either to get an honest "unknown" bar rather than a fabricated fraction. */
  pcHp?: number;
  pcMaxHp?: number;
  /** `travel` only: the origin location's display name. The destination is always the literal
   *  "????" — rumoured by design, never a real slot at this pre-decision moment. */
  locationName?: string;
  /** Accepted for API completeness but NEVER drawn in the frame body: emoji render double-width in
   *  Discord and would push a column's border out of line. */
  locationEmoji?: string;
  /** One-line scene hint. No wireframe carries free text inside the frame body, so the reply posted
   *  beneath it is that slot's home; kept on this type only for symmetry, the frame ignores it. */
  sceneHint?: string;
  /** `combat` only: the foe's name, when already signalled (e.g. a `combatEnemy` hint from DECIDE).
   *  Undefined renders an honest "unknown foe": `handleCombatStep` writes the `in_combat` edge only on the first choice, so pre-decision neither is knowable. */
  enemyName?: string;
  /** `combat` re-entry only: a persisted `in_combat` edge from a prior bail means the foe is already
   *  damaged. Banded (wound word + pips), never exact HP; absent, the placeholder bar is unchanged. */
  enemyCondition?: { woundWord: string; filled: number; total: number };
}

// The wireframes' own bar width. The placeholder branch is fixed (never real HP); the re-entry
// branch below swaps in a pip run sized to `condition.total`.
const ENEMY_BAR_WIDTH = 14;
// Placeholder-branch width only. The real-HP branch sizes its bar adaptively instead: a fixed width
// would let fitSegments truncate a wide "{hp}/{maxHp}" suffix, eating a digit off the HP number.
const PC_BAR_WIDTH = 6;
// Floor for the adaptive real-HP bar: a long "hp/maxHp" suffix can shrink it but not erase it.
const MIN_PC_BAR_WIDTH = 3;
// Mirrors AnsiRenderer's LOW_HP_THRESHOLD; duplicated because that constant isn't exported.
const LOW_HP_THRESHOLD = 0.4;

const BLANK = ' '.repeat(28);

function plain(t: string): Segment {
  return { text: escapeBackticks(t) };
}

function coloured(t: string, role: Role): Segment {
  return { text: escapeBackticks(t), role };
}

/** A fully static wireframe line — no dynamic slot content, no colour role. */
function staticLine(t: string): Segment[] {
  return [plain(t)];
}

/** A fully static wireframe line, one colour role for the whole run. */
function colouredLine(t: string, role: Role): Segment[] {
  return [coloured(t, role)];
}

/** Split a static wireframe line around ONE occurrence of `marker`, colouring the marker
 *  `markerRole` and the rest (before + after) `restRole`; undefined leaves the rest plain. */
function splitOnce(full: string, marker: string, markerRole: Role, restRole?: Role): Segment[] {
  const idx = full.indexOf(marker);
  if (idx === -1) return restRole ? [coloured(full, restRole)] : [plain(full)];
  const wrap = (t: string): Segment => (restRole ? coloured(t, restRole) : plain(t));
  return [wrap(full.slice(0, idx)), coloured(marker, markerRole), wrap(full.slice(idx + marker.length))];
}

/** Like `splitOnce` but colours EVERY occurrence of `marker` (search's repeated '?' clue
 *  glyphs) — the rest of the line stays plain (uncoloured). */
function splitRepeated(full: string, marker: string, markerRole: Role): Segment[] {
  const segments: Segment[] = [];
  let rest = full;
  while (rest.length > 0) {
    const idx = rest.indexOf(marker);
    if (idx === -1) {
      segments.push(plain(rest));
      break;
    }
    if (idx > 0) segments.push(plain(rest.slice(0, idx)));
    segments.push(coloured(marker, markerRole));
    rest = rest.slice(idx + marker.length);
  }
  return segments;
}

/** Clip a free-text slot value to `max` before splicing it into a fixed-width line: an unclipped
 *  name would make fitSegments eat the line's trailing padding, not just the name. */
function clipName(value: string, max: number): string {
  const safe = escapeBackticks(value);
  return safe.length > max ? safe.slice(0, max) : safe;
}

/** `combat` -> COMBAT_FRAME (opener variant): a placeholder enemy header (see `enemyName`) and a
 *  footer that uses real player data when the caller supplies it. */
function combatLines(slots: OpeningFrameSlots): Segment[][] {
  const enemyName = slots.enemyName ? clipName(slots.enemyName, 20) : 'Unknown foe';
  const enemyBar = hpBar(0, 0, ENEMY_BAR_WIDTH); // maxHp<=0 -> all-empty "unknown" bar (honest, not broken)

  // Re-entry: a persisted in_combat edge means the foe is already damaged, so the placeholder bar
  // and `?/?` swap for the banded pip readout (see the continue card); absent, nothing changes.
  const condition = slots.enemyCondition;
  const enemyHpLine: Segment[] = condition
    ? [
      plain('  HP ['),
      coloured('▓'.repeat(condition.filled) + '░'.repeat(condition.total - condition.filled), 'threat'),
      plain(`] ${condition.woundWord}`),
    ]
    : [plain('  HP ['), coloured(enemyBar, 'chrome'), plain('] ?/?')];

  const pcName = clipName(slots.pcName ?? 'Warden', 14);
  const hasPcHp = slots.pcHp !== undefined && slots.pcMaxHp !== undefined;

  // Clamp before display so the printed number agrees with hpBar's own clamp; otherwise a negative
  // pcHp would print "-5/30" beside a bar that correctly renders empty.
  const clampedMax = hasPcHp ? Math.max(slots.pcMaxHp!, 0) : 0;
  const clampedHp = hasPcHp ? Math.min(Math.max(slots.pcHp!, 0), clampedMax) : 0;
  const pcSuffix = hasPcHp ? ` ${Math.round(clampedHp)}/${Math.round(clampedMax)}` : ' ?/?';

  // Size the real-HP bar from the fixed prefix, the ']' and the actual suffix, minus one so the HP
  // figure keeps a space inside the right border; the placeholder branch keeps PC_BAR_WIDTH.
  const pcBarPrefixLen = '  /|_|\\   HP ['.length;
  const pcBarWidth = hasPcHp
    ? Math.max(MIN_PC_BAR_WIDTH, INTERIOR_WIDTH - pcBarPrefixLen - 1 - pcSuffix.length - 1)
    : PC_BAR_WIDTH;
  const pcBar = hasPcHp ? hpBar(clampedHp, clampedMax, pcBarWidth) : hpBar(0, 0, PC_BAR_WIDTH);
  const pcFraction = hasPcHp && clampedMax > 0 ? clampedHp / clampedMax : 1;
  const pcBarRole: Role = hasPcHp ? (pcFraction < LOW_HP_THRESHOLD ? 'threat' : 'life') : 'chrome';

  return [
    [plain('  '), coloured(enemyName, 'threat')],
    enemyHpLine,
    staticLine(BLANK),
    staticLine('        /\\        /\\        '),
    staticLine('       /  \\______/  \\       '),
    staticLine('      |    o    o    |      '),
    staticLine('      |      /\\      |      '),
    staticLine("       \\    '--'    /       "),
    staticLine("        '-.______.-'        "),
    staticLine(BLANK),
    staticLine('   ,^.                      '),
    [plain('  ( _ )   '), coloured(pcName, 'player')],
    [plain('  /|_|\\   HP ['), coloured(pcBar, pcBarRole), plain(']' + pcSuffix)],
    staticLine('  _/ \\_                     '),
  ];
}

/** `travel` -> SCENE (route strip); the destination is always the literal "????", never a slot. */
function travelLines(slots: OpeningFrameSlots): Segment[][] {
  const origin = clipName(slots.locationName ?? 'Home', 20);
  return [
    staticLine('  TRAVEL                    '),
    staticLine(BLANK),
    [plain('  '), coloured(origin, 'player')],
    staticLine('   (=)._                    '),
    staticLine("       '._      ^  ^  ^     "),
    staticLine("          '._  ^ /\\ ^  ^    "),
    staticLine("             '.(  )  ^  ^   "),
    staticLine("       ,^.     '._          "),
    splitOnce("      ( _ )       '._  ???? ", '????', 'chrome'),
    staticLine("      /|_|\\          '-(o)  "),
    staticLine(BLANK),
  ];
}

/** `social` -> DIALOGUE_MODAL (bust opener), fully static: no `npc_archetype` fragment exists yet,
 *  so the bust is the generic placeholder and the NPC's speech lives in the reply. */
function socialLines(): Segment[][] {
  return [
    splitOnce(' .-.~.-.~< @ >~.-.~.-.~.-.  ', '< @ >', 'warmth', 'chrome'),
    staticLine(BLANK),
    colouredLine('           ______           ', 'player'),
    colouredLine('          /      \\          ', 'player'),
    colouredLine('         | o    o |         ', 'player'),
    colouredLine('         |   <    |         ', 'player'),
    colouredLine('          \\  __  /          ', 'player'),
    colouredLine("          |`----'|          ", 'player'),
    colouredLine('         /|      |\\         ', 'player'),
    staticLine(BLANK),
    colouredLine(' .-.~.-.~.-.~.-.~.-.~.-.~.  ', 'chrome'),
  ];
}

/** `skill` -> SCENE (focus placeholder): no skill-specific fragment exists yet. */
function skillLines(): Segment[][] {
  return [
    colouredLine('  SKILL                     ', 'chrome'),
    staticLine(BLANK),
    colouredLine('          ,^.               ', 'player'),
    colouredLine('         ( o )              ', 'player'),
    splitOnce('         /|_|\\   ??         ', '??', 'chrome', 'player'),
    colouredLine('          / \\   (  )        ', 'chrome'),
    colouredLine('      ======[==]======      ', 'chrome'),
    colouredLine('       |            |       ', 'chrome'),
    staticLine(BLANK),
  ];
}

/** `search` -> SCENE (scavenge): no slot data — the clue glyphs and ground strip are always this
 *  static scatter, not per-search content. */
function searchLines(): Segment[][] {
  return [
    colouredLine('  SEARCH                    ', 'chrome'),
    staticLine(BLANK),
    splitRepeated('     ,^.        ?           ', '?', 'warmth'),
    splitRepeated('    ( o )     ?    ?        ', '?', 'warmth'),
    colouredLine('    /|Q|\\', 'player'),
    colouredLine('     / \\     .   ,    .     ', 'chrome'),
    colouredLine('  .,·.,·.,·.,·.,·.,·.,·.,·. ', 'chrome'),
    staticLine(BLANK),
  ];
}

/** `rest` -> REST_STOP (campfire opener): no location fragments exist yet, so the campfire is
 *  always this static vignette. */
function restLines(): Segment[][] {
  return [
    colouredLine('  REST                      ', 'chrome'),
    staticLine(BLANK),
    colouredLine('        z Z                 ', 'status'),
    colouredLine('      z                     ', 'status'),
    splitOnce('     ,^.        ( )         ', '( )', 'warmth', 'player'),
    splitOnce('    ( - )      ( ~ )        ', '( ~ )', 'warmth', 'player'),
    splitOnce('    /|_|\\      ,@@@,        ', ',@@@,', 'warmth', 'player'),
    colouredLine('  ,,,,,,,,,@@@@@@@@@,,,,,,  ', 'chrome'),
    staticLine(BLANK),
  ];
}

/** `other` -> SCENE (minimal placeholder): the catch-all has no bespoke scene. */
function otherLines(): Segment[][] {
  return [
    colouredLine('  . . .                     ', 'chrome'),
    staticLine(BLANK),
    colouredLine('            ,^.             ', 'player'),
    colouredLine('           ( o )            ', 'player'),
    colouredLine('           /|_|\\            ', 'player'),
    colouredLine('             |              ', 'player'),
    colouredLine('           _/ \\_            ', 'player'),
    staticLine(BLANK),
  ];
}

/** The per-type wireframe line sets: each mirrors a filled wireframe example, substituting only the
 *  slots known pre-decision, so deferred fragment art reads as a deliberate placeholder scene. */
function buildLines(type: OpeningActionType, slots: OpeningFrameSlots): Segment[][] {
  switch (type) {
    case 'combat': return combatLines(slots);
    case 'travel': return travelLines(slots);
    case 'social': return socialLines();
    case 'skill': return skillLines();
    case 'search': return searchLines();
    case 'rest': return restLines();
    case 'other': return otherLines();
  }
}

/** Render the OPENING frame for a classified action type: a fenced ```ansi block, top border,
 *  N interior lines, bottom border — the same width invariants as every AnsiRenderer output. */
export function renderOpeningFrame(
  type: OpeningActionType,
  slots: OpeningFrameSlots = {},
  palette: Palette = PALETTES.house,
  style: BorderStyle = BORDERS.standard,
): string {
  const lines = buildLines(type, slots);
  const body = [
    borderTop(style, palette),
    ...lines.map((segments) => composeLine(segments, palette, style.side)),
    borderBottom(style, palette),
  ];
  return '```ansi\n' + body.join('\n') + '\n```';
}
