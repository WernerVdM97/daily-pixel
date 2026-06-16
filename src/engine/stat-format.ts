/** Stat abbreviation + emoji mapping for all rendered output. */

export const STAT_LABELS: Record<
  string,
  { emoji: string; abbr: string; full: string }
> = {
  physical: { emoji: '💪', abbr: 'PHY', full: 'Physical' },
  wisdom: { emoji: '🧠', abbr: 'WIS', full: 'Wisdom' },
  intelligence: { emoji: '📖', abbr: 'INT', full: 'Intelligence' },
  charisma: { emoji: '💬', abbr: 'CHA', full: 'Charisma' },
};

/** E.g. `💪 PHY` for rendering in stat lines. */
export function formatStatLabel(stat: string): string {
  const info = STAT_LABELS[stat];
  if (!info) return stat;
  return `${info.emoji} ${info.abbr}`;
}

/** E.g. `Physical` — the original full name. */
export function statFullName(stat: string): string {
  return STAT_LABELS[stat]?.full ?? stat;
}
