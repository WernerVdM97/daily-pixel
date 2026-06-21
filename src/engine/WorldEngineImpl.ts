/** 30 minutes in ms — mid-action state auto-times out after this. */
const ACTION_TIMEOUT_MS = 30 * 60 * 1000;

import type Database from "better-sqlite3";
import type { LlmGateway, CartographerGateway } from "../llm/LlmGateway.js";
import type { UserRepository } from "../db/repositories/user.js";
import type {
  CharacterRepository,
  CharacterRow,
} from "../db/repositories/character.js";
import type { ItemRepository } from "../db/repositories/item.js";
import type { ActionRepository } from "../db/repositories/action.js";
import type { NpcRepository } from "../db/repositories/npc.js";
import { LocationRepository } from "../db/repositories/location.js";
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
  type WorldContextResolver,
} from "./action/machine.js";
import { validateMutations, applyMutations } from "./action/mutations.js";
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
  WorldMutation,
  NearbyEntity,
  LocationInfo,
  ItemData,
  JournalData,
  TickResult,
  NpcMovement,
  StatBlock,
  Leaderboards,
} from "./WorldEngine.js";

/** Daily action allotment granted at character creation and refreshed each tick. */
const DAILY_ROLL_ALLOWANCE = 3;

/** Extra rolls everyone is granted on the Saturday tick (a weekend treat). */
const SATURDAY_BONUS_ROLLS = 1;

// ── Seeded RNG helpers (no external deps) ──

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

/** Net character-state change after `after` (mutated) is applied to a CharacterRow.
 *  Subset of CharacterRow we read for the before→after diff. */
type AppliedStateView = {
  currentHealth: number;
  stamina: number;
  maxStamina: number;
  wealth: number;
  rollsRemaining: number;
  location: string;
};

/** Compact, human-readable summary of one applied mutation, e.g. `wealth+5`,
 *  `→Town Square`, `+item:Rabbit Pelt`. */
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

