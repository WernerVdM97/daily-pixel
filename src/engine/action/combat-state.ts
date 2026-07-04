/**
 * combatState — the `in_combat`/`combat_save` scene-state model (Stage 3 Thread C, T2).
 *
 * Pure model only: no DB/repo/machine imports, no I/O. Endpoints are carried AS AUTHORED
 * (`RelationEndpoint`, name-keyed) exactly like the rest of the T2 relation vocabulary
 * (`mutations.ts`) — npc-name/location-name -> id resolution stays in `relation-wiring.ts`
 * (Stage 2 decision 4), wired by T3, not here.
 */
import type { AuthoredRelation, RelationEndpoint } from './mutations.js';
import type { SceneStateEdge } from '../../llm/LlmGateway.js';

export interface CombatState {
  enemyName: string;
  enemyHp: number;
  enemyMaxHp: number;
  round: number;
  anchor: RelationEndpoint;
}

/**
 * Map a resolved scene-state node back to the authored `RelationEndpoint` shape so it can be
 * fed straight back into `combatStateToSetRelation`/`combatRoundUpdate`.
 *
 * CAVEAT (flagged for T3 review): for an `npc` anchor, `SceneStateEdge.to.ref` is the resolved
 * numeric npc id (see `relation-wiring.ts:resolveRelationEndpoint` — npc refs are ids, not
 * names), not a display name. `RelationEndpoint`'s `npc` variant only carries a `name` used for
 * case-insensitive lookup against `nearbyNpcs`. This helper does a structural passthrough (it has
 * no npc-id->name lookup available, nor should it per decision 4) — round-tripping a *real*
 * npc-anchored edge back through `resolveAuthoredRelation` would fail to re-match by id-as-name.
 * Harmless for this pass's pure round-trip tests (location anchors round-trip correctly; npc
 * anchors round-trip structurally); T3 must either resolve npc anchors once and hold the
 * resolved `RelationKey` across rounds (skipping re-resolution) or thread the npc's name through
 * separately. Out of scope for T2 (endpoint resolution is explicitly a T3 concern).
 */
function toAnchor(node: SceneStateEdge['to']): RelationEndpoint {
  if (node.type === 'pc') return { node: 'pc' };
  if (node.type === 'npc') return { node: 'npc', name: node.ref };
  return { node: 'location', name: node.ref };
}

/** Basic numeric/shape sanity beyond typeof — mirrors the write-time clamps (`mutations.ts`)
 *  closely enough to reject obviously-corrupt persisted props, without re-importing the
 *  validator (this module stays pure/dependency-free of `mutations.ts`'s runtime code). */
function isSaneCombatProps(enemyHp: number, enemyMaxHp: number, round: number): boolean {
  return enemyMaxHp >= 1 && enemyHp >= 0 && enemyHp <= enemyMaxHp && round >= 1;
}

/** Find the `in_combat` edge authored BY the pc (`from.type === 'pc'`) and parse its props into
 *  a `CombatState`, or `null` if absent or malformed (missing/wrong-typed/out-of-range props). */
export function readCombatState(edges: SceneStateEdge[]): CombatState | null {
  const edge = edges.find((e) => e.relType === 'in_combat' && e.from.type === 'pc');
  if (!edge) return null;

  const { enemyName, enemyHp, enemyMaxHp, round } = edge.props as Record<string, unknown>;
  if (typeof enemyName !== 'string' || enemyName.trim() === '') return null;
  if (typeof enemyHp !== 'number' || !Number.isFinite(enemyHp)) return null;
  if (typeof enemyMaxHp !== 'number' || !Number.isFinite(enemyMaxHp)) return null;
  if (typeof round !== 'number' || !Number.isFinite(round)) return null;
  if (!isSaneCombatProps(enemyHp, enemyMaxHp, round)) return null;

  return { enemyName, enemyHp, enemyMaxHp, round, anchor: toAnchor(edge.to) };
}

/** The initial (or any full-state) `set_relation` for the `in_combat` edge — `set` upserts by
 *  overwriting props wholesale (`relation.ts:set`), so this always carries the FULL prop set. */
export function combatStateToSetRelation(state: CombatState): AuthoredRelation {
  return {
    from: { node: 'pc' },
    to: state.anchor,
    relType: 'in_combat',
    props: {
      enemyName: state.enemyName,
      enemyHp: state.enemyHp,
      enemyMaxHp: state.enemyMaxHp,
      round: state.round,
    },
  };
}

/**
 * Advance combat by one round.
 *
 * NOTE on the round/delta-vs-set ambiguity (spec-flagged, resolved here): `RelationRepository
 * .updateProps` (`relation.ts:64-90`) SUMS any prop key already numeric on the edge — correct
 * for `enemyHp` (it only ever moves by a signed delta) but wrong for `round`, which is ALSO
 * already numeric on the edge, so an `update_relation` delta would double-sum it instead of
 * setting the next absolute value. Splitting into two ops (a delta `update_relation` for
 * `enemyHp` + a separate absolute write for `round`) would need two round-trips and extra T3
 * bookkeeping for one op that's conceptually a single "advance the round" step. Per the plan's
 * own fallback, this instead returns a SINGLE `set_relation` carrying the full, already-absolute
 * prop set (`relation.ts:set` overwrites props wholesale, so a *partial* `set_relation` here
 * would silently drop `enemyName`/`enemyMaxHp` — this is why the full `CombatState`, not a bare
 * anchor, is threaded through as input rather than the anchor-only shape the plan sketched).
 * `enemyHpDelta` is applied and clamped to `[0, state.enemyMaxHp]` here so the emitted op is
 * always a valid absolute value; `nextRound` is written as-is (callers pass `round + 1`).
 */
export function combatRoundUpdate(
  state: CombatState,
  enemyHpDelta: number,
  nextRound: number,
): AuthoredRelation {
  const enemyHp = Math.max(0, Math.min(state.enemyMaxHp, state.enemyHp + enemyHpDelta));
  return combatStateToSetRelation({ ...state, enemyHp, round: nextRound });
}

/** Read the once-per-day floor's `savedDay` off the pc's `combat_save` self-edge, or `null` if
 *  absent/malformed. */
export function readCombatSave(edges: SceneStateEdge[]): number | null {
  const edge = edges.find(
    (e) => e.relType === 'combat_save' && e.from.type === 'pc' && e.to.type === 'pc',
  );
  if (!edge) return null;

  const savedDay = (edge.props as Record<string, unknown>).savedDay;
  return typeof savedDay === 'number' && Number.isFinite(savedDay) && savedDay >= 0 ? savedDay : null;
}

/** The `pc -> pc` self-edge marking the once-per-day no-one-shot floor as spent for `currentDay`. */
export function combatSaveUpdate(currentDay: number): AuthoredRelation {
  return {
    from: { node: 'pc' },
    to: { node: 'pc' },
    relType: 'combat_save',
    props: { savedDay: currentDay },
  };
}
