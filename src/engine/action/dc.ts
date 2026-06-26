import type { ItemData, StatBlock } from '../WorldEngine.js';

const MIN_DC = 0;
const MAX_DC = 30;
const MIN_MODIFIER = -5;
const MAX_MODIFIER = 5;

/**
 * Accumulate base DC with signed modifiers (negative = easier, positive = harder),
 * clamped to [0, 30].
 */
export function accumulateDc(baseDc: number, modifiers: number[]): number {
  const sum = modifiers.reduce((acc, m) => acc + m, baseDc);
  return Math.max(MIN_DC, Math.min(MAX_DC, sum));
}

/** Valid DC modifier: a number within [-5, +5]. */
export function validateDcModifier(mod: number): boolean {
  return !Number.isNaN(mod) && mod >= MIN_MODIFIER && mod <= MAX_MODIFIER;
}

/**
 * Sum item modifiers for a given stat.
 *
 * Quantity does NOT multiply the modifier: modifier is the item's quality,
 * quantity only tracks consumption (ammo/consumables). 10 arrows shoot no better
 * than 1 — each is used one at a time.
 */
export function itemStatModifier(items: ItemData[], stat: string): number {
  return items
    .filter(item => item.stat === stat)
    .reduce((sum, item) => sum + item.modifier, 0);
}

/**
 * Effective ability scores: base stats plus summed item modifiers per stat.
 * This drives rolls (`abilityCheckBonus`), so it's what `/stats` and the might
 * leaderboard surface — base stats alone understate a geared-up character.
 */
export function effectiveStats(stats: StatBlock, items: ItemData[]): StatBlock {
  return {
    physical: stats.physical + itemStatModifier(items, 'physical'),
    wisdom: stats.wisdom + itemStatModifier(items, 'wisdom'),
    intelligence: stats.intelligence + itemStatModifier(items, 'intelligence'),
    charisma: stats.charisma + itemStatModifier(items, 'charisma'),
  };
}

/**
 * Roll bonus added to the d20: the character's stat plus summed item modifiers
 * for that stat.
 *
 * The stat is chosen per-decision (the player's approach), so "haggle" taps
 * charisma while "inspect" taps wisdom — build and gear decide which approach is
 * strongest. Returns 0 for an unknown stat key.
 */
export function abilityCheckBonus(stats: StatBlock, items: ItemData[], stat: string): number {
  const abilityScore = (stats as unknown as Record<string, number>)[stat] ?? 0;
  return abilityScore + itemStatModifier(items, stat);
}

/**
 * Resolve a d20 roll against a DC. Natural 1 always fails, natural 20 always
 * succeeds; otherwise roll + bonus >= DC succeeds.
 */
export function resolveRoll(
  d20: number,
  bonus: number,
  dc: number,
): 'success' | 'failure' {
  if (d20 === 1) return 'failure';
  if (d20 === 20) return 'success';
  return d20 + bonus >= dc ? 'success' : 'failure';
}