/** One concise, always-on line per resolved action: the mutations actually
 *  applied plus the net before→after state change. Makes anomalies (e.g. a roll
 *  handed back via modify_rolls_remaining) greppable from the live log. */
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
  /** D3 async world-builder. When present, a newly-created provisional location is
   *  enriched (is_safe + description) off the player's critical path. Optional —
   *  absent in tests / when no LLM key is configured; the row just stays provisional. */
  cartographer?: CartographerGateway;
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
    this.metaRepo = new MetaRepository(config.db);
    this.llmCallRepo = new LlmCallRepository(config.db);
    this.classDefs = config.classDefs ?? [];
    this.upbringingDefs = config.upbringingDefs ?? [];
    this.raceDefs = config.raceDefs ?? [];
    this.dayJobIncome = config.dayJobIncome ?? {};
    this.itemSets = config.itemSets ?? [];
    this.cartographer = config.cartographer;

    // Wrap LLM in fallback decorator (S4: two-tier retry → divine intervention)
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
    };

    this.machine = new ActionStateMachine(
      fallbackLlm,
      config.rollD20,
      contextResolver,
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

    // Assign starting items from the chosen item set
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

    return this.rowToCharacterData(row);
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
   * write the action row (+ link the LLM audit row), spawn NPCs, and clear any
   * mid-action state. Shared by stepAction and the startAction auto-finish path.
   * Caller wraps this in a transaction. Mutates `outcome.mutations` to drop
   * invalid entries so the renderer sees only what was applied (per spec).
   */
  private applyResolution(
    characterId: number,
    row: CharacterRow,
    outcome: ActionOutcome,
    rawInput: string,
    decisions: ActionDecisionRecord[],
  ): { worldChanged: boolean; provisionalLocations: string[] } {
    // Clear mid-action state (no-op for auto-finish, which never persisted)
    this.charRepo.update(characterId, { last_action_state: null });

    // D3 lazy world growth: a resolved set_location naming a place not on the
    // known map (case/trim-normalized) creates a PROVISIONAL stub row right now —
    // is_safe=0 (off-map wilds are unsafe until charted), a placeholder
    // description, enrichment_pending=1 — so the player lands somewhere valid and
    // renderable immediately (the stranding bug dies regardless of LLM timing).
    // An async cartographer (fired by the caller, off the critical path) fills in
    // is_safe + a real description later. Matches reuse the existing row (the
    // mutation validator/applier then snaps to canonical casing).
    const knownLocations = this.locationRepo.findAll().map((l) => l.name);
    const provisionalLocations = this.ensureProvisionalLocations(
      outcome.mutations,
      knownLocations,
    );

    const ctx = {
      currentHealth: row.health,
      maxHealth: row.max_health,
      stamina: row.stamina,
      maxStamina: row.max_stamina,
      wealth: row.wealth,
      rollsRemaining: row.rolls_remaining,
      location: row.location,
      // Now includes any just-created provisional names, so the set_location guard
      // accepts them and applyMutations snaps to canonical casing.
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

    // Apply character state changes
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

    // D1: did this resolution change the world? A character-state delta
    // (location/health/stamina/wealth/rolls), an item gained/lost, or an NPC
    // spawned all count. Drives the no-op roll refund in startAction. Computed
    // from the applied mutations only — the roll debit itself is not a "change".
    const worldChanged =
      Object.keys(updates).length > 0 ||
      applied.itemsToAdd.length > 0 ||
      applied.itemsToRemove.length > 0 ||
      applied.npcsToSpawn.length > 0;

    // Add items
    for (const item of applied.itemsToAdd) {
      this.itemRepo.create(characterId, item);
    }

    // Remove items — decrement the stack so trading 1 of N leaves the rest
    for (const { name, quantity } of applied.itemsToRemove) {
      this.itemRepo.decrementByName(characterId, name, quantity);
    }

    // Insight log + audit: record the mutations actually applied (post-validation,
    // post-failure-strip) and a one-line before→after summary of the net effect.
    logAppliedMutations(characterId, outcome, row, applied);

    // Insert action record
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
      // Save the LLM's outcome text as narrative for the journal
      narrative: (outcome.outcomeText ?? "").slice(0, 500) || null,
    });

    // Link the audit row to the action it produced (best-effort)
    if (outcome.llmCallId !== undefined) {
      this.llmCallRepo.linkAction(outcome.llmCallId, actionRow.id);
    }

    // Spawn NPCs
    for (const npc of applied.npcsToSpawn) {
      this.npcRepo.create({
        name: npc.name,
        class: npc.class,
        race: npc.race,
        description: npc.description,
        createdByActionId: actionRow.id,
      });
    }

    return { worldChanged, provisionalLocations };
  }

  /**
   * D3 async cartographer — fire-and-forget. For each provisional location just
   * created, ask the LLM (off the player's critical path) to chart it: fill
   * is_safe + a real description and clear enrichment_pending, only while the row
   * is STILL provisional (enrichProvisional guards on the flag, so a double-fire
   * or a row already settled is a no-op). If the cartographer says the new name is
   * really an existing place, we leave the provisional row alone (POC: no merge —
   * the player may be standing on it) and just clear the flag with the LLM's
   * verdict. Never awaited; never throws into the caller.
   */
  private fireCartographer(provisionalNames: string[], narrative: string): void {
    if (!this.cartographer || provisionalNames.length === 0) return;
    const cartographer = this.cartographer;

    for (const name of provisionalNames) {
      // Existing names EXCLUDING this fresh provisional row, so the cartographer
      // can flag it as a synonym of a real one.
      const existingNames = this.locationRepo
        .findAll()
        .map((l) => l.name)
        .filter((n) => n !== name);

      void (async () => {
        try {
          const result = await cartographer.enrich({ newName: name, existingNames, narrative });
          const description =
            result.description ??
            "An uncharted place beyond the known map.";
          const isSafe = result.is_safe ?? 0;
          const updated = this.locationRepo.enrichProvisional(name, { isSafe, description });
          if (updated) {
            console.log(
              `[cartographer] charted "${name}" (is_safe=${isSafe}${result.matchesExisting ? `, llm flagged dup of "${result.matchesExisting}"` : ""})`,
            );
          }
        } catch (err) {
          // Best-effort: a failed enrichment just leaves the row provisional.
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
   * D3 helper: for each `set_location` mutation whose name does not match (case/
   * trim-normalized) any known location, create a provisional stub row and return
   * the list of names actually created. A match reuses the existing row (no
   * create). Names are de-duped within the call. The `locations.name UNIQUE`
   * constraint + INSERT OR IGNORE make a racing create harmless.
   */
  private ensureProvisionalLocations(
    mutations: WorldMutation[],
    knownLocations: string[],
  ): string[] {
    const known = new Set(knownLocations.map((n) => n.trim().toLowerCase()));
    const created: string[] = [];

    for (const m of mutations) {
      if (m.type !== "set_location") continue;
      const name = typeof m.name === "string" ? m.name.trim() : "";
      if (name === "") continue;
      const norm = name.toLowerCase();
      if (known.has(norm)) continue; // snap-to-canonical handled downstream

      this.locationRepo.create({
        name,
        description: "An uncharted place, newly set foot upon. (Mapping…)",
        isSafe: 0,
        enrichmentPending: 1,
      });
      known.add(norm); // dedupe within this resolution
      created.push(name);
      console.log(`[location] provisional row created: "${name}" (enrichment pending)`);
    }

    return created;
  }

  async startAction(
    characterId: number,
    rawInput: string,
  ): Promise<ActionStartResult> {
    // Guard: prevent concurrent or duplicate action starts
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

      const startResult = await this.machine.start(char, rawInput, items);
      const internalState = startResult.state;

      // Divine intervention during start: drain roll, persist divine state, return single Resolve option
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
      // D1 roll economy — a roll is the price of a resolved action that CHANGES
      // the world or offers a real choice, never the price of merely starting one:
      //   • world-changing (>=1 applied mutation) or the player rolled → charge.
      //   • no-op (a `done` with no world change) → refund the roll, but only the
      //     first no-op per character per day; later no-ops that day still cost it.
      // applyResolution may itself adjust rolls_remaining (e.g. a +1 roll reward),
      // so the charge/refund is applied as a delta on top of the post-resolution value.
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

          const charged = startResult.outcome.playerRolled != null || res.worldChanged;
          // No-op gets the free refund only if it hasn't already been used today.
          const noopAlreadyRefundedToday = row.last_noop_refund_day === today;
          const debit = charged || noopAlreadyRefundedToday;

          // Re-read: applyResolution may have written a mutation-driven roll change.
          const afterRes = this.charRepo.findById(characterId)!;
          if (debit) {
            this.charRepo.update(characterId, {
              rolls_remaining: Math.max(0, afterRes.rolls_remaining - 1),
            });
          } else {
            // Free no-op refund granted — stamp the day so it's once-per-day.
            this.stampRefundDay(characterId, "last_noop_refund_day", today);
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

    // D2 30-min timeout: if the state has gone stale, resolve it as an in-voice
    // server-side timeout (refund the roll once per day) and return that outcome
    // so the UI renders an explicit grey card instead of a bare error.
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
        },
      };
    }

    const result = await this.machine.step(internalState, choice, char, items);

    if (result.resolved) {
      // Divine intervention (S4 tier-2): clear state but skip the action row + mutations
      if (result.outcome.distilledType === DIVINE_INTERVENTION_TYPE) {
        this.charRepo.update(characterId, { last_action_state: null });
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
      })();

      // D3: enrich any just-created provisional locations off the critical path.
      this.fireCartographer(provisionalLocations, result.outcome.outcomeText);

      return {
        resolved: true,
        state: this.toPublicState(result.state),
        outcome: result.outcome,
      };
    }

    // Persist updated state for next step
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

    // D2 30-min timeout: resolve the stale state (refund once/day, no mutations)
    // and surface the in-voice timeout message. The resume entry point can't return
    // an outcome, so we throw the player-facing message for the caller to show.
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
      })),
    };
  }

  // ── Feedback & bugs ──

  submitFeedback(characterId: number, text: string): void {
    this.db
      .prepare("INSERT INTO feedback (character_id, text) VALUES (?, ?)")
      .run(characterId, text);
  }

  submitBug(characterId: number, text: string): void {
    this.db
      .prepare("INSERT INTO bug_reports (character_id, text) VALUES (?, ?)")
      .run(characterId, text);
  }

  // ── Rest & recovery ──

  restAtOak(discordUserId: string): CharacterData | null {
    const user = this.userRepo.findByDiscordId(discordUserId);
    if (!user) return null;
    const row = this.charRepo.findByUserId(user.id);
    if (!row) return null;

    this.updateLastPlayed(row.id);

    // Stamp the rest on the current game day so the Rest nav button hides until
    // the next tick (when day_number advances and resting is possible again).
    const currentDay = Number(this.metaRepo.get("day_number") ?? "1");

    const oakName = "The Warden's Oak";
    if (row.location === oakName) {
      // Already at the Oak — still record the rest and return the character so
      // the command can flavour it.
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
        const [stat, value] = (
          Object.entries(c.stats) as [string, number][]
        ).reduce((best, cur) => (cur[1] > best[1] ? cur : best));
        return { name: c.name, class: c.class, value, stat };
      })
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);

    return { wealth, might };
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
      // Unknown location (no matching row) is treated explicitly as unsafe —
      // a soul standing somewhere we can't vouch for is "out in the wilds".
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

    // Cron idempotency: skip if last_cron_date is already today
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

    // Wrap all writes in a transaction so a partial failure doesn't
    // leave the world half-ticked and the cron date poisoned.
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

        // Stamina just bottomed out from the unsafe drain — flag a public
        // collapse announcement (by character name).
        if (charRow.stamina > 0 && newStamina === 0) {
          collapsedNames.push(charRow.name);
        }

        // Five-day absence nudge: on the tick where a player crosses exactly
        // 5 calendar days without interacting, collect their Discord id so the
        // caller can DM a "danger is nearby" warning. No HP penalty — this is a
        // soft, one-shot retention nudge (fires once, on day 5, not nightly).
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

        // 80% chance to move, seeded by NPC.id + newDay
        // Use multiplier to avoid seed collisions across NPCs.
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
    // Stamp lastActionAt on every persist so the 30-min timeout hook has a basis
    state.lastActionAt = Date.now();
    this.charRepo.update(characterId, {
      last_action_state: JSON.stringify(state),
    });
  }

  /** Current game day number (meta `day_number`, default 1). */
  private currentDayNumber(): number {
    return Number(this.metaRepo.get("day_number") ?? "1");
  }

  /**
   * Stamp a per-day refund-grace column on a character via raw SQL. These columns
   * (`last_noop_refund_day`, `last_timeout_refund_day`) are outside CharacterRepository's
   * update whitelist, so we write them directly — the column name is a fixed
   * literal (never user input), so this is injection-safe.
   */
  private stampRefundDay(
    characterId: number,
    column: "last_noop_refund_day" | "last_timeout_refund_day",
    day: number,
  ): void {
    this.db
      .prepare(`UPDATE player_characters SET ${column} = ? WHERE id = ?`)
      .run(day, characterId);
  }

  /**
   * D2 timeout handling. If the stored action state has been idle past the 30-min
   * timeout, atomically: clear the state, write a `timed_out` action row (no
   * mutations — the intended travel does NOT occur), and refund the roll for the
   * FIRST timeout per character per day (stamping `last_timeout_refund_day`); later
   * timeouts that day keep the roll spent. Returns an in-voice `timed_out`
   * ActionOutcome the caller surfaces for rendering, or null if the state is fresh.
   *
   * The timeout grace is separate from the D1 no-op grace — a server-side timeout
   * (our slowness) must never burn the player's no-op allowance, and vice versa.
   */
  private resolveStaleTimeout(
    state: InternalActionState,
    characterId: number,
  ): ActionOutcome | null {
    // If the state predates lastActionAt (pre-S7 state), treat as not stale.
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
    };

    // Wrap all writes so a partial failure can't leave a timed_out row orphaned
    // while last_action_state survives.
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
        // Hand the spent roll back (capped at the daily allowance) and stamp the day.
        this.charRepo.update(characterId, {
          rolls_remaining: Math.min(
            DAILY_ROLL_ALLOWANCE,
            row.rolls_remaining + 1,
          ),
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
  } {
    return {
      rawInput: internal.rawInput,
      decisions: internal.decisions,
      accumulatedDc: internal.accumulatedDc,
    };
  }
}
