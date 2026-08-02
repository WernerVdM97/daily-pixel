import { WORLD_MUTATION_TYPES, type WorldMutation } from '../WorldEngine.js';
import { ENEMY_HP_MAX } from './combat-dc.js';

/**
 * Stage 2 T2 — edge-shaped relation mutation vocabulary (scene-state graph, D2).
 *
 * Doc-to-code mapping (decision 6): the design doc ([[prompt-v12-scene-state]] D2) writes
 * `{ op, from, to, type, props }`; the codebase's `WorldMutation` already uses `type` for the
 * OP NAME (`WorldEngine.ts`). So in code the op name is `type: 'set_relation' | 'update_relation'`
 * and the *relationship* kind is carried as `relType` (doc's `type` → code's `relType`; doc's
 * `op` → code's `type`).
 *
 * `node identity is polymorphic (type, ref)` (decision 4): `pc` has no name (there is exactly
 * one PC per action context); `npc`/`location` carry the name AS AUTHORED by the LLM — this pure
 * layer does no DB lookups and no npc-name→id resolution, exactly like `update_npc`/`remove_npc`
 * receiving a pre-resolved `npcId` from upstream (see the comment above). Resolution + drop of
 * unresolvable endpoints is deferred to T3's engine wiring.
 */
export type RelationEndpoint =
  | { node: 'pc' }
  | { node: 'npc'; name: string }
  | { node: 'location'; name: string };

/** A relation mutation, edges as authored by the LLM — endpoints unresolved (see above). */
export interface AuthoredRelation {
  from: RelationEndpoint;
  to: RelationEndpoint;
  relType: string;
  props: Record<string, number | string | boolean>;
}

/** Seed whitelist of relationship kinds (`relType`) — extensible; writers add theirs (Stage 3+).
 *  Stage 3 T2 adds `combat_save` (the once-per-day no-one-shot floor edge, decision 5); `in_combat`
 *  was already seeded here in Stage 2. Per-`relType` prop schemas (combat's `enemyHp`/`enemyMaxHp`/
 *  `round`/`savedDay`) are filled in below by `validateTypedRelationProps` — the first writer of
 *  the schemas Stage 2 deferred (see that function's doc comment). */
const RELATION_TYPE_WHITELIST = new Set([
  'in_combat',
  'combat_save',
  'trust',
  'disposition',
  'knows_secret',
  'fears',
  'owes_debt',
  'puzzle',
]);

/** Global clamp on any numeric relation prop value (±). Per-`relType` bounds are a Stage 3+
 *  concern; this is only the generic "no absurd number" guard for the edge-shape validator. */
const RELATION_NUM_CLAMP = 9999;

export interface MutationContext {
  currentHealth: number;
  maxHealth: number;
  stamina: number;
  maxStamina: number;
  wealth: number;
  rollsRemaining: number;
  location: string;
  /** Known location names. When provided and non-empty, move_to is
   *  rejected unless its name matches one of these exactly (case-insensitive).
   *  Omit to skip the check (e.g. in unit tests with synthetic locations). */
  knownLocations?: string[];
}

export interface MutationError {
  index: number;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: MutationError[];
}

