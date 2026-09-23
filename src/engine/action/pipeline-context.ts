import type { LlmContext, SceneStateEdge } from '../../llm/LlmGateway.js';
import type { CharacterData, ItemData } from '../WorldEngine.js';
import type { WorldContextResolver } from './machine.js';
import type { NodeType } from '../../db/repositories/relation.js';
import type { RelationRow } from '../../db/repositories/types.js';
import { itemStatModifier } from './dc.js';

/** The four ability stats, used to build the item-bonus hint. */
const ALL_STATS = ['physical', 'wisdom', 'intelligence', 'charisma'] as const;

/**
 * A pipeline-local `WorldContextResolver` plus an optional scene-state read-back hook — optional so
 * every existing resolver with no relations backing stays a valid `PipelineContextResolver`.
 */
export interface PipelineContextResolver extends WorldContextResolver {
  getSceneRelations?(node: { type: NodeType; ref: string }): RelationRow[];
  /** Optional per-day combat floor hook: the in-game day number, or 0 (the default) when absent. */
  getCurrentDay?(): number;
}

/** The pipeline's LLM context: the character sheet, nearby actors, geography, scene relations and the item-bonus hints. */
export function buildPipelineContext(
  resolver: PipelineContextResolver,
  char: CharacterData,
  rawInput: string,
  previous: { prompt: string; chosen: string; dcModifier: number }[],
  items: ItemData[],
): LlmContext {
  const hintParts: string[] = [];

  // Item bonuses per stat — the LLM authors per-option stats and needs to see which approaches
  // the player's gear favours. Ability scores are already in the `## You` block.
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
  // "here + exits" block from localGeography instead of this global list.
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

  // The persisted subgraph touching this PC, as structured data only — rendering is the template's
  // concern.
  const sceneRelationRows = resolver.getSceneRelations?.({ type: 'pc', ref: String(char.id) }) ?? [];
  const sceneState: SceneStateEdge[] = sceneRelationRows.map((row) => ({
    from: { type: row.from_type as NodeType, ref: row.from_ref },
    to: { type: row.to_type as NodeType, ref: row.to_ref },
    relType: row.rel_type,
    props: JSON.parse(row.props) as Record<string, number | string | boolean>,
  }));

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
    // Project to the LLM-facing shape explicitly — `getNearbyNpcs` now also carries `health`
    // (combat max-HP), which the prompt never uses and must not leak into the context.
    nearbyNpcs: resolver.getNearbyNpcs(char.location).map((n) => ({ id: n.id, name: n.name, description: n.description })),
    nearbyPcs: resolver.getNearbyPcs(char.location, char.id),
    recentActions: resolver.getRecentActions(char.id),
    knownLocations,
    localGeography: { neighbours: localGeography.neighbours, frontiers: localGeography.frontiers },
    rawInput,
    ...(previous.length > 0 ? { previousDecisions: previous } : {}),
    ...(sceneState.length > 0 ? { sceneState } : {}),
    itemBonuses: itemBonusByStat,
    inventory: items.map(i => ({ emoji: i.emoji, name: i.name, stat: i.stat, modifier: i.modifier, quantity: i.quantity })),
    scalingHint: hintParts.join(' | ') || 'No relevant items',
  };
}
