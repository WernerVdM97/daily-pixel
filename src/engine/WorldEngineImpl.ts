/** 30 minutes in ms — mid-action state auto-times out after this. */
const ACTION_TIMEOUT_MS = 30 * 60 * 1000;

import type Database from 'better-sqlite3';
import type { LlmGateway } from '../llm/LlmGateway.js';
import type { UserRepository } from '../db/repositories/user.js';
import type { CharacterRepository, CharacterRow } from '../db/repositories/character.js';
import type { ItemRepository } from '../db/repositories/item.js';
import type { ActionRepository } from '../db/repositories/action.js';
import type { NpcRepository } from '../db/repositories/npc.js';
import { LocationRepository } from '../db/repositories/location.js';
import { MetaRepository } from '../db/repositories/meta.js';
import { LlmCallRepository } from '../db/repositories/llm-call.js';
import { FallbackLlmGateway, DIVINE_INTERVENTION_TYPE, DIVINE_MESSAGE } from '../llm/FallbackLlmGateway.js';
import { PROMPT_VERSION } from '../llm/prompt-builder.js';
import { APP_VERSION } from '../version.js';
import { ActionStateMachine, type InternalActionState, type WorldContextResolver } from './action/machine.js';
import { validateMutations, applyMutations } from './action/mutations.js';
import { computeStats, type ClassDef, type ModifierDef } from './StatComputer.js';
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
} from './WorldEngine.js';

// ── Seeded RNG helpers (no external deps) ──

/** mulberry32 PRNG — deterministic, seedable. */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
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
  return tags.split(',').map(t => t.trim()).includes(tag);
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
    case 'set_location': return `→${String(m.name ?? '?')}`;
    case 'add_item': return `+item:${String(m.name ?? '?')}`;
    case 'remove_item': return `-item:${String(m.name ?? '?')}`;
    case 'spawn_npc': return `npc:${String(m.name ?? '?')}`;
    default: {
      // modify_* — show the signed amount against the trimmed stat name.
      const stat = m.type.replace(/^modify_/, '');
      const amt = Number(m.amount ?? 0);
      return `${stat}${amt >= 0 ? '+' : ''}${amt}`;
    }
  }
}

/** Only the character fields that changed, as `before→after` pairs. */
function stateDeltas(before: CharacterRow, after: AppliedStateView): string {
  const parts: string[] = [];
  if (after.currentHealth !== before.health) parts.push(`hp ${before.health}→${after.currentHealth}`);
  if (after.stamina !== before.stamina) parts.push(`sta ${before.stamina}→${after.stamina}`);
  if (after.maxStamina !== before.max_stamina) parts.push(`maxSta ${before.max_stamina}→${after.maxStamina}`);
  if (after.wealth !== before.wealth) parts.push(`wealth ${before.wealth}→${after.wealth}`);
  if (after.rollsRemaining !== before.rolls_remaining) parts.push(`rolls ${before.rolls_remaining}→${after.rollsRemaining}`);
  if (after.location !== before.location) parts.push(`loc ${before.location}→${after.location}`);
  return parts.join(', ') || 'no state change';
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
  const roll = outcome.playerRolled != null
    ? `roll=${outcome.playerRolled}${outcome.rollBonus ? `+${outcome.rollBonus}` : ''} vs DC${outcome.finalDc}`
    : 'no-roll';
  const muts = outcome.mutations.length > 0
    ? outcome.mutations.map(summariseMutation).join(', ')
    : 'none';
  const call = outcome.llmCallId !== undefined ? ` call=${outcome.llmCallId}` : '';
  console.log(
    `[mutations] char=${characterId} ${outcome.distilledType}/${outcome.outcome} ${roll}${call} | ` +
    `applied: ${muts} | net: ${stateDeltas(before, after)}`,
  );
}

