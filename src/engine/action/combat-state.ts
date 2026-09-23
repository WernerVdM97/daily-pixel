/** The `in_combat`/`combat_save` scene-state model. Pure model: no DB/repo/machine imports, no I/O.
 *  Endpoints are carried AS AUTHORED; name -> id resolution lives in `relation-wiring.ts`. */
import type { AuthoredRelation, RelationEndpoint } from './mutations.js';
import type { SceneStateEdge } from '../../llm/LlmGateway.js';
import { ENEMY_HP_MAX } from './combat-dc.js';

export interface CombatState {
  enemyName: string;
  enemyHp: number;
  enemyMaxHp: number;
  round: number;
  anchor: RelationEndpoint;
  /** The intended name of an `anchor: 'npc'` foe. Held on the edge because the per-action marker dies
   *  with the action, bails included: a re-engaged fight would otherwise continue the edge's positive HP instead of re-running establish. */
  mintName?: string;
  /** The fight's authored `baseDc`, pinned at establish and read back on every later round.
   *  Optional for edges persisted before the prop existed. */
  baseDc?: number;
}

/** CAVEAT: an `npc`'s `SceneStateEdge.to.ref` is the resolved numeric id, which
 *  `resolveAuthoredRelation` cannot re-match by id-as-name — hold the anchor resolved once instead of re-resolving. */
function toAnchor(node: SceneStateEdge['to']): RelationEndpoint {
  if (node.type === 'pc') return { node: 'pc' };
  if (node.type === 'npc') return { node: 'npc', name: node.ref };
  return { node: 'location', name: node.ref };
}

/** Shape sanity that rejects corrupt persisted props without importing the validator. `mintName`
 *  is deliberately absent: a bad value on it drops the prop rather than invalidating the whole read. */
function isSaneCombatProps(enemyHp: number, enemyMaxHp: number, round: number): boolean {
  // Must mirror validateTypedRelationProps' clamps exactly (incl. the enemyMaxHp upper bound) so
  // the read guard never accepts a bag the write path rejects.
  return (
    enemyMaxHp >= 1 &&
    enemyMaxHp <= ENEMY_HP_MAX &&
    enemyHp >= 0 &&
    enemyHp <= enemyMaxHp &&
    round >= 1
  );
}

/** Find the `in_combat` edge authored BY the pc and parse its props into a `CombatState`, or
 *  `null` if absent or malformed. */
export function readCombatState(edges: SceneStateEdge[]): CombatState | null {
  const edge = edges.find((e) => e.relType === 'in_combat' && e.from.type === 'pc');
  if (!edge) return null;

  const { enemyName, enemyHp, enemyMaxHp, round } = edge.props as Record<string, unknown>;
  if (typeof enemyName !== 'string' || enemyName.trim() === '') return null;
  if (typeof enemyHp !== 'number' || !Number.isFinite(enemyHp)) return null;
  if (typeof enemyMaxHp !== 'number' || !Number.isFinite(enemyMaxHp)) return null;
  if (typeof round !== 'number' || !Number.isFinite(round)) return null;
  if (!isSaneCombatProps(enemyHp, enemyMaxHp, round)) return null;

  // Read tolerantly: an edge predating this prop (or a malformed value) yields `undefined` rather
  // than invalidating the whole read, unlike the required fields above.
  const rawMintName = (edge.props as Record<string, unknown>).mintName;
  const mintName = typeof rawMintName === 'string' && rawMintName.trim() !== '' ? rawMintName : undefined;

  const rawBaseDc = (edge.props as Record<string, unknown>).baseDc;
  const baseDc = typeof rawBaseDc === 'number' && Number.isFinite(rawBaseDc) && rawBaseDc >= 0
    ? rawBaseDc
    : undefined;

  return { enemyName, enemyHp, enemyMaxHp, round, anchor: toAnchor(edge.to), mintName, baseDc };
}

/** The initial (or any full-state) `set_relation` for the `in_combat` edge — `set` overwrites props
 *  wholesale, so this always carries the FULL prop set. The caller tags it `type: 'set_relation'`. */
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
      // Omitted rather than written undefined: `props` admits no undefined members, and a fight
      // with no mint leaves the edge's prop bag as it was before this prop existed.
      ...(state.mintName ? { mintName: state.mintName } : {}),
      ...(state.baseDc !== undefined ? { baseDc: state.baseDc } : {}),
    },
  };
}

/** Advance combat by one round: a single `set_relation` with the full absolute prop set. `updateProps` SUMS an already-numeric prop,
 *  right for `enemyHp` and wrong for `round`; a partial `set` would drop `enemyName`/`enemyMaxHp`. The caller tags it `type: 'set_relation'`. */
export function combatRoundUpdate(
  state: CombatState,
  enemyHpDelta: number,
  nextRound: number,
): AuthoredRelation {
  const enemyHp = Math.max(0, Math.min(state.enemyMaxHp, state.enemyHp + enemyHpDelta));
  return combatStateToSetRelation({ ...state, enemyHp, round: nextRound });
}

/** The pc's `combat_save` self-edge's `savedDay`, or `null` if absent/malformed. */
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
