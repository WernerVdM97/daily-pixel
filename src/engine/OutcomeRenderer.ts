// ── OutcomeRenderer ── pure function, no dependencies
// Formats action outcomes for Discord display per S4 spec.
// Change indicators are derived from outcome.mutations, so the caller never pre-computes diffs.

import type { ActionOutcome, WorldMutation } from './WorldEngine.js';
import { STAT_LABELS } from './stat-format.js';

// ── Public context — only current (post-mutation) values ──

export interface OutcomeRenderContext {
  stamina: number;
  maxStamina: number;
  rollsRemaining: number;
  health: number;
  maxHealth: number;
  wealth: number;
  /** Player display name for the combat-frame footer nameplate (T2b). */
  name: string;
}

// ── Internal: derived from mutations ──

interface MutationDeltas {
  healthDelta: number;
  staminaDelta: number;
  maxStaminaDelta: number;
  wealthDelta: number;
  rollsDelta: number;
  itemsGained: Array<{ emoji: string; name: string }>;
  itemsLost: Array<{ emoji?: string; name: string; quantity?: number }>;
  newLocation: string | null;
}

/** Aggregate all mutations into deltas and side-effect lists. */
function deriveFromMutations(mutations: WorldMutation[]): MutationDeltas {
  const d: MutationDeltas = {
    healthDelta: 0,
    staminaDelta: 0,
    maxStaminaDelta: 0,
    wealthDelta: 0,
    rollsDelta: 0,
    itemsGained: [],
    itemsLost: [],
    newLocation: null,
  };

  for (const m of mutations) {
    switch (m.type) {
      case 'modify_health':
        d.healthDelta += Number(m.amount ?? 0);
        break;
      case 'modify_stamina':
        d.staminaDelta += Number(m.amount ?? 0);
        break;
      case 'modify_max_stamina':
        d.maxStaminaDelta += Number(m.amount ?? 0);
        break;
      case 'modify_wealth':
        d.wealthDelta += Number(m.amount ?? 0);
        break;
      case 'modify_rolls_remaining':
        d.rollsDelta += Number(m.amount ?? 0);
        break;
      case 'add_item':
        d.itemsGained.push({
          emoji: String(m.emoji ?? ''),
          name: String(m.name ?? ''),
        });
        break;
      case 'remove_item': {
        // `remove_item` carries no `emoji` today (prompt/mutation apply omit it — see
        // mutations.ts ~479-484); read it defensively so a future addition renders for free
        // instead of silently dropping the glyph.
        const quantity = Number(m.quantity ?? 1);
        d.itemsLost.push({
          ...(typeof m.emoji === 'string' && m.emoji ? { emoji: m.emoji } : {}),
          name: String(m.name ?? ''),
          ...(quantity > 1 ? { quantity } : {}),
        });
        break;
      }
      case 'set_location':
      case 'cross_frontier':
        d.newLocation = String(m.name ?? '');
        break;
      // spawn_npc ignored — NPCs are narrated in outcome_text
    }
  }

  return d;
}

/** Format a signed delta, e.g. " (+3)"; empty string when zero. */
function formatDelta(delta: number): string {
  if (delta === 0) return '';
  const sign = delta > 0 ? '+' : '';
  return ` (${sign}${delta})`;
}

// ── Distilled-action → emoji (for the decision breadcrumb) ──

// Keyword-substring match so variants (combat/fight/duel) share an emoji.
// distilled_type is free-form lowercase; unknowns fall back to ✴️.
const DISTILLED_EMOJI: Array<[string, string]> = [
  ['combat', '⚔️'], ['fight', '⚔️'], ['duel', '⚔️'], ['attack', '⚔️'], ['ambush', '⚔️'],
  ['hunt', '🏹'], ['shoot', '🏹'],
  ['travel', '🥾'], ['journey', '🥾'],
  ['explore', '🧭'], ['scout', '🧭'],
  ['talk', '🗣️'], ['negotiate', '🗣️'], ['persuade', '🗣️'], ['social', '🗣️'], ['counsel', '🗣️'],
  ['trade', '🤝'], ['barter', '🤝'], ['buy', '🤝'], ['sell', '🤝'],
  ['investigate', '🔍'], ['search', '🔍'], ['inspect', '🔍'], ['study', '🔍'],
  ['flee', '🏃'], ['retreat', '🏃'], ['escape', '🏃'],
  ['rest', '😴'], ['sleep', '😴'], ['camp', '🏕️'],
  ['craft', '🔨'], ['forge', '🔨'], ['build', '🔨'], ['repair', '🔨'], ['mend', '🔨'],
  ['heal', '✨'], ['pray', '🙏'], ['bless', '🙏'],
  ['steal', '🗝️'], ['sneak', '🥷'], ['gather', '🌿'], ['fish', '🎣'],
];

