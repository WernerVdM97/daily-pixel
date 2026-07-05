/**
 * Stage 2 T5a — the shared geography-finalize logic, extracted out of `WorldEngineImpl` so the
 * live engine and the pipeline sim can share ONE implementation (no drift between two
 * mint/route/validate copies). `WorldEngineImpl` delegates its `finalizeMutations` /
 * `applyGeography` / `resolveCrossFrontier` / `routeBetween` bodies here, closed over the two
 * repos that were their only instance coupling (`LocationRepository` + `LocationEdgeRepository`).
 * Behaviour-preserving: every function body below is verbatim from `WorldEngineImpl.ts` except
 * `this.locationRepo`/`this.edgeRepo` → `deps.*` and `this.routeBetween`/`this.resolveCrossFrontier`
 * → the module-local functions.
 */
import type { LocationRepository } from "../db/repositories/location.js";
import type { LocationEdgeRepository } from "../db/repositories/locationEdge.js";
import {
  collapseStackedDeltas,
  validateMutations,
  type MutationContext,
} from "./action/mutations.js";
import { findRoute } from "./geography.js";
import { sanitizeAuthored } from "./authored-text.js";
import type { WorldMutation, TravelRoute } from "./WorldEngine.js";

/** The home region every new player starts having discovered (§3). Matches the
 *  `region` the seed world (assets/world/locations.yml) gives the Vale. New
 *  ground gets other regions and stays fogged until explored. */
export const HOME_REGION = "The Vale";

