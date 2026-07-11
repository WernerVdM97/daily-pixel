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

/** Clip an already-escaped enemy name to `max` chars. `enemyName` is LLM-authored free
 *  text with no length validation upstream — without this, `twoColumnLine`'s gap collapses
 *  to 0 once the name (plus tag) overruns `INTERIOR_WIDTH`, and `composeLine`'s `fitSegments`
 *  truncates from the END, eating into the danger tag and gluing it to the name with no
 *  space (e.g. "...Sentinel[med" instead of "...Sentinel [medium]"). Mirrors
 *  `OpeningFrameRenderer.ts`'s `clipName` — a hard slice, no ellipsis needed for this slot. */
function clipEnemyName(name: string, max: number): string {
  return name.length > max ? name.slice(0, max) : name;
}

/** Clip text at a word boundary with an ellipsis — never truncate mid-word.
 *  Used as a safety net for any display text that enters the card's interior
 *  (belt-and-braces; all current card text is engine-composed and short). */
function clipWord(text: string, max: number): string {
  if (text.length <= max) return text;
  // Find the last space before the cutoff.
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 0) return cut.slice(0, lastSpace) + '…';
  // No space found — single very long word; hard-clip.
  return cut.slice(0, max - 1) + '…';
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

/**
 * Per-round HP-delta line shared by the CONTINUE and TERMINAL cards (POC+ 0.3.2 C2): the band
 * word alone doesn't say who paid what, so this line makes the HP outcome explicit beside it.
 * Left = your delta (life when unhurt at 0, threat when you lost HP — the sign already carries
 * the meaning in monochrome). Right = the enemy's delta, always life-coloured: enemy HP loss is
 * good news for the player in every band, so it never reads as a threat colour.
 */
function hpDeltaLine(playerHpDelta: number, enemyHpDelta: number): Segment[] {
  const youRole: Role = playerHpDelta === 0 ? 'life' : 'threat';
  const youText = playerHpDelta === 0 ? '0' : signed(playerHpDelta);
  const foeText = enemyHpDelta === 0 ? '0' : signed(enemyHpDelta);
  return twoColumnLine(
    [plain('  you '), coloured(youText, youRole)],
    [coloured(`foe ${foeText}`, 'life')],
  );
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
    /** Base DC this round's enemy bonus derived from — carried for the danger-tier
     *  lookup at the call site, not printed as a per-beat threshold (see `dangerTier`). */
    dc: number;
    enemyD20: number;
    enemyBonus: number;
    margin: number;
    band: string;
    /** ACTUAL applied signed player-HP delta this round (clamped/floored to real HP, not
     *  the raw band nominal) — POC+ 0.3.2 C2: surfaced beside the band word so the band, the
     *  HP outcome, and (on the terminal card) the verdict all tell one coherent story instead
     *  of contradicting each other. */
    playerHpDelta: number;
    /** Enemy-HP delta this round applied — always <= 0 (every band damages the enemy). */
    enemyHpDelta: number;
  };
  /** Resolved encounter-danger word (`dangerTier(dc)` from `combat-dc.ts`), passed in
   *  because this renderer must not import the engine (ANSI-C boundary). Labels the foe's
   *  overall danger on the nameplate — never a per-beat threshold. Undefined = no tag shown. */
  dangerTier?: string;
}

