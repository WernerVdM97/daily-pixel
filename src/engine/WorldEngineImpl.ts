/** Mid-action state auto-times out after this (30 min). */
const ACTION_TIMEOUT_MS = 30 * 60 * 1000;

/** A node never holds more than this many outgoing spokes (charted edges + frontier
 *  exits), so the map can't fan out without bound. */
const SPOKE_CAP = 5;

import type Database from "better-sqlite3";
import type { LlmGateway, CartographerGateway, CartographerResult, CriticGateway } from "../llm/LlmGateway.js";
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
import { APP_VERSION } from "../version.js";
import { PROMPT_SET_VERSION } from "../llm/prompt-builder.js";
import {
  PipelineActionStateMachine,
  enemyConditionBand,
} from "./action/PipelineActionStateMachine.js";
import type {
  PipelineInternalActionState,
} from "./action/PipelineActionStateMachine.js";
import { ProdPipelineLlmGateway, type ProdPipelineGatewayConfig } from "../llm/pipeline/ProdPipelineGateway.js";
import { isLlmStageFailure } from "../llm/pipeline/PipelineStageError.js";
import type { PipelineLlmGateway } from "../llm/pipeline/types.js";
import type { PipelineContextResolver } from "./action/pipeline-context.js";
import { persistAuthoredRelations, type NearbyNpc } from "./action/relation-wiring.js";
import type { CriticGateMode } from "./action/critic-gate.js";
import { applyMutations, type MutationContext } from "./action/mutations.js";
import { readCombatState, type CombatState } from "./action/combat-state.js";
import type { NodeType } from "../db/repositories/relation.js";
import type { SceneStateEdge } from "../llm/LlmGateway.js";
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
  PendingChoiceSelector,
  ActionOption,
  RestAtOakResult,
} from "./WorldEngine.js";
import { sanitizeAuthored } from "./authored-text.js";

/** Daily rolls granted at creation and refreshed each tick. Exported so the agent-player
 *  handbook test can pin its copy against the engine's real figures. */
export const DAILY_ROLL_ALLOWANCE = 3;

/** Extra rolls granted on the Saturday tick. */
export const SATURDAY_BONUS_ROLLS = 1;

/** Failed enrichment attempts before a provisional row gives up and settles with the placeholder. */
const ENRICHMENT_MAX_ATTEMPTS = 3;

/** Pending rows the nightly sweep re-fires per tick, oldest first. */
const ENRICHMENT_SWEEP_LIMIT = 3;

// ── Seeded RNG helpers ──

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

/** Render a relation endpoint for the compact mutation summary, e.g. `pc`, `npc:Greta`.
 *  Shape only, never resolved — the endpoint carries no id at this point. */
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

