// ── OutcomeRenderer ── pure function, no dependencies
// Formats action outcomes for Discord display per S4 spec.
// Change indicators are derived from outcome.mutations (not caller-provided flags)
// so the caller never has to pre-compute diffs.

import type { ActionOutcome, WorldMutation } from './WorldEngine.js';

// ── Public context — only current (post-mutation) values ──

export interface OutcomeRenderContext {
  stamina: number;
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

// ── Outcome label map ──

const OUTCOME_LABELS: Record<string, { icon: string; label: string }> = {
  success:   { icon: '✓', label: 'Success' },
  failure:   { icon: '✗', label: 'Failure' },
  skipped:   { icon: '↩', label: 'Skipped' },
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
    lines.push(`🎲 ${outcome.playerRolled} vs ${outcome.finalDc} ${meta.icon} ${meta.label}`);
  } else {
    const meta = OUTCOME_LABELS[outcome.outcome] ?? { icon: '?', label: outcome.outcome };
    lines.push(`${meta.icon} ${meta.label}`);
  }

  lines.push('');

  // ── Body — outcome text from LLM ──
  lines.push(outcome.outcomeText);

  lines.push('');

  // ── Summary line ──
  const parts: string[] = [];

  // Items gained
  for (const item of d.itemsGained) {
    parts.push(`+ ${item.emoji} ${item.name}`);
  }

  // Items lost
  for (const name of d.itemsLost) {
    parts.push(`- ${name}`);
  }

  // Location change
  if (d.newLocation) {
    parts.push(`→ ${d.newLocation}`);
  }

  // Stats footer
  // Health — only shown when it changed
  if (d.healthDelta !== 0) {
    parts.push(`Health: ${ctx.health}/${ctx.maxHealth}${formatDelta(d.healthDelta)}`);
  }

  // Stamina — always shown, with delta when it changed
  parts.push(`Stamina: ${ctx.stamina}/10${formatDelta(d.staminaDelta)}`);

  // Rolls — always shown, with delta when it changed
  parts.push(`Rolls: ${ctx.rollsRemaining}/2${formatDelta(d.rollsDelta)}`);

  // Wealth — only shown when it changed
  if (d.wealthDelta !== 0) {
    parts.push(`Wealth: ${ctx.wealth}${formatDelta(d.wealthDelta)}`);
  }

  lines.push(parts.join(' ┃ '));

  return lines.join('\n');
}