export interface AppliedState extends MutationContext {
  itemsToAdd: Array<{ name: string; emoji: string; stat: string; modifier: number; quantity: number }>;
  itemsToRemove: Array<{ name: string; quantity: number }>;
  /** v11: add_npc (create-only). Legacy spawn_npc maps here. `health` added by RA-3 bounded —
   *  `npcRepo.create` always accepted it, the gap was only ever in this applier. An explicit
   *  `location` lets a caller (the combat mint) pin the row to the FIGHT's location instead of
   *  the applier's `applied.location` fallback, which is POST-mutation and can diverge from it
   *  when the same resolution also relocates the player — see the create-loop comment in
   *  `WorldEngineImpl.ts`. Omitting it keeps the pre-existing behaviour every LLM-authored
   *  `add_npc` relies on. */
  npcsToAdd: Array<{ name: string; class?: string; description?: string; race?: string; homeLocation?: string; health?: number; location?: string }>;
  /** v11: update_npc — handle already resolved to npcId by the gateway. */
  npcsToUpdate: Array<{ npcId: number; description?: string; location?: string; class?: string; race?: string }>;
  /** v11: remove_npc — handle already resolved to npcId by the gateway. */
  npcsToRemove: Array<{ npcId: number }>;
  /** v11: reveal_location — authors a frontier exit at the current location. */
  locationsToReveal: Array<{ name: string; direction?: string; isSafe?: number; description?: string }>;
  /**
   * Stage 2 T2 — `set_relation` edges, endpoints AS AUTHORED (unresolved). Intentionally
   * dangling this pass: nothing reads this field yet — T3 wires it through
   * `RelationRepository.set` after resolving npc-name→id upstream. Not dead code.
   */
  relationsToSet: AuthoredRelation[];
  /**
   * Stage 2 T2 — `update_relation` edges, endpoints AS AUTHORED (unresolved). Intentionally
   * dangling this pass: nothing reads this field yet — T3 wires it through
   * `RelationRepository.updateProps` after resolving npc-name→id upstream. Not dead code.
   */
  relationsToUpdate: AuthoredRelation[];
}

/** Active types accepted by the validator — derived from the canonical `WORLD_MUTATION_TYPES`
 *  array (`WorldEngine.ts`) so this set can never drift from the `WorldMutation.type` union
 *  (mirrors the `ACTION_CATEGORIES` drift-proofing pattern, commit 62b102b). `set_location` and
 *  `spawn_npc` are legacy aliases, treated identically to `move_to`/`add_npc` respectively. */
const MUTATION_TYPES: Set<string> = new Set(WORLD_MUTATION_TYPES);

/** The three ops that all converge onto `state.location` (see the relocate switch cases in
 *  `validateOne`/`applyMutations` below) — the single shared source for anything that needs to
 *  know "is this mutation a relocate?" without re-deriving its own copy of the list
 *  (`travel-gate.ts`'s `RELOCATE_MUTATION_TYPES` usage). */
export const RELOCATE_MUTATION_TYPES = new Set<string>(['set_location', 'move_to', 'cross_frontier']);

/** Per-axis stacked-delta caps (§5a guard 1). Applied by collapseStackedDeltas. */
const STAMINA_DELTA_CAP = -5;
const HEALTH_DELTA_CAP = -4;

/** RA-1 Stage 1 — ceiling on the generic LLM-authored `add_item` channel. Base stats are set once
 *  at character creation and never change (no `modify_stat` mutation exists anywhere), so items
 *  are the only growth channel for `abilityCheckBonus` (`dc.ts`); item count is uncapped and the
 *  sum is monotonic, so an unbounded per-item modifier would decay RA-1's DC retune within a week
 *  of play. This is a TIER ceiling, not a design limit: a future named/legendary item tier is
 *  expected to exceed it through its own channel, and must not be read as a permanent cap on item
 *  power. See `clampAuthoredItemModifiers` below for where it's enforced. */
export const LLM_ITEM_MODIFIER_MAX = 2;

/**
 * Collapse same-axis scalar deltas into a single mutation (§5a stacked-delta guard).
 * Multiple modify_stamina mutations in one resolution are summed and capped so a bad
 * LLM pass can't stack unlimited costs. Non-scalar mutations pass through unchanged.
 *
 * Call this BEFORE validateMutations so the validator sees already-collapsed input.
 */
export function collapseStackedDeltas(mutations: WorldMutation[]): WorldMutation[] {
  const COLLAPSIBLE = ['modify_stamina', 'modify_health', 'modify_wealth', 'modify_rolls_remaining', 'modify_max_stamina'] as const;
  type CollapsibleType = typeof COLLAPSIBLE[number];
  const isCollapsible = (t: string): t is CollapsibleType => (COLLAPSIBLE as readonly string[]).includes(t);

  const sums = new Map<CollapsibleType, number>();
  const pass: WorldMutation[] = [];

  for (const m of mutations) {
    if (isCollapsible(m.type)) {
      const prev = sums.get(m.type) ?? 0;
      sums.set(m.type, prev + Number(m.amount ?? 0));
    } else {
      pass.push(m);
    }
  }

  for (const [type, raw] of sums) {
    let amount = raw;
    if (type === 'modify_stamina') amount = Math.max(STAMINA_DELTA_CAP, Math.min(0, amount) || amount);
    if (type === 'modify_health') amount = Math.max(HEALTH_DELTA_CAP, Math.min(0, amount) || amount);
    pass.push({ type, amount });
  }

  return pass;
}