/**
 * Check if the stored action state has been sitting idle past the 30-min timeout.
 * If stale, atomically clears the state and inserts a timed_out action row so the
 * player sees the correct outcome in their journal.
 *
 * @returns true if the state was stale and has been auto-failed
 */
function isStateStale(
  state: InternalActionState,
  _row: { id: number },
  actionRepo: ActionRepository,
  charRepo: CharacterRepository,
  characterId: number,
  db: Database.Database,
): boolean {
  // If the state predates lastActionAt (pre-S7 state), treat as not stale
  if (!state.lastActionAt) return false;

  const elapsed = Date.now() - state.lastActionAt;
  if (elapsed < ACTION_TIMEOUT_MS) return false;

  // Wrap both writes in a transaction so a partial failure doesn't leave
  // a timed_out row orphaned while last_action_state survives.
  db.transaction(() => {
    actionRepo.create({
      characterId,
      rawInput: state.rawInput,
      type: state.distilledType,
      decisionsJson: JSON.stringify(state.decisions),
      finalDc: state.accumulatedDc,
      playerRolled: null,
      outcome: 'timed_out',
      appVersion: APP_VERSION,
      promptVersion: PROMPT_VERSION,
    });
    charRepo.update(characterId, { last_action_state: null });
  })();

  return true;
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
  /** YAML asset data for stat computation. Injected so engine stays presentation-free. */
  classDefs?: ClassDef[];
  upbringingDefs?: ModifierDef[];
  raceDefs?: ModifierDef[];
  /** Day-job name → base_income for daily tick. Injected from parsed day-jobs.yml. */
  dayJobIncome?: Record<string, number>;
  /** Item sets from item-sets.yml — matched by name to assign starting items. */
  itemSets?: Array<{ name: string; for_classes: string[]; items: Array<{ name: string; emoji: string; stat: string; modifier: number; quantity?: number }> }>;
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
  private classDefs: ClassDef[];
  private upbringingDefs: ModifierDef[];
  private raceDefs: ModifierDef[];
  private dayJobIncome: Record<string, number>;
  private itemSets: Array<{ name: string; for_classes: string[]; items: Array<{ name: string; emoji: string; stat: string; modifier: number; quantity?: number }> }>;

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

    // Wrap LLM in fallback decorator (S4: two-tier retry → divine intervention)
    const fallbackLlm = new FallbackLlmGateway(config.llm, {
      onTier2Fallback: () => {
        const current = this.metaRepo.get('llm_fallback_count');
        const next = current ? String(Number(current) + 1) : '1';
        this.metaRepo.set('llm_fallback_count', next);
      },
    });

    const contextResolver: WorldContextResolver = {
      getNearbyNpcs: (location: string) => {
        return this.npcRepo.findByLocation(location)
          .filter(n => n.description)
          .map(n => ({ name: n.name, description: n.description! }));
      },
      getNearbyPcs: (location: string, excludeCharId: number) => {
        const allChars = this.charRepo.findAll();
        return allChars
          .filter(c => c.location === location && c.id !== excludeCharId)
          .map(c => ({ name: c.name, class: c.class }));
      },
      getRecentActions: (characterId: number) => {
        return this.actionRepo.findRecentByCharacterId(characterId, 3)
          .map(a => ({ type: a.type, outcome: a.outcome, narrative: a.narrative }));
      },
      getKnownLocations: () => {
        return this.locationRepo.findAll().map(l => l.name);
      },
    };

    this.machine = new ActionStateMachine(fallbackLlm, config.rollD20, contextResolver);
  }

  // ── Character lifecycle ──

  createCharacter(discordUserId: string, data: CharCreateData): CharacterData {
    const user = this.userRepo.findByDiscordId(discordUserId)
      ?? this.userRepo.create(discordUserId);

    const stats = this.classDefs.length > 0
      ? computeStats(data.class, data.upbringing, data.race, this.classDefs, this.upbringingDefs, this.raceDefs)
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
      rolls_remaining: 2,
      location: "The Warden's Oak",
      wealth: 0,
      last_action_state: null,
    });

    // Assign starting items from the chosen item set
    if (data.itemSetName) {
      const kit = this.itemSets.find(s => s.name === data.itemSetName);
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
  ): void {
    // Clear mid-action state (no-op for auto-finish, which never persisted)
    this.charRepo.update(characterId, { last_action_state: null });

    const ctx = {
      currentHealth: row.health,
      maxHealth: row.max_health,
      stamina: row.stamina,
      maxStamina: row.max_stamina,
      wealth: row.wealth,
      rollsRemaining: row.rolls_remaining,
      location: row.location,
    };

    // Per spec: malformed mutations are silently dropped, valid ones applied.
    const validation = validateMutations(outcome.mutations, ctx);
    if (!validation.valid) {
      console.warn(
        '[engine] Dropping invalid mutations:',
        validation.errors.map(e => `[${e.index}] ${e.message}`).join('; '),
      );
      const invalidIndices = new Set(validation.errors.map(e => e.index));
      outcome.mutations = outcome.mutations.filter((_, i) => !invalidIndices.has(i));
    }

    const applied = applyMutations(outcome.mutations, ctx);

    // Apply character state changes
    const updates: Record<string, unknown> = {};
    if (applied.currentHealth !== row.health) updates.health = applied.currentHealth;
    if (applied.stamina !== row.stamina) updates.stamina = applied.stamina;
    if (applied.maxStamina !== row.max_stamina) updates.max_stamina = applied.maxStamina;
    if (applied.wealth !== row.wealth) updates.wealth = applied.wealth;
    if (applied.rollsRemaining !== row.rolls_remaining) updates.rolls_remaining = applied.rollsRemaining;
    if (applied.location !== row.location) updates.location = applied.location;
    if (Object.keys(updates).length > 0) {
      this.charRepo.update(characterId, updates);
    }

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
      appliedMutations: outcome.mutations.length > 0 ? JSON.stringify(outcome.mutations) : null,
      // Save the LLM's outcome text as narrative for the journal
      narrative: (outcome.outcomeText ?? '').slice(0, 500) || null,
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
  }

  async startAction(characterId: number, rawInput: string): Promise<ActionStartResult> {
    // Guard: prevent concurrent or duplicate action starts
    if (this.processingActions.has(characterId)) {
      throw new Error('An action is already being processed. Finish your current action first.');
    }
    this.processingActions.add(characterId);

    const row = this.charRepo.findById(characterId);
    if (!row) {
      this.processingActions.delete(characterId);
      throw new Error('Character not found');
    }

    // Guard: character already mid-action (stale state in DB)
    if (row.last_action_state) {
      this.processingActions.delete(characterId);
      throw new Error('You are already mid-action. Finish your current action first.');
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
          options: [{ label: 'Resolve', dcModifier: 0 } as const],
        };

        return {
          state: { rawInput, decisions: [], accumulatedDc: 10 },
          firstDecision: divineDecision,
        };
      }

      // Auto-finish: the LLM resolved the action outright (e.g. travel/rest).
      // Drain a roll, apply the resolution (writes an action row), return the outcome.
      if (startResult.resolved) {
        this.db.transaction(() => {
          this.charRepo.update(characterId, {
            rolls_remaining: Math.max(0, row.rolls_remaining - 1),
          });
          this.applyResolution(characterId, row, startResult.outcome, rawInput, internalState.decisions);
        })();

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

  async stepAction(characterId: number, choice: string): Promise<ActionStepResult> {
    const row = this.charRepo.findById(characterId);
    if (!row) throw new Error('Character not found');
    if (!row.last_action_state) throw new Error('No action in progress');

    const internalState = JSON.parse(row.last_action_state) as InternalActionState;

    // 30-min timeout auto-fail: if the state has been sitting untouched, auto-fail it
    if (isStateStale(internalState, row, this.actionRepo, this.charRepo, characterId, this.db)) {
      throw new Error('Action timed out after 30 minutes');
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
          outcome: 'failure',
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

      this.db.transaction(() => {
        this.applyResolution(characterId, row, result.outcome, result.state.rawInput, result.state.decisions);
      })();

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
    if (!row) throw new Error('Character not found');
    if (!row.last_action_state) throw new Error('No action to resume');

    const internalState = JSON.parse(row.last_action_state) as InternalActionState;

    // 30-min timeout auto-fail: if the state has been sitting untouched, auto-fail it
    if (isStateStale(internalState, row, this.actionRepo, this.charRepo, characterId, this.db)) {
      throw new Error('Action timed out after 30 minutes');
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
      description: row.description ?? '',
      tags: row.tags ? row.tags.split(',').map(t => t.trim()) : [],
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
        classOrType: npc.class ?? 'Unknown',
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
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    this.charRepo.update(characterId, { last_played_at: now });
  }

  // ── Items ──

  getItems(characterId: number): ItemData[] {
    return this.itemRepo.findByCharacterId(characterId).map(row => ({
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
      knownLocations: locationRows.map(r => r.name),
      currentLocation,
      npcsEncountered: npcRows.map(r => ({
        name: r.name,
        class: r.class,
        location: r.location,
      })),
      recentActions: actionRows.map(r => ({
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
      .prepare('INSERT INTO feedback (character_id, text) VALUES (?, ?)')
      .run(characterId, text);
  }

  submitBug(characterId: number, text: string): void {
    this.db
      .prepare('INSERT INTO bug_reports (character_id, text) VALUES (?, ?)')
      .run(characterId, text);
  }

  // ── Rest & recovery ──

  restAtOak(discordUserId: string): CharacterData | null {
    const user = this.userRepo.findByDiscordId(discordUserId);
    if (!user) return null;
    const row = this.charRepo.findByUserId(user.id);
    if (!row) return null;

    this.updateLastPlayed(row.id);

    const oakName = "The Warden's Oak";
    if (row.location === oakName) {
      // Already at the Oak — still return the character so the command can flavour it
      return this.rowToCharacterData(row);
    }

    this.charRepo.update(row.id, { location: oakName });
    return this.rowToCharacterData({
      ...row,
      location: oakName,
    });
  }

  // ── Health modifier ──

  countSoulsInUnsafe(): number {
    const allChars = this.charRepo.findAll();
    let count = 0;
    for (const charRow of allChars) {
      const loc = this.locationRepo.findByName(charRow.location);
      if (!loc || loc.is_safe !== 1) count++;
    }
    return count;
  }

  modifyHealth(discordUserId: string, amount: number): CharacterData | null {
    const user = this.userRepo.findByDiscordId(discordUserId);
    if (!user) return null;
    const row = this.charRepo.findByUserId(user.id);
    if (!row) return null;
    const newHealth = Math.max(0, Math.min(row.max_health, row.health + amount));
    this.charRepo.update(row.id, { health: newHealth });
    return this.rowToCharacterData({ ...row, health: newHealth });
  }

  // ── World tick (S5) ──

  tick(isAdmin: boolean): TickResult {
    const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

    // Cron idempotency: skip if last_cron_date is already today
    if (!isAdmin) {
      const lastCron = this.metaRepo.get('last_cron_date');
      if (lastCron === today) {
        const dayNum = Number(this.metaRepo.get('day_number') ?? '1');
        return { dayNumber: dayNum, playersAffected: 0, npcMovements: [] };
      }
    }

    // Wrap all writes in a transaction so a partial failure doesn't
    // leave the world half-ticked and the cron date poisoned.
    return this.db.transaction((): TickResult => {
      // ── Advance day number ──
      const currentDayStr = this.metaRepo.get('day_number') ?? '1';
      const newDay = Number(currentDayStr) + 1;
      this.metaRepo.set('day_number', String(newDay));
      this.metaRepo.set('last_cron_date', today);

      // ── Player effects ──
      const allChars = this.charRepo.findAll();
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

        // Three-day absence penalty: if the player hasn't interacted
        // in 3+ days (by calendar date), they lose 3 health.
        if (charRow.last_played_at) {
          const lastDate = charRow.last_played_at.slice(0, 10);
          const diffMs = new Date(today + 'T00:00:00Z').getTime() - new Date(lastDate + 'T00:00:00Z').getTime();
          const diffDays = Math.floor(diffMs / 86400000);
          if (diffDays >= 3) {
            const absentPenalty = Math.min(3, newHealth !== undefined ? newHealth : charRow.health);
            if (newHealth !== undefined) {
              newHealth = Math.max(0, newHealth - absentPenalty);
            } else {
              newHealth = Math.max(0, charRow.health - absentPenalty);
            }
          }
        }

        const income = this.dayJobIncome[charRow.day_job] ?? 0;

        const updates: Record<string, unknown> = {
          rolls_remaining: 2,
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
        const cls = npc.class ?? '';

        // The Warden never leaves the Oak — frozen in place.
        if (cls === 'Warden') continue;

        if (cls === 'Blacksmith') {
          this.npcRepo.update(npc.id, { wealth: (npc.wealth ?? 0) + 5 });
          continue;
        }

        // 80% chance to move, seeded by NPC.id + newDay
        // Use multiplier to avoid seed collisions across NPCs.
        const seed = npc.id * 100000 + newDay;
        const rng = mulberry32(seed);
        const shouldMove = rng() < 0.8;

        if (!shouldMove) {
          if (cls === 'Merchant') {
            this.npcRepo.update(npc.id, {
              wealth: (npc.wealth ?? 0) + seededRandomRange(seed + 100000, 5, 15),
            });
          }
          continue;
        }

        // Determine destination by class
        let candidates: string[] = [];

        if (cls === 'Hunter') {
          candidates = allLocations
            .filter(l => locationTagsContain(l.tags, 'wilderness') || locationTagsContain(l.tags, 'forest'))
            .map(l => l.name);
        } else if (cls === 'Merchant') {
          candidates = allLocations
            .filter(l => locationTagsContain(l.tags, 'town') || locationTagsContain(l.tags, 'market') || locationTagsContain(l.tags, 'square'))
            .map(l => l.name);
        } else if (cls === 'Herbalist') {
          candidates = allLocations
            .filter(l => locationTagsContain(l.tags, 'forest') || locationTagsContain(l.tags, 'river'))
            .map(l => l.name);
        } else if (cls === 'Acolyte') {
          candidates = allLocations
            .filter(l => locationTagsContain(l.tags, 'shrine') || locationTagsContain(l.tags, 'temple'))
            .map(l => l.name);
        } else {
          candidates = allLocations.map(l => l.name);
        }

        if (candidates.length === 0) {
          candidates = allLocations.map(l => l.name);
        }

        const filteredCandidates = candidates.filter(c => c !== npc.location);
        if (filteredCandidates.length === 0) {
          continue;
        }

        const destIndex = Math.floor(rng() * filteredCandidates.length);
        const dest = filteredCandidates[destIndex];

        const fromLocation = npc.location ?? '(unknown)';
        this.npcRepo.updateLocation(npc.id, dest);

        if (cls === 'Merchant') {
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

      this.metaRepo.set('last_tick_players_affected', String(allChars.length));
      this.metaRepo.set('last_tick_npc_movement_count', String(npcMovements.length));

      return {
        dayNumber: newDay,
        playersAffected: allChars.length,
        npcMovements,
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
    id: number; user_id: number; name: string; class: string;
    upbringing: string; race: string; alignment: string; day_job: string;
    stats: string; health: number; max_health: number; stamina: number; max_stamina: number;
    rolls_remaining: number; location: string; wealth: number;
    last_action_state: string | null; created_at: string;
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
      } catch { /* leave null */ }
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