/** Emoji for a distilled action type (decision breadcrumb). Unknown → ✴️. */
export function distilledActionEmoji(type: string): string {
  const t = (type ?? '').toLowerCase();
  for (const [keyword, emoji] of DISTILLED_EMOJI) {
    if (t.includes(keyword)) return emoji;
  }
  return '✴️';
}

// ── Outcome label map ──

const OUTCOME_LABELS: Record<string, { icon: string; label: string }> = {
  success:   { icon: '✅', label: 'SUCCESS' },
  failure:   { icon: '❌', label: 'FAILURE' },
  skipped:   { icon: '⏭️', label: 'SKIPPED' },
  bailed:    { icon: '🚪', label: 'BAILED' },
  done:      { icon: '✅', label: 'DONE' },
  timed_out: { icon: '⏰', label: 'TIMED OUT' },
};

/** Structural mirror of `render/CombatCardRenderer.ts`'s `CombatTerminalCard` — kept as a local
 *  shape rather than importing the type so `src/render/` has no engine-side importer (ANSI-C);
 *  the presentation-side caller's `renderCombatFrame` still accepts this structurally. */
export interface CombatTerminalCard {
  label: string;
  /** Focal roll — the fight's deciding d20, raw (unsigned). */
  playerD20: number;
  /** Signed at render, not here — kept as the raw ability bonus so the card composer decides the
   *  "+"/"−" glyph the same way every other segment in the render layer does. */
  bonus: number;
  total: number;
  /** Enemy's raw d20 this round — surfaced so the terminal card can show it as a contestant
   *  roll instead of the misleading solo `[DC N]` (combat is contested, not a DC check). */
  enemyD20: number;
  /** Enemy's total ability bonus applied to `enemyD20` this round. */
  enemyBonus: number;
  /** ASCII-only pass/fail glyph ("+"/"x") — never a ✓/✗ dingbat (ansi-frames skill §1: mobile
   *  fonts can't be trusted to carry them, and Discord's own emoji rendering would double-width
   *  the column). */
  marker: string;
  verdict: string;
  margin: number;
  /** Combat band name (e.g. GLANCED, TRADE) — the mechanical truth of the final round, short
   *  enough for a single line in the terminal card. Replaces the truncated-prose flavour line
   *  (F#22: prose never fits there). */
  band: string;
  /** Signed player-HP delta the fight-ending round applied (POC+ 0.3.2 C2) — surfaced beside
   *  the band word and the WON/LOST verdict so all three facts read as one coherent story. */
  playerHpDelta: number;
  /** Enemy-HP delta the fight-ending round applied — always <= 0. */
  enemyHpDelta: number;

}

/**
 * Combat-maths reveal (ANSI-D): the fight-over data card replacing the old two-line message-box
 * roll header. Sourced from the ROUND LOG in preference to the flat `outcome.playerRolled`/
 * `rollBonus`/`finalDc` fields — `combatRounds`' terminal entry carries the same numbers the
 * round's own band was picked from, so a multi-round fight's last-round maths (not some
 * fight-wide aggregate) is what the player sees, matching what actually decided the last blow.
 * Falls back to `outcome.combatBeat` for a fight predating the round-log accumulation (still the
 * terminal beat, just not list-shaped). Deliberately drops the enemy nameplate/HP bar and the
 * player footer the old spec carried — those duplicate the embed's own stats footer just below
 * this card (see `formatOutcome`'s trailing `❤️ ⚡ 🎲 💰` line), which is the whole point of the
 * data-card register (skill §2): the cheapest, most legible form for a fact already decided.
 */
