// ── OutcomeRenderer ── pure function, no dependencies
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
  /** Player display name for the combat-frame footer nameplate. */
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
        // `remove_item` carries no `emoji` today, so read it defensively: a future addition then
        // renders for free instead of the glyph being silently dropped.
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

/** Structural mirror of `render/CombatCardRenderer.ts`'s `CombatTerminalCard`, kept as a local
 *  shape rather than imported so `src/render/` has no engine-side importer; the caller accepts it structurally. */
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
  /** ASCII-only pass/fail glyph ("+"/"x") — never a ✓/✗ dingbat: mobile fonts cannot be trusted
   *  to carry them, and Discord's own emoji rendering would double-width the column. */
  marker: string;
  verdict: string;
  margin: number;
  /** Combat band name (e.g. GLANCED, TRADE) — the mechanical truth of the final round, short
   *  enough for a single line in the terminal card, where prose never fits. */
  band: string;
  /** Signed player-HP delta the fight-ending round applied, shown beside the band word and the
   *  WON/LOST verdict. */
  playerHpDelta: number;
  /** Enemy-HP delta the fight-ending round applied — always <= 0. */
  enemyHpDelta: number;

}

/**
 * Combat-maths card built from the round log, not the flat `playerRolled`/`finalDc`: the deciding round's
 * maths, not a fight-wide aggregate. Nameplate, HP bar and footer are dropped as the embed duplicates them.
 */
function buildCombatTerminalCard(outcome: ActionOutcome, _ctx: OutcomeRenderContext): CombatTerminalCard | null {
  // `_ctx` is unused today (the card carries no player-stat slot) but kept on the signature for
  // symmetry with the rest of this module's builders, all of which take the render context.
  const beat = outcome.combatRounds?.at(-1) ?? outcome.combatBeat;
  if (!beat) return null;

  const total = beat.playerD20 + beat.playerBonus;
  const success = outcome.outcome === 'success';
  // Past tense: the fight is over on this card, so the verdict reads as a completed fact
  // ("WON"/"LOST"). Set on the fight-terminal beat only, unlike the per-round readout.
  const verdict = success ? 'WON' : outcome.outcome === 'failure' ? 'LOST' : outcome.outcome.toUpperCase();

  // `fatalBlow` distinguishes the two identical-verdict endings (both `success`); a plain
  // win/loss/cap-derive beat never sets it, so those keep the generic label.
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
 * Format an action outcome into a display string. The combat card is rendered by the caller's
 * `renderCombatFrame` — this module never imports `src/render/` — and without one it is simply omitted.
 */
export function formatOutcome(
  outcome: ActionOutcome,
  ctx: OutcomeRenderContext,
  renderCombatFrame?: (card: CombatTerminalCard) => string,
): string {
  const d = deriveFromMutations(outcome.mutations);
  const lines: string[] = [];

  // ── Header — roll vs DC, OR (combat outcomes) the combat-maths data card ──
  // The card goes first, ahead of everything else, so it survives description-length clipping.
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
  // otherwise infer one per resolved roll, plus any `modify_rolls_remaining`.
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
  // A positive roll grant is invisible in the 🎲 counter when it nets to zero against the action cost,
  // so surface it. Gates on the grant alone, independent of `rollRefunded` — refund and grant are separate facts.
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
  // Rolls — no fixed denominator, because the daily allowance varies. A no-op refund shows
  // "(refunded)" or the unchanged count reads as a bug; that suffix is for a net-zero refund only.
  const rollsSuffix = outcome.rollRefunded && rollsDelta === 0 ? ' (refunded)' : formatDelta(rollsDelta);
  stats.push(`🎲 ${ctx.rollsRemaining}${rollsSuffix}`);
  // Wealth — only when changed
  if (d.wealthDelta !== 0) {
    stats.push(`💰 ${ctx.wealth}${formatDelta(d.wealthDelta)}`);
  }

  if (changes.length > 0) {
    lines.push(changes.join('  '));
  }
  lines.push('`' + stats.join('  ┃  ') + '`');

  return lines.join('\n');
}
