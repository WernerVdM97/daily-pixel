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
}

// ── Internal: derived from mutations ──

interface MutationDeltas {
  healthDelta: number;
  staminaDelta: number;
  wealthDelta: number;
  rollsDelta: number;
  itemsGained: Array<{ emoji: string; name: string }>;
  itemsLost: string[];
  newLocation: string | null;
}

/** Aggregate all mutations into deltas and side-effect lists. */
function deriveFromMutations(mutations: WorldMutation[]): MutationDeltas {
  const d: MutationDeltas = {
    healthDelta: 0,
    staminaDelta: 0,
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
      case 'remove_item':
        d.itemsLost.push(String(m.name ?? ''));
        break;
      case 'set_location':
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

// ── Public renderer ──

/**
 * Format an action outcome into a display string.
 * Change detection (items, location, stat deltas) is derived from `outcome.mutations`;
 * the caller supplies only current post-mutation values for the printed totals.
 */
export function formatOutcome(
  outcome: ActionOutcome,
  ctx: OutcomeRenderContext,
): string {
  const d = deriveFromMutations(outcome.mutations);
  const lines: string[] = [];

  // ── Header — roll vs DC ──
  if (outcome.playerRolled !== null) {
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

  // ── Changes line — items gained/lost and location ──
  const changes: string[] = [];
  for (const item of d.itemsGained) {
    changes.push(`+ ${item.emoji} ${item.name}`);
  }
  for (const name of d.itemsLost) {
    changes.push(`- ${name}`);
  }
  if (d.newLocation) {
    changes.push(`→ ${d.newLocation}`);
  }

  // ── Stat footer — standardised emoji glyphs ──
  const stats: string[] = [];
  // Health — only when changed
  if (d.healthDelta !== 0) {
    stats.push(`❤️ ${ctx.health}/${ctx.maxHealth}${formatDelta(d.healthDelta)}`);
  }
  // Stamina — always
  stats.push(`⚡ ${ctx.stamina}/${ctx.maxStamina}${formatDelta(d.staminaDelta)}`);
  // Rolls — no fixed denominator (daily allowance varies: 3, Saturday 4), so the old
  // `/2` printed an over-full fraction. Starting an action debits one roll via an engine
  // decrement (not a mutation), so a resolved roll shows (−1) plus any modify_rolls_remaining.
  const rollsSpent = outcome.playerRolled !== null ? -1 : 0;
  stats.push(`🎲 ${ctx.rollsRemaining}${formatDelta(d.rollsDelta + rollsSpent)}`);
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
