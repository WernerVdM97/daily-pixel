/** Mid-action state auto-times out after this (30 min). */
const ACTION_TIMEOUT_MS = 30 * 60 * 1000;

/** The home region every new player starts having discovered (§3). Matches the
 *  `region` the seed world (assets/world/locations.yml) gives the Vale. New
 *  ground gets other regions and stays fogged until explored. */
const HOME_REGION = "The Vale";

/** Map §4 spoke cap: a node never sprouts more than this many outgoing spokes
 *  (charted edges + frontier exits), so the graph can't fan out without bound. */
const SPOKE_CAP = 5;

import type Database from "better-sqlite3";
import type { LlmGateway, CartographerGateway, CriticGateway } from "../llm/LlmGateway.js";
import { CritiquedLlmGateway } from "../llm/CritiquedLlmGateway.js";
import type { UserRepository } from "../db/repositories/user.js";
import type {
  CharacterRepository,
  CharacterRow,
} from "../db/repositories/character.js";
import type { ItemRepository } from "../db/repositories/item.js";
import type { ActionRepository } from "../db/repositories/action.js";
import type { NpcRepository } from "../db/repositories/npc.js";
import { LocationRepository } from "../db/repositories/location.js";
import { LocationEdgeRepository } from "../db/repositories/locationEdge.js";
import { CharacterLocationRepository } from "../db/repositories/characterLocation.js";
import { MetaRepository } from "../db/repositories/meta.js";
import { findRoute } from "./geography.js";
import { LlmCallRepository } from "../db/repositories/llm-call.js";
import {
  FallbackLlmGateway,
  DIVINE_INTERVENTION_TYPE,
  DIVINE_MESSAGE,
} from "../llm/FallbackLlmGateway.js";
import { PROMPT_VERSION } from "../llm/prompt-builder.js";
import { APP_VERSION } from "../version.js";
import {
  ActionStateMachine,
  type InternalActionState,
  type WorldContextResolver,
} from "./action/machine.js";
import { validateMutations, applyMutations } from "./action/mutations.js";
import { effectiveStats } from "./action/dc.js";
import {
  computeStats,
  type ClassDef,
  type ModifierDef,
} from "./StatComputer.js";
import type {
  WorldEngine,
  CharCreateData,
  CharacterData,
  ActionStartResult,
  ActionStepResult,
  ActionResumeResult,
  ActionOutcome,
  ActionDecisionRecord,
  ActionKind,
  WorldMutation,
  NearbyEntity,
  LocationInfo,
  ItemData,
  JournalData,
  DiscoveredGraph,
  TravelRoute,
  LocationExits,
  TickResult,
  NpcMovement,
  StatBlock,
  Leaderboards,
  WeeklyActionSummary,
} from "./WorldEngine.js";

/** Daily rolls granted at creation and refreshed each tick. */
const DAILY_ROLL_ALLOWANCE = 3;

/** Extra rolls granted on the Saturday tick. */
const SATURDAY_BONUS_ROLLS = 1;

// ── Seeded RNG helpers ──

