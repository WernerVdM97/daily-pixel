/** Mid-action state auto-times out after this (30 min). */
const ACTION_TIMEOUT_MS = 30 * 60 * 1000;

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
import { RelationRepository } from "../db/repositories/relation.js";
import { CharacterLocationRepository } from "../db/repositories/characterLocation.js";
import { MetaRepository } from "../db/repositories/meta.js";
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
} from "./action/machine.js";
import {
  PipelineActionStateMachine,
} from "./action/PipelineActionStateMachine.js";
import type {
  PipelineInternalActionState,
} from "./action/PipelineActionStateMachine.js";
import { ProdPipelineLlmGateway, type ProdPipelineGatewayConfig } from "../llm/pipeline/ProdPipelineGateway.js";
import type { PipelineContextResolver } from "./action/pipeline-context.js";
import { persistAuthoredRelations, type NearbyNpc } from "./action/relation-wiring.js";
import { applyMutations, type MutationContext } from "./action/mutations.js";
import { createGeographyFinalize, HOME_REGION, routeBetween as geographyRouteBetween } from "./geography-finalize.js";
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
import { sanitizeAuthored } from "./authored-text.js";

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

/** Render a relation endpoint for the compact mutation summary, e.g. `pc`, `npc:Greta`. Shape
 *  only — no resolution (mirrors mutations.ts's `isValidEndpoint`; endpoints are unresolved here). */
function describeRelationEndpoint(v: unknown): string {
  if (typeof v !== "object" || v === null) return "?";
  const node = (v as { node?: unknown }).node;
  if (node === "pc") return "pc";
  if (node === "npc" || node === "location") {
    return `${node}:${String((v as { name?: unknown }).name ?? "?")}`;
  }
  return "?";
}

