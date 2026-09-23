/**
 * The shared mint/route/validate geography logic, so the live engine and the pipeline sim cannot
 * drift: `WorldEngineImpl` delegates its four bodies here, closed over the two location repos.
 */
import type { LocationRepository } from "../db/repositories/location.js";
import type { LocationEdgeRepository } from "../db/repositories/locationEdge.js";
import {
  clampAuthoredItemModifiers,
  collapseStackedDeltas,
  validateMutations,
  type MutationContext,
} from "./action/mutations.js";
import { findRoute } from "./geography.js";
import { sanitizeAuthored } from "./authored-text.js";
import type { WorldMutation, TravelRoute } from "./WorldEngine.js";

/** The home region every player starts having discovered, matching the `region` the seed world
 *  (assets/world/locations.yml) gives the Vale. Other regions stay fogged until explored. */
export const HOME_REGION = "The Vale";

/** Least-cost route over the shared graph; null when unreachable. The cost is computed but not
 *  charged as stamina. Module-local so the public API and the reachability check share one body. */
export function routeBetween(
  edgeRepo: LocationEdgeRepository,
  from: string,
  to: string,
): TravelRoute | null {
  return findRoute(from, to, (name) =>
    edgeRepo.neighbours(name).map((n) => ({ name: n.name, difficulty: n.difficulty })),
  );
}

/**
 * Resolve one `cross_frontier` mutation: a normalised `cross_frontier` on a first mint, a
 * `set_location` when the exit was already bound, else null. `known`/`minted` grow on a mint.
 */
function resolveCrossFrontier(
  deps: { locationRepo: LocationRepository; edgeRepo: LocationEdgeRepository },
  m: WorldMutation,
  currentLocation: string,
  known: Set<string>,
  minted: string[],
): WorldMutation | null {
  const direction = typeof m.direction === "string" ? m.direction.trim().toUpperCase() : "";
  // Sanitize the LLM-coined name before it becomes a DB key rendered into markdown + prompts.
  const proposed = typeof m.name === "string" ? sanitizeAuthored(m.name) : "";
  const edge = direction ? deps.edgeRepo.find(currentLocation, direction) : undefined;
  if (!edge) {
    console.warn(`[engine] dropping cross_frontier ${direction} from "${currentLocation}" — no such exit`);
    return null;
  }
  if (edge.to_location !== null) {
    // A prior crosser already bound this exit — arrive at the shared place,
    // ignoring the LLM's proposed name (we never re-mint or rename).
    return { type: "set_location", name: edge.to_location };
  }
  if (proposed === "") {
    console.warn(`[engine] dropping cross_frontier ${direction} from "${currentLocation}" — no destination name`);
    return null;
  }
  // First crosser: mint the destination and bind the exit; seed its region from the crossing place so
  // it is never region-less on /map before the cartographer charts it, which may reassign it.
  const fromRegion = deps.locationRepo.findByName(currentLocation)?.region ?? HOME_REGION;
  deps.locationRepo.create({
    name: proposed,
    description: "An uncharted place, newly crossed into. (Mapping…)",
    isSafe: 0,
    enrichmentPending: 1,
    region: fromRegion,
  });
  if (!deps.edgeRepo.bindFrontier(currentLocation, direction, proposed)) {
    // The exit got bound between the find and the bind. Defensive today: only a future refactor
    // making this path re-entrant can reach it. No mint is narrated; the provisional row stays unreferenced and harmless.
    const settled = deps.edgeRepo.find(currentLocation, direction)?.to_location;
    console.warn(`[engine] cross_frontier ${direction} from "${currentLocation}" lost the bind — arriving at "${settled}"`);
    return settled ? { type: "set_location", name: settled } : null;
  }
  minted.push(proposed);
  known.add(proposed.toLowerCase());
  console.log(`[location] frontier crossed: minted "${proposed}" (${direction} of "${currentLocation}")`);
  return { type: "cross_frontier", direction, name: proposed };
}

/**
 * Graph-validated movement: an unknown or unreachable destination is DROPPED, never minted, and
 * `cross_frontier` on a real unbound exit is the only mint path. Returns the kept list plus the names minted this turn.
 */
function applyGeography(
  deps: { locationRepo: LocationRepository; edgeRepo: LocationEdgeRepository },
  currentLocation: string,
  mutations: WorldMutation[],
  knownLocations: string[],
): { mutations: WorldMutation[]; minted: string[] } {
  const known = new Set(knownLocations.map((n) => n.trim().toLowerCase()));
  const currentNorm = currentLocation.trim().toLowerCase();
  const minted: string[] = [];

  // Pass 1 — resolve crossings first (mint + bind), so a same-action `set_location` into just-minted
  // ground validates in pass 2 whatever order the LLM emitted them in.
  const crossResolved = new Map<WorldMutation, WorldMutation | null>();
  for (const m of mutations) {
    if (m.type !== "cross_frontier") continue;
    crossResolved.set(m, resolveCrossFrontier(deps, m, currentLocation, known, minted));
  }

  // Pass 2 — build the kept list in original order; move_to/set_location now sees the full
  // known set (seed locations + anything minted this turn).
  const kept: WorldMutation[] = [];
  for (const m of mutations) {
    if (m.type === "cross_frontier") {
      const resolved = crossResolved.get(m);
      if (resolved) kept.push(resolved);
    } else if (m.type === "move_to" || m.type === "set_location") {
      const name = typeof m.name === "string" ? m.name.trim() : "";
      if (name === "") {
        kept.push(m); // shape-invalid — let validateMutations report/drop it
        continue;
      }
      const norm = name.toLowerCase();
      // Canonicalize to the known casing so the (case-sensitive) graph route resolves
      // an LLM-lowercased name like "town square".
      const canonical = knownLocations.find((l) => l.trim().toLowerCase() === norm) ?? name;
      const reachable =
        norm === currentNorm ||
        (known.has(norm) && routeBetween(deps.edgeRepo, currentLocation, canonical) !== null);
      if (!reachable) {
        console.warn(
          `[engine] dropping ${m.type} to unreachable/unknown "${name}" — movement is graph-validated (no lazy-create)`,
        );
        continue;
      }
      kept.push(m);
    } else {
      kept.push(m);
    }
  }

  return { mutations: kept, minted };
}