/**
 * RA-1 Stage 1 — bounds `add_item.modifier` at `LLM_ITEM_MODIFIER_MAX`, upper-bound only. Clamps
 * rather than rejects: `finalizeMutations` (`geography-finalize.ts`) drops every mutation the
 * validator reports, so rejecting an over-limit `add_item` would delete the reward outright and
 * leave a SUCCESS carrying only a stamina cost — `resolve/BASE.md` names that in bold as "a
 * failure reward - never do this". A negative modifier passes through untouched: no prompt
 * mentions one today, but a cursed or burdensome item is a legitimate future authoring, and
 * flooring it at 0 would silently strip a deliberate drawback. Tests with `Number.isFinite`
 * rather than a bare `<=` comparison so a non-finite `modifier` is handled by decision, not by
 * accident of comparison semantics: `NaN <= LLM_ITEM_MODIFIER_MAX` is false (a bare comparison
 * would clamp `NaN` to the ceiling — the maximum bonus for garbage input), and
 * `-Infinity <= LLM_ITEM_MODIFIER_MAX` is true (it would reach the `items.modifier` SQLite column
 * untouched). A non-finite numeric `modifier` (`NaN`, `Infinity`, `-Infinity`) coerces to `0`
 * instead: still a sanctioned value ("Can be 0 for purely narrative items" in the prompt
 * contract), so the item is still granted and the SUCCESS still carries a reward, but no bonus is
 * invented from a malformed number — and dropping the mutation instead would hit the same
 * "SUCCESS with only a stamina cost" problem noted above. Non-numeric/absent `modifier` also
 * passes through untouched — that shape is the validator's job (`validateOne`'s `add_item` case),
 * not this normaliser's.
 *
 * Call this from `finalizeMutations`, immediately before `collapseStackedDeltas` — the seam where
 * every `add_item` arrives via resolve → finalize (see `applyMutations`'s `add_item` case for why
 * this is the single home of the ceiling, not a second clamp there).
 */
export function clampAuthoredItemModifiers(mutations: WorldMutation[]): WorldMutation[] {
  return mutations.map((m) => {
    if (m.type !== 'add_item' || typeof m.modifier !== 'number') {
      return m;
    }
    if (!Number.isFinite(m.modifier)) {
      return { ...m, modifier: 0 };
    }
    if (m.modifier <= LLM_ITEM_MODIFIER_MAX) {
      return m;
    }
    return { ...m, modifier: LLM_ITEM_MODIFIER_MAX };
  });
}

/** Shape-only check for a `RelationEndpoint` — no DB lookup, no name resolution (T2 scope fence;
 *  see the `AuthoredRelation` doc comment above). `pc` carries no name (one PC per action ctx). */
function isValidEndpoint(v: unknown): v is RelationEndpoint {
  if (typeof v !== 'object' || v === null) return false;
  const node = (v as { node?: unknown }).node;
  if (node === 'pc') return true;
  if (node === 'npc' || node === 'location') {
    const name = (v as { name?: unknown }).name;
    return typeof name === 'string' && name.trim() !== '';
  }
  return false;
}

/** Validate the generic edge-shape `props` bag: a flat record of scalars, numbers within the
 *  global clamp. Rejects out-of-range/non-scalar values rather than silently clamping them —
 *  clamp-and-write is a T3/persistence concern (decision 5), this pass only gates the shape. */
