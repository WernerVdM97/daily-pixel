// ── OutcomeRenderer ── pure function, no dependencies
// Formats action outcomes for Discord display per S4 spec.

import type { ActionOutcome } from './WorldEngine.js';

export interface OutcomeRenderContext {
  stamina: number;
  rollsRemaining: number;
  health: number;
  maxHealth: number;
  wealth: number;
  /** Only true when health actually changed. */
  healthChanged?: boolean;
  /** Only true when wealth actually changed. */
  wealthChanged?: boolean;
  itemsGained?: Array<{ emoji: string; name: string }>;
  itemsLost?: string[];
  newLocation?: string;
}

const OUTCOME_LABELS: Record<string, { icon: string; label: string }> = {
  success:   { icon: '✓', label: 'Success' },
  failure:   { icon: '✗', label: 'Failure' },
  skipped:   { icon: '↩', label: 'Skipped' },
  timed_out: { icon: '⏰', label: 'Timed out' },
};

/**
 * Format an action outcome into a display string.
 * Handles success, failure, skipped, and timed_out outcomes with
 * deterministic summary lines per the S4 spec.
 */
export function formatOutcome(
  outcome: ActionOutcome,
  ctx: OutcomeRenderContext,
): string {
  const lines: string[] = [];

  // ── Header — roll vs DC ──
  if (outcome.playerRolled !== null) {
    const meta = OUTCOME_LABELS[outcome.outcome] ?? { icon: '?', label: outcome.outcome };
    lines.push(`🎲 ${outcome.playerRolled} vs ${outcome.finalDc} ${meta.icon} ${meta.label}`);
  } else {
    // Skipped / timed out — no roll line, just the icon and label
    const meta = OUTCOME_LABELS[outcome.outcome] ?? { icon: '?', label: outcome.outcome };
    lines.push(`${meta.icon} ${meta.label}`);
  }

  lines.push('');

  // ── Body — outcome text from LLM ──
  lines.push(outcome.outcomeText);

  lines.push('');

  // ── Summary line ──
  const summaryParts: string[] = [];

  // Items gained
  if (ctx.itemsGained && ctx.itemsGained.length > 0) {
    for (const item of ctx.itemsGained) {
      summaryParts.push(`+ ${item.emoji} ${item.name}`);
    }
  }

  // Items lost
  if (ctx.itemsLost && ctx.itemsLost.length > 0) {
    for (const name of ctx.itemsLost) {
      summaryParts.push(`- ${name}`);
    }
  }

  // Location change
  if (ctx.newLocation) {
    summaryParts.push(`→ ${ctx.newLocation}`);
  }

  // Stats footer
  const statParts: string[] = [];
  if (ctx.healthChanged) {
    statParts.push(`Health: ${ctx.health}/${ctx.maxHealth}`);
  }
  statParts.push(`Stamina: ${ctx.stamina}/10`);
  statParts.push(`Rolls: ${ctx.rollsRemaining}/2`);

  if (ctx.wealthChanged) {
    statParts.push(`Wealth: ${ctx.wealth}`);
  }

  const summaryLine = [...summaryParts, ...statParts].join(' ┃ ');
  lines.push(summaryLine);

  return lines.join('\n');
}