function buildContinueLines(input: ContinueCardInput): Segment[][] {
  const bar = '▓'.repeat(input.pips.filled) + '░'.repeat(input.pips.total - input.pips.filled);
  const lines: Segment[][] = [];

  // Enemy nameplate, with an optional encounter-danger tag (this foe's overall danger,
  // never a per-beat threshold — see `ContinueCardInput.dangerTier`'s doc comment).
  if (input.dangerTier) {
    const hardTiers = ['hard', 'risky', 'fatal'];
    const tierRole: Role = hardTiers.includes(input.dangerTier) ? 'threat' : 'warmth';
    const tag = `[${escapeBackticks(input.dangerTier)}]`;
    // Prefix '  ' (2) + name + >=1 space of gap + tag must fit within INTERIOR_WIDTH.
    const maxNameLen = INTERIOR_WIDTH - 2 - tag.length - 1;
    const name = clipEnemyName(escapeBackticks(input.enemyName), maxNameLen);
    lines.push(twoColumnLine(
      [plain(`  ${name}`)],
      [coloured(tag, tierRole)],
    ));
  } else {
    const maxNameLen = INTERIOR_WIDTH - 2;
    const name = clipEnemyName(escapeBackticks(input.enemyName), maxNameLen);
    lines.push([plain(`  ${name}`)]);
  }
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
    const barWidth = Math.max(MIN_BAR, INTERIOR_WIDTH - (label.length + 1 + suffix.length) - 1); // -1 leaves a space inside the right border
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
 * a diced readout (the contested roll — player vs the enemy's total, mirroring the terminal
 * card's vocabulary — plus a band-coloured margin + band word).
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

    const { d20, bonus, enemyD20, enemyBonus, margin, band, playerHpDelta, enemyHpDelta } = input.lastRound;
    const bandRole = bandColor(band);
    const enemyTotal = enemyD20 + enemyBonus;

    // Focal line: left = player d20 (warmth), right = enemy's contested roll (threat).
    // Mirrors the terminal card's focal line exactly (CombatCardRenderer.ts buildTerminalLines,
    // "B#20") — combat is a contested roll against the enemy's hidden total, not a DC pass/fail,
    // so showing the enemy's dice makes the sign of the margin self-evident instead of the
    // misleading solo `[DC N]` this replaces.
    body.push(composeLine(
      twoColumnLine(
        [plain('  '), coloured(String(d20), 'warmth')],
        [coloured(`vs ${enemyD20} ${signed(enemyBonus)} = ${enemyTotal}`, 'threat')],
      ),
      palette,
      style.side,
    ));

    // Calc line: "{+/-bonus} = {total}" left, nothing right. Mirrors the terminal calc line.
    body.push(composeLine(
      twoColumnLine(
        [plain(`  ${signed(bonus)} = ${d20 + bonus}`)],
        [],
      ),
      palette,
      style.side,
    ));

    // Margin+band line (unchanged behaviour): "  hit {+/-margin} margin"  |  "{BAND}"
    const marginRole: Role = margin >= 0 ? 'life' : 'threat';
    body.push(composeLine(
      twoColumnLine(
        [plain('  hit '), coloured(`${signed(margin)} margin`, marginRole)],
        [coloured(band.toUpperCase(), bandRole)],
      ),
      palette,
      style.side,
    ));

    // HP-delta line (POC+ 0.3.2 C2): both combatants' HP outcome beside the band word, so
    // "TRADE" plus "-1/-2" reads as one coherent story instead of leaving the player to infer
    // who paid what from the band name alone. No WIN/LOSS word here — per-round is band-led;
    // an unqualified verdict is reserved for the fight-terminal card only.
    body.push(composeLine(
      hpDeltaLine(playerHpDelta, enemyHpDelta),
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
  enemyD20: number;
  enemyBonus: number;
  marker: string;
  verdict: string;
  margin: number;
  band: string;
  /** ACTUAL applied signed player-HP delta the fight-ending round caused, clamped to real
   *  HP on a lethal blow (POC+ 0.3.2 C2) — see `ContinueCardInput.lastRound.playerHpDelta`'s
   *  doc comment for the rationale. */
  playerHpDelta: number;
  /** Enemy-HP delta the fight-ending round applied — always <= 0. */
  enemyHpDelta: number;
}

function buildTerminalLines(card: CombatTerminalCard): Segment[][] {
  const outcomeRole: Role = card.marker === '+' ? 'life' : 'threat';
  const enemyTotal = card.enemyD20 + card.enemyBonus;

  return [
    [plain(`  ${clipWord(card.label, INTERIOR_WIDTH - 2)}`)],
    [plain(BLANK)],
    // Focal line: left = player d20 (gold), right = enemy's contestant roll (threat).
    // Combat is a contested roll, not a DC pass/fail — showing the enemy's dice makes
    // this visible rather than the misleading solo `[DC N]` (B#20).
    twoColumnLine(
      [plain('  '), coloured(String(card.playerD20), 'warmth')],
      [coloured(`vs ${card.enemyD20} ${signed(card.enemyBonus)} = ${enemyTotal}`, 'threat')],
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
    // Band name — the mechanical truth of the final round, short enough for this line (F#22).
    // Replaces the truncated-prose flavour which was never readable at 26 chars.
    [coloured(`  ${card.band}`, bandColor(card.band))],
    // HP-delta line (POC+ 0.3.2 C2) — same format/colours as the continue card, so the
    // terminal card shows band + both HP deltas + the fight verdict together as one story.
    hpDeltaLine(card.playerHpDelta, card.enemyHpDelta),
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