function validateRelationProps(opType: string, props: unknown): string | null {
  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    return `${opType} requires a "props" object (flat record of scalars)`;
  }
  for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
    if (typeof value === 'number') {
      if (Number.isNaN(value) || Math.abs(value) > RELATION_NUM_CLAMP) {
        return `${opType} prop "${key}" (${value}) exceeds the ±${RELATION_NUM_CLAMP} clamp`;
      }
    } else if (typeof value !== 'string' && typeof value !== 'boolean') {
      return `${opType} prop "${key}" must be a scalar (number, string, or boolean)`;
    }
  }
  return null;
}

/** Per-`relType` prop schemas (Stage 3 T2) — layered ON TOP of the generic edge-shape check
 *  above (`validateRelationProps`), never replacing it. This is the first writer of the schemas
 *  Stage 2 deferred ("per-`relType` prop schemas... are OUT of scope for this pass", now in
 *  scope): `in_combat` (engine-owned enemy numbers, decision 3) and `combat_save` (the
 *  once-per-day floor, decision 5). Every other whitelisted relType (trust, disposition, ...)
 *  falls through unchanged — only the generic scalar/clamp check applies to them, exactly as
 *  before this stage. */
function validateTypedRelationProps(
  opType: string,
  relType: string,
  props: Record<string, unknown>,
): string | null {
  if (relType === 'in_combat') {
    // Deliberately requires the FULL prop set even for update_relation: combat writers
    // (combat-state.ts) always emit the absolute set_relation shape, never a partial
    // in_combat delta (round would double-sum through updateProps, see combatRoundUpdate),
    // and the LLM never authors in_combat ops (engine-owned, decision 3). A future partial
    // in_combat delta writer would need to relax this by opType.
    const { enemyName, enemyHp, enemyMaxHp, round, mintName } = props as {
      enemyName?: unknown;
      enemyHp?: unknown;
      enemyMaxHp?: unknown;
      round?: unknown;
      mintName?: unknown;
    };
    if (typeof enemyName !== 'string' || enemyName.trim() === '') {
      return `${opType} "in_combat" requires a non-empty "enemyName" string`;
    }
    if (typeof enemyHp !== 'number' || !Number.isFinite(enemyHp)) {
      return `${opType} "in_combat" requires a finite numeric "enemyHp"`;
    }
    if (typeof enemyMaxHp !== 'number' || !Number.isFinite(enemyMaxHp)) {
      return `${opType} "in_combat" requires a finite numeric "enemyMaxHp"`;
    }
    if (typeof round !== 'number' || !Number.isFinite(round)) {
      return `${opType} "in_combat" requires a finite numeric "round"`;
    }
    if (enemyMaxHp < 1 || enemyMaxHp > ENEMY_HP_MAX) {
      return `${opType} "in_combat" prop "enemyMaxHp" (${enemyMaxHp}) must be within [1, ${ENEMY_HP_MAX}]`;
    }
    if (enemyHp < 0 || enemyHp > enemyMaxHp) {
      return `${opType} "in_combat" prop "enemyHp" (${enemyHp}) must be within [0, enemyMaxHp=${enemyMaxHp}]`;
    }
    if (round < 1) {
      return `${opType} "in_combat" prop "round" (${round}) must be >= 1`;
    }
    // `mintName` (RA-3 bounded, see `CombatState.mintName`) is the one optional prop here:
    // absent is legal, so edges already persisted in a live DB keep validating. When present it
    // must be a non-empty string, same shape as `enemyName`.
    if (mintName !== undefined && (typeof mintName !== 'string' || mintName.trim() === '')) {
      return `${opType} "in_combat" prop "mintName" must be a non-empty string when present`;
    }
    return null;
  }

  if (relType === 'combat_save') {
    const savedDay = (props as { savedDay?: unknown }).savedDay;
    if (typeof savedDay !== 'number' || !Number.isFinite(savedDay) || savedDay < 0) {
      return `${opType} "combat_save" requires a finite numeric "savedDay" (>= 0)`;
    }
    return null;
  }

  return null;
}

export function validateMutations(
  mutations: WorldMutation[],
  ctx: MutationContext,
): ValidationResult {
  const errors: MutationError[] = [];

  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];
    const err = validateOne(m, ctx, i);
    if (err) errors.push(err);
  }

  return { valid: errors.length === 0, errors };
}

