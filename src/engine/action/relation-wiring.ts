import type { RelationRepository, RelationKey, NodeType } from '../../db/repositories/relation.js';
import type { AuthoredRelation, RelationEndpoint } from './mutations.js';

/** The shape `WorldContextResolver.getNearbyNpcs` returns — duplicated locally rather than imported
 *  from `machine.ts`, so this pure helper has zero dependency on that file. */
export interface NearbyNpc {
  id: number;
  name: string;
  description: string;
  health?: number | null;
}

/**
 * Maps one authored endpoint to a graph node, pure and DB-free: `npc` resolves case-insensitively by
 * name, `location` is name-keyed. An unresolvable endpoint returns `null` and warns, never a throw.
 */
export function resolveRelationEndpoint(
  endpoint: RelationEndpoint,
  char: { id: number },
  nearbyNpcs: NearbyNpc[],
): { type: NodeType; ref: string } | null {
  if (endpoint.node === 'pc') {
    return { type: 'pc', ref: String(char.id) };
  }

  if (endpoint.node === 'npc') {
    const target = endpoint.name.trim().toLowerCase();
    const match = nearbyNpcs.find((n) => n.name.trim().toLowerCase() === target);
    if (!match) {
      console.warn(
        `[relation-wiring] dropping relation edge — unresolved npc endpoint "${endpoint.name}" (not among nearby npcs)`,
      );
      return null;
    }
    return { type: 'npc', ref: String(match.id) };
  }

  const name = endpoint.name.trim();
  if (name === '') {
    console.warn('[relation-wiring] dropping relation edge — empty location endpoint name');
    return null;
  }
  return { type: 'location', ref: name };
}

/**
 * Resolve a full authored relation to a `RelationKey` the repository can persist against, or `null`
 * if either endpoint drops.
 */
export function resolveAuthoredRelation(
  relation: AuthoredRelation,
  char: { id: number },
  nearbyNpcs: NearbyNpc[],
): RelationKey | null {
  const from = resolveRelationEndpoint(relation.from, char, nearbyNpcs);
  if (!from) return null;
  const to = resolveRelationEndpoint(relation.to, char, nearbyNpcs);
  if (!to) return null;
  return {
    fromType: from.type,
    fromRef: from.ref,
    toType: to.type,
    toRef: to.ref,
    relType: relation.relType,
  };
}

/**
 * Resolve and persist authored relations; shared by the prod engine and the sim host. Unresolvable
 * edges drop with a warning (never a throw), and an `update_relation` on a missing edge warns and is skipped.
 */
export function persistAuthoredRelations(
  repo: RelationRepository,
  relationsToSet: AuthoredRelation[],
  relationsToUpdate: AuthoredRelation[],
  char: { id: number },
  nearbyNpcs: NearbyNpc[],
): void {
  for (const relation of relationsToSet) {
    const key = resolveAuthoredRelation(relation, char, nearbyNpcs);
    if (!key) continue;
    repo.set({ ...key, props: relation.props });
  }

  for (const relation of relationsToUpdate) {
    const key = resolveAuthoredRelation(relation, char, nearbyNpcs);
    if (!key) continue;
    const updated = repo.updateProps(key, relation.props);
    if (!updated) {
      console.warn(
        `[relation-wiring] dropping update_relation — no existing edge for ${key.fromType}:${key.fromRef} -> ${key.toType}:${key.toRef} (${key.relType})`,
      );
    }
  }
}
