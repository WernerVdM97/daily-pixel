// Presentation-side composers for the two combat-card registers: CONTINUE (between decisions, keeps
// HP bars) and TERMINAL (fight-over reveal, drops them). AnsiRenderer primitives mirroring `assets/ansi/wireframes/`, no engine imports.

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

/** Clip an already-escaped, unvalidated LLM enemy name to `max`: once name + tag overrun
 *  INTERIOR_WIDTH the gap collapses and fitSegments glues the tag to the name ("...Sentinel[med"). */
function clipEnemyName(name: string, max: number): string {
  return name.length > max ? name.slice(0, max) : name;
}

/** Clip text at a word boundary with an ellipsis, never mid-word — belt-and-braces; all current
 *  card text is engine-composed and short. */
function clipWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 0) return cut.slice(0, lastSpace) + '…';
  return cut.slice(0, max - 1) + '…';
}

/** Compose a two-column line: left hugs the left edge, right the right, the gap computed so the
 *  right column keeps one space inside the border (the `-1` undershoots INTERIOR_WIDTH). */
function twoColumnLine(left: Segment[], right: Segment[]): Segment[] {
  const leftLen = left.reduce((n, s) => n + s.text.length, 0);
  const rightLen = right.reduce((n, s) => n + s.text.length, 0);
  const gap = Math.max(0, INTERIOR_WIDTH - leftLen - rightLen - 1);
  return [...left, { text: ' '.repeat(gap) }, ...right];
}

/** HP-delta line shared by both cards: your delta on the left (life at 0, else threat — the sign
 *  carries the meaning in monochrome), the enemy's on the right, always life: foe HP loss is good news in every band. */
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

/** Map a combat band to its colour role — the band word and the `+`/`−` sign keep the meaning
 *  when colour is stripped (mobile). */
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
    /** ACTUAL applied signed player-HP delta this round (clamped to real HP, not the raw band
     *  nominal) — shown beside the band word so the two can't contradict each other. */
    playerHpDelta: number;
    /** Enemy-HP delta this round applied — always <= 0 (every band damages the enemy). */
    enemyHpDelta: number;
  };
  /** Resolved encounter-danger word, passed in because this renderer must not import the engine:
   *  the foe's overall danger on the nameplate, not a per-beat threshold. Undefined = no tag. */
  dangerTier?: string;
}

function buildContinueLines(input: ContinueCardInput): Segment[][] {
  const bar = '▓'.repeat(input.pips.filled) + '░'.repeat(input.pips.total - input.pips.filled);
  const lines: Segment[][] = [];

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
  {
    const label = '  HP [';
    const suffix = input.woundWord ? ` ${escapeBackticks(input.woundWord)}` : '';
    lines.push([{ text: label }, coloured(bar, 'threat'), { text: ']' }, { text: suffix }]);
  }

  lines.push([plain('  YOU')]);

  {
    const label = '  HP [';
    const clampedMax = Math.max(input.playerMaxHp, 0);
    const clampedHp = Math.min(Math.max(input.playerHp, 0), clampedMax);
    const fraction = clampedMax > 0 ? clampedHp / clampedMax : 0;
    const fillRole: Role = fraction < 0.4 ? 'threat' : 'life';
    // Same INTERIOR_WIDTH budget maths as AnsiRenderer's hpLineSegments.
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

/** Render the combat CONTINUE card: HP bars plus, once a round has been fought, the contested
 *  roll, the band and the HP deltas. `style` comes from the caller's escalation rules. */
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

    // Focal line: player d20 (warmth) vs the enemy's contested total (threat). Combat is a
    // contested roll, not a DC pass/fail, so showing both makes the margin's sign self-evident.
    body.push(composeLine(
      twoColumnLine(
        [plain('  '), coloured(String(d20), 'warmth')],
        [coloured(`vs ${enemyD20} ${signed(enemyBonus)} = ${enemyTotal}`, 'threat')],
      ),
      palette,
      style.side,
    ));

    body.push(composeLine(
      twoColumnLine(
        [plain(`  ${signed(bonus)} = ${d20 + bonus}`)],
        [],
      ),
      palette,
      style.side,
    ));

    const marginRole: Role = margin >= 0 ? 'life' : 'threat';
    body.push(composeLine(
      twoColumnLine(
        [plain('  hit '), coloured(`${signed(margin)} margin`, marginRole)],
        [coloured(band.toUpperCase(), bandRole)],
      ),
      palette,
      style.side,
    ));

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

/** Mirror of `engine/OutcomeRenderer.ts`'s `CombatTerminalCard`, kept local rather than importing
 *  the engine's type. */
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
  /** ACTUAL applied signed player-HP delta from the fight-ending round, clamped to real HP on a
   *  lethal blow; see `ContinueCardInput.lastRound.playerHpDelta`. */
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
    twoColumnLine(
      [plain('  '), coloured(String(card.playerD20), 'warmth')],
      [coloured(`vs ${card.enemyD20} ${signed(card.enemyBonus)} = ${enemyTotal}`, 'threat')],
    ),
    twoColumnLine(
      [plain(`  ${signed(card.bonus)} = ${card.total}`)],
      [],
    ),
    twoColumnLine(
      [plain('  '), coloured(`${card.marker} ${card.verdict}`, outcomeRole)],
      [plain(`margin ${signed(card.margin)}`)],
    ),
    // The final round's band name — the mechanical truth, short enough to fit this line.
    [coloured(`  ${card.band}`, bandColor(card.band))],
    hpDeltaLine(card.playerHpDelta, card.enemyHpDelta),
  ];
}

/** Render the combat TERMINAL card: a fenced ```ansi block with no nameplate, HP bar or sprite —
 *  a typographic reveal of the deciding roll. `style` is the caller's border register. */
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
