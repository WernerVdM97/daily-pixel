// Presentation-side composer for the OPENING register family (ANSI-F; classification framework
// §2c "the opening frame" / §3.0 "OPENING — pre-decision scene-setter family"): the scene-setter
// frame shown once per action, right after `classify` resolves and before the first decision.
// One register per classified action type — never touches the engine or the LLM, mirroring
// AnsiRenderer.ts's own presentation-only boundary (ANSI-C).
//
// The seven wireframes in `assets/ansi/wireframes/opening-*.ascii` are the mandatory inspiration
// input (ansi-frames skill §5.0) — every line below mirrors a wireframe's filled example,
// substituting only the handful of slots genuinely known pre-decision (see each builder's
// comment for exactly which). Everything else is the wireframe's own placeholder art: the
// `fragments` catalogue (framework §9) stays deferred, so any slot that would otherwise be a
// DB-backed fragment lookup (enemy sprite, NPC bust, campfire, task rig) renders as the generic
// placeholder scene instead — "placeholder scenes... must read as deliberate, not broken"
// (poc-plus-0.3.1-polish-plan.md "ANSI-F").
//
// No numeric "level" exists on a `CharacterData` (stats-based, not level-based) — the wireframes'
// illustrative "Lv N" suffixes are therefore never reproduced here; nameplates show name (and,
// for `combat`, HP) only.

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
  /** Player character's display name. Drawn in the `combat` footer nameplate only — every other
   *  type's PC art is a fixed placeholder glyph (no `pc_class` fragments yet), so this slot is
   *  otherwise unused inside the frame body. */
  pcName?: string;
  /** Player's current/max HP, for the `combat` footer HP bar — real data (unlike the enemy
   *  header; see `enemyName`), since the caller always has the acting character's HP on hand.
   *  Omit either to render an honest "unknown" bar instead of fabricating a fraction. */
  pcHp?: number;
  pcMaxHp?: number;
  /** `travel` only: the origin location's display name (`character.location`). The destination
   *  is always the wireframe's literal "????" — travel's own binding calls it a "rumoured
   *  destination", i.e. deliberately unknown at this pre-decision moment, never a real slot. */
  locationName?: string;
  /** Accepted for API completeness (a future embed title may want it) but NEVER drawn inside the
   *  monochrome frame body: emoji render double-width in Discord and would push a column's
   *  border out of line (ansi-frames skill §1, "single-width glyphs only"). */
  locationEmoji?: string;
  /** One-line scene hint (e.g. a clipped `rawInput`). None of the seven wireframes carry a
   *  free-text line inside the frame body — the fitting home for this is the REPLY posted
   *  beneath the frame (§2b), not the frame itself. Kept on this type only for symmetry with the
   *  composer's stated slot contract; the frame ignores it. */
  sceneHint?: string;
  /** `combat` only: the foe's name, when already signalled (e.g. a future `combatEnemy` hint
   *  surfaced from DECIDE). Undefined renders an honest "unknown foe" placeholder with an
   *  unfilled HP bar — the enemy isn't established in the `in_combat` scene edge until the
   *  player's first choice (`PipelineActionStateMachine.handleCombatStep`), so a real name/HP
   *  genuinely isn't knowable yet at this pre-decision moment. */
  enemyName?: string;
}

// Matches the wireframes' own bar width (opening-combat.ascii) — the enemy bar is always the
// "unknown foe" placeholder (never real HP, see enemyName's doc comment above), so unlike
// AnsiRenderer's combat-continue frame this bar width stays fixed, not adaptive.
const ENEMY_BAR_WIDTH = 14;
// Placeholder-branch width only (no real HP, fixed "?/?" suffix, never overflows). The real-HP
// branch in combatLines sizes its bar adaptively instead — same reason AnsiRenderer's
// hpLineSegments does: a fixed width would let fitSegments truncate a wide "{hp}/{maxHp}" suffix
// from the end of the line, silently eating a digit off the HP number itself.
const PC_BAR_WIDTH = 6;
// Floor for the adaptively-sized real-HP bar (mirrors AnsiRenderer's MIN_HP_BAR_WIDTH) so a very
// long "hp/maxHp" suffix can still shrink the bar without erasing it.
const MIN_PC_BAR_WIDTH = 3;
// Mirrors AnsiRenderer's own LOW_HP_THRESHOLD (fraction below which a filled bar reads as threat
// rather than life) — duplicated locally since that constant isn't exported; both frames rely on
// the same "under ~40%" design-doc convention that shouldn't need re-litigating here.
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

/**
 * Split a static wireframe line around ONE occurrence of `marker`, colouring the marker
 * `markerRole` and the rest (before + after) `restRole` (undefined = plain). Covers the handful
 * of wireframe lines that mix one semantically distinct run — travel's "????" rumoured
 * destination, social's "< @ >" crest, rest's campfire glyphs, skill's "??" rig marker — into an
 * otherwise single-role line, without hand-counting column offsets into a 28-char art string.
 */
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