function validateOne(
  m: WorldMutation,
  ctx: MutationContext,
  index: number,
): MutationError | null {
  if (!MUTATION_TYPES.has(m.type)) {
    return { index, message: `Unknown mutation type: "${m.type}"` };
  }

  switch (m.type) {
    // Relocate ops — see RELOCATE_MUTATION_TYPES above for the shared list; update both if a
    // future alias joins this trio.
    case 'move_to':
    case 'set_location': {
      const name = m.name;
      if (typeof name !== 'string' || name.trim() === '') {
        return { index, message: `${m.type} requires a non-empty "name" string` };
      }
      // Reject locations the world doesn't know about — moving the player to a
      // phantom location leaves /hi and scene lookup with nothing to render.
      if (ctx.knownLocations && ctx.knownLocations.length > 0) {
        const target = name.trim().toLowerCase();
        const match = ctx.knownLocations.some(l => l.trim().toLowerCase() === target);
        if (!match) {
          return { index, message: `${m.type} names an unknown location: "${name}"` };
        }
      }
      return null;
    }
    case 'modify_health': {
      if (typeof m.amount !== 'number' || Number.isNaN(m.amount)) {
        return { index, message: 'modify_health requires a numeric "amount"' };
      }
      const newHealth = ctx.currentHealth + m.amount;
      if (newHealth < 0) {
        return { index, message: `modify_health would reduce health to ${newHealth} (below 0)` };
      }
      if (newHealth > ctx.maxHealth) {
        return { index, message: `modify_health would exceed max_health (${newHealth} > ${ctx.maxHealth})` };
      }
      return null;
    }
    case 'modify_stamina': {
      if (typeof m.amount !== 'number' || Number.isNaN(m.amount)) {
        return { index, message: 'modify_stamina requires a numeric "amount"' };
      }
      if (ctx.stamina + m.amount < 0) {
        return { index, message: `modify_stamina would reduce stamina below 0` };
      }
      return null;
    }
    case 'modify_max_stamina': {
      if (typeof m.amount !== 'number' || Number.isNaN(m.amount)) {
        return { index, message: 'modify_max_stamina requires a numeric "amount"' };
      }
      if (ctx.maxStamina + m.amount < 1) {
        return { index, message: `modify_max_stamina would reduce max stamina to ${ctx.maxStamina + m.amount} (below 1)` };
      }
      return null;
    }
    case 'modify_wealth': {
      if (typeof m.amount !== 'number' || Number.isNaN(m.amount)) {
        return { index, message: 'modify_wealth requires a numeric "amount"' };
      }
      if (ctx.wealth + m.amount < 0) {
        return { index, message: `modify_wealth would reduce wealth below 0` };
      }
      return null;
    }
    case 'modify_rolls_remaining': {
      if (typeof m.amount !== 'number' || Number.isNaN(m.amount)) {
        return { index, message: 'modify_rolls_remaining requires a numeric "amount"' };
      }
      if (ctx.rollsRemaining + m.amount < 0) {
        return { index, message: `modify_rolls_remaining would reduce rolls below 0` };
      }
      return null;
    }
    case 'add_item': {
      if (typeof m.name !== 'string' || m.name.trim() === '') {
        return { index, message: 'add_item requires a non-empty "name" string' };
      }
      if (typeof m.emoji !== 'string') {
        return { index, message: 'add_item requires an "emoji" string' };
      }
      if (typeof m.stat !== 'string') {
        return { index, message: 'add_item requires a "stat" string' };
      }
      if (typeof m.modifier !== 'number') {
        return { index, message: 'add_item requires a numeric "modifier"' };
      }
      return null;
    }
    case 'remove_item': {
      if (typeof m.name !== 'string' || m.name.trim() === '') {
        return { index, message: 'remove_item requires a non-empty "name" string' };
      }
      if (m.quantity !== undefined && (typeof m.quantity !== 'number' || m.quantity < 1)) {
        return { index, message: 'remove_item "quantity" must be a number >= 1 when present' };
      }
      return null;
    }
    case 'add_npc':
    case 'spawn_npc': {
      if (typeof m.name !== 'string' || m.name.trim() === '') {
        return { index, message: `${m.type} requires a non-empty "name" string` };
      }
      return null;
    }
    case 'update_npc': {
      if (typeof m.npcId !== 'number' || !Number.isInteger(m.npcId) || m.npcId <= 0) {
        return { index, message: 'update_npc requires a positive integer "npcId" (resolved from handle by gateway; 0 means unknown handle)' };
      }
      return null;
    }
    case 'remove_npc': {
      if (typeof m.npcId !== 'number' || !Number.isInteger(m.npcId) || m.npcId <= 0) {
        return { index, message: 'remove_npc requires a positive integer "npcId" (resolved from handle by gateway; 0 means unknown handle)' };
      }
      return null;
    }
    case 'reveal_location': {
      if (typeof m.name !== 'string' || m.name.trim() === '') {
        return { index, message: 'reveal_location requires a non-empty "name" string' };
      }
      return null;
    }
    case 'cross_frontier': {
      // Shape only — the engine (applyGeography) does the graph-level validation
      // (that this direction is a real unbound frontier on the current node) and
      // mints/binds before this runs, normalizing name/direction.
      if (typeof m.direction !== 'string' || m.direction.trim() === '') {
        return { index, message: 'cross_frontier requires a non-empty "direction" string' };
      }
      if (typeof m.name !== 'string' || m.name.trim() === '') {
        return { index, message: 'cross_frontier requires a non-empty "name" string' };
      }
      return null;
    }
    case 'set_relation':
    case 'update_relation': {
      if (!isValidEndpoint(m.from)) {
        return { index, message: `${m.type} requires a well-formed "from" Endpoint ({node:'pc'} | {node:'npc',name} | {node:'location',name})` };
      }
      if (!isValidEndpoint(m.to)) {
        return { index, message: `${m.type} requires a well-formed "to" Endpoint ({node:'pc'} | {node:'npc',name} | {node:'location',name})` };
      }
      if (typeof m.relType !== 'string' || m.relType.trim() === '' || !RELATION_TYPE_WHITELIST.has(m.relType)) {
        return { index, message: `${m.type} "relType" must be one of the seed whitelist: ${[...RELATION_TYPE_WHITELIST].join(', ')} (got "${String(m.relType)}")` };
      }
      const propsErr = validateRelationProps(m.type, m.props);
      if (propsErr) return { index, message: propsErr };
      const typedErr = validateTypedRelationProps(m.type, m.relType, m.props as Record<string, unknown>);
      if (typedErr) return { index, message: typedErr };
      return null;
    }
  }

  return null;
}

