import type { WorldMutation } from '../WorldEngine.js';

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
  /** v11: add_npc (create-only). Legacy spawn_npc maps here. */
  npcsToAdd: Array<{ name: string; class?: string; description?: string; race?: string; homeLocation?: string }>;
  /** v11: update_npc — handle already resolved to npcId by the gateway. */
  npcsToUpdate: Array<{ npcId: number; description?: string; location?: string; class?: string; race?: string }>;
  /** v11: remove_npc — handle already resolved to npcId by the gateway. */
  npcsToRemove: Array<{ npcId: number }>;
  /** v11: reveal_location — authors a frontier exit at the current location. */
  locationsToReveal: Array<{ name: string; direction?: string; isSafe?: number; description?: string }>;
}

/** v11 vocabulary — active types accepted by the validator. */
const MUTATION_TYPES = new Set([
  'move_to',
  'set_location',   // legacy alias — accepted, treated identically to move_to
  'cross_frontier',
  'modify_health',
  'modify_stamina',
  'modify_max_stamina',
  'modify_wealth',
  'modify_rolls_remaining',
  'add_item',
  'remove_item',
  'add_npc',
  'spawn_npc',      // legacy alias — accepted, treated identically to add_npc
  'update_npc',
  'remove_npc',
  'reveal_location',
]);

/** Per-axis stacked-delta caps (§5a guard 1). Applied by collapseStackedDeltas. */
const STAMINA_DELTA_CAP = -5;
const HEALTH_DELTA_CAP = -4;

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
  };

  for (const m of mutations) {
    switch (m.type) {
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
    }
  }

  return state;
}