/** mulberry32 PRNG — deterministic, seedable. */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic random integer in [min, max] using a distinct seed. */
function seededRandomRange(seed: number, min: number, max: number): number {
  const rng = mulberry32(seed);
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Check if a comma-separated tags string contains the given tag. */
function locationTagsContain(tags: string | null, tag: string): boolean {
  if (!tags) return false;
  return tags
    .split(",")
    .map((t) => t.trim())
    .includes(tag);
}

// ── Mutation insight logging ──

/** Subset of CharacterRow read for the before→after diff. */
type AppliedStateView = {
  currentHealth: number;
  stamina: number;
  maxStamina: number;
  wealth: number;
  rollsRemaining: number;
  location: string;
};

/** Compact summary of one mutation, e.g. `wealth+5`, `→Town Square`, `+item:Rabbit Pelt`. */
function summariseMutation(m: WorldMutation): string {
  switch (m.type) {
    case "set_location":
      return `→${String(m.name ?? "?")}`;
    case "add_item":
      return `+item:${String(m.name ?? "?")}`;
    case "remove_item":
      return `-item:${String(m.name ?? "?")}`;
    case "spawn_npc":
      return `npc:${String(m.name ?? "?")}`;
    default: {
      // modify_* — show the signed amount against the trimmed stat name.
      const stat = m.type.replace(/^modify_/, "");
      const amt = Number(m.amount ?? 0);
      return `${stat}${amt >= 0 ? "+" : ""}${amt}`;
    }
  }
}

/** Only the character fields that changed, as `before→after` pairs. */
function stateDeltas(before: CharacterRow, after: AppliedStateView): string {
  const parts: string[] = [];
  if (after.currentHealth !== before.health)
    parts.push(`hp ${before.health}→${after.currentHealth}`);
  if (after.stamina !== before.stamina)
    parts.push(`sta ${before.stamina}→${after.stamina}`);
  if (after.maxStamina !== before.max_stamina)
    parts.push(`maxSta ${before.max_stamina}→${after.maxStamina}`);
  if (after.wealth !== before.wealth)
    parts.push(`wealth ${before.wealth}→${after.wealth}`);
  if (after.rollsRemaining !== before.rolls_remaining)
    parts.push(`rolls ${before.rolls_remaining}→${after.rollsRemaining}`);
  if (after.location !== before.location)
    parts.push(`loc ${before.location}→${after.location}`);
  return parts.join(", ") || "no state change";
}

/** One always-on log line per resolved action (mutations applied + net state delta),
 *  so anomalies like a roll handed back via modify_rolls_remaining stay greppable. */
function logAppliedMutations(
  characterId: number,
  outcome: ActionOutcome,
  before: CharacterRow,
  after: AppliedStateView,
): void {
  const roll =
    outcome.playerRolled != null
      ? `roll=${outcome.playerRolled}${outcome.rollBonus ? `+${outcome.rollBonus}` : ""} vs DC${outcome.finalDc}`
      : "no-roll";
  const muts =
    outcome.mutations.length > 0
      ? outcome.mutations.map(summariseMutation).join(", ")
      : "none";
  const call =
    outcome.llmCallId !== undefined ? ` call=${outcome.llmCallId}` : "";
  console.log(
    `[mutations] char=${characterId} ${outcome.distilledType}/${outcome.outcome} ${roll}${call} | ` +
      `applied: ${muts} | net: ${stateDeltas(before, after)}`,
  );
}

interface WorldEngineConfig {
  db: Database.Database;
  llm: LlmGateway;
  userRepo: UserRepository;
  charRepo: CharacterRepository;
  itemRepo: ItemRepository;
  actionRepo: ActionRepository;
  npcRepo: NpcRepository;
  rollD20?: () => number;
  /** D3 async world-builder: enriches new provisional locations (is_safe + description)
   *  off the critical path. Absent in tests / without an LLM key — row stays provisional. */
  cartographer?: CartographerGateway;
  /** Coherence critic (Thread 2, opt-in): decision beats critiqued via CritiquedLlmGateway,
   *  resolution beats via the machine hook. Absent = disabled. */
  critic?: CriticGateway;
  /** YAML asset data for stat computation. Injected so engine stays presentation-free. */
  classDefs?: ClassDef[];
  upbringingDefs?: ModifierDef[];
  raceDefs?: ModifierDef[];
  /** Day-job name → base_income for daily tick. Injected from parsed day-jobs.yml. */
  dayJobIncome?: Record<string, number>;
  /** Item sets from item-sets.yml — matched by name to assign starting items. */
  itemSets?: Array<{
    name: string;
    for_classes: string[];
    items: Array<{
      name: string;
      emoji: string;
      stat: string;
      modifier: number;
      quantity?: number;
    }>;
  }>;
}

export class WorldEngineImpl implements WorldEngine {
  private db: Database.Database;
  private userRepo: UserRepository;
  private charRepo: CharacterRepository;
  private itemRepo: ItemRepository;
  private actionRepo: ActionRepository;
  private npcRepo: NpcRepository;
  private locationRepo: LocationRepository;
  private edgeRepo: LocationEdgeRepository;
  private charLocRepo: CharacterLocationRepository;
  private metaRepo: MetaRepository;
  private llmCallRepo: LlmCallRepository;
  private machine: ActionStateMachine;
  private cartographer?: CartographerGateway;
  private classDefs: ClassDef[];
  private upbringingDefs: ModifierDef[];
  private raceDefs: ModifierDef[];
  private dayJobIncome: Record<string, number>;
  private itemSets: Array<{
    name: string;
    for_classes: string[];
    items: Array<{
      name: string;
      emoji: string;
      stat: string;
      modifier: number;
      quantity?: number;
    }>;
  }>;

  /** Guards against concurrent action starts for the same character. */
  private processingActions = new Set<number>();

  constructor(config: WorldEngineConfig) {
    this.db = config.db;
    this.userRepo = config.userRepo;
    this.charRepo = config.charRepo;
    this.itemRepo = config.itemRepo;
    this.actionRepo = config.actionRepo;
    this.npcRepo = config.npcRepo;
    this.locationRepo = new LocationRepository(config.db);
    this.edgeRepo = new LocationEdgeRepository(config.db);
    this.charLocRepo = new CharacterLocationRepository(config.db);
    this.metaRepo = new MetaRepository(config.db);
    this.llmCallRepo = new LlmCallRepository(config.db);
    this.classDefs = config.classDefs ?? [];
    this.upbringingDefs = config.upbringingDefs ?? [];
    this.raceDefs = config.raceDefs ?? [];
    this.dayJobIncome = config.dayJobIncome ?? {};
    this.itemSets = config.itemSets ?? [];
    this.cartographer = config.cartographer;

    // S4: two-tier retry → divine intervention
    const fallbackLlm = new FallbackLlmGateway(config.llm, {
      onTier2Fallback: () => {
        const current = this.metaRepo.get("llm_fallback_count");
        const next = current ? String(Number(current) + 1) : "1";
        this.metaRepo.set("llm_fallback_count", next);
      },
    });

    const contextResolver: WorldContextResolver = {
      getNearbyNpcs: (location: string) => {
        return this.npcRepo
          .findByLocation(location)
          .filter((n) => n.description)
          .map((n) => ({ name: n.name, description: n.description! }));
      },
      getNearbyPcs: (location: string, excludeCharId: number) => {
        const allChars = this.charRepo.findAll();
        return allChars
          .filter((c) => c.location === location && c.id !== excludeCharId)
          .map((c) => ({ name: c.name, class: c.class }));
      },
      getRecentActions: (characterId: number) => {
        return this.actionRepo
          .findRecentByCharacterId(characterId, 3)
          .map((a) => ({
            type: a.type,
            outcome: a.outcome,
            narrative: a.narrative,
          }));
      },
      getKnownLocations: () => {
        return this.locationRepo.findAll().map((l) => l.name);
      },
      isLocationSafe: (location: string) => {
        // Unknown/off-map locations default to unsafe.
        return this.locationRepo.findByName(location)?.is_safe === 1;
      },
      getLocalGeography: (location: string) => ({
        region: this.locationRepo.findByName(location)?.region ?? null,
        // Immediate charted exits you can see from where you stand (move targets);
        // and the uncharted roads radiating outward (cross_frontier invitations).
        neighbours: this.edgeRepo
          .neighbours(location)
          .map((n) => ({ name: n.name, direction: n.direction, difficulty: n.difficulty })),
        frontiers: this.edgeRepo
          .frontierExits(location)
          .map((f) => ({ direction: f.direction, teaser: f.teaser, difficulty: f.difficulty })),
      }),
    };

    // Critic (opt-in): wrap gateway for DECISION beats; pass critic to the machine for the
    // RESOLUTION-beat hook (needs post-applyOutcomeToMutations mutations). Absent → disabled.
    const decisionLlm = config.critic
      ? new CritiquedLlmGateway(fallbackLlm, config.critic)
      : fallbackLlm;

    this.machine = new ActionStateMachine(
      decisionLlm,
      config.rollD20,
      contextResolver,
      config.critic,
    );
  }

  // ── Character lifecycle ──

  createCharacter(discordUserId: string, data: CharCreateData): CharacterData {
    const user =
      this.userRepo.findByDiscordId(discordUserId) ??
      this.userRepo.create(discordUserId);

    const stats =
      this.classDefs.length > 0
        ? computeStats(
            data.class,
            data.upbringing,
            data.race,
            this.classDefs,
            this.upbringingDefs,
            this.raceDefs,
          )
        : { physical: 0, wisdom: 0, intelligence: 0, charisma: 0 };

    const row = this.charRepo.create(user.id, {
      name: data.name,
      class: data.class,
      upbringing: data.upbringing,
      race: data.race,
      alignment: data.alignment,
      day_job: data.dayJob,
      stats: JSON.stringify(stats),
      health: 10,
      max_health: 10,
      stamina: 10,
      max_stamina: 10,
      rolls_remaining: DAILY_ROLL_ALLOWANCE,
      location: "The Warden's Oak",
      wealth: 0,
      last_action_state: null,
    });

    if (data.itemSetName) {
      const kit = this.itemSets.find((s) => s.name === data.itemSetName);
      if (kit) {
        for (const item of kit.items) {
          this.itemRepo.create(row.id, {
            name: item.name,
            emoji: item.emoji,
            stat: item.stat,
            modifier: item.modifier,
            quantity: item.quantity ?? 1,
          });
        }
      }
    }

    this.seedHomeClusterDiscovery(row.id);

    return this.rowToCharacterData(row);
  }

  /** Every new player starts already knowing the home Vale — nobody "discovers"
   *  their own workplace (§1, §3). The home cluster is the seeded home region;
   *  new ground (other regions) stays fogged until explored. */
  private seedHomeClusterDiscovery(characterId: number): void {
    const home = this.locationRepo
      .findAll()
      .filter((l) => l.region === HOME_REGION || l.name === "The Warden's Oak");
    for (const loc of home) {
      this.charLocRepo.recordVisit(characterId, loc.name);
    }
  }

  getCharacter(discordUserId: string): CharacterData | null {
    const user = this.userRepo.findByDiscordId(discordUserId);
    if (!user) return null;
    const row = this.charRepo.findByUserId(user.id);
    if (!row) return null;
    return this.rowToCharacterData(row);
  }

  characterExists(discordUserId: string): boolean {
    const user = this.userRepo.findByDiscordId(discordUserId);
    if (!user) return false;
    return !!this.charRepo.findByUserId(user.id);
  }

  // ── Action state machine (S3) ──

  /**
   * Apply a resolved outcome: drop invalid mutations, apply char/item changes,
   * write the action row (+ link the LLM audit row), spawn NPCs, clear mid-action
   * state. Shared by stepAction and the startAction auto-finish path. Caller wraps
   * this in a transaction. Mutates `outcome.mutations` to drop invalid entries so the
   * renderer sees only what was applied (per spec).
   */
  private applyResolution(
    characterId: number,
    row: CharacterRow,
    outcome: ActionOutcome,
    rawInput: string,
    decisions: ActionDecisionRecord[],
  ): { worldChanged: boolean; provisionalLocations: string[]; actionId: number; rollsMutationDelta: number } {
    // Clear mid-action state (no-op for auto-finish, which never persisted)
    this.charRepo.update(characterId, { last_action_state: null });

    // Geographic resolution (per-player-map-exploration §2): movement is now
    // engine-validated against the shared graph. `set_location` must reach a charted
    // node; `cross_frontier` mints new ground ONLY by crossing a real frontier exit.
    // Illegal moves are dropped (no lazy-create-from-thin-air). Returns the names
    // minted this turn — fed to the async cartographer to chart their geometry.
    const knownLocations = this.locationRepo.findAll().map((l) => l.name);
    const geo = this.applyGeography(row.location, outcome.mutations, knownLocations);
    outcome.mutations = geo.mutations;
    const provisionalLocations = geo.minted;

    const ctx = {
      currentHealth: row.health,
      maxHealth: row.max_health,
      stamina: row.stamina,
      maxStamina: row.max_stamina,
      wealth: row.wealth,
      rollsRemaining: row.rolls_remaining,
      location: row.location,
      // Include just-minted names so the set_location/cross_frontier guard accepts them
      // and applyMutations snaps to canonical casing.
      knownLocations: [...knownLocations, ...provisionalLocations],
    };

    // Per spec: malformed mutations are silently dropped, valid ones applied.
    const validation = validateMutations(outcome.mutations, ctx);
    if (!validation.valid) {
      console.warn(
        "[engine] Dropping invalid mutations:",
        validation.errors.map((e) => `[${e.index}] ${e.message}`).join("; "),
      );
      const invalidIndices = new Set(validation.errors.map((e) => e.index));
      outcome.mutations = outcome.mutations.filter(
        (_, i) => !invalidIndices.has(i),
      );
    }

    const applied = applyMutations(outcome.mutations, ctx);

    const updates: Record<string, unknown> = {};
    if (applied.currentHealth !== row.health)
      updates.health = applied.currentHealth;
    if (applied.stamina !== row.stamina) updates.stamina = applied.stamina;
    if (applied.maxStamina !== row.max_stamina)
      updates.max_stamina = applied.maxStamina;
    if (applied.wealth !== row.wealth) updates.wealth = applied.wealth;
    if (applied.rollsRemaining !== row.rolls_remaining)
      updates.rolls_remaining = applied.rollsRemaining;
    if (applied.location !== row.location) updates.location = applied.location;
    if (Object.keys(updates).length > 0) {
      this.charRepo.update(characterId, updates);
    }

    // Fog-of-war: discovering (or revisiting) the place you end up. Recency on a
    // revisit drives the /map ordering (§5). The ORIGIN was already discovered.
    if (updates.location !== undefined) {
      this.charLocRepo.recordVisit(characterId, applied.location);
    }

    // D1: did this resolution change the world? Drives the no-op roll refund in
    // startAction. Health/max_stamina/wealth/location/item/NPC deltas count. Spending stamina or
    // rolls does NOT — those are the costs of effort/turns, so a "shrug" that only tires you or
    // burns rolls is still a refundable no-op (you got nothing for it). But GAINING rolls is
    // getting something: the action is charged like any other, so a granted roll nets against the
    // action's own cost instead of stacking free on top of the refund.
    // Item changes count only if they REALLY touch inventory: an add of a real (qty>0) item, or
    // a remove of an item the character actually owns. A hallucinated remove_item for an unowned
    // item is a repo no-op, so it must NOT flag worldChanged and deny the no-op roll refund.
    const ownedNames = new Set(this.itemRepo.findByCharacterId(characterId).map((i) => i.name));
    const itemsAdded = applied.itemsToAdd.filter((i) => i.quantity > 0);
    const itemsRemoved = applied.itemsToRemove.filter((r) => ownedNames.has(r.name));
    const rollsGained = applied.rollsRemaining > row.rolls_remaining;

    const worldChanged =
      updates.health !== undefined ||
      updates.max_stamina !== undefined ||
      updates.wealth !== undefined ||
      updates.location !== undefined ||
      itemsAdded.length > 0 ||
      itemsRemoved.length > 0 ||
      applied.npcsToSpawn.length > 0 ||
      rollsGained;

    for (const item of itemsAdded) {
      this.itemRepo.create(characterId, item);
    }

    // Decrement the stack so trading 1 of N leaves the rest
    for (const { name, quantity } of itemsRemoved) {
      this.itemRepo.decrementByName(characterId, name, quantity);
    }

    logAppliedMutations(characterId, outcome, row, applied);

    const actionRow = this.actionRepo.create({
      characterId,
      rawInput,
      type: outcome.distilledType,
      decisionsJson: JSON.stringify(decisions),
      finalDc: outcome.finalDc,
      playerRolled: outcome.playerRolled,
      outcome: outcome.outcome,
      appVersion: APP_VERSION,
      promptVersion: PROMPT_VERSION,
      appliedMutations:
        outcome.mutations.length > 0 ? JSON.stringify(outcome.mutations) : null,
      narrative: (outcome.outcomeText ?? "").slice(0, 500) || null,
      // Origin snapshot: where the character stood when they acted (§6). For
      // travel this is the start, not the destination — the narrative carries
      // the destination, and "from the Oak, set out east" reads naturally.
      locationName: row.location,
    });

    // Link every audit row this action produced (decision/narration/critic) so the full
    // call chain is mineable. Falls back to the single resolution call id for older states
    // predating llmCallIds. De-duped to avoid double links.
    const callIdsToLink = new Set<number>(outcome.llmCallIds ?? []);
    if (outcome.llmCallId !== undefined) callIdsToLink.add(outcome.llmCallId);
    for (const callId of callIdsToLink) {
      this.llmCallRepo.linkAction(callId, actionRow.id);
    }

    for (const npc of applied.npcsToSpawn) {
      this.npcRepo.create({
        name: npc.name,
        class: npc.class,
        race: npc.race,
        description: npc.description,
        createdByActionId: actionRow.id,
      });
    }

    // Stamp provenance on any place minted this turn (which action grew the world).
    // Done post-create because the action id doesn't exist until the row is written.
    for (const name of provisionalLocations) {
      this.db
        .prepare('UPDATE locations SET created_by_action_id = ? WHERE name = ? AND created_by_action_id IS NULL')
        .run(actionRow.id, name);
    }

    // Net roll change from this resolution's mutations alone (excludes the start-drain, which the
    // caller folds in). Lets stepAction report a true rolls delta instead of the renderer guessing.
    return {
      worldChanged,
      provisionalLocations,
      actionId: actionRow.id,
      rollsMutationDelta: applied.rollsRemaining - row.rolls_remaining,
    };
  }

  /**
   * Async cartographer (fire-and-forget). For each freshly-minted location, ask the
   * LLM to chart it: fill is_safe + description + tags AND the geometry — region,
   * emoji, node_tier — then author 1–3 onward frontier exits so exploration
   * continues. Only writes while the row is STILL provisional (enrichProvisional
   * guards on the flag → double-fire/settled-row safe). The engine validates the
   * structural fields (never trusts the LLM for hierarchy — map §4): emoji falls
   * back to 📍, region to the crossing region, tier to 2. Never awaited/throws.
   */
  private fireCartographer(provisionalNames: string[], narrative: string): void {
    if (!this.cartographer || provisionalNames.length === 0) return;
    const cartographer = this.cartographer;

    for (const name of provisionalNames) {
      // Existing names excluding this fresh row, so the LLM can flag it as a synonym.
      const existingNames = this.locationRepo
        .findAll()
        .map((l) => l.name)
        .filter((n) => n !== name);
      const knownRegions = [
        ...new Set(
          this.locationRepo
            .findAll()
            .map((l) => l.region)
            .filter((r): r is string => !!r),
        ),
      ];
      // The node it was crossed from is its parent on the graph (the inbound edge).
      const inbound = this.edgeRepo.all().find((e) => e.to_location === name);
      const fromLocation = inbound?.from_location;
      const fromRegion = fromLocation ? this.locationRepo.findByName(fromLocation)?.region ?? null : null;

      void (async () => {
        try {
          const result = await cartographer.enrich({
            newName: name,
            existingNames,
            narrative,
            knownRegions,
            fromLocation,
            fromRegion,
          });
          const description = result.description ?? "An uncharted place beyond the known map.";
          const isSafe = result.is_safe ?? 0;
          const updated = this.locationRepo.enrichProvisional(name, {
            isSafe,
            description,
            tags: result.tags ?? null,
            // Geometry — validated/defaulted here, never trusted blind.
            region: result.region?.trim() || fromRegion || HOME_REGION,
            emoji: result.emoji?.trim() || "📍",
            nodeTier: result.node_tier === 1 ? 1 : 2,
          });
          if (updated) {
            this.authorOnwardFrontiers(name, result.onwardFrontiers ?? []);
            console.log(
              `[cartographer] charted "${name}" (is_safe=${isSafe}, tier=${result.node_tier ?? 2}, region=${result.region ?? fromRegion ?? HOME_REGION}${result.matchesExisting ? `, llm flagged dup of "${result.matchesExisting}"` : ""})`,
            );
          }
        } catch (err) {
          // Best-effort: a failed enrichment leaves the row provisional.
          console.warn(
            "[cartographer] enrichment failed for",
            name,
            err instanceof Error ? err.message : String(err),
          );
        }
      })();
    }
  }

  /**
   * Author the cartographer's onward frontier exits from a newly-charted node,
   * each on a free cardinal direction. SPOKE CAP (map §4): a node never sprouts
   * more than SPOKE_CAP total spokes (charted edges + frontier exits) — once it's
   * full, further onward exits are dropped so the map can't fan out without bound.
   */
  private authorOnwardFrontiers(
    from: string,
    frontiers: Array<{ teaser: string; difficulty: 1 | 2 | 3 }>,
  ): void {
    const CARDINALS = ["N", "E", "S", "W", "NE", "NW", "SE", "SW"];
    for (const f of frontiers) {
      const used = new Set(this.edgeRepo.directionsFrom(from));
      if (used.size >= SPOKE_CAP) break; // node is full — stop growing it
      const dir = CARDINALS.find((c) => !used.has(c));
      if (!dir) break;
      this.edgeRepo.recordEdge({ from, to: null, direction: dir, difficulty: f.difficulty, teaser: f.teaser });
    }
  }

  /**
   * Engine-owned geographic resolution (per-player-map-exploration §2). Replaces the
   * old lazy-create-on-any-set_location with graph-validated movement:
   *
   * - `set_location` is kept only if the target is the current node or a charted node
   *   reachable on the shared graph (`routeBetween`). An unreachable/unknown target is
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
  private applyGeography(
    currentLocation: string,
    mutations: WorldMutation[],
    knownLocations: string[],
  ): { mutations: WorldMutation[]; minted: string[] } {
    const known = new Set(knownLocations.map((n) => n.trim().toLowerCase()));
    const currentNorm = currentLocation.trim().toLowerCase();
    const minted: string[] = [];
    const kept: WorldMutation[] = [];

    for (const m of mutations) {
      if (m.type === "set_location") {
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
          (known.has(norm) && this.routeBetween(currentLocation, canonical) !== null);
        if (!reachable) {
          console.warn(
            `[engine] dropping set_location to unreachable/unknown "${name}" — movement is graph-validated (no lazy-create)`,
          );
          continue;
        }
        kept.push(m);
      } else if (m.type === "cross_frontier") {
        const direction = typeof m.direction === "string" ? m.direction.trim().toUpperCase() : "";
        const proposed = typeof m.name === "string" ? m.name.trim() : "";
        const edge = direction ? this.edgeRepo.find(currentLocation, direction) : undefined;
        if (!edge) {
          console.warn(`[engine] dropping cross_frontier ${direction} from "${currentLocation}" — no such exit`);
          continue;
        }
        if (edge.to_location !== null) {
          // A prior crosser already bound this exit — arrive at the shared place,
          // ignoring the LLM's proposed name (we never re-mint or rename).
          kept.push({ type: "set_location", name: edge.to_location });
          continue;
        }
        if (proposed === "") {
          console.warn(`[engine] dropping cross_frontier ${direction} from "${currentLocation}" — no destination name`);
          continue;
        }
        // First crosser: mint the destination + bind the frontier (shared thereafter).
        this.locationRepo.create({
          name: proposed,
          description: "An uncharted place, newly crossed into. (Mapping…)",
          isSafe: 0,
          enrichmentPending: 1,
        });
        this.edgeRepo.bindFrontier(currentLocation, direction, proposed);
        minted.push(proposed);
        known.add(proposed.toLowerCase());
        kept.push({ type: "cross_frontier", direction, name: proposed });
        console.log(`[location] frontier crossed: minted "${proposed}" (${direction} of "${currentLocation}")`);
      } else {
        kept.push(m);
      }
    }

    return { mutations: kept, minted };
  }

  async startAction(
    characterId: number,
    rawInput: string,
    opts: { kind?: ActionKind; wage?: number } = {},
  ): Promise<ActionStartResult> {
    // Guard: concurrent/duplicate action starts
    if (this.processingActions.has(characterId)) {
      throw new Error(
        "An action is already being processed. Finish your current action first.",
      );
    }
    this.processingActions.add(characterId);

    const row = this.charRepo.findById(characterId);
    if (!row) {
      this.processingActions.delete(characterId);
      throw new Error("Character not found");
    }

    // Guard: character already mid-action (stale state in DB)
    if (row.last_action_state) {
      this.processingActions.delete(characterId);
      throw new Error(
        "You are already mid-action. Finish your current action first.",
      );
    }

    this.updateLastPlayed(characterId);

    try {
      const char = this.rowToCharacterData(row);
      const items = this.getItems(characterId);

      const startResult = await this.machine.start(char, rawInput, items, opts.kind, opts.wage);
      const internalState = startResult.state;

      // Divine intervention during start: drain roll, persist state, return single Resolve option
      if (internalState.distilledType === DIVINE_INTERVENTION_TYPE) {
        // Drain roll (per spec: not refunded)
        this.charRepo.update(characterId, {
          rolls_remaining: Math.max(0, row.rolls_remaining - 1),
        });

        // Persist divine marker so stepAction can resolve it
        this.charRepo.update(characterId, {
          last_action_state: JSON.stringify(internalState),
        });

        const divineDecision = {
          prompt: DIVINE_MESSAGE,
          options: [{ label: "Resolve", dcModifier: 0 } as const],
        };

        return {
          state: { rawInput, decisions: [], accumulatedDc: 10 },
          firstDecision: divineDecision,
        };
      }

      // Auto-finish: the LLM resolved the action outright (e.g. travel/rest).
      // D1 roll economy — a roll is the price of a resolved action that CHANGES the
      // world, never of merely starting one:
      //   • world-changing or player rolled → charge.
      //   • no-op (`done`, no change) → refund, but only the first no-op per char per
      //     day; later no-ops that day still cost it.
      // applyResolution may itself adjust rolls_remaining (e.g. +1 reward), so the
      // charge/refund is a delta on top of the post-resolution value.
      if (startResult.resolved) {
        const today = this.currentDayNumber();
        let provisionalLocations: string[] = [];
        this.db.transaction(() => {
          const res = this.applyResolution(
            characterId,
            row,
            startResult.outcome,
            rawInput,
            internalState.decisions,
          );
          provisionalLocations = res.provisionalLocations;
          // Link the persisted action row so the outcome's Feedback/Bug buttons can attribute to it.
          startResult.outcome.actionId = res.actionId;

          const charged = startResult.outcome.playerRolled != null || res.worldChanged;
          // Free no-op refund only if not already used today.
          const noopAlreadyRefundedToday = row.last_noop_refund_day === today;
          const debit = charged || noopAlreadyRefundedToday;

          // Re-read: applyResolution may have written a mutation-driven roll change.
          const afterRes = this.charRepo.findById(characterId)!;
          const finalRolls = debit
            ? Math.max(0, afterRes.rolls_remaining - 1)
            : afterRes.rolls_remaining;
          if (debit) {
            this.charRepo.update(characterId, { rolls_remaining: finalRolls });
          } else {
            // Free no-op refund — stamp the day so it's once-per-day.
            this.stampRefundDay(characterId, "last_noop_refund_day", today);
          }
          // Surface the real roll accounting so the footer reflects it instead of guessing:
          // a no-op refund keeps the roll (delta 0, flagged); a charge spent one.
          startResult.outcome.rollsDelta = finalRolls - row.rolls_remaining;
          startResult.outcome.rollRefunded = !debit;
        })();

        // D3: enrich any just-created provisional locations off the critical path.
        this.fireCartographer(provisionalLocations, startResult.outcome.outcomeText);

        return {
          state: this.toPublicState(internalState),
          firstDecision: internalState.pendingDecision,
          outcome: startResult.outcome,
        };
      }

      // Normal path: drain a roll + persist state atomically
      this.db.transaction(() => {
        this.charRepo.update(characterId, {
          rolls_remaining: Math.max(0, row.rolls_remaining - 1),
        });
        this.persistState(characterId, internalState);
      })();

      return {
        state: this.toPublicState(internalState),
        firstDecision: startResult.firstDecision,
      };
    } finally {
      this.processingActions.delete(characterId);
    }
  }

  async stepAction(
    characterId: number,
    choice: string,
  ): Promise<ActionStepResult> {
    const row = this.charRepo.findById(characterId);
    if (!row) throw new Error("Character not found");
    if (!row.last_action_state) throw new Error("No action in progress");

    const internalState = JSON.parse(
      row.last_action_state,
    ) as InternalActionState;

    // D2 30-min timeout: resolve stale state as an in-voice server-side timeout (refund
    // once/day) so the UI renders a grey card instead of a bare error.
    const timeout = this.resolveStaleTimeout(internalState, characterId);
    if (timeout) {
      return {
        resolved: true,
        state: this.toPublicState(internalState),
        outcome: timeout,
      };
    }

    this.updateLastPlayed(characterId);

    const char = this.rowToCharacterData(row);
    const items = this.getItems(characterId);

    // Divine intervention from startAction — resolve directly, no LLM call
    if (internalState.distilledType === DIVINE_INTERVENTION_TYPE) {
      this.charRepo.update(characterId, { last_action_state: null });

      return {
        resolved: true,
        state: this.toPublicState(internalState),
        outcome: {
          distilledType: DIVINE_INTERVENTION_TYPE,
          finalDc: 10,
          playerRolled: null,
          outcome: "failure",
          mutations: [],
          outcomeText: DIVINE_MESSAGE,
          // The roll was drained when the action started and isn't refunded — report it.
          rollsDelta: -1,
        },
      };
    }

    const result = await this.machine.step(internalState, choice, char, items);

    if (result.resolved) {
      // Divine intervention (S4 tier-2): clear state, skip the action row + mutations
      if (result.outcome.distilledType === DIVINE_INTERVENTION_TYPE) {
        this.charRepo.update(characterId, { last_action_state: null });
        // The roll was drained when the action started and isn't refunded — report it.
        result.outcome.rollsDelta = -1;
        return {
          resolved: true,
          state: this.toPublicState(result.state),
          outcome: result.outcome,
        };
      }

      let provisionalLocations: string[] = [];
      this.db.transaction(() => {
        const res = this.applyResolution(
          characterId,
          row,
          result.outcome,
          result.state.rawInput,
          result.state.decisions,
        );
        provisionalLocations = res.provisionalLocations;
        // The action drained one roll at start; fold that into the mutation delta so the footer
        // reports the true change (covers bail and rolled resolutions alike — playerRolled-null
        // bails no longer silently omit the −1).
        result.outcome.rollsDelta = -1 + res.rollsMutationDelta;
        // Link the persisted action row so the outcome's Feedback/Bug buttons can attribute to it.
        result.outcome.actionId = res.actionId;
      })();

      // D3: enrich any just-created provisional locations off the critical path.
      this.fireCartographer(provisionalLocations, result.outcome.outcomeText);

      return {
        resolved: true,
        state: this.toPublicState(result.state),
        outcome: result.outcome,
      };
    }

    this.persistState(characterId, result.state);

    return {
      resolved: false,
      state: this.toPublicState(result.state),
      nextDecision: result.nextDecision,
    };
  }

  resumeAction(characterId: number): ActionResumeResult {
    const row = this.charRepo.findById(characterId);
    if (!row) throw new Error("Character not found");
    if (!row.last_action_state) throw new Error("No action to resume");

    const internalState = JSON.parse(
      row.last_action_state,
    ) as InternalActionState;

    // D2 30-min timeout: resolve stale state (refund once/day, no mutations). Resume
    // can't return an outcome, so throw the player-facing message for the caller.
    const timeout = this.resolveStaleTimeout(internalState, characterId);
    if (timeout) {
      throw new Error(timeout.outcomeText);
    }

    const { state, nextDecision } = this.machine.resume(internalState);

    return {
      state: this.toPublicState(state),
      nextDecision,
    };
  }

  // ── Location ──

  getLocation(name: string): LocationInfo | null {
    const row = this.locationRepo.findByName(name);
    if (!row) return null;
    return {
      name: row.name,
      description: row.description ?? "",
      tags: row.tags ? row.tags.split(",").map((t) => t.trim()) : [],
      isSafe: row.is_safe === 1,
      emoji: row.emoji,
    };
  }

  /** Edges leaving a location — charted neighbours + frontier exits (for /look). */
  getExits(location: string): LocationExits {
    return {
      neighbours: this.edgeRepo
        .neighbours(location)
        .map((n) => ({ name: n.name, direction: n.direction, difficulty: n.difficulty })),
      frontiers: this.edgeRepo
        .frontierExits(location)
        .map((f) => ({ direction: f.direction, teaser: f.teaser, difficulty: f.difficulty })),
    };
  }

  // ── Nearby ──

  getNearbyEntities(characterId: number): NearbyEntity[] {
    const char = this.charRepo.findById(characterId);
    if (!char) return [];

    const entities: NearbyEntity[] = [];

    // NPCs at this location
    const npcs = this.npcRepo.findByLocation(char.location);
    for (const npc of npcs) {
      entities.push({
        name: npc.name,
        classOrType: npc.class ?? "Unknown",
        description: npc.description ?? null,
        isPlayer: false,
      });
    }

    // Other player characters at this location
    const allChars = this.charRepo.findAll();
    for (const pc of allChars) {
      if (pc.id === characterId) continue;
      if (pc.location !== char.location) continue;
      entities.push({
        name: pc.name,
        classOrType: pc.class,
        description: null,
        isPlayer: true,
      });
    }

    return entities;
  }

  // ── Last played ──

  updateLastPlayed(characterId: number): void {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    this.charRepo.update(characterId, { last_played_at: now });
  }

  // ── Items ──

  getItems(characterId: number): ItemData[] {
    return this.itemRepo.findByCharacterId(characterId).map((row) => ({
      id: row.id,
      characterId: row.character_id,
      name: row.name,
      emoji: row.emoji,
      stat: row.stat,
      modifier: row.modifier,
      quantity: row.quantity,
    }));
  }

  // ── Journal ──

  getJournal(characterId: number): JournalData {
    const charRow = this.charRepo.findById(characterId);
    const currentLocation = charRow?.location ?? "The Warden's Oak";

    const locationRows = this.locationRepo.findAll();
    const npcRows = this.npcRepo.findByCharacterActions(characterId);
    const actionRows = this.actionRepo.findRecentByCharacterId(characterId, 5);

    return {
      knownLocations: locationRows.map((r) => r.name),
      currentLocation,
      npcsEncountered: npcRows.map((r) => ({
        name: r.name,
        class: r.class,
        location: r.location,
      })),
      recentActions: actionRows.map((r) => ({
        type: r.type,
        outcome: r.outcome,
        createdAt: r.created_at,
        narrative: r.narrative,
        location: r.location_name,
        locationEmoji: r.location_name
          ? this.locationRepo.findByName(r.location_name)?.emoji ?? "📍"
          : null,
      })),
    };
  }

  // ── Map: fog-of-war over the shared graph ──

  /** The player's discovered subgraph: discovered nodes, charted edges between
   *  them, and frontier exits radiating from them. Adjacency is shared truth; the
   *  mask is per-player (§1). */
  getDiscoveredGraph(characterId: number): DiscoveredGraph {
    const charRow = this.charRepo.findById(characterId);
    const current = charRow?.location ?? "The Warden's Oak";

    const visits = this.charLocRepo.findByCharacter(characterId);
    const lastVisited = new Map(visits.map((v) => [v.location_name, v.last_visited_at]));
    const discovered = new Set(lastVisited.keys());
    // The current location is always part of your own view, even pre-record.
    discovered.add(current);

    const nodes: DiscoveredGraph["nodes"] = [];
    for (const name of discovered) {
      const loc = this.locationRepo.findByName(name);
      if (!loc) continue;
      nodes.push({
        name: loc.name,
        emoji: loc.emoji,
        isSafe: loc.is_safe === 1,
        nodeTier: loc.node_tier,
        region: loc.region,
        lastVisitedAt: lastVisited.get(name) ?? "",
      });
    }

    const edges: DiscoveredGraph["edges"] = [];
    const frontiers: DiscoveredGraph["frontiers"] = [];
    for (const e of this.edgeRepo.all()) {
      if (!discovered.has(e.from_location)) continue;
      if (e.to_location === null) {
        frontiers.push({ from: e.from_location, direction: e.direction, teaser: e.teaser, difficulty: e.difficulty });
      } else if (discovered.has(e.to_location)) {
        edges.push({ from: e.from_location, to: e.to_location, direction: e.direction, difficulty: e.difficulty, flavour: e.flavour });
      }
    }

    return { current, nodes, edges, frontiers };
  }

  /** Least-cost route over the shared graph (Dijkstra on edge difficulty). The
   *  cost is the Σ-difficulty stamina price; null when unreachable (§2). */
  routeBetween(from: string, to: string): TravelRoute | null {
    return findRoute(from, to, (name) =>
      this.edgeRepo.neighbours(name).map((n) => ({ name: n.name, difficulty: n.difficulty })),
    );
  }

  /** Public visit-recorder for non-engine movement paths (the daily-work commute). */
  recordVisit(characterId: number, locationName: string): void {
    this.charLocRepo.recordVisit(characterId, locationName);
  }

  // ── Feedback & bugs ──

  submitFeedback(characterId: number, text: string, actionId?: number): void {
    this.db
      .prepare("INSERT INTO feedback (character_id, text, action_id) VALUES (?, ?, ?)")
      .run(characterId, text, actionId ?? null);
  }

  submitBug(characterId: number, text: string, actionId?: number): void {
    this.db
      .prepare("INSERT INTO bug_reports (character_id, text, action_id) VALUES (?, ?, ?)")
      .run(characterId, text, actionId ?? null);
  }

  // ── Rest & recovery ──

  restAtOak(discordUserId: string): CharacterData | null {
    const user = this.userRepo.findByDiscordId(discordUserId);
    if (!user) return null;
    const row = this.charRepo.findByUserId(user.id);
    if (!row) return null;

    this.updateLastPlayed(row.id);

    // Stamp the rest on the current game day so the Rest nav button hides until the
    // next tick (day_number advances and resting is possible again).
    const currentDay = Number(this.metaRepo.get("day_number") ?? "1");

    const oakName = "The Warden's Oak";
    if (row.location === oakName) {
      // Already at the Oak — still record the rest and return the character.
      this.charRepo.update(row.id, { last_rested_day: currentDay });
      return this.rowToCharacterData({ ...row, last_rested_day: currentDay });
    }

    this.charRepo.update(row.id, {
      location: oakName,
      last_rested_day: currentDay,
    });
    return this.rowToCharacterData({
      ...row,
      location: oakName,
      last_rested_day: currentDay,
    });
  }

  spawnNpc(data: {
    name: string;
    class?: string;
    race?: string;
    description?: string;
    location: string;
  }): void {
    this.npcRepo.create({
      name: data.name,
      class: data.class,
      race: data.race,
      description: data.description,
      location: data.location,
    });
  }

  getLeaderboards(limit: number): Leaderboards {
    const chars = this.charRepo.findAll().map((r) => this.rowToCharacterData(r));

    const wealth = [...chars]
      .sort((a, b) => b.wealth - a.wealth)
      .slice(0, limit)
      .map((c) => ({ name: c.name, class: c.class, value: c.wealth }));

    const might = chars
      .map((c) => {
        // Rank on effective scores (base + gear), so item bonuses count.
        const eff = effectiveStats(c.stats, this.getItems(c.id));
        const [stat, value] = (
          Object.entries(eff) as [string, number][]
        ).reduce((best, cur) => (cur[1] > best[1] ? cur : best));
        return { name: c.name, class: c.class, value, stat };
      })
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);

    return { wealth, might };
  }

  getActionsBetween(startIso: string, endIso: string): WeeklyActionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT pc.name AS character, a.type AS type, a.outcome AS outcome,
                COALESCE(a.narrative, '') AS narrative
           FROM actions a
           JOIN player_characters pc ON pc.id = a.character_id
          WHERE a.created_at >= ? AND a.created_at < ?
          ORDER BY a.created_at ASC`,
      )
      .all(startIso, endIso) as WeeklyActionSummary[];
    return rows;
  }

  countSoulsInUnsafe(): number {
    // Build a name→is_safe map once (avoids an N+1 findByName per character).
    const safeByName = new Map<string, boolean>();
    for (const loc of this.locationRepo.findAll()) {
      safeByName.set(loc.name, loc.is_safe === 1);
    }
    let count = 0;
    for (const charRow of this.charRepo.findAll()) {
      const isSafe = safeByName.get(charRow.location);
      // Unknown location (no row) counts as unsafe — "out in the wilds".
      if (isSafe === undefined || isSafe === false) count++;
    }
    return count;
  }

  // ── Health modifier ──

  modifyHealth(discordUserId: string, amount: number): CharacterData | null {
    const user = this.userRepo.findByDiscordId(discordUserId);
    if (!user) return null;
    const row = this.charRepo.findByUserId(user.id);
    if (!row) return null;
    const newHealth = Math.max(
      0,
      Math.min(row.max_health, row.health + amount),
    );
    this.charRepo.update(row.id, { health: newHealth });
    return this.rowToCharacterData({ ...row, health: newHealth });
  }

  // ── World tick (S5) ──

  tick(isAdmin: boolean): TickResult {
    const now = new Date();
    const today = now.toISOString().slice(0, 10); // 'YYYY-MM-DD'
    // Saturday (UTC) grants everyone a bonus roll on top of the daily allowance.
    const rollAllowance =
      DAILY_ROLL_ALLOWANCE + (now.getUTCDay() === 6 ? SATURDAY_BONUS_ROLLS : 0);

    // Cron idempotency: skip if already ticked today
    if (!isAdmin) {
      const lastCron = this.metaRepo.get("last_cron_date");
      if (lastCron === today) {
        const dayNum = Number(this.metaRepo.get("day_number") ?? "1");
        return {
          dayNumber: dayNum,
          playersAffected: 0,
          npcMovements: [],
          absentWarnings: [],
          collapsedNames: [],
        };
      }
    }

    // Transaction so a partial failure can't half-tick the world and poison the cron date.
    return this.db.transaction((): TickResult => {
      // ── Advance day number ──
      const currentDayStr = this.metaRepo.get("day_number") ?? "1";
      const newDay = Number(currentDayStr) + 1;
      this.metaRepo.set("day_number", String(newDay));
      this.metaRepo.set("last_cron_date", today);

      // ── Player effects ──
      const allChars = this.charRepo.findAll();
      const absentWarnings: string[] = [];
      const collapsedNames: string[] = [];
      for (const charRow of allChars) {
        const loc = this.locationRepo.findByName(charRow.location);
        const isSafe = loc?.is_safe === 1;

        let newStamina: number;
        let newHealth: number | undefined;

        if (isSafe) {
          newStamina = Math.min(charRow.stamina + 5, charRow.max_stamina);
          newHealth = Math.min(charRow.health + 3, charRow.max_health);
        } else {
          newStamina = Math.max(charRow.stamina - 1, 0);
        }

        // Stamina just hit 0 from the unsafe drain — flag a public collapse announcement.
        if (charRow.stamina > 0 && newStamina === 0) {
          collapsedNames.push(charRow.name);
        }

        // Five-day absence nudge: on the tick where a player crosses exactly 5 days
        // without interacting, collect their Discord id for a DM warning. No HP penalty —
        // a soft retention nudge that fires once, on day 5, not nightly.
        if (charRow.last_played_at) {
          const lastDate = charRow.last_played_at.slice(0, 10);
          const diffMs =
            new Date(today + "T00:00:00Z").getTime() -
            new Date(lastDate + "T00:00:00Z").getTime();
          const diffDays = Math.floor(diffMs / 86400000);
          if (diffDays === 5) {
            const user = this.userRepo.findById(charRow.user_id);
            if (user) absentWarnings.push(user.discord_user_id);
          }
        }

        const income = this.dayJobIncome[charRow.day_job] ?? 0;

        const updates: Record<string, unknown> = {
          rolls_remaining: rollAllowance,
          stamina: newStamina,
          wealth: charRow.wealth + income,
        };
        if (newHealth !== undefined) {
          updates.health = newHealth;
        }

        this.charRepo.update(charRow.id, updates);
      }

      // ── NPC effects ──
      const allLocations = this.locationRepo.findAll();
      const npcMovements: NpcMovement[] = [];
      const allNpcs = this.npcRepo.findAll();

      for (const npc of allNpcs) {
        const cls = npc.class ?? "";

        // The Warden never leaves the Oak — frozen in place.
        if (cls === "Warden") continue;

        if (cls === "Blacksmith") {
          this.npcRepo.update(npc.id, { wealth: (npc.wealth ?? 0) + 5 });
          continue;
        }

        // 80% chance to move; multiplier in seed avoids collisions across NPCs.
        const seed = npc.id * 100000 + newDay;
        const rng = mulberry32(seed);
        const shouldMove = rng() < 0.8;

        if (!shouldMove) {
          if (cls === "Merchant") {
            this.npcRepo.update(npc.id, {
              wealth:
                (npc.wealth ?? 0) + seededRandomRange(seed + 100000, 5, 15),
            });
          }
          continue;
        }

        // Determine destination by class
        let candidates: string[] = [];

        if (cls === "Hunter") {
          candidates = allLocations
            .filter(
              (l) =>
                locationTagsContain(l.tags, "wilderness") ||
                locationTagsContain(l.tags, "forest"),
            )
            .map((l) => l.name);
        } else if (cls === "Merchant") {
          candidates = allLocations
            .filter(
              (l) =>
                locationTagsContain(l.tags, "town") ||
                locationTagsContain(l.tags, "market") ||
                locationTagsContain(l.tags, "square"),
            )
            .map((l) => l.name);
        } else if (cls === "Herbalist") {
          candidates = allLocations
            .filter(
              (l) =>
                locationTagsContain(l.tags, "forest") ||
                locationTagsContain(l.tags, "river"),
            )
            .map((l) => l.name);
        } else if (cls === "Acolyte") {
          candidates = allLocations
            .filter(
              (l) =>
                locationTagsContain(l.tags, "shrine") ||
                locationTagsContain(l.tags, "temple"),
            )
            .map((l) => l.name);
        } else {
          candidates = allLocations.map((l) => l.name);
        }

        if (candidates.length === 0) {
          candidates = allLocations.map((l) => l.name);
        }

        const filteredCandidates = candidates.filter((c) => c !== npc.location);
        if (filteredCandidates.length === 0) {
          continue;
        }

        const destIndex = Math.floor(rng() * filteredCandidates.length);
        const dest = filteredCandidates[destIndex];

        const fromLocation = npc.location ?? "(unknown)";
        this.npcRepo.updateLocation(npc.id, dest);

        if (cls === "Merchant") {
          this.npcRepo.update(npc.id, {
            wealth: (npc.wealth ?? 0) + seededRandomRange(seed + 200000, 5, 15),
          });
        }

        npcMovements.push({
          npcId: npc.id,
          npcName: npc.name,
          fromLocation,
          toLocation: dest,
        });
      }

      this.metaRepo.set("last_tick_players_affected", String(allChars.length));
      this.metaRepo.set(
        "last_tick_npc_movement_count",
        String(npcMovements.length),
      );

      return {
        dayNumber: newDay,
        playersAffected: allChars.length,
        npcMovements,
        absentWarnings,
        collapsedNames,
      };
    })();
  }

  // ── Meta ──

  getMeta(key: string): string | null {
    return this.metaRepo.get(key);
  }

  setMeta(key: string, value: string): void {
    this.metaRepo.set(key, value);
  }

  // ── Private helpers ──

  private rowToCharacterData(row: {
    id: number;
    user_id: number;
    name: string;
    class: string;
    upbringing: string;
    race: string;
    alignment: string;
    day_job: string;
    stats: string;
    health: number;
    max_health: number;
    stamina: number;
    max_stamina: number;
    rolls_remaining: number;
    location: string;
    wealth: number;
    last_action_state: string | null;
    last_rested_day?: number | null;
    created_at: string;
  }): CharacterData {
    let stats: StatBlock;
    try {
      stats = JSON.parse(row.stats);
    } catch {
      stats = { physical: 0, wisdom: 0, intelligence: 0, charisma: 0 };
    }

    let lastActionState = null;
    if (row.last_action_state) {
      try {
        lastActionState = JSON.parse(row.last_action_state);
      } catch {
        /* leave null */
      }
    }

    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      class: row.class,
      upbringing: row.upbringing,
      race: row.race,
      alignment: row.alignment,
      dayJob: row.day_job,
      stats,
      health: row.health,
      maxHealth: row.max_health,
      stamina: row.stamina,
      maxStamina: row.max_stamina,
      rollsRemaining: row.rolls_remaining,
      location: row.location,
      wealth: row.wealth,
      lastActionState,
      hasRestedToday:
        row.last_rested_day != null &&
        row.last_rested_day === Number(this.metaRepo.get("day_number") ?? "1"),
      createdAt: row.created_at,
    };
  }

  private persistState(characterId: number, state: InternalActionState): void {
    // Stamp lastActionAt on every persist as the basis for the 30-min timeout.
    state.lastActionAt = Date.now();
    this.charRepo.update(characterId, {
      last_action_state: JSON.stringify(state),
    });
  }

  /** Current game day number (meta `day_number`, default 1). */
  private currentDayNumber(): number {
    return Number(this.metaRepo.get("day_number") ?? "1");
  }

  /** Stamp a per-day refund-grace column on a character (via the repo update whitelist). */
  private stampRefundDay(
    characterId: number,
    column: "last_noop_refund_day" | "last_timeout_refund_day",
    day: number,
  ): void {
    this.charRepo.update(characterId, { [column]: day });
  }

  /**
   * D2 timeout. If the state has been idle past the 30-min timeout, atomically clear
   * it, write a `timed_out` action row (no mutations — the intended travel does NOT
   * occur), and refund the roll for the FIRST timeout per char per day; later timeouts
   * that day keep the roll spent. Returns an in-voice `timed_out` ActionOutcome, or null
   * if fresh. This grace is separate from the D1 no-op grace — a server-side timeout
   * must never burn the player's no-op allowance, and vice versa.
   */
  private resolveStaleTimeout(
    state: InternalActionState,
    characterId: number,
  ): ActionOutcome | null {
    // Pre-S7 state (no lastActionAt) is treated as not stale.
    if (!state.lastActionAt) return null;
    if (Date.now() - state.lastActionAt < ACTION_TIMEOUT_MS) return null;

    const today = this.currentDayNumber();
    const row = this.charRepo.findById(characterId);
    const refunded =
      row != null && row.last_timeout_refund_day !== today;

    const message = refunded
      ? "The moment slipped away before you could act — a delay on our side, not yours. Nothing happened, and your travel did not occur. Your roll has been **refunded**; try again when you're ready."
      : "The moment slipped away before you could act — a delay on our side, not yours. Nothing happened, and your travel did not occur. Your roll was already **spent** (you've had your free timeout today).";

    const outcome: ActionOutcome = {
      distilledType: state.distilledType,
      finalDc: state.accumulatedDc,
      playerRolled: null,
      outcome: "timed_out",
      mutations: [],
      outcomeText: message,
      // The roll was drained at start; the timeout either hands it back (net 0) or keeps it spent.
      rollsDelta: refunded ? 0 : -1,
      rollRefunded: refunded,
    };

    // Transaction so a partial failure can't orphan a timed_out row while
    // last_action_state survives.
    this.db.transaction(() => {
      this.actionRepo.create({
        characterId,
        rawInput: state.rawInput,
        type: state.distilledType,
        decisionsJson: JSON.stringify(state.decisions),
        finalDc: state.accumulatedDc,
        playerRolled: null,
        outcome: "timed_out",
        appVersion: APP_VERSION,
        promptVersion: PROMPT_VERSION,
        narrative: message.slice(0, 500),
      });
      this.charRepo.update(characterId, { last_action_state: null });
      if (refunded && row) {
        // Hand the spent roll back and stamp the day. Cap at the day's ACTUAL allowance
        // (incl. the Saturday bonus) — capping at the bare weekday allowance would silently
        // eat a Saturday bonus roll from a player who'd already used it before timing out.
        const allowance =
          DAILY_ROLL_ALLOWANCE + (new Date().getUTCDay() === 6 ? SATURDAY_BONUS_ROLLS : 0);
        this.charRepo.update(characterId, {
          rolls_remaining: Math.min(allowance, row.rolls_remaining + 1),
        });
        this.stampRefundDay(characterId, "last_timeout_refund_day", today);
      }
    })();

    return outcome;
  }

  private toPublicState(internal: InternalActionState): {
    rawInput: string;
    decisions: ActionDecisionRecord[];
    accumulatedDc: number;
    kind?: ActionKind;
  } {
    return {
      rawInput: internal.rawInput,
      decisions: internal.decisions,
      accumulatedDc: internal.accumulatedDc,
      ...(internal.kind ? { kind: internal.kind } : {}),
    };
  }
}
