import type { RelationRepository, RelationKey, NodeType } from '../../db/repositories/relation.js';
import type { AuthoredRelation, RelationEndpoint } from './mutations.js';

/** The shape `WorldContextResolver.getNearbyNpcs` returns — duplicated locally rather than
 *  imported from `machine.ts` (frozen, decision 1) so this pure helper has zero dependency on
 *  that file. */
export interface NearbyNpc {
  id: number;
  name: string;
  description: string;
}

/**
 * Stage 2 T3 — the "T3 wiring layer" decision 4 defers endpoint resolution to. Maps a single
 * authored `RelationEndpoint` to a graph node `(type, ref)`. Pure: takes the data it needs as
 * params (the acting character, a nearby-npc list scoped by the caller) and does no DB I/O
 * itself — the caller (`PipelineSimEngine`) owns fetching `nearbyNpcs` from its resolver.
 *
 * `npc` name resolution is case-insensitive against `nearbyNpcs`; `location` is name-keyed with
 * no lookup (matches `location_edges`'s existing convention). An unresolvable endpoint returns
 * `null` and warns — mirrors `applyGeography`'s drop-with-warn (`WorldEngineImpl.ts`) — never a
 * throw.
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

  // location — name-keyed, no lookup (decision 4).
  const name = endpoint.name.trim();
  if (name === '') {
    console.warn('[relation-wiring] dropping relation edge — empty location endpoint name');
    return null;
  }
  return { type: 'location', ref: name };
}

/**
 * Resolve a full authored relation (both endpoints) to a `RelationKey` the repository can
 * persist against, or `null` if either endpoint drops (see `resolveRelationEndpoint`).
 * Resolution order is npc-first then location per endpoint (risk table) — moot in practice
 * since `RelationEndpoint` already discriminates by `node`, but the switch order in
 * `resolveRelationEndpoint` above mirrors it for the settled-design contract.
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
 * Resolve + persist authored relation mutations against a RelationRepository. Shared by the
 * prod engine (WorldEngineImpl.applyResolution) and the sim host (PipelineSimEngine). Endpoints
 * are resolved via resolveAuthoredRelation against `nearbyNpcs`; an unresolvable edge is
 * dropped-with-warn (never throws). `update_relation` on a missing edge warns and is skipped.
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
