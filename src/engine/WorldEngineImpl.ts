import type Database from 'better-sqlite3';
import type { LlmGateway } from '../llm/LlmGateway.js';
import type { UserRepository } from '../db/repositories/user.js';
import type { CharacterRepository } from '../db/repositories/character.js';
import type { ItemRepository } from '../db/repositories/item.js';
import type { ActionRepository } from '../db/repositories/action.js';
import type { NpcRepository } from '../db/repositories/npc.js';
import { LocationRepository } from '../db/repositories/location.js';
import { MetaRepository } from '../db/repositories/meta.js';
import { ActionStateMachine, type InternalActionState } from './action/machine.js';
import { validateMutations, applyMutations } from './action/mutations.js';
import { computeStats, type ClassDef, type ModifierDef } from './StatComputer.js';
import type {
  WorldEngine,
  CharCreateData,
  CharacterData,
  ActionStartResult,
  ActionStepResult,
  ActionResumeResult,
  ActionDecisionRecord,
  LocationInfo,
  ItemData,
  JournalData,
  TickResult,
  StatBlock,
} from './WorldEngine.js';

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
  private machine: ActionStateMachine;
  private classDefs: ClassDef[];
  private upbringingDefs: ModifierDef[];
  private raceDefs: ModifierDef[];

  constructor(config: WorldEngineConfig) {
    this.db = config.db;
    this.userRepo = config.userRepo;
    this.charRepo = config.charRepo;
    this.itemRepo = config.itemRepo;
    this.actionRepo = config.actionRepo;
    this.npcRepo = config.npcRepo;
    this.locationRepo = new LocationRepository(config.db);
    this.metaRepo = new MetaRepository(config.db);
    this.classDefs = config.classDefs ?? [];
    this.upbringingDefs = config.upbringingDefs ?? [];
    this.raceDefs = config.raceDefs ?? [];
    this.machine = new ActionStateMachine(config.llm, config.rollD20);
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
      rolls_remaining: 2,
      location: "The Warden's Oak",
      wealth: 0,
      last_action_state: null,
    });

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

  async startAction(characterId: number, rawInput: string): Promise<ActionStartResult> {
    const row = this.charRepo.findById(characterId);
    if (!row) throw new Error('Character not found');

    const char = this.rowToCharacterData(row);
    const items = this.getItems(characterId);

    const { state: internalState, firstDecision } = await this.machine.start(char, rawInput, items);

    // Drain a roll + persist state atomically
    this.db.transaction(() => {
      this.charRepo.update(characterId, {
        rolls_remaining: Math.max(0, row.rolls_remaining - 1),
      });
      this.persistState(characterId, internalState);
    })();

    return {
      state: this.toPublicState(internalState),
      firstDecision,
    };
  }

  async stepAction(characterId: number, choice: string): Promise<ActionStepResult> {
    const row = this.charRepo.findById(characterId);
    if (!row) throw new Error('Character not found');
    if (!row.last_action_state) throw new Error('No action in progress');

    const internalState = JSON.parse(row.last_action_state) as InternalActionState;
    const char = this.rowToCharacterData(row);
    const items = this.getItems(characterId);

    const result = await this.machine.step(internalState, choice, char, items);

    if (result.resolved) {
      // Wrap all resolution side-effects in a transaction for atomicity
      const applyResolution = this.db.transaction(() => {
        // Clear mid-action state
        this.charRepo.update(characterId, { last_action_state: null });

        // Validate and apply mutations
        const ctx = {
          currentHealth: row.health,
          maxHealth: row.max_health,
          stamina: row.stamina,
          wealth: row.wealth,
          rollsRemaining: row.rolls_remaining,
          location: row.location,
        };

        const validation = validateMutations(result.outcome.mutations, ctx);
        if (!validation.valid) {
          throw new Error(`Mutation validation failed: ${validation.errors.map(e => e.message).join('; ')}`);
        }

        const applied = applyMutations(result.outcome.mutations, ctx);

        // Apply character state changes
        const updates: Record<string, unknown> = {};
        if (applied.currentHealth !== row.health) updates.health = applied.currentHealth;
        if (applied.stamina !== row.stamina) updates.stamina = applied.stamina;
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

        // Remove items
        for (const name of applied.itemsToRemove) {
          this.itemRepo.deleteByName(characterId, name);
        }

        // Insert action record
        const actionRow = this.actionRepo.create({
          characterId,
          rawInput: result.state.rawInput,
          type: result.outcome.distilledType,
          decisionsJson: JSON.stringify(result.state.decisions),
          finalDc: result.outcome.finalDc,
          playerRolled: result.outcome.playerRolled,
          outcome: result.outcome.outcome,
        });

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
      });

      applyResolution();

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

  // ── World tick (S5 — stub) ──

  tick(_isAdmin: boolean): TickResult {
    return {
      dayNumber: 1,
      playersAffected: 0,
      npcMovements: [],
    };
  }

  // ── Meta ──

  getMeta(key: string): string | null {
    return this.metaRepo.get(key);
  }

  // ── Private helpers ──

  private rowToCharacterData(row: {
    id: number; user_id: number; name: string; class: string;
    upbringing: string; race: string; alignment: string; day_job: string;
    stats: string; health: number; max_health: number; stamina: number;
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
      rollsRemaining: row.rolls_remaining,
      location: row.location,
      wealth: row.wealth,
      lastActionState,
      createdAt: row.created_at,
    };
  }

  private persistState(characterId: number, state: InternalActionState): void {
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
