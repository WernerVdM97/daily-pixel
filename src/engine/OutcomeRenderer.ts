// ── OutcomeRenderer ── pure function, no dependencies
// Formats action outcomes for Discord display per S4 spec.
// Change indicators are derived from outcome.mutations (not caller-provided flags)
// so the caller never has to pre-compute diffs.

import type { ActionOutcome, WorldMutation } from './WorldEngine.js';

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
      // spawn_npc is deliberately ignored — NPCs are narrated in outcome_text
    }
  }

  return d;
}

/** Format a signed delta for display, e.g. " (−2)" or " (+3)". Returns empty string when zero. */
function formatDelta(delta: number): string {
  if (delta === 0) return '';
  const sign = delta > 0 ? '+' : '';
  return ` (${sign}${delta})`;
}

// ── Distilled-action → emoji (for the decision breadcrumb) ──

// Matched by keyword-substring so variants (combat/fight/duel) share an emoji.
// distilled_type is a free-form lowercase word, so unknowns fall back to ✴️.
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

/** Emoji for a distilled action type, for the decision breadcrumb. Unknown → ✴️. */
export function distilledActionEmoji(type: string): string {
  const t = (type ?? '').toLowerCase();
  for (const [keyword, emoji] of DISTILLED_EMOJI) {
    if (t.includes(keyword)) return emoji;
  }
  return '✴️';
}

// ── Outcome label map ──

const OUTCOME_LABELS: Record<string, { icon: string; label: string }> = {
  success:   { icon: '✓', label: 'Success' },
  failure:   { icon: '✗', label: 'Failure' },
  skipped:   { icon: '↩', label: 'Skipped' },
  bailed:    { icon: '↩', label: 'Bailed' },
  done:      { icon: '✓', label: 'Done' },
  timed_out: { icon: '⏰', label: 'Timed out' },
};

// ── Public renderer ──

/**
 * Format an action outcome into a display string.
 *
 * Change detection (items gained/lost, location, stat deltas) is derived
 * from `outcome.mutations` — the caller only provides current post-mutation
 * values so the renderer can print the up-to-date totals.
 */
export function formatOutcome(
  outcome: ActionOutcome,
  ctx: OutcomeRenderContext,
): string {
  const d = deriveFromMutations(outcome.mutations);
  const lines: string[] = [];

  // ── Header — roll vs DC ──
  if (outcome.playerRolled !== null) {
    const meta = OUTCOME_LABELS[outcome.outcome] ?? { icon: '?', label: outcome.outcome };
    // Show the item/stat bonus separately so the math is legible, e.g. `8 + 7 vs 11`.
    const bonus = outcome.rollBonus ?? 0;
    const rollExpr = bonus === 0
      ? `${outcome.playerRolled}`
      : `${outcome.playerRolled} ${bonus > 0 ? '+' : '−'} ${Math.abs(bonus)}`;
    lines.push(`🎲 ${rollExpr} vs ${outcome.finalDc} ${meta.icon} ${meta.label}`);
  } else {
    const meta = OUTCOME_LABELS[outcome.outcome] ?? { icon: '?', label: outcome.outcome };
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
  // Health — only when it changed
  if (d.healthDelta !== 0) {
    stats.push(`❤️ ${ctx.health}/${ctx.maxHealth}${formatDelta(d.healthDelta)}`);
  }
  // Stamina — always
  stats.push(`⚡ ${ctx.stamina}/${ctx.maxStamina}${formatDelta(d.staminaDelta)}`);
  // Rolls — always
  stats.push(`🎲 ${ctx.rollsRemaining}/2${formatDelta(d.rollsDelta)}`);
  // Wealth — only when it changed
  if (d.wealthDelta !== 0) {
    stats.push(`💰 ${ctx.wealth}${formatDelta(d.wealthDelta)}`);
  }

  // Separator between narrative and footer for scan-ability
  lines.push('───');
  if (changes.length > 0) {
    lines.push(changes.join('  '));
  }
  lines.push(stats.join('  ┃  '));

  return lines.join('\n');
}