function buildCombatTerminalCard(outcome: ActionOutcome, _ctx: OutcomeRenderContext): CombatTerminalCard | null {
  // `_ctx` is unused today (the card carries no player-stat slot) but kept on the signature for
  // symmetry with the rest of this module's builders, all of which take the render context.
  const beat = outcome.combatRounds?.at(-1) ?? outcome.combatBeat;
  if (!beat) return null;

  const total = beat.playerD20 + beat.playerBonus;
  const success = outcome.outcome === 'success';
  // Past tense (POC+ 0.3.2 C2): the fight is over on this card, so the verdict reads as a
  // completed fact ("WON"/"LOST"), not a live in-round call — reserved for the fight-terminal
  // beat only, distinct from the per-round band-led readout on the continue card.
  const verdict = success ? 'WON' : outcome.outcome === 'failure' ? 'LOST' : outcome.outcome.toUpperCase();

  // SL-6: the fatal-blow interstitial's terminal beat carries `fatalBlow` so the two
  // identical-verdict endings (both `outcome === 'success'`) read differently — a plain
  // win/loss/cap-derive beat never sets it, so those keep the generic label unchanged.
  const label =
    beat.fatalBlow === 'finish' ? 'FOE SLAIN'
    : beat.fatalBlow === 'spare' ? 'FOE SPARED'
    : 'COMBAT RESOLVED';

  return {
    label,
    playerD20: beat.playerD20,
    bonus: beat.playerBonus,
    total,
    enemyD20: beat.enemyD20,
    enemyBonus: beat.enemyBonus,
    marker: success ? '+' : 'x',
    verdict,
    margin: beat.margin,
    band: beat.band.toUpperCase(),
    playerHpDelta: beat.playerHpDelta,
    enemyHpDelta: beat.enemyHpAfter - beat.enemyHpBefore,
  };
}

// ── Public renderer ──

/**
 * Format an action outcome into a display string.
 * Change detection (items, location, stat deltas) is derived from `outcome.mutations`;
 * the caller supplies only current post-mutation values for the printed totals.
 *
 * `renderCombatFrame` is the presentation-side card render call (ANSI-D) — this module only
 * assembles the card's structured data (`buildCombatTerminalCard`) and never imports
 * `src/render/` itself. Omitted (e.g. a caller that never renders combat), a combat outcome
 * simply carries no card line rather than throwing.
 */