// ── Category → mutation map ──

/**
 * Expected mutation types per action category, for the deviation telemetry below: a mutation
 * outside its category's set is logged, never dropped.
 */
export const CATEGORY_MUTATION_MAP: Record<string, string[]> = {
  // add_npc: the engine mints a named-but-unresolved foe that survived the fight, not a deviation.
  combat:  ['modify_stamina', 'modify_health', 'add_item', 'add_npc', 'update_npc', 'remove_npc', 'set_relation', 'update_relation'],
  travel:  ['move_to', 'cross_frontier', 'modify_stamina', 'add_npc', 'add_item'],
  social:  ['modify_wealth', 'add_npc', 'update_npc', 'add_item', 'remove_item', 'set_relation', 'update_relation'],
  skill:   ['modify_stamina', 'modify_max_stamina', 'modify_rolls_remaining', 'set_relation', 'update_relation'],
  search:  ['add_item', 'modify_stamina', 'set_relation', 'update_relation'],
  rest:    ['modify_health', 'modify_stamina', 'modify_rolls_remaining'],
  other:   [], // catch-all — anything goes; never flag
};

/** Log unexpected mutations for a given category. Flag-only — never dropped. */
function logCategoryDeviations(category: string, mutations: WorldMutation[]): void {
  const expected = CATEGORY_MUTATION_MAP[category];
  if (!expected) return; // unknown category — skip
  if (expected.length === 0) return; // 'other' — catch-all

  for (const m of mutations) {
    if (!expected.includes(m.type)) {
      console.log(
        `[category-telemetry] unexpected mutation "${m.type}" on category "${category}" — flagged for tuning`,
      );
    }
  }
}

/**
 * Deterministic mutation finalize: geography → collapse → validate. "Pure" is read narrowly — it
 * persists no action's health/wealth/rolls/action-row, while a first crossing's frontier mint stays.
 */
function finalizeMutations(
  deps: { locationRepo: LocationRepository; edgeRepo: LocationEdgeRepository },
  proposed: WorldMutation[],
  ctx: MutationContext,
  category?: string,
): { mutations: WorldMutation[]; minted: string[] } {
  const geo = applyGeography(deps, ctx.location, proposed, ctx.knownLocations ?? []);

  // Validation must see the just-minted names, or a same-turn move into freshly crossed ground is
  // rejected as unknown.
  const validationCtx: MutationContext = {
    ...ctx,
    knownLocations: [...(ctx.knownLocations ?? []), ...geo.minted],
  };

  // Clamp over-limit `add_item.modifier` here, not in the applier: the prompt's final-mutations block,
  // the `applied_mutations` audit column and the persisted item row must agree on the landed number.
  const itemClamped = clampAuthoredItemModifiers(geo.mutations);

  // Collapse same-axis scalar deltas before validation, so the validator sees the summed and capped
  // set rather than the individual deltas.
  const collapsed = collapseStackedDeltas(itemClamped);

  // Category-deviation telemetry runs on the collapsed set BEFORE validation drops anything, so a
  // mutation that deviates and is later dropped as malformed is still flagged.
  if (category) {
    logCategoryDeviations(category, collapsed);
  }

  // Malformed mutations are dropped, valid ones applied.
  let mutations = collapsed;
  const validation = validateMutations(collapsed, validationCtx);
  if (!validation.valid) {
    console.warn(
      "[engine] Dropping invalid mutations:",
      validation.errors.map((e) => `[${e.index}] ${e.message}`).join("; "),
    );
    const invalidIndices = new Set(validation.errors.map((e) => e.index));
    mutations = collapsed.filter((_, i) => !invalidIndices.has(i));
  }

  return { mutations, minted: geo.minted };
}

/**
 * Builds the shared geography-finalize function over a location + edge repo pair: one
 * implementation, two callers (the live engine and the pipeline sim), so the two cannot drift.
 */
export function createGeographyFinalize(deps: {
  locationRepo: LocationRepository;
  edgeRepo: LocationEdgeRepository;
}): (
  proposed: WorldMutation[],
  ctx: MutationContext,
  category?: string,
) => { mutations: WorldMutation[]; minted: string[] } {
  return (proposed, ctx, category) => finalizeMutations(deps, proposed, ctx, category);
}