/** The two mutation kinds that read as player-facing journal intel: a location revealed, an NPC met. */
function journalDiscoveries(appliedMutationsJson: string | null): string[] {
  if (!appliedMutationsJson) return [];
  let mutations: WorldMutation[];
  try {
    mutations = JSON.parse(appliedMutationsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(mutations)) return [];

  const facts: string[] = [];
  for (const m of mutations) {
    const name = typeof m?.name === "string" ? m.name.trim() : "";
    if (!name) continue;
    if (m.type === "reveal_location") facts.push(`🗺️ Discovered **${name}**`);
    else if (m.type === "add_npc" || m.type === "spawn_npc") facts.push(`🤝 Met **${name}**`);
  }
  return facts;
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
  llm?: LlmGateway;
  userRepo: UserRepository;
  charRepo: CharacterRepository;
  itemRepo: ItemRepository;
  actionRepo: ActionRepository;
  npcRepo: NpcRepository;
  rollD20?: () => number;
  /** Enriches new provisional locations (is_safe + description) off the critical path.
   *  Absent in tests / without an LLM key — the row stays provisional. */
  cartographer?: CartographerGateway;
  /** Failed enrichment attempts before a row settles with the placeholder (default 3). */
  enrichmentMaxAttempts?: number;
  /** Pending rows the nightly sweep re-fires, oldest first (default 3). */
  enrichmentSweepLimit?: number;
  /** Coherence critic: decision beats via CritiquedLlmGateway, resolution beats via the machine
   *  hook. Absent = disabled. */
  critic?: CriticGateway;
  /** When the critic above fires. Absent → machine default ('narrate-gated'). */
  criticGateMode?: CriticGateMode;
  /** Pipeline config; unused when `pipelineLlmGateway` is present. */
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
  /** Pre-constructed pipeline gateway for tests/sim, used directly when present; otherwise
   *  `pipelineLlm` builds one. One of the two must be provided. */
  pipelineLlmGateway?: PipelineLlmGateway;
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
  /** Scene-state relation spine: projected into the decision context, read back for combat. */
  private relationRepo: RelationRepository;
  /** The shared geography-finalize closure (mint/route/collapse/validate), built in the
   *  constructor body because it closes over `locationRepo`/`edgeRepo`, assigned there. */
  private geographyFinalize: ReturnType<typeof createGeographyFinalize>;
  private charLocRepo: CharacterLocationRepository;
  private metaRepo: MetaRepository;
  private llmCallRepo: LlmCallRepository;
  private machine: PipelineActionStateMachine;
  private cartographer?: CartographerGateway;
  private enrichmentMaxAttempts: number;
  private enrichmentSweepLimit: number;
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

  private processingActions = new Set<number>();
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
    this.enrichmentMaxAttempts = config.enrichmentMaxAttempts ?? ENRICHMENT_MAX_ATTEMPTS;
    this.enrichmentSweepLimit = config.enrichmentSweepLimit ?? ENRICHMENT_SWEEP_LIMIT;

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

    const pipelineGateway = config.pipelineLlmGateway ?? new ProdPipelineLlmGateway(config.pipelineLlm!);
    this.machine = new PipelineActionStateMachine(
      pipelineGateway,
      config.rollD20,
      contextResolver,
      this.geographyFinalize,
      config.critic,
      config.criticGateMode,
    );
  }

  /** `npc` endpoints in `applyResolution`'s relation-persist call resolve against the same
   *  mapping the decision context uses, rather than a second copy of it. */
  private nearbyNpcsAt(location: string): NearbyNpc[] {
    return this.npcRepo
      .findByLocation(location)
      .filter((n) => n.description)
      .sort((a, b) => a.id - b.id)
      .map((n) => ({ id: n.id, name: n.name, description: n.description!, health: n.health }));
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

  /** New players start knowing the home Vale rather than "discovering" their own workplace;
   *  every other region stays fogged until explored. */
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

  // ── Action state machine ──

  /** Applies a resolved outcome, dropping invalid mutations from `outcome.mutations` so the
   *  renderer sees only what was applied. The caller wraps this in a transaction. */
  private applyResolution(
    characterId: number,
    row: CharacterRow,
    outcome: ActionOutcome,
    rawInput: string,
    decisions: ActionDecisionRecord[],
  ): { worldChanged: boolean; provisionalLocations: string[]; actionId: number; rollsMutationDelta: number } {
    console.log(`[engine] applyResolution start char=${characterId} type=${outcome.distilledType} outcome=${outcome.outcome}`);
    this.charRepo.update(characterId, { last_action_state: null });

    // Movement is engine-validated: an illegal move is dropped rather than lazily created, and
    // `cross_frontier` mints ground only through a real exit. Minted names feed the cartographer.
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

    // Just-minted names are added so the applier snaps moves against the same known set
    // `finalizeMutations` validated against.
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

    // Fog-of-war: record where you end up. A revisit refreshes the recency that orders /map;
    // the origin was already discovered.
    if (updates.location !== undefined) {
      this.charLocRepo.recordVisit(characterId, applied.location);
    }

    // The no-op refund's test: health/max-stamina/wealth/location/item/NPC deltas and gained rolls
    // count; spent stamina or rolls do not, and an item counts only if it really moved.
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
      promptVersion: PROMPT_SET_VERSION,
      appliedMutations:
        outcome.mutations.length > 0 ? JSON.stringify(outcome.mutations) : null,
      narrative: (outcome.outcomeText ?? "").slice(0, 500) || null,
      // Origin snapshot, not the destination: for travel it is where the character set out from,
      // which is what "from the Oak, set out east" reads as.
      locationName: row.location,
    });

    // Link every audit row this action produced (decision/narration/critic). Falls back to the
    // single resolution call id for states predating `llmCallIds`, de-duped to avoid double links.
    const callIdsToLink = new Set<number>(outcome.llmCallIds ?? []);
    if (outcome.llmCallId !== undefined) callIdsToLink.add(outcome.llmCallId);
    for (const callId of callIdsToLink) {
      this.llmCallRepo.linkAction(callId, actionRow.id);
    }

    // add_npc is create-only with collision detection: never auto-merge — flag the duplicate and
    // still create it, so the world-state change stays auditable.
    for (const npc of applied.npcsToAdd) {
      // An explicit `npc.location` wins: `applied.location` is the post-mutation location, and
      // using it desyncs the row from its wander anchor and lets a duplicate be minted later.
      const atLocation = npc.location ?? applied.location;
      const collision = this.npcRepo.findByLocation(atLocation)
        .find(existing => existing.name.trim().toLowerCase() === npc.name.trim().toLowerCase());
      if (collision) {
        const warn = `add_npc collision: "${npc.name}" already exists at "${atLocation}" (id=${collision.id}) — creating duplicate`;
        console.warn(`[engine] ${warn}`);
      }
      this.npcRepo.create({
        name: npc.name,
        class: npc.class,
        race: npc.race,
        description: npc.description,
        health: npc.health,
        location: atLocation,
        homeLocation: npc.homeLocation,
        createdByActionId: actionRow.id,
      });
    }

    // Field changes go through the resolved npcId; the repo's allowed-list gates the columns.
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

    // Hard delete: the row's `created_by_action_id` goes with it; the removal is recorded in this
    // action's `applied_mutations`.
    for (const rem of applied.npcsToRemove) {
      this.db.prepare('DELETE FROM npcs WHERE id = ?').run(rem.npcId);
    }

    for (const reveal of applied.locationsToReveal) {
      this.applyRevealLocation(row.location, reveal, actionRow.id);
    }

    // Stamped after the action row exists — the id is what provenance is written with.
    for (const name of provisionalLocations) {
      this.db
        .prepare('UPDATE locations SET created_by_action_id = ? WHERE name = ? AND created_by_action_id IS NULL')
        .run(actionRow.id, name);
    }

    // Rolls changed by this resolution's mutations alone; the caller folds in the start-drain.
    console.log(`[engine] applyResolution done char=${characterId} actionId=${actionRow.id} worldChanged=${worldChanged}`);
    return {
      worldChanged,
      provisionalLocations,
      actionId: actionRow.id,
      rollsMutationDelta: applied.rollsRemaining - row.rolls_remaining,
    };
  }

  /** Geography → collapse → validate. "Pure" only in that it never persists an action's
   *  health/wealth/rolls/row; the frontier-mint write it calls is live and stays. */
  private finalizeMutations(
    proposed: WorldMutation[],
    ctx: MutationContext,
    category?: string,
  ): { mutations: WorldMutation[]; minted: string[] } {
    return this.geographyFinalize(proposed, ctx, category);
  }

  private pendingEnrichmentNames(): Set<string> {
    return new Set(
      this.locationRepo.findAll().filter((l) => l.enrichment_pending === 1).map((l) => l.name),
    );
  }

  /** Provisional rows minted by this action, recovered by diffing the pending set around the
   *  machine call — `applyResolution`'s re-finalize against a bound edge reports none. */
  private mintedSince(before: Set<string>): string[] {
    return [...this.pendingEnrichmentNames()].filter((name) => !before.has(name));
  }

  private fireCartographer(provisionalNames: string[], narrative: string): void {
    if (!this.cartographer || provisionalNames.length === 0) return;
    for (const name of provisionalNames) {
      void this.enrichProvisionalLocation(name, narrative);
    }
  }

  /** Nightly re-attempt for rows a failed enrichment left pending, oldest first and bounded per
   *  tick so a burst of failures cannot turn into unbounded LLM spend in one sweep. */
  private reconcileEnrichment(): void {
    if (!this.cartographer) return;
    for (const row of this.locationRepo.findPendingEnrichment(this.enrichmentSweepLimit)) {
      // The narrative that minted the row is long gone; the sweep re-asks from the map alone.
      void this.enrichProvisionalLocation(row.name, "");
    }
  }

  /** One enrichment attempt — the validate + default path shared by the mint-time fire and the
   *  nightly sweep. A failure leaves the row provisional and counts the attempt; at the cap the
   *  row settles with the placeholder instead, so an unmappable name cannot retry for ever. */
  private async enrichProvisionalLocation(name: string, narrative: string): Promise<void> {
    const cartographer = this.cartographer;
    if (!cartographer) return;

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

    let result: CartographerResult | undefined;
    let failure = "";
    try {
      result = await cartographer.enrich({
        newName: name,
        existingNames,
        narrative,
        knownRegions,
        fromLocation,
        fromRegion,
      });
    } catch (err) {
      failure = ` (${err instanceof Error ? err.message : String(err)})`;
    }

    if (result === undefined) {
      const attempts = this.locationRepo.incrementEnrichmentAttempts(name);
      if (attempts < this.enrichmentMaxAttempts) {
        console.warn(
          `[cartographer] enrichment attempt ${attempts}/${this.enrichmentMaxAttempts} failed for "${name}"${failure} — the nightly sweep will retry`,
        );
        return;
      }
      console.warn(
        `[cartographer] giving up on "${name}" after ${attempts} attempts${failure} — settling with the placeholder`,
      );
      result = {};
    }

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
  }

  /** Author the cartographer's onward exits, one per free cardinal. A node stops growing once
   *  it holds `SPOKE_CAP` total spokes (charted edges + frontier exits). */
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
      // The teaser is shown on /map and re-injected into every future decision from this node,
      // so it is sanitised and capped.
      const teaser = sanitizeAuthored(f.teaser, 120);
      this.edgeRepo.recordEdge({ from, to: null, direction: dir, difficulty: f.difficulty, teaser });
    }
  }

  /** Author a frontier exit (`to_location=NULL`) for a `reveal_location`; the destination is
   *  minted only when a later `cross_frontier` binds it. `direction` defaults to a free cardinal. */
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

    if (row.last_action_state) {
      const isStaleResolved = this.isStaleResolvedState(row.last_action_state);
      if (isStaleResolved) {
        console.warn(
          `[engine] clearing stale resolved state for character ${characterId} — ` +
          `options were empty, action never persisted`,
        );
        this.charRepo.update(characterId, { last_action_state: null });
      } else {
        this.processingActions.delete(characterId);
        throw new Error(
          "You are already mid-action. Finish your current action first.",
        );
      }
    }

    this.updateLastPlayed(characterId);

    try {
      const char = this.rowToCharacterData(row);
      const items = this.getItems(characterId);

      return await this.startActionPipeline(characterId, row, char, rawInput, items, opts);
    } finally {
      this.processingActions.delete(characterId);
    }
  }

  /** A state the machine resolved whose persistence transaction threw: no options to choose and
   *  nothing to step, so it is unrecoverable and gets cleared for a fresh start. */
  private isStaleResolvedState(stateJson: string): boolean {
    try {
      const parsed = JSON.parse(stateJson);
      const opts = parsed?.pendingDecision?.options;
      return Array.isArray(opts) && opts.length === 0 && typeof parsed?.pendingDecision?.prompt === 'string' && parsed.pendingDecision.prompt.length > 0;
    } catch {
      // Unparseable state — treat as stale so it gets cleared.
      return true;
    }
  }

  /** Classifies, decides, then auto-finishes or drains a roll. */
  private async startActionPipeline(
    characterId: number,
    row: CharacterRow,
    char: CharacterData,
    rawInput: string,
    items: ItemData[],
    opts: { kind?: ActionKind; wage?: number },
  ): Promise<ActionStartResult> {
    // No LLM catch here by design: the machine owns beat-1 resilience and turns any stage
    // failure into a divine intervention, which arrives below as an ordinary resolved outcome.
    const machine = this.machine as PipelineActionStateMachine;
    const pendingBefore = this.pendingEnrichmentNames();
    const startResult = await machine.start(char, rawInput, items, opts.kind, opts.wage);
    const internalState = startResult.state;

    // Both resolving paths, divine intervention and auto-resolve, land here: drain the roll
    // (refunded for divine intervention), apply the outcome, return directly.
    if (startResult.resolved) {
      let res: ReturnType<typeof this.applyResolution>;
      try {
        this.db.transaction(() => {
          // A divine intervention is a system fault, not a real action, so its roll is not drained.
          const rollsRemaining = startResult.outcome.isDivineIntervention
            ? row.rolls_remaining
            : Math.max(0, row.rolls_remaining - 1);
          this.charRepo.update(characterId, {
            rolls_remaining: rollsRemaining,
          });
          // Mutate the row in place so `applyResolution`'s baseCtx and the rolls delta read the
          // drained value; otherwise a same-resolution grant clobbers the drain instead of stacking.
          row.rolls_remaining = rollsRemaining;
          res = this.applyResolution(characterId, row, startResult.outcome, rawInput, internalState.decisions);
        })();
      } catch (err) {
        // The transaction rolled back, so the roll was not drained and no action row exists. Clear
        // any `last_action_state` an external write set meanwhile so the character isn't stuck.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[engine] auto-resolve transaction failed for character ${characterId} ` +
          `(rawInput: "${rawInput.slice(0, 80)}", distilledType: ${internalState.distilledType}) — ` +
          `clearing last_action_state; error: ${msg}`,
        );
        this.charRepo.update(characterId, { last_action_state: null });
        throw err;
      }
      // The DB count was left untouched, so this path must not report a −1 spend.
      if (startResult.outcome.isDivineIntervention) {
        startResult.outcome.rollsDelta = 0;
        startResult.outcome.rollRefunded = true;
      } else {
        startResult.outcome.rollsDelta = -1 + res!.rollsMutationDelta;
      }
      // A crossing that auto-resolves inside start() still mints a provisional row, so its
      // enrichment is scheduled here, after the transaction commits.
      this.fireCartographer(this.mintedSince(pendingBefore), startResult.outcome.outcomeText);
      return {
        state: this.toPublicState(internalState),
        firstDecision: internalState.pendingDecision,
        outcome: startResult.outcome,
        actionType: internalState.actionType,
        combatEnemyName: internalState.lastDecideResult.combatEnemy?.name,
      };
    }

    // The decide beat produced real options — persist the state and hand back the first decision.

    // Drain a roll and persist atomically. No no-op refund on this path: every pipeline action
    // costs exactly one roll.
    this.db.transaction(() => {
      this.charRepo.update(characterId, {
        rolls_remaining: Math.max(0, row.rolls_remaining - 1),
      });
      this.persistState(characterId, internalState);
    })();

    // The resolving branch returned early, so `firstDecision` is guaranteed present here.
    const firstDecision = (startResult as Extract<typeof startResult, { resolved: false }>).firstDecision;
    const remembered = this.readPersistedCombatFoe(characterId, internalState, row.location);
    const llmName = internalState.lastDecideResult.combatEnemy?.name;
    return {
      state: this.toPublicState(internalState),
      firstDecision,
      actionType: internalState.actionType,
      combatEnemyName: llmName ?? remembered?.name,
      combatEnemyCondition: remembered?.condition,
    };
  }

  /** Reads a prior bail's persisted `in_combat` edge to band the foe's condition on the opening
   *  frame. A spare closes that edge, so the `undefined` after one is by design — don't re-open it. */
  private readPersistedCombatFoe(
    characterId: number,
    internalState: PipelineInternalActionState,
    currentLocation: string,
  ): { name: string; condition: { woundWord: string; filled: number; total: number } } | undefined {
    if (internalState.actionType !== 'combat') return undefined;

    // The DB row shape back into the `SceneStateEdge` shape `readCombatState` expects, mirroring
    // `pipeline-context.ts`'s scene-relations projection.
    const rows = this.relationRepo.forNode('pc', String(characterId));
    const edges: SceneStateEdge[] = rows.map((row) => ({
      from: { type: row.from_type as NodeType, ref: row.from_ref },
      to: { type: row.to_type as NodeType, ref: row.to_ref },
      relType: row.rel_type,
      props: JSON.parse(row.props) as Record<string, number | string | boolean>,
    }));

    const cs = readCombatState(edges);
    if (!cs) return undefined;
    if (cs.enemyHp <= 0 || cs.enemyMaxHp <= 0) return undefined;   // dead foe: nothing to remember
    if (cs.enemyHp >= cs.enemyMaxHp) return undefined;              // full HP reads identical to a fresh fight

    const llmName = internalState.lastDecideResult.combatEnemy?.name;
    const matches = llmName
      ? cs.enemyName.toLowerCase() === llmName.toLowerCase()
      : this.combatAnchorIsHere(cs, currentLocation);
    if (!matches) return undefined;

    const { filled, woundWord } = enemyConditionBand(cs.enemyHp / cs.enemyMaxHp);
    return { name: cs.enemyName, condition: { woundWord, filled, total: 5 } };
  }

  /** Is the remembered foe's anchor still here? Reached only when the LLM stayed silent on the
   *  foe's name, so it is the sole discriminator against a stale edge leaking onto this fight. */
  private combatAnchorIsHere(cs: CombatState, currentLocation: string): boolean {
    const anchor = cs.anchor;
    if (anchor.node === 'location') return anchor.name === currentLocation;
    if (anchor.node === 'npc') {
      return this.npcRepo.findByLocation(currentLocation).some((n) => String(n.id) === anchor.name);
    }
    return false; // pc anchor is never a foe
  }

  async stepAction(
    characterId: number,
    choice: string,
  ): Promise<ActionStepResult> {
    const row = this.charRepo.findById(characterId);
    if (!row) throw new Error("Character not found");
    if (!row.last_action_state) throw new Error("No action in progress");

    const internalState = JSON.parse(row.last_action_state) as PipelineInternalActionState;

    // A stale state resolves as an in-voice server-side timeout rather than a bare error.
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

    return await this.stepActionPipeline(characterId, row, char, internalState, choice, items);
  }

  /** Handles divine intervention, multi-beat persist, and serialised step() per action. */
  private async stepActionPipeline(
    characterId: number,
    row: CharacterRow,
    char: CharacterData,
    internalState: PipelineInternalActionState,
    choice: string,
    items: ItemData[],
  ): Promise<ActionStepResult> {
    // Serialised per action: two Discord interactions must not interleave one action's state, and
    // round N is persisted before round N+1 begins.
    if (this.steppingActions.has(characterId)) {
      throw new Error(
        "A step is already being processed for this action. Wait for the result before choosing again.",
      );
    }
    this.steppingActions.add(characterId);

    try {
      const machine = this.machine as PipelineActionStateMachine;
      const pendingBefore = this.pendingEnrichmentNames();
      const result = await machine.step(internalState, choice, char, items);

      if (result.resolved) {
        // Divine intervention: the roll was drained at start, so clearing the state resolves it.
        if (result.outcome.isDivineIntervention) {
          this.charRepo.update(characterId, { last_action_state: null });
          result.outcome.rollsDelta = -1;
          return {
            resolved: true,
            state: this.toPublicState(result.state),
            outcome: result.outcome,
          };
        }

        this.db.transaction(() => {
          const res = this.applyResolution(
            characterId,
            row,
            result.outcome,
            result.state.rawInput,
            result.state.decisions,
          );

          // `systemRefund` is never set on a beat that reaches here — only the timeout return below
          // sets it — so this refunds a bail, once per day (`last_bail_refund_day`).
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

        this.fireCartographer(this.mintedSince(pendingBefore), result.outcome.outcomeText);

        return {
          resolved: true,
          state: this.toPublicState(result.state),
          outcome: result.outcome,
        };
      }

      // ── Non-terminal branch — multi-beat scene-state persist ──
      // Non-terminal beats (combat rounds) return mutations: apply them and persist relations
      // before the next beat's context is built, so scene-state reads back across beats.
      if (result.mutations && result.mutations.length > 0) {
        // Location at action start; combat beats don't move, but the terminal path captures here.
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

        const charUpdates: Record<string, unknown> = {};
        if (applied.currentHealth !== char.health) charUpdates.health = applied.currentHealth;
        if (applied.stamina !== char.stamina) charUpdates.stamina = applied.stamina;
        if (applied.maxStamina !== char.maxStamina) charUpdates.max_stamina = applied.maxStamina;
        if (Object.keys(charUpdates).length > 0) {
          this.charRepo.update(characterId, charUpdates);
        }

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
      if (isLlmStageFailure(err)) {
        // An LLM stage failure past the first beat resolves as timed_out instead of re-serving the
        // same stuck decision. Narrow by design: only faults raised at the LLM boundary qualify.
        const timeoutState: PipelineInternalActionState = {
          ...internalState,
          lastActionAt: Date.now(), // advancing-pin audited: see resolveStaleTimeout's note
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



  resumeAction(characterId: number): ActionResumeResult {
    const row = this.charRepo.findById(characterId);
    if (!row) throw new Error("Character not found");
    if (!row.last_action_state) throw new Error("No action to resume");

    const internalState = JSON.parse(
      row.last_action_state,
    ) as PipelineInternalActionState;

    // The same timeout, but resume can't return an outcome — throw the player-facing message.
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

    const npcs = this.npcRepo.findByLocation(char.location);
    for (const npc of npcs) {
      entities.push({
        name: npc.name,
        classOrType: npc.class ?? "Unknown",
        description: npc.description ?? null,
        isPlayer: false,
      });
    }

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
        discoveries: journalDiscoveries(r.applied_mutations),
      })),
    };
  }

  // ── Map: fog-of-war over the shared graph ──

  /** The player's discovered subgraph — adjacency is shared truth, the mask is per-player. */
  getDiscoveredGraph(characterId: number): DiscoveredGraph {
    const charRow = this.charRepo.findById(characterId);
    const current = charRow?.location ?? "The Warden's Oak";

    const visits = this.charLocRepo.findByCharacter(characterId);
    const lastVisited = new Map(visits.map((v) => [v.location_name, v.last_visited_at]));
    const discovered = new Set(lastVisited.keys());
    // The current location is always in view, even pre-record: stamp a DB-formatted "now" so it
    // sorts most-recent and `lastVisitedAt` stays non-null rather than an empty string.
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

  /** Least-cost route over the shared graph (Dijkstra on edge difficulty); null when unreachable.
   *  The cost is computed but not yet charged as stamina. Body lives in `geography-finalize.ts`. */
  routeBetween(from: string, to: string): TravelRoute | null {
    return geographyRouteBetween(this.edgeRepo, from, to);
  }

  /** The day-job commute rule lives in the engine, not a frontend, so every client gets it. */
  commuteToWorkplace(characterId: number, workplace: string | null): { to: string; stamina: number } | null {
    const row = this.charRepo.findById(characterId);
    if (!row) return null;

    const oakName = "The Warden's Oak";
    if (row.location !== oakName || !workplace || workplace === row.location) return null;

    const stamina = Math.max(0, row.stamina - 1);
    this.charRepo.update(characterId, { stamina, location: workplace });
    this.charLocRepo.recordVisit(characterId, workplace);
    return { to: workplace, stamina };
  }

  resolvePendingChoice(characterId: number, selector: PendingChoiceSelector): string | null {
    const row = this.charRepo.findById(characterId);
    if (!row || !row.last_action_state) {
      return selector.kind === 'bail' ? 'Bail' : null;
    }

    // An empty option list stands in for a bare Continue button, so both selectors resolve against it.
    const internalState = JSON.parse(row.last_action_state) as PipelineInternalActionState;
    const rawOptions = internalState.pendingDecision?.options ?? [];
    const options: ActionOption[] = rawOptions.length > 0
      ? rawOptions
      : [{ label: 'Continue', dcModifier: 0 }];

    if (selector.kind === 'bail') {
      return options.find((o) => o.dcModifier === null)?.label ?? 'Bail';
    }
    return options[selector.index]?.label ?? null;
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

  restAtOak(discordUserId: string, opts?: { workplace?: string | null }): RestAtOakResult {
    const user = this.userRepo.findByDiscordId(discordUserId);
    if (!user) return { character: null, wasUnsafe: false, unsafeFromName: "" };
    const row = this.charRepo.findByUserId(user.id);
    if (!row) return { character: null, wasUnsafe: false, unsafeFromName: "" };

    this.updateLastPlayed(row.id);

    // Stamped on the current game day, which hides the Rest nav button until the next tick.
    const currentDay = Number(this.metaRepo.get("day_number") ?? "1");

    // Resting away from the Oak on unsafe ground costs 1 HP; the passed workplace is exempt,
    // since doing your job is not the leak the penalty exists for.
    const oakName = "The Warden's Oak";
    const alreadyThere = row.location === oakName;
    const atWorkplace = opts?.workplace != null && row.location === opts.workplace;
    const currentLoc = this.locationRepo.findByName(row.location);
    const wasUnsafe = currentLoc !== undefined && currentLoc.is_safe !== 1 && !alreadyThere && !atWorkplace;
    const unsafeFromName = row.location;

    if (alreadyThere) {
      this.charRepo.update(row.id, { last_rested_day: currentDay });
      return {
        character: this.rowToCharacterData({ ...row, last_rested_day: currentDay }),
        wasUnsafe,
        unsafeFromName,
      };
    }

    this.charRepo.update(row.id, {
      location: oakName,
      last_rested_day: currentDay,
    });
    let character = this.rowToCharacterData({
      ...row,
      location: oakName,
      last_rested_day: currentDay,
    });

    // Applied through modifyHealth so the clamp is shared and the returned character reflects it.
    if (wasUnsafe) {
      const updated = this.modifyHealth(discordUserId, -1);
      if (updated) character = updated;
    }

    return { character, wasUnsafe, unsafeFromName };
  }

  spawnNpc(data: {
    name: string;
    class?: string;
    race?: string;
    description?: string;
    location: string;
  }): void {
    // Idempotent: the threat rotation can land the same foe back at a spot it still occupies,
    // so don't stack a duplicate mob.
    const alreadyHere = this.npcRepo
      .findByLocation(data.location)
      .some((n) => n.name.trim().toLowerCase() === data.name.trim().toLowerCase());
    if (alreadyHere) return;

    this.npcRepo.create({
      name: data.name,
      class: data.class,
      race: data.race,
      description: data.description,
      location: data.location,
      // Anchored to its announced location: the nightly wander holds any NPC standing at its
      // `home_location` in place, so async players still find the foe where it was announced.
      homeLocation: data.location,
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
      if (isSafe === undefined || isSafe === false) count++;
    }
    return count;
  }

  countActivePlayersSince(startIso: string): number {
    return this.charRepo.countActiveSince(startIso);
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

  // ── World tick ──

  tick(isAdmin: boolean): TickResult {
    // Meant to move: the harness ticks the pinned clock a day before this call, so `today` is that day.
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
    const result = this.db.transaction((): TickResult => {
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

        // Fires once, on the tick that crosses day 5: calendar-based on purpose, no HP penalty.
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

        // Anchored NPCs (see `spawnNpc`) hold their post at `home_location` instead of wandering,
        // so an announced threat stays put for the weekend.
        if (npc.home_location && npc.location === npc.home_location) continue;

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

    // After the transaction: the sweep only queues async work, and the tick's write lock must
    // not be held across it.
    this.reconcileEnrichment();
    return result;
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

  private persistState(characterId: number, state: PipelineInternalActionState): void {
    // Stamp lastActionAt on every persist as the basis for the 30-min timeout.
    state.lastActionAt = Date.now();
    const isResolved = 'pendingDecision' in state &&
      Array.isArray((state as PipelineInternalActionState).pendingDecision?.options) &&
      (state as PipelineInternalActionState).pendingDecision.options.length === 0;
    console.log(
      `[engine] persistState char=${characterId} ` +
      `resolved=${isResolved} ` +
      `opts=${(state as PipelineInternalActionState).pendingDecision?.options?.length ?? '?'}`,
    );
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

  /** Refund one roll, capped at today's allowance (Saturday bonus included). Used by the bail,
   *  timeout and no-op paths; the caller owns grace-day stamping and the rolls bookkeeping. */
  private refundRoll(characterId: number): void {
    const allowance =
      DAILY_ROLL_ALLOWANCE + (new Date().getUTCDay() === 6 ? SATURDAY_BONUS_ROLLS : 0);
    const row = this.charRepo.findById(characterId)!;
    this.charRepo.update(characterId, {
      rolls_remaining: Math.min(allowance, row.rolls_remaining + 1),
    });
  }

  /** An idle action past the 30-minute timeout resolves as `timed_out` with no mutations, and its
   *  once-a-day roll refund is a separate grace from the no-op refund's. */
  private resolveStaleTimeout(
    state: PipelineInternalActionState,
    characterId: number,
  ): ActionOutcome | null {
    // State without `lastActionAt` predates the field and is treated as not stale.
    if (!state.lastActionAt) return null;
    // An action left pending overnight reads a day stale here: `lastActionAt` comes off the same
    // pinned clock the harness advances nightly. Pinned by tests/agent/advancing-clock.test.ts.
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

    // Transaction: a partial failure must not orphan a timed_out row while the state survives.
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
        promptVersion: PROMPT_SET_VERSION,
        narrative: message.slice(0, 500),
      });
      this.charRepo.update(characterId, { last_action_state: null });
      if (refunded && row) {
        this.refundRoll(characterId);
        this.stampRefundDay(characterId, "last_timeout_refund_day", today);
      }
    })();

    return outcome;
  }

  private toPublicState(internal: PipelineInternalActionState): {
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