export function formatOutcome(
  outcome: ActionOutcome,
  ctx: OutcomeRenderContext,
  renderCombatFrame?: (card: CombatTerminalCard) => string,
): string {
  const d = deriveFromMutations(outcome.mutations);
  const lines: string[] = [];

  // ── Header — roll vs DC, OR (combat outcomes) the combat-maths data card ──
  // Combat replaces the text header with a card at the very top of the string (ahead of
  // everything else) so it survives description-length clipping in buildOutcomeEmbed.
  if (outcome.combatBeat) {
    const card = buildCombatTerminalCard(outcome, ctx);
    if (card && renderCombatFrame) lines.push(renderCombatFrame(card));
  } else if (outcome.playerRolled !== null) {
    const meta = OUTCOME_LABELS[outcome.outcome] ?? { icon: '❓', label: outcome.outcome.toUpperCase() };
    const bonus = outcome.rollBonus ?? 0;
    const total = outcome.playerRolled + bonus;

    const statEmoji = outcome.rollStat
      ? (STAT_LABELS[outcome.rollStat]?.emoji ?? '🎲') + ' '
      : '';

    // Roll expression, e.g. 20 + 7 = 27
    const isCrit = outcome.playerRolled === 20 || outcome.playerRolled === 1;
    let rollExpr: string;
    if (bonus === 0) {
      rollExpr = `${outcome.playerRolled}`;
    } else {
      const sign = bonus > 0 ? '+' : '−';
      // Don't bold the total when crit bold will already wrap it
      const totalExpr = isCrit ? `${total}` : `**${total}**`;
      rollExpr = `${outcome.playerRolled} ${sign} ${Math.abs(bonus)} = ${totalExpr}`;
    }

    // Critical highlight prefix
    const prefix = outcome.playerRolled === 20
      ? '🌟'
      : outcome.playerRolled === 1
        ? '💥'
        : '';
    const rollPart = isCrit ? `**${rollExpr}**` : rollExpr;
    const critPrefix = prefix ? `${prefix} ` : '';

    lines.push(`${critPrefix}${statEmoji}🎲 ${rollPart}  vs  ${outcome.finalDc}  →  ${meta.icon} **${meta.label}**`);
  } else {
    const meta = OUTCOME_LABELS[outcome.outcome] ?? { icon: '❓', label: outcome.outcome.toUpperCase() };
    lines.push(`${meta.icon} ${meta.label}`);
  }

  lines.push('');

  // ── Body — outcome text from LLM ──
  lines.push(outcome.outcomeText);

  lines.push('');

  // ── Roll accounting — computed early so the changes section can reference it ──
  // Prefer the engine's reported delta (set for auto-finish no-ops the renderer can't infer);
  // otherwise infer: a resolved roll debits one plus any modify_rolls_remaining mutation.
  const rollsSpent = outcome.playerRolled !== null ? -1 : 0;
  const rollsDelta = outcome.rollsDelta ?? d.rollsDelta + rollsSpent;

  // ── Changes line — items gained/lost and location ──
  const changes: string[] = [];
  for (const item of d.itemsGained) {
    changes.push(`+ ${item.emoji} ${item.name}`);
  }
  for (const item of d.itemsLost) {
    // U+2212 minus (not ASCII "- ") — a leading "- " is Discord's unordered-list marker,
    // which turns a loss-only line into a bullet instead of reading as a subtraction.
    const emojiPart = item.emoji ? `${item.emoji} ` : '';
    const qtyPart = item.quantity && item.quantity > 1 ? ` ×${item.quantity}` : '';
    changes.push(`− ${emojiPart}${item.name}${qtyPart}`);
  }
  if (d.newLocation) {
    changes.push(`→ ${d.newLocation}`);
  }
  // A positive roll grant that nets to zero against the action cost is invisible in the 🎲
  // counter — surface it explicitly so the player knows they were rewarded (feedback #13).
  // This must fire independently of `rollRefunded`: a refund and a grant are separate facts
  // (the footer's "(refunded)" suffix below has its own `rollRefunded` gate), so an
  // auto-resolved action whose roll was refunded must still show the grant it also carried
  // (B#3 follow-up — the reported "auto-resolved rest showed refunded but no inspiration text").
  // RA-2: a net-positive grant (any auto-resolved or refunded action that also granted) is the
  // SAME fact and was previously invisible too — it showed only as a bare `+N` beside the 🎲
  // counter, which does not read as a reward. Gate on the grant alone (`d.rollsDelta > 0`), not
  // on how it nets, so the line always names the reward regardless of what else happened to the
  // roll count this action.
  if (d.rollsDelta > 0) {
    const rollWord = d.rollsDelta === 1 ? 'roll' : 'rolls';
    changes.push(`✨ Inspired: +${d.rollsDelta} ${rollWord}`);
  }

  // ── Stat footer — standardised emoji glyphs ──
  const stats: string[] = [];
  // Health — only when changed
  if (d.healthDelta !== 0) {
    stats.push(`❤️ ${ctx.health}/${ctx.maxHealth}${formatDelta(d.healthDelta)}`);
  }
  // Stamina — always. A max_stamina change gets a labelled "(max +N)" suffix so it can never
  // be confused with the plain current-stamina delta when both fire on the same outcome.
  const maxStaminaSuffix = d.maxStaminaDelta !== 0
    ? ` (max ${d.maxStaminaDelta > 0 ? '+' : ''}${d.maxStaminaDelta})`
    : '';
  stats.push(`⚡ ${ctx.stamina}/${ctx.maxStamina}${formatDelta(d.staminaDelta)}${maxStaminaSuffix}`);
  // Rolls — no fixed denominator (daily allowance varies: 3, Saturday 4), so the old
  // `/2` printed an over-full fraction. A no-op refund shows "(refunded)" — without it,
  // the unchanged count reads as a bug (see player report).
  // "(refunded)" only for a genuine net-zero refund; if a mutation also moved rolls, show the
  // real delta instead so a grant/loss isn't mislabelled as a refund.
  const rollsSuffix = outcome.rollRefunded && rollsDelta === 0 ? ' (refunded)' : formatDelta(rollsDelta);
  stats.push(`🎲 ${ctx.rollsRemaining}${rollsSuffix}`);
  // Wealth — only when changed
  if (d.wealthDelta !== 0) {
    stats.push(`💰 ${ctx.wealth}${formatDelta(d.wealthDelta)}`);
  }

  if (changes.length > 0) {
    lines.push(changes.join('  '));
  }
  // Stats footer in monospace — clean break without a manual separator
  lines.push('`' + stats.join('  ┃  ') + '`');

  return lines.join('\n');
}
