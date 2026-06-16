import type { ItemData } from '../WorldEngine.js';

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
export function computeItemBonus(items: ItemData[], stat: string): number {
  return items
    .filter(item => item.stat === stat)
    .reduce((sum, item) => sum + item.modifier, 0);
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