/** Compact summary of one mutation, e.g. `wealth+5`, `→Town Square`, `+item:Rabbit Pelt`. */
function summariseMutation(m: WorldMutation): string {
  switch (m.type) {
    case "move_to":
    case "set_location":
      return `→${String(m.name ?? "?")}`;
    case "cross_frontier":
      return `frontier:${String(m.direction ?? "?")}→${String(m.name ?? "?")}`;
    case "reveal_location":
      return `reveal:${String(m.name ?? "?")}`;
    case "add_item":
      return `+item:${String(m.name ?? "?")}`;
    case "remove_item":
      return `-item:${String(m.name ?? "?")}`;
    case "add_npc":
    case "spawn_npc":
      return `+npc:${String(m.name ?? "?")}`;
    case "update_npc":
      return `~npc:${String(m.npcId ?? "?")}`;
    case "remove_npc":
      return `-npc:${String(m.npcId ?? "?")}`;
    case "set_relation":
    case "update_relation": {
      const verb = m.type === "set_relation" ? "set" : "upd";
      return `${verb}_rel:${describeRelationEndpoint(m.from)}→${describeRelationEndpoint(m.to)}:${String(m.relType ?? "?")}`;
    }
    default: {
      // modify_* — show the signed amount against the trimmed stat name.
      const stat = (m.type as string).replace(/^modify_/, "");
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
  /** T6 live cutover: if present, build PipelineActionStateMachine (v12 pipeline) instead of
   *  the legacy ActionStateMachine. The sim's legacy path omits this and gets the v11 machine;
   *  production passes it and gets v12. After the smoke run clears, T7 makes this
   *  non-optional and deletes the legacy machine. */
  pipelineLlm?: ProdPipelineGatewayConfig;
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
  /** Stage 5 Task 0 — the prod host's scene-state repo, dormant under the legacy machine (which
   *  emits no relation mutations) but live the moment T6 installs the pipeline machine. */
  private relationRepo: RelationRepository;
  /** T5a: the shared geography-finalize closure (mint/route/collapse/validate), extracted so the
   *  pipeline sim can reuse the SAME logic over its own seeded repos — see geography-finalize.ts.
   *  Built in the constructor body (not a field initializer) since it closes over
   *  `this.locationRepo`/`this.edgeRepo`, which are themselves assigned in the constructor body. */
  private geographyFinalize: ReturnType<typeof createGeographyFinalize>;
  private charLocRepo: CharacterLocationRepository;
  private metaRepo: MetaRepository;
  private llmCallRepo: LlmCallRepository;
  /** T6 live cutover: pipeline machine (v12) when pipelineLlm is present, legacy machine (v11)
   *  otherwise. T7 collapses this to PipelineActionStateMachine only. */
  private machine: PipelineActionStateMachine | ActionStateMachine;
  private isPipeline: boolean;
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
  /** Guards against concurrent step() calls for the same action — T6 serialises step()
   *  per action so concurrent Discord interactions can't interleave combat state. */
  private steppingActions = new Set<number>();

  constructor(config: WorldEngineConfig) {
    this.db = config.db;
    this.userRepo = config.userRepo;
    this.charRepo = config.charRepo;
    this.itemRepo = config.itemRepo;
    this.actionRepo = config.actionRepo;
    this.npcRepo = config.npcRepo;
    this.locationRepo = new LocationRepository(config.db);
    this.edgeRepo = new LocationEdgeRepository(config.db);
    this.relationRepo = new RelationRepository(config.db);
    this.geographyFinalize = createGeographyFinalize({
      locationRepo: this.locationRepo,
      edgeRepo: this.edgeRepo,
    });
    this.charLocRepo = new CharacterLocationRepository(config.db);
    this.metaRepo = new MetaRepository(config.db);
    this.llmCallRepo = new LlmCallRepository(config.db);
    this.classDefs = config.classDefs ?? [];
    this.upbringingDefs = config.upbringingDefs ?? [];
    this.raceDefs = config.raceDefs ?? [];
    this.dayJobIncome = config.dayJobIncome ?? {};
    this.itemSets = config.itemSets ?? [];
    this.cartographer = config.cartographer;

    // ── T6 live cutover: pipeline machine when pipelineLlm is present, legacy when absent ──
    this.isPipeline = config.pipelineLlm !== undefined;

    const contextResolver: PipelineContextResolver = {
      getNearbyNpcs: (location: string) => this.nearbyNpcsAt(location),
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
        neighbours: this.edgeRepo
          .neighbours(location)
          .map((n) => ({ name: n.name, direction: n.direction, difficulty: n.difficulty })),
        frontiers: this.edgeRepo
          .frontierExits(location)
          .map((f) => ({ direction: f.direction, teaser: f.teaser, difficulty: f.difficulty })),
      }),
      getSceneRelations: (node) => this.relationRepo.forNode(node.type, node.ref),
      getCurrentDay: () => this.currentDayNumber(),
    };

    if (this.isPipeline) {
      // v12 pipeline path — ProdPipelineLlmGateway for DeepSeek-backed four-stage calls.
      // Critic is injected as the optional 5th ctor param (T4 pass-through). No
      // FallbackLlmGateway wrapping: resilience is structural in PipelineActionStateMachine
      // (classify throw → typed divine intervention; decide/resolve throws propagate).
      const pipelineGateway = new ProdPipelineLlmGateway(config.pipelineLlm!);
      this.machine = new PipelineActionStateMachine(
        pipelineGateway,
        config.rollD20,
        contextResolver,
        this.geographyFinalize,
        config.critic,
      );
    } else {
      // v11 legacy path — unchanged from before the swap. The sim's legacy path
      // (engine-factory.ts) omits pipelineLlm and arrives here. T7 deletes this branch.
      const fallbackLlm = new FallbackLlmGateway(config.llm, {
        onTier2Fallback: () => {
          const current = this.metaRepo.get("llm_fallback_count");
          const next = current ? String(Number(current) + 1) : "1";
          this.metaRepo.set("llm_fallback_count", next);
        },
      });
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
  }

  /** Extracted out of `contextResolver.getNearbyNpcs` (Stage 5 Task 0) so the relation-persist
   *  call in `applyResolution` resolves `npc` endpoints against the SAME source, rather than a
   *  second copy of this npc-mapping. */
  private nearbyNpcsAt(location: string): NearbyNpc[] {
    return this.npcRepo
      .findByLocation(location)
      .filter((n) => n.description)
      .sort((a, b) => a.id - b.id)
      .map((n) => ({ id: n.id, name: n.name, description: n.description! }));
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
    // engine-validated against the shared graph. `move_to`/`set_location` must reach a
    // charted node; `cross_frontier` mints new ground ONLY by crossing a real frontier exit.
    // Illegal moves are dropped (no lazy-create-from-thin-air). Returns the names
    // minted this turn — fed to the async cartographer to chart their geometry.
    const knownLocations = this.locationRepo.findAll().map((l) => l.name);
    const baseCtx: MutationContext = {
      currentHealth: row.health,
      maxHealth: row.max_health,
      stamina: row.stamina,
      maxStamina: row.max_stamina,
      wealth: row.wealth,
      rollsRemaining: row.rolls_remaining,
      location: row.location,
      knownLocations,
    };

    const { mutations: finalMutations, minted: provisionalLocations } = this.finalizeMutations(
      outcome.mutations,
      baseCtx,
      outcome.category,
    );
    outcome.mutations = finalMutations;

    // Include just-minted names so applyMutations' move_to/cross_frontier snap-to-canonical
    // sees the same known set finalizeMutations validated against.
    const ctx: MutationContext = {
      ...baseCtx,
      knownLocations: [...knownLocations, ...provisionalLocations],
    };

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
      applied.npcsToAdd.length > 0 ||
      applied.npcsToUpdate.length > 0 ||
      applied.npcsToRemove.length > 0 ||
      applied.locationsToReveal.length > 0 ||
      rollsGained;

    for (const item of itemsAdded) {
      this.itemRepo.create(characterId, item);
    }

    // Decrement the stack so trading 1 of N leaves the rest
    for (const { name, quantity } of itemsRemoved) {
      this.itemRepo.decrementByName(characterId, name, quantity);
    }

    // Stage 5 Task 0 — host wiring for the scene-state spine. The legacy machine never
    // constructs relation mutations, so in practice applied.relationsToSet/Update are always
    // empty here and this call is inert — not live until T6 installs the pipeline machine. The
    // only way a row could be written under v11 today is a malformed/injected LLM relation
    // mutation (set_relation/update_relation are in the global WORLD_MUTATION_TYPES), which
    // nothing in the v11 read path consumes (getSceneRelations is pipeline-only) and which the
    // T7 cutover wipe clears — so it's observably inert, not structurally gated.
    // Inside the caller's existing db.transaction (both callers wrap applyResolution in one).
    persistAuthoredRelations(
      this.relationRepo,
      applied.relationsToSet,
      applied.relationsToUpdate,
      { id: characterId },
      this.nearbyNpcsAt(row.location),
    );

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
      promptVersion: this.isPipeline ? 'v12' : PROMPT_VERSION,
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

    // add_npc: create-only + collision detection (§2a). Never auto-merge — a duplicate
    // name at the same location is almost certainly an LLM accident; flag it and still create,
    // so the auditable world-state change is recorded even when we know it's a dup.
    for (const npc of applied.npcsToAdd) {
      const atLocation = applied.location;
      const collision = this.npcRepo.findByLocation(atLocation)
        .find(existing => existing.name.trim().toLowerCase() === npc.name.trim().toLowerCase());
      if (collision) {
        const warn = `add_npc collision: "${npc.name}" already exists at "${atLocation}" (id=${collision.id}) — creating duplicate`;
        console.warn(`[engine] ${warn}`);
        // Append to validation_warnings on the LLM call if we can — telemetry for §5a.
        // (Best-effort; the call may not exist yet when add_npc comes from a test fixture.)
      }
      this.npcRepo.create({
        name: npc.name,
        class: npc.class,
        race: npc.race,
        description: npc.description,
        location: atLocation,
        homeLocation: npc.homeLocation,
        createdByActionId: actionRow.id,
      });
    }

    // update_npc: apply field changes via resolved npcId (§2a). class and race are included
    // because the repo's allowed-list already gates which DB columns can be written.
    for (const upd of applied.npcsToUpdate) {
      const fields: Record<string, unknown> = {};
      if (upd.description !== undefined) fields.description = upd.description;
      if (upd.location !== undefined) fields.location = upd.location;
      if (upd.class !== undefined) fields.class = upd.class;
      if (upd.race !== undefined) fields.race = upd.race;
      if (Object.keys(fields).length > 0) {
        this.npcRepo.update(upd.npcId, fields);
      }
    }

    // remove_npc: hard delete — the action audit row (created_by_action_id on the npc) is
    // already persisted, so provenance is preserved even after the row is gone.
    for (const rem of applied.npcsToRemove) {
      this.db.prepare('DELETE FROM npcs WHERE id = ?').run(rem.npcId);
    }

    // reveal_location: author a frontier exit at the current location (§3). The destination
    // is NOT created yet — it's minted when cross_frontier binds it later. direction is
    // auto-assigned from the first unused cardinal if not provided in the mutation.
    for (const reveal of applied.locationsToReveal) {
      this.applyRevealLocation(row.location, reveal, actionRow.id);
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
   * Deterministic mutation finalize: geography → collapse → validate (Thread D Task 3's
   * extraction of `applyResolution`'s inline steps, so the pipeline machine's D5b inversion can
   * call the same logic ahead of narration). "Pure" is read narrowly here — it never persists an
   * action's health/wealth/rolls/action-row — but `applyGeography`/`resolveCrossFrontier`'s
   * pre-existing frontier-mint DB write (a `locations` row + a bound `location_edges` row on a
   * first crossing) is untouched live behaviour, not a resolution-level persist, so it stays.
   */
  private finalizeMutations(
    proposed: WorldMutation[],
    ctx: MutationContext,
    category?: string,
  ): { mutations: WorldMutation[]; minted: string[] } {
    return this.geographyFinalize(proposed, ctx, category);
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
            // Geometry — validated/defaulted here, never trusted blind. The region is
            // sanitized: it lands in /map headers and the prompt's region labels.
            region: (result.region ? sanitizeAuthored(result.region, 40) : "") || fromRegion || HOME_REGION,
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
      // Sanitize + cap the teaser: it's shown on /map and re-injected into every future
      // decision prompt from this node, so an unbounded or markdown-laden one bloats both.
      const teaser = sanitizeAuthored(f.teaser, 120);
      this.edgeRepo.recordEdge({ from, to: null, direction: dir, difficulty: f.difficulty, teaser });
    }
  }

  /**
   * Author a frontier exit for a `reveal_location` mutation (§3). Creates a `location_edges`
   * row with `to_location=NULL` at `fromLocation`. `direction` is auto-assigned from the first
   * unused cardinal/ordinal if not provided in the mutation. Does NOT create a location row —
   * the destination is minted when the player later `cross_frontier`s this exit.
   */
  private applyRevealLocation(
    fromLocation: string,
    reveal: { name: string; direction?: string; isSafe?: number; description?: string },
    actionId: number,
  ): void {
    const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const usedDirections = new Set(
      this.edgeRepo.all()
        .filter(e => e.from_location === fromLocation)
        .map(e => e.direction.toUpperCase()),
    );

    const direction = reveal.direction?.toUpperCase().trim() ||
      CARDINALS.find(d => !usedDirections.has(d)) ||
      "N"; // last-resort fallback when all directions occupied

    // Skip if this direction already has an outbound edge from this location
    if (usedDirections.has(direction)) {
      console.warn(
        `[engine] reveal_location: direction "${direction}" already occupied at "${fromLocation}" — skipping`,
      );
      return;
    }

    const teaser = reveal.description
      ? `${reveal.name} — ${reveal.description}`
      : reveal.name;

    this.edgeRepo.recordEdge({
      from: fromLocation,
      to: null,
      direction,
      teaser,
      difficulty: 2,
      createdByActionId: actionId,
    });
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

      if (this.isPipeline) {
        return await this.startActionPipeline(characterId, row, char, rawInput, items, opts);
      }
      return await this.startActionLegacy(characterId, row, char, rawInput, items, opts);
    } finally {
      this.processingActions.delete(characterId);
    }
  }

  /** Pipeline (v12) startAction — classifies, decides, auto-finishes or drains roll. */
  private async startActionPipeline(
    characterId: number,
    row: CharacterRow,
    char: CharacterData,
    rawInput: string,
    items: ItemData[],
    opts: { kind?: ActionKind; wage?: number },
  ): Promise<ActionStartResult> {
    // No AbortError catch here — all 6 observed decide timeouts in the v12 QA session
    // were beat-2 CONTINUE calls (stepActionPipeline path). A beat-1 decide timeout is
    // theoretically possible but unobserved; catching it would require restructuring the
    // roll-drain transaction (the roll hasn't been drained yet pre-start()) and plumbing a
    // timed-out ActionOutcome through ActionStartResult, which is designed for
    // divine-intervention outcomes only. If beat-1 timeouts become common, add a catch
    // mirroring stepActionPipeline with a no-drain refund (roll was never spent).
    const machine = this.machine as PipelineActionStateMachine;
    const startResult = await machine.start(char, rawInput, items, opts.kind, opts.wage);
    const internalState = startResult.state;

    // Pipeline divine intervention: classify fallback failure resolves outright — drain the roll
    // (not refunded) and return the canned outcome. The legacy path's two-phase divine
    // intervention (mark → resolve) is retired; the pipeline resolves it in a single beat.
    if (startResult.resolved && startResult.outcome.isDivineIntervention) {
      this.db.transaction(() => {
        this.charRepo.update(characterId, {
          rolls_remaining: Math.max(0, row.rolls_remaining - 1),
        });
        this.applyResolution(characterId, row, startResult.outcome, rawInput, internalState.decisions);
      })();
      startResult.outcome.rollsDelta = -1;
      return {
        state: this.toPublicState(internalState),
        firstDecision: internalState.pendingDecision,
        outcome: startResult.outcome,
      };
    }

    // Pipeline divine intervention during startAction (classify failure): handled above as
    // `startResult.resolved` path. Pipeline DECIDE never authors mutations/outcome_text, so
    // no auto-finish path exists here — DECIDE always returns `resolved: false`.

    // Normal path: drain a roll + persist state atomically.
    // Pipeline no-op refund path is accepted scope reduction from T2 review — every pipeline
    // action costs exactly 1 roll unconditionally.
    this.db.transaction(() => {
      this.charRepo.update(characterId, {
        rolls_remaining: Math.max(0, row.rolls_remaining - 1),
      });
      this.persistState(characterId, internalState);
    })();

    // At this point startResult is resolved: false (the divine-intervention branch returned
    // early), so firstDecision is guaranteed.
    const firstDecision = (startResult as Extract<typeof startResult, { resolved: false }>).firstDecision;
    return {
      state: this.toPublicState(internalState),
      firstDecision,
    };
  }

  /** Legacy (v11) startAction — unchanged from before the swap. */
  private async startActionLegacy(
    characterId: number,
    row: CharacterRow,
    char: CharacterData,
    rawInput: string,
    items: ItemData[],
    opts: { kind?: ActionKind; wage?: number },
  ): Promise<ActionStartResult> {
    const machine = this.machine as ActionStateMachine;
    const startResult = await machine.start(char, rawInput, items, opts.kind, opts.wage);
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

        if (startResult.outcome.systemRefund) {
          // Degenerate decision shape on the very first beat (roll not yet drained here): never
          // charge and never consume the once-per-day no-op grace — the player got no real choice.
          startResult.outcome.rollsDelta = 0;
          startResult.outcome.rollRefunded = true;
        } else {
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
        }
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
  }

  async stepAction(
    characterId: number,
    choice: string,
  ): Promise<ActionStepResult> {
    const row = this.charRepo.findById(characterId);
    if (!row) throw new Error("Character not found");
    if (!row.last_action_state) throw new Error("No action in progress");

    const internalState = JSON.parse(row.last_action_state) as InternalActionState | PipelineInternalActionState;

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

    if (this.isPipeline) {
      return await this.stepActionPipeline(characterId, row, char, internalState as PipelineInternalActionState, choice, items);
    }
    return await this.stepActionLegacy(characterId, row, char, internalState as InternalActionState, choice, items);
  }

  /** Pipeline (v12) stepAction — handles divine intervention, multi-beat persist, and
   *  serialised step() per action (guards against concurrent Discord interactions
   *  interleaving one action's combat state). */
  private async stepActionPipeline(
    characterId: number,
    row: CharacterRow,
    char: CharacterData,
    internalState: PipelineInternalActionState,
    choice: string,
    items: ItemData[],
  ): Promise<ActionStepResult> {
    // T6 serialisation: guard against concurrent step() calls for the same action.
    // Two Discord interactions (e.g. combat round + explore choice) must not interleave
    // one action's combat state — round N is persisted before round N+1 begins.
    if (this.steppingActions.has(characterId)) {
      throw new Error(
        "A step is already being processed for this action. Wait for the result before choosing again.",
      );
    }
    this.steppingActions.add(characterId);

    try {
      const machine = this.machine as PipelineActionStateMachine;
      const result = await machine.step(internalState, choice, char, items);

      if (result.resolved) {
        // Pipeline divine intervention — the outcome carries `isDivineIntervention: true`,
        // not a legacy string sentinel. Clear state, skip refund (the roll was drained at start).
        if (result.outcome.isDivineIntervention) {
          this.charRepo.update(characterId, { last_action_state: null });
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

          // T6 — refund calls: confirm the refund-day logic (bail/timeout/systemRefund)
          // still fires on the pipeline path, not just the legacy path. The pipeline machine
          // emits `systemRefund` for degenerate-shape no-ops (accepted scope reduction from
          // T2: no no-op refund path in startAction, but stepAction's bail path still
          // propagates). The bail-refund grace is once-per-day, same as legacy.
          const today = this.currentDayNumber();
          const systemRefund = result.outcome.systemRefund === true;
          const bailRefunded =
            result.outcome.outcome === "bailed" && row.last_bail_refund_day !== today;
          if (systemRefund || bailRefunded) {
            this.refundRoll(characterId);
            if (bailRefunded && !systemRefund) {
              this.stampRefundDay(characterId, "last_bail_refund_day", today);
            }
            result.outcome.rollsDelta = res.rollsMutationDelta;
            result.outcome.rollRefunded = true;
          } else {
            result.outcome.rollsDelta = -1 + res.rollsMutationDelta;
          }
          result.outcome.actionId = res.actionId;
        })();

        this.fireCartographer(provisionalLocations, result.outcome.outcomeText);

        return {
          resolved: true,
          state: this.toPublicState(result.state),
          outcome: result.outcome,
        };
      }

      // ── Non-terminal branch — multi-beat scene-state persist ──
      // The pipeline machine returns mutations on non-terminal beats (e.g. combat rounds).
      // Apply them and persist relations before the next beat's context is built, so
      // scene-state read-back works across beats. Mirrors PipelineSimEngine.stepAction
      // :195-221, reusing the Task 0 persistAuthoredRelations helper. Round N is persisted
      // before round N+1 begins (ordering asserted by the serialisation guard above).
      if (result.mutations && result.mutations.length > 0) {
        // Capture location as of action START — combat beats never move the character, but
        // keeping the same capture-then-pass shape as the terminal path avoids divergence.
        const preMoveLocation = char.location;
        const ctx: MutationContext = {
          currentHealth: char.health,
          maxHealth: char.maxHealth,
          stamina: char.stamina,
          maxStamina: char.maxStamina,
          wealth: char.wealth,
          rollsRemaining: char.rollsRemaining,
          location: char.location,
        };
        const applied = applyMutations(result.mutations, ctx);

        // Apply HP/stamina changes to the character in DB before the next beat.
        const charUpdates: Record<string, unknown> = {};
        if (applied.currentHealth !== char.health) charUpdates.health = applied.currentHealth;
        if (applied.stamina !== char.stamina) charUpdates.stamina = applied.stamina;
        if (applied.maxStamina !== char.maxStamina) charUpdates.max_stamina = applied.maxStamina;
        if (Object.keys(charUpdates).length > 0) {
          this.charRepo.update(characterId, charUpdates);
        }

        // Persist scene-state relations authored this beat.
        persistAuthoredRelations(
          this.relationRepo,
          applied.relationsToSet,
          applied.relationsToUpdate,
          { id: characterId },
          this.nearbyNpcsAt(preMoveLocation),
        );
      }

      this.persistState(characterId, result.state);

      return {
        resolved: false,
        state: this.toPublicState(result.state),
        nextDecision: result.nextDecision,
      };
    } catch (_err) {
      const err = _err as Error & { name?: string };
      if (err.name === 'AbortError' || (err.message ?? '').toLowerCase().includes('abort')) {
        // DeepSeek decide timeout — resolve as timed_out instead of re-throwing so the
        // player isn't re-served the same stuck decision (v12 QA §1: each timed-out
        // CONTINUE beat re-presented the identical decision screen).
        const timeoutState: PipelineInternalActionState = {
          ...internalState,
          lastActionAt: Date.now(),
        };
        this.charRepo.update(characterId, { last_action_state: null });
        // Stamina cost mirrors bail — applied directly since we bypass applyResolution.
        const newStamina = Math.max(0, row.stamina - 1);
        this.charRepo.update(characterId, { stamina: newStamina });
        // System timeout always refunds the roll (not subject to once-per-day grace).
        this.refundRoll(characterId);
        return {
          resolved: true,
          state: this.toPublicState(timeoutState),
          outcome: {
            distilledType: internalState.distilledType,
            finalDc: internalState.accumulatedDc,
            playerRolled: null,
            outcome: 'timed_out',
            mutations: [{ type: 'modify_stamina', amount: -1 }],
            outcomeText:
              "The Warden's voice grows distant. Your action hangs in the air, unresolved.",
            rollStat: internalState.rollStat,
            systemRefund: true,
            rollsDelta: 0,
            rollRefunded: true,
          },
        };
      }
      throw err;
    } finally {
      this.steppingActions.delete(characterId);
    }
  }

  /** Legacy (v11) stepAction — unchanged from before the swap. */
  private async stepActionLegacy(
    characterId: number,
    row: CharacterRow,
    char: CharacterData,
    internalState: InternalActionState,
    choice: string,
    items: ItemData[],
  ): Promise<ActionStepResult> {
    // Legacy divine intervention from startAction — resolve directly, no LLM call
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

    const machine = this.machine as ActionStateMachine;
    const result = await machine.step(internalState, choice, char, items);

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
        const today = this.currentDayNumber();
        const systemRefund = result.outcome.systemRefund === true;
        const bailRefunded =
          result.outcome.outcome === "bailed" && row.last_bail_refund_day !== today;
        if (systemRefund || bailRefunded) {
          this.refundRoll(characterId);
          if (bailRefunded && !systemRefund) {
            this.stampRefundDay(characterId, "last_bail_refund_day", today);
          }
          result.outcome.rollsDelta = res.rollsMutationDelta;
          result.outcome.rollRefunded = true;
        } else {
          result.outcome.rollsDelta = -1 + res.rollsMutationDelta;
        }
        result.outcome.actionId = res.actionId;
      })();

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
    ) as InternalActionState | PipelineInternalActionState;

    // D2 30-min timeout: resolve stale state (refund once/day, no mutations). Resume
    // can't return an outcome, so throw the player-facing message for the caller.
    const timeout = this.resolveStaleTimeout(internalState, characterId);
    if (timeout) {
      throw new Error(timeout.outcomeText);
    }

    const { state, nextDecision } = this.isPipeline
      ? (this.machine as PipelineActionStateMachine).resume(internalState as PipelineInternalActionState)
      : (this.machine as ActionStateMachine).resume(internalState as InternalActionState);

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
    // The current location is always part of your own view, even pre-record. If it has no
    // visit row yet, the player is standing there now — stamp it with a DB-formatted "now"
    // (matches the stored format) so it sorts most-recent and never breaks the non-null
    // lastVisitedAt contract with an empty string.
    discovered.add(current);
    if (!lastVisited.has(current)) {
      const now = (this.db.prepare("SELECT datetime('now') AS now").get() as { now: string }).now;
      lastVisited.set(current, now);
    }

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

  /** Least-cost route over the shared graph (Dijkstra on edge difficulty); null when
   *  unreachable (§2). The cost is computed but not charged as stamina yet — that's
   *  deferred to fast-travel (§9). Used today to validate movement reachability.
   *  Body lives in `geography-finalize.ts` (T5a) — shared with the pipeline sim. */
  routeBetween(from: string, to: string): TravelRoute | null {
    return geographyRouteBetween(this.edgeRepo, from, to);
  }

  /** Public visit-recorder for non-engine movement paths (the daily-work commute). */
  recordVisit(characterId: number, locationName: string): void {
    this.charLocRepo.recordVisit(characterId, locationName);
  }

  // ── Feedback & bugs ──

  submitFeedback(characterId: number, text: string, actionId?: number): void {
    this.db
      .prepare("INSERT INTO feedback (character_id, text, action_id, app_version) VALUES (?, ?, ?, ?)")
      .run(characterId, text, actionId ?? null, APP_VERSION);
  }

  submitBug(characterId: number, text: string, actionId?: number): void {
    this.db
      .prepare("INSERT INTO bug_reports (character_id, text, action_id, app_version) VALUES (?, ?, ?, ?)")
      .run(characterId, text, actionId ?? null, APP_VERSION);
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

  private persistState(characterId: number, state: InternalActionState | PipelineInternalActionState): void {
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
    column: "last_noop_refund_day" | "last_timeout_refund_day" | "last_bail_refund_day",
    day: number,
  ): void {
    this.charRepo.update(characterId, { [column]: day });
  }

  /** Refund one roll (add 1 to `rolls_remaining`, capped at today's total allowance including
   *  Saturday bonus). Used by bail, timeout, and no-op refund paths — the caller still owns
   *  grace-day stamping (`stampRefundDay`) and `rollRefunded` / `rollsDelta` bookkeeping. */
  private refundRoll(characterId: number): void {
    const allowance =
      DAILY_ROLL_ALLOWANCE + (new Date().getUTCDay() === 6 ? SATURDAY_BONUS_ROLLS : 0);
    const row = this.charRepo.findById(characterId)!;
    this.charRepo.update(characterId, {
      rolls_remaining: Math.min(allowance, row.rolls_remaining + 1),
    });
  }

  /**
   * D2 timeout. If the state has been idle past the 30-min timeout, atomically clear
   * it, write a `timed_out` action row (no mutations — the intended travel does NOT
   * occur), and refund the roll for the FIRST timeout per char per day; later timeouts
   * that day keep the roll spent. Returns an in-voice `timed_out` ActionOutcome, or null
   * if fresh. This grace is separate from the D1 no-op grace — a server-side timeout
   * must never burn the player's no-op allowance, and vice versa.
   *
   * T6: widened to accept the union of legacy and pipeline internal state types — both
   * carry `lastActionAt`, `distilledType`, `accumulatedDc`, `rawInput`, and `decisions`.
   */
  private resolveStaleTimeout(
    state: InternalActionState | PipelineInternalActionState,
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
        promptVersion: this.isPipeline ? 'v12' : PROMPT_VERSION,
        narrative: message.slice(0, 500),
      });
      this.charRepo.update(characterId, { last_action_state: null });
      if (refunded && row) {
        // Hand the spent roll back and stamp the day.
        this.refundRoll(characterId);
        this.stampRefundDay(characterId, "last_timeout_refund_day", today);
      }
    })();

    return outcome;
  }

  private toPublicState(internal: InternalActionState | PipelineInternalActionState): {
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