export function applyMutations(
  mutations: WorldMutation[],
  ctx: MutationContext,
): AppliedState {
  const state: AppliedState = {
    ...ctx,
    itemsToAdd: [],
    itemsToRemove: [],
    npcsToAdd: [],
    npcsToUpdate: [],
    npcsToRemove: [],
    locationsToReveal: [],
    relationsToSet: [],
    relationsToUpdate: [],
  };

  for (const m of mutations) {
    switch (m.type) {
      // Relocate ops — see RELOCATE_MUTATION_TYPES above for the shared list.
      case 'move_to':
      case 'set_location':
      case 'cross_frontier': {
        // All three relocate the character. By the time this runs, the engine
        // (applyGeography) has already minted + bound any frontier destination and
        // normalized the name, so cross_frontier resolves identically to move_to.
        const requested = String(m.name ?? ctx.location);
        // Snap to the canonical casing of a known location so the (case-sensitive)
        // DB lookup in getLocation resolves. Falls back to the requested string.
        const canonical = ctx.knownLocations?.find(
          l => l.trim().toLowerCase() === requested.trim().toLowerCase(),
        );
        state.location = canonical ?? requested;
        break;
      }
      case 'modify_health':
        state.currentHealth = Math.max(0, Math.min(state.maxHealth,
          state.currentHealth + Number(m.amount ?? 0)));
        break;
      case 'modify_max_stamina':
        state.maxStamina = Math.max(1, state.maxStamina + Number(m.amount ?? 0));
        // Clamp current stamina to the new ceiling
        state.stamina = Math.min(state.stamina, state.maxStamina);
        break;
      case 'modify_stamina':
        state.stamina = Math.max(0, Math.min(state.maxStamina, state.stamina + Number(m.amount ?? 0)));
        break;
      case 'modify_wealth':
        state.wealth = Math.max(0, state.wealth + Number(m.amount ?? 0));
        break;
      case 'modify_rolls_remaining':
        state.rollsRemaining = Math.max(0, state.rollsRemaining + Number(m.amount ?? 0));
        break;
      case 'add_item':
        // RA-1 Stage 1: the ceiling is enforced in `finalizeMutations` (`clampAuthoredItemModifiers`),
        // not here. The terminal resolve path is the only route that currently produces `add_item`,
        // and it does go through finalize; the non-terminal beat branch calls this applier directly,
        // with no finalize in between. Anything that adds `add_item` to a non-terminal beat must
        // route it through the clamp first. Do not add a second clamp here.
        state.itemsToAdd.push({
          name: String(m.name ?? ''),
          emoji: String(m.emoji ?? ''),
          stat: String(m.stat ?? 'physical'),
          modifier: Number(m.modifier ?? 0),
          quantity: Number(m.quantity ?? 1),
        });
        break;
      case 'remove_item':
        state.itemsToRemove.push({
          name: String(m.name ?? ''),
          quantity: Math.max(1, Number(m.quantity ?? 1)),
        });
        break;
      case 'add_npc':
      case 'spawn_npc':
        state.npcsToAdd.push({
          name: String(m.name ?? ''),
          ...(m.class !== undefined ? { class: String(m.class) } : {}),
          ...(m.description !== undefined ? { description: String(m.description) } : {}),
          ...(m.race !== undefined ? { race: String(m.race) } : {}),
          ...(m.homeLocation !== undefined ? { homeLocation: String(m.homeLocation) } : {}),
          // RA-3 bounded: carries the surviving foe's HP for the engine-authored mint.
          // `npcRepo.create` already accepted `health`; only this copy was missing.
          ...(m.health !== undefined ? { health: Number(m.health) } : {}),
          // Honoured by the applier ahead of its `applied.location` fallback — see the
          // `npcsToAdd` shape comment above.
          ...(m.location !== undefined ? { location: String(m.location) } : {}),
        });
        break;
      case 'update_npc':
        state.npcsToUpdate.push({
          npcId: Number(m.npcId),
          ...(m.description !== undefined ? { description: String(m.description) } : {}),
          ...(m.location !== undefined ? { location: String(m.location) } : {}),
          ...(m.class !== undefined ? { class: String(m.class) } : {}),
          ...(m.race !== undefined ? { race: String(m.race) } : {}),
        });
        break;
      case 'remove_npc':
        state.npcsToRemove.push({ npcId: Number(m.npcId) });
        break;
      case 'reveal_location':
        state.locationsToReveal.push({
          name: String(m.name ?? ''),
          ...(m.direction !== undefined ? { direction: String(m.direction) } : {}),
          ...(m.isSafe !== undefined ? { isSafe: Number(m.isSafe) } : {}),
          ...(m.description !== undefined ? { description: String(m.description) } : {}),
        });
        break;
      case 'set_relation':
        state.relationsToSet.push(toAuthoredRelation(m));
        break;
      case 'update_relation':
        state.relationsToUpdate.push(toAuthoredRelation(m));
        break;
    }
  }

  return state;
}

/** Carry a `set_relation`/`update_relation` mutation into `AuthoredRelation` shape, endpoints AS
 *  AUTHORED (no DB lookup, no npc-name→id resolution — mirrors `update_npc`/`remove_npc` trusting
 *  their already-validated/pre-resolved input; see the doc comment above `AuthoredRelation`). */
function toAuthoredRelation(m: WorldMutation): AuthoredRelation {
  return {
    from: m.from as RelationEndpoint,
    to: m.to as RelationEndpoint,
    relType: String(m.relType ?? ''),
    props: (m.props && typeof m.props === 'object' ? m.props as Record<string, number | string | boolean> : {}),
  };
}
