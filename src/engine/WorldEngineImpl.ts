import type Database from 'better-sqlite3';
import type { LlmGateway } from '../llm/LlmGateway.js';
import type { UserRepository } from '../db/repositories/user.js';
import type { CharacterRepository } from '../db/repositories/character.js';
import type { ItemRepository } from '../db/repositories/item.js';
import type { ActionRepository } from '../db/repositories/action.js';
import type { NpcRepository } from '../db/repositories/npc.js';
import { LocationRepository } from '../db/repositories/location.js';
import { MetaRepository } from '../db/repositories/meta.js';
import { FallbackLlmGateway, DIVINE_INTERVENTION_TYPE, DIVINE_MESSAGE } from '../llm/FallbackLlmGateway.js';
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
  private dayJobIncome: Record<string, number>;

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
    this.dayJobIncome = config.dayJobIncome ?? {};

    // Wrap LLM in fallback decorator (S4: two-tier retry → divine intervention)
    const fallbackLlm = new FallbackLlmGateway(config.llm, {
      onTier2Fallback: () => {
        const current = this.metaRepo.get('llm_fallback_count');
        const next = current ? String(Number(current) + 1) : '1';
        this.metaRepo.set('llm_fallback_count', next);
      },
    });

    this.machine = new ActionStateMachine(fallbackLlm, config.rollD20);
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

    // Normal path: drain a roll + persist state atomically
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

      // Divine intervention (S4 tier-2): clear state but skip action row insert
      if (result.outcome.distilledType === DIVINE_INTERVENTION_TYPE) {
        // Clear mid-action state (no action row inserted, no mutations applied)
        this.charRepo.update(characterId, { last_action_state: null });

        return {
          resolved: true,
          state: this.toPublicState(result.state),
          outcome: result.outcome,
        };
      }

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

      // Safe: recover stamina +5 (cap 10), health +3 (cap max_health)
      // Wilds: decay stamina -1 (floor 0)
      let newStamina: number;
      let newHealth: number | undefined;

      if (isSafe) {
        newStamina = Math.min(charRow.stamina + 5, 10);
        newHealth = Math.min(charRow.health + 3, charRow.max_health);
      } else {
        newStamina = Math.max(charRow.stamina - 1, 0);
        // No health change in wilds
      }

      // Day-job income
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

      if (cls === 'Blacksmith') {
        // Stays at current location, works the forge
        this.npcRepo.update(npc.id, { wealth: (npc.wealth ?? 0) + 5 });
        continue;
      }

      // 80% chance to move, seeded by NPC.id + newDay
      const seed = npc.id + newDay;
      const rng = mulberry32(seed);
      const shouldMove = rng() < 0.8;

      if (!shouldMove) {
        // Merchant still earns even if not moving
        if (cls === 'Merchant') {
          this.npcRepo.update(npc.id, { wealth: (npc.wealth ?? 0) + seededRandomRange(seed + 1, 5, 15) });
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
        // Unknown class: move to a random location (excluding current? No, random from all)
        candidates = allLocations.map(l => l.name);
      }

      // Fallback: if no candidates match, use all locations
      if (candidates.length === 0) {
        candidates = allLocations.map(l => l.name);
      }

      // Exclude current location so the NPC truly "moves"
      const filteredCandidates = candidates.filter(c => c !== npc.location);
      if (filteredCandidates.length === 0) {
        continue; // nowhere to go
      }

      // Pick destination with seeded rng
      const destIndex = Math.floor(rng() * filteredCandidates.length);
      const dest = filteredCandidates[destIndex];

      const fromLocation = npc.location ?? '(unknown)';
      this.npcRepo.updateLocation(npc.id, dest);

      // Merchant gains wealth 5-15 on movement
      if (cls === 'Merchant') {
        this.npcRepo.update(npc.id, { wealth: (npc.wealth ?? 0) + seededRandomRange(seed + 1, 5, 15) });
      }

      npcMovements.push({
        npcId: npc.id,
        npcName: npc.name,
        fromLocation,
        toLocation: dest,
      });
    }

    return {
      dayNumber: newDay,
      playersAffected: allChars.length,
      npcMovements,
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