/** Least-cost route over the shared graph (Dijkstra on edge difficulty); null when
 *  unreachable (§2). The cost is computed but not charged as stamina yet — that's
 *  deferred to fast-travel (§9). Used today to validate movement reachability.
 *
 *  Module-local so both `WorldEngineImpl.routeBetween` (public API, unchanged signature) and
 *  `createGeographyFinalize`'s internal `applyGeography` reachability check share one body. */
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
 * Resolve one `cross_frontier` mutation against the shared graph. Returns the kept mutation
 * (a normalized `cross_frontier` on a first mint, or a `set_location` when the exit was already
 * bound), or null when the exit is missing / unbound-but-unnamed. Mutates `known` + `minted`
 * on a successful mint.
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
  // First crosser: mint the destination + bind the frontier (shared thereafter).
  // Seed its region from the place it was crossed from (fallback the home region)
  // so it's never region-less on /map even before the cartographer charts it; the
  // cartographer may reassign a new region on enrichment if the fiction moves on.
  const fromRegion = deps.locationRepo.findByName(currentLocation)?.region ?? HOME_REGION;
  deps.locationRepo.create({
    name: proposed,
    description: "An uncharted place, newly crossed into. (Mapping…)",
    isSafe: 0,
    enrichmentPending: 1,
    region: fromRegion,
  });
  if (!deps.edgeRepo.bindFrontier(currentLocation, direction, proposed)) {
    // The exit got bound between our find() and bind() (only possible if a future
    // refactor makes this path re-entrant). Don't narrate a mint that didn't take —
    // arrive at whatever shared destination won the bind. The provisional row we just
    // INSERT-OR-IGNOREd is left unreferenced and harmless (no edge → never rendered).
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
 * Engine-owned geographic resolution (per-player-map-exploration §2). Replaces the
 * old lazy-create-on-any-set_location with graph-validated movement:
 * - `move_to`/`set_location` to anywhere NOT already known (seed set + minted this
 *   turn) or not reachable via `routeBetween` from the current node is
 *   DROPPED (the player simply doesn't move) — no more minting from thin air.
 * - `cross_frontier { direction, name }` is the ONLY mint path. If `direction` is a
 *   real **unbound** frontier exit on the current node, mint the named destination
 *   (provisional, enrichment_pending → cartographer charts the rest) and bind the
 *   exit (shared thereafter). If the exit is **already bound** (a prior crosser got
 *   there first), arrive at that shared destination instead of minting a duplicate.
 *   No matching frontier → dropped.
 *
 * Returns the filtered mutation list (cross_frontier normalized to the resolved
 * destination name) and the names minted this turn (for the async cartographer).
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

  // Pass 1 — resolve frontier crossings first (mint + bind), so a same-action
  // set_location to a just-minted place validates in pass 2 regardless of the order
  // the LLM emitted the two mutations in. Each cross maps to its resolved replacement
  // (a set_location/cross_frontier), or null when dropped; `known`/`minted` grow here.
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

// ── Category → mutation map (§4 / §5 soft enforcement) ──

/**
 * Expected mutation types per action category. Used to:
 *  a) generate the §4 recipe section in the prompt (single source of truth)
 *  b) flag unexpected mutations at runtime (§5 telemetry — always applied, never dropped)
 */
export const CATEGORY_MUTATION_MAP: Record<string, string[]> = {
  // Stage 2 T2: set_relation/update_relation added to categories matching the seed relType
  // whitelist's near-term writers ([[prompt-v12-scene-state]] graph model) — combat's
  // `in_combat`, social's `trust`/`disposition`/`knows_secret`/`fears`/`owes_debt`, skill/search's
  // `puzzle`. Pipeline-only ops in this pass (decision 1) — no live-path LLM emits them yet, so
  // this is additive telemetry config, not a behaviour change for existing ops.
  combat:  ['modify_stamina', 'modify_health', 'add_item', 'update_npc', 'remove_npc', 'set_relation', 'update_relation'],
  travel:  ['move_to', 'cross_frontier', 'modify_stamina', 'add_npc', 'add_item'],
  social:  ['modify_wealth', 'add_npc', 'update_npc', 'add_item', 'remove_item', 'set_relation', 'update_relation'],
  skill:   ['modify_stamina', 'modify_max_stamina', 'modify_rolls_remaining', 'set_relation', 'update_relation'],
  search:  ['add_item', 'modify_stamina', 'set_relation', 'update_relation'],
  rest:    ['modify_health', 'modify_stamina', 'modify_rolls_remaining'],
  other:   [], // catch-all — anything goes; never flag
};

/** Log unexpected mutations for a given category (§5 telemetry). Flag-only, never dropped.
 *  Co-located here (T5a follow-up) next to its sole caller, `finalizeMutations` below — no
 *  other module references either this or `CATEGORY_MUTATION_MAP` above. */
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
 * Deterministic mutation finalize: geography → collapse → validate (Thread D Task 3's
 * extraction of `applyResolution`'s inline steps, so the pipeline machine's D5b inversion can
 * call the same logic ahead of narration). "Pure" is read narrowly here — it never persists an
 * action's health/wealth/rolls/action-row — but `applyGeography`/`resolveCrossFrontier`'s
 * pre-existing frontier-mint DB write (a `locations` row + a bound `location_edges` row on a
 * first crossing) is untouched live behaviour, not a resolution-level persist, so it stays.
 */
function finalizeMutations(
  deps: { locationRepo: LocationRepository; edgeRepo: LocationEdgeRepository },
  proposed: WorldMutation[],
  ctx: MutationContext,
  category?: string,
): { mutations: WorldMutation[]; minted: string[] } {
  const geo = applyGeography(deps, ctx.location, proposed, ctx.knownLocations ?? []);

  // Validation must see the just-minted names (mirrors applyResolution's prior inline
  // `knownLocations: [...knownLocations, ...provisionalLocations]`) so a same-turn move_to
  // into freshly-crossed ground isn't rejected as unknown.
  const validationCtx: MutationContext = {
    ...ctx,
    knownLocations: [...(ctx.knownLocations ?? []), ...geo.minted],
  };

  // §5a stacked-delta clamp: collapse same-axis scalar deltas before validation so
  // the validator sees the already-summed (and capped) set, not individual −1/−2 pairs.
  const collapsed = collapseStackedDeltas(geo.mutations);

  // §5 category deviation telemetry: log when a mutation falls outside its category's
  // expected set. Flag-only — never dropped (emergent scenes are legitimate). Must run on the
  // collapsed set BEFORE validation drops anything, so a mutation that deviates AND later gets
  // dropped for being malformed is still flagged (matches pre-extraction ordering).
  if (category) {
    logCategoryDeviations(category, collapsed);
  }

  // Per spec: malformed mutations are silently dropped, valid ones applied.
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
 * Build the shared geography-finalize function over a `LocationRepository` +
 * `LocationEdgeRepository` pair (T5a). `WorldEngineImpl` closes this over its own repos; the
 * pipeline sim (T5b) closes it over a seeded `:memory:` world's repos — one implementation,
 * two callers, no drift between a live-engine copy and a pipeline copy of mint/route/validate.
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
