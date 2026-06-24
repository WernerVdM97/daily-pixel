import type { ItemData, StatBlock } from '../WorldEngine.js';

const MIN_DC = 0;
const MAX_DC = 30;
const MIN_MODIFIER = -5;
const MAX_MODIFIER = 5;

/**
 * Accumulate base DC with signed modifiers from decisions.
 * Each modifier is literal and signed: negative = easier, positive = harder.
 * Result is clamped to [0, 30].
 */
export function accumulateDc(baseDc: number, modifiers: number[]): number {
  const sum = modifiers.reduce((acc, m) => acc + m, baseDc);
  return Math.max(MIN_DC, Math.min(MAX_DC, sum));
}

/**
 * Validate that a DC modifier is within the allowed range [-5, +5] and is a number.
 */
export function validateDcModifier(mod: number): boolean {
  return !Number.isNaN(mod) && mod >= MIN_MODIFIER && mod <= MAX_MODIFIER;
}

/**
 * Sum item modifiers for a given stat.
 *
 * Quantity does NOT multiply the modifier — modifier represents the item's
 * quality, quantity is just how many you have left (for tracking consumption
 * of ammunition/consumables).  Having 10 arrows makes you no better at
 * shooting than having 1; each is used one at a time.
 */
export function itemStatModifier(items: ItemData[], stat: string): number {
  return items
    .filter(item => item.stat === stat)
    .reduce((sum, item) => sum + item.modifier, 0);
}

/**
 * A character's effective ability scores: base stats plus the summed item
 * modifiers keyed to each stat. This is the score that actually drives rolls
 * (`abilityCheckBonus`), so it's what `/stats` and the might leaderboard should
 * surface — base stats alone understate a geared-up character.
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
 * Total roll bonus for an ability check: the character's own stat plus the summed
 * modifiers of items keyed to that stat. This is what's added to the d20.
 *
 * The stat is chosen per-decision (the approach the player took), so picking the
 * "haggle" option taps charisma while "inspect" taps wisdom — your build and gear
 * decide which approach is strongest for you. Returns 0 for an unknown stat key.
 */
export function abilityCheckBonus(stats: StatBlock, items: ItemData[], stat: string): number {
  const abilityScore = (stats as unknown as Record<string, number>)[stat] ?? 0;
  return abilityScore + itemStatModifier(items, stat);
}

/**
 * Resolve a d20 roll against a DC.
 * Natural 1 = always failure. Natural 20 = always success.
 * Otherwise: roll + bonus >= DC → success.
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
