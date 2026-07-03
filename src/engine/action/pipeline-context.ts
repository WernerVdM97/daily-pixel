import type { LlmContext } from '../../llm/LlmGateway.js';
import type { CharacterData, ItemData } from '../WorldEngine.js';
import type { WorldContextResolver } from './machine.js';
import { itemStatModifier } from './dc.js';

/** The four ability stats, in display order. Duplicated from `machine.ts` (module-private
 *  there) — see file-level rationale below. */
const ALL_STATS = ['physical', 'wisdom', 'intelligence', 'charisma'] as const;

/**
 * Pipeline's own context builder — a deliberate duplicate of `ActionStateMachine`'s private
 * `buildContext`, not an extraction of it. Stage 1's core constraint is zero risk to the live
 * v11 path, so `machine.ts` is never touched (not even to export a shared helper); this
 * duplication is the intentional trade-off. A later stage can de-duplicate once the pipeline
 * machine is proven (see stage-1-thread-d-backbone-plan.md, Task 2).
 */
export function buildPipelineContext(
  resolver: WorldContextResolver,
  char: CharacterData,
  rawInput: string,
  previous: { prompt: string; chosen: string; dcModifier: number }[],
  items: ItemData[],
): LlmContext {
  const hintParts: string[] = [];

  // Item bonuses per stat — the LLM authors per-option stats and needs to see which approaches
  // the player's gear favours. Ability scores are already in the CHARACTER line.
  const itemBonuses = ALL_STATS
    .map(s => ({ s, b: itemStatModifier(items, s) }))
    .filter(x => x.b !== 0)
    .map(x => `${x.s} ${x.b >= 0 ? '+' : ''}${x.b}`);
  hintParts.push(itemBonuses.length > 0 ? `item bonuses: ${itemBonuses.join(', ')}` : 'no item stat bonuses');

  // Full inventory — for remove_item targets and avoiding duplicate add_item.
  if (items.length > 0) {
    hintParts.push(`inventory: ${items.map(i => `${i.emoji} ${i.name} (${i.stat}+${i.modifier}, qty ${i.quantity})`).join(', ')}`);
  }

  // Known locations: retained for the digest + stripped retry. The PROMPT renders the local
  // "here + exits" block (v10) from localGeography instead of this global list.
  const knownLocations = resolver.getKnownLocations();
  const localGeography = resolver.getLocalGeography(char.location);

  // Structured item data: per-stat summed bonus (table `Gear` column) and inventory list. The
  // `scalingHint` above carries the same data for the audit digest.
  const itemBonusByStat = {
    physical: itemStatModifier(items, 'physical'),
    wisdom: itemStatModifier(items, 'wisdom'),
    intelligence: itemStatModifier(items, 'intelligence'),
    charisma: itemStatModifier(items, 'charisma'),
  };

  return {
    character: {
      class: char.class,
      stats: char.stats,
      health: char.health,
      maxHealth: char.maxHealth,
      stamina: char.stamina,
      maxStamina: char.maxStamina,
      alignment: char.alignment,
      dayJob: char.dayJob,
    },
    location: { name: char.location, isSafe: resolver.isLocationSafe(char.location), region: localGeography.region },
    nearbyNpcs: resolver.getNearbyNpcs(char.location),
    nearbyPcs: resolver.getNearbyPcs(char.location, char.id),
    recentActions: resolver.getRecentActions(char.id),
    knownLocations,
    localGeography: { neighbours: localGeography.neighbours, frontiers: localGeography.frontiers },
    rawInput,
    ...(previous.length > 0 ? { previousDecisions: previous } : {}),
    itemBonuses: itemBonusByStat,
    inventory: items.map(i => ({ emoji: i.emoji, name: i.name, stat: i.stat, modifier: i.modifier, quantity: i.quantity })),
    scalingHint: hintParts.join(' | ') || 'No relevant items',
  };
}