/** Clip a free-text slot value to a safe max length before splicing it into a fixed-width line.
 *  `composeLine`'s `fitSegments` truncates an overflowing LINE from its trailing segments —
 *  useful for whole-line overflow, but wrong here: an unclipped long name would eat into the
 *  line's own trailing padding/art rather than just the name itself. */
function clipName(value: string, max: number): string {
  const safe = escapeBackticks(value);
  return safe.length > max ? safe.slice(0, max) : safe;
}

/**
 * `combat` -> COMBAT_FRAME (opener variant). Header (enemy) is always a placeholder — see
 * `enemyName`'s doc comment for why real enemy HP genuinely isn't knowable pre-decision. Footer
 * (player) uses real data when the caller supplies it.
 */
function combatLines(slots: OpeningFrameSlots): Segment[][] {
  const enemyName = slots.enemyName ? clipName(slots.enemyName, 20) : 'Unknown foe';
  const enemyBar = hpBar(0, 0, ENEMY_BAR_WIDTH); // maxHp<=0 -> all-empty "unknown" bar (honest, not broken)

  const pcName = clipName(slots.pcName ?? 'Warden', 14);
  const hasPcHp = slots.pcHp !== undefined && slots.pcMaxHp !== undefined;

  // Clamp before display so the printed number always agrees with hpBar's own internal clamp
  // (mirrors AnsiRenderer.hpLineSegments's guard) — otherwise e.g. pcHp: -5 would print "-5/30"
  // next to a bar that (correctly) renders empty.
  const clampedMax = hasPcHp ? Math.max(slots.pcMaxHp!, 0) : 0;
  const clampedHp = hasPcHp ? Math.min(Math.max(slots.pcHp!, 0), clampedMax) : 0;
  const pcSuffix = hasPcHp ? ` ${Math.round(clampedHp)}/${Math.round(clampedMax)}` : ' ?/?';

  // Size the real-HP bar from the fixed prefix ('  /|_|\   HP [') + trailing ']' + the actual
  // suffix length, so the line lands at exactly INTERIOR_WIDTH before fitSegments ever has to
  // truncate — see PC_BAR_WIDTH's comment for why a fixed width silently ate a digit off 3-digit
  // HP. The no-HP placeholder branch keeps the short fixed PC_BAR_WIDTH (its suffix never grows).
  const pcBarPrefixLen = '  /|_|\\   HP ['.length;
  const pcBarWidth = hasPcHp
    ? Math.max(MIN_PC_BAR_WIDTH, INTERIOR_WIDTH - pcBarPrefixLen - 1 - pcSuffix.length)
    : PC_BAR_WIDTH;
  const pcBar = hasPcHp ? hpBar(clampedHp, clampedMax, pcBarWidth) : hpBar(0, 0, PC_BAR_WIDTH);
  const pcFraction = hasPcHp && clampedMax > 0 ? clampedHp / clampedMax : 1;
  const pcBarRole: Role = hasPcHp ? (pcFraction < LOW_HP_THRESHOLD ? 'threat' : 'life') : 'chrome';

  return [
    [plain('  '), coloured(enemyName, 'threat')],
    [plain('  HP ['), coloured(enemyBar, 'chrome'), plain('] ?/?')],
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

/** `travel` -> SCENE (route strip). Destination is always the literal "????" (rumoured/unknown
 *  by design, not a slot — see `locationName`'s doc comment on `OpeningFrameSlots`). */
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

/** `social` -> DIALOGUE_MODAL (bust opener). Fully static/mute — the NPC's actual speech lives
 *  in the reply (§2b); no `npc_archetype` fragment exists yet, so the bust is always this
 *  generic placeholder, never keyed to any particular NPC. */
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

/** `skill` -> SCENE (focus placeholder). No skill-specific fragment exists yet — pc pose + task
 *  rig are always this placeholder (framework §3.0: "placeholder until a skill-specific frag
 *  exists"). */
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

/** `search` -> SCENE (scavenge). No slot data — the clue glyphs/ground strip are always this
 *  static scatter (engine-static per the wireframe's own binding, not per-search content). */
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

/** `rest` -> REST_STOP (campfire opener). No `fragments` location lookup exists yet — the
 *  campfire is always this static vignette (framework §3.0 binding). */
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

/** `other` -> SCENE (minimal placeholder). The catch-all type has no bespoke scene at all —
 *  always the bare placeholder PC, per the wireframe. */
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

/**
 * Render the OPENING frame for a classified action type: a fenced ```ansi block, one register
 * per type (see the module doc comment / classification framework §3.0's OPENING table). Always
 * the same shape as every other AnsiRenderer output — top border, N interior lines, bottom
 * border — so it shares the exact width/budget invariants (`composeLine`/`fitSegments`) the rest
 * of the renderer is tested against, rather than re-deriving them.
 *
 * `style` controls the border register — always `standard` for opening frames (the ladder's
 * heavy/crit tiers are reserved for combat-intensity signalling).
 */
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
