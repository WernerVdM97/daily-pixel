// ── Seam data types (plain serializable — no discord.js, no ASCII, no SQL rows) ──

export interface CharCreateData {
  name: string;
  class: string;
  upbringing: string;
  race: string;
  alignment: string;
  dayJob: string;
  itemSetName?: string;
}

export interface CharacterData {
  id: number;
  userId: number;
  name: string;
  class: string;
  upbringing: string;
  race: string;
  alignment: string;
  dayJob: string;
  stats: StatBlock;
  health: number;
  maxHealth: number;
  stamina: number;
  maxStamina: number;
  rollsRemaining: number;
  location: string;
  wealth: number;
  lastActionState: ActionState | null;
  /** True when the player has already rested at the Oak on the current game day
   *  (last_rested_day === day_number). Drives the Rest nav button's visibility. */
  hasRestedToday: boolean;
  createdAt: string;
}

export interface StatBlock {
  physical: number;
  wisdom: number;
  intelligence: number;
  charisma: number;
}

export interface ActionDecision {
  prompt: string;
  options: ActionOption[];
}

export interface ActionOption {
  label: string;
  dcModifier: number | null; // signed -5..+5; null = bail
  /**
   * The ability stat this approach tests (physical/wisdom/intelligence/charisma).
   * Optional override: when present, choosing this option makes it the action's roll
   * stat; when absent, the option inherits the action's top-level stat. See ADR
   * [[per-option-stat-and-ability-checks]].
   */
  stat?: string;
}

export interface ActionDecisionRecord {
  prompt: string;
  options: ActionOption[];
  chosen: string;
  dcModifier: number;
  /** The LLM's distilled_type for the beat this choice was made on — the breadcrumb trail. */
  distilledType?: string;
}

/** Whether an action was started as preset daily work or a freeform quest — drives the
 *  story-thread label ("Work:" vs "Quest:"). Defaults to 'quest' when unset. */
export type ActionKind = 'work' | 'quest';

export interface ActionState {
  rawInput: string;
  decisions: ActionDecisionRecord[];
  accumulatedDc: number;
  /** How the action was initiated. Set at start, carried through every beat. */
  kind?: ActionKind;
  /** A guaranteed reward (day-job wage) paid into the outcome when the action RESOLVES — added
   *  to the outcome mutations after the failure-strip, so it survives a failed roll and shows in
   *  the footer. Set at start; not paid if the player bails. */
  wage?: number;
}

export interface WorldMutation {
  type: 'set_location' | 'modify_health' | 'modify_stamina'
      | 'modify_wealth' | 'modify_rolls_remaining'
      | 'modify_max_stamina'
      | 'add_item' | 'remove_item' | 'spawn_npc';
  [key: string]: unknown;
}

export interface ActionStartResult {
  state: ActionState;
  firstDecision: ActionDecision;
  /**
   * Present when the LLM resolved the action immediately (done, non-required, no
   * options) — an auto-finish. The mutations are already applied and an action
   * row written; the caller renders the outcome instead of showing buttons.
   */
  outcome?: ActionOutcome;
}

export type ActionStepResult =
  | { resolved: false; state: ActionState; nextDecision: ActionDecision }
  | { resolved: true;  state: ActionState; outcome: ActionOutcome };

export interface ActionOutcome {
  distilledType: string;
  finalDc: number;
  playerRolled: number | null;
  outcome: 'success' | 'failure' | 'skipped' | 'bailed' | 'done' | 'timed_out';
  /** Item/stat bonus added to the d20 for this roll. Shown in the footer (e.g. `8 + 7 vs 11`). */
  rollBonus?: number;
  /** The ability stat this action tested (physical/wisdom/intelligence/charisma). */
  rollStat?: string;
  mutations: WorldMutation[];
  outcomeText: string;
  /** Id of the llm_calls audit row this outcome's resolution came from. Linked after insert. */
  llmCallId?: number;
  /** EVERY llm_calls row id produced across this action (decision beats, narration, critics).
   *  All are linked to the action row at resolution so the full call chain is mineable. */
  llmCallIds?: number[];
}

export interface ActionResumeResult {
  state: ActionState;
  nextDecision: ActionDecision;
}

export interface LocationInfo {
  name: string;
  description: string;
  tags: string[];
  isSafe: boolean;
}

export interface ItemData {
  id: number;
  characterId: number;
  name: string;
  emoji: string;
  stat: string;
  modifier: number;
  quantity: number;
}

export interface JournalData {
  knownLocations: string[];
  currentLocation: string;
  npcsEncountered: JournalNpc[];
  recentActions: JournalAction[];
}

export interface JournalNpc {
  name: string;
  class: string | null;
  location: string | null;
}

export interface JournalAction {
  type: string;
  outcome: string;
  createdAt: string;
  narrative?: string | null;
}

export interface NpcMovement {
  npcId: number;
  npcName: string;
  fromLocation: string;
  toLocation: string;
}

export interface TickResult {
  dayNumber: number;
  playersAffected: number;
  npcMovements: NpcMovement[];
  /**
   * Discord user ids of players who crossed exactly 5 calendar days of absence
   * on this tick. The caller DMs each a "danger is nearby" warning. Empty on
   * idempotent (already-ticked-today) returns.
   */
  absentWarnings: string[];
  /**
   * Character names whose stamina dropped to 0 on this tick (from
   * resting/lingering in unsafe locations). The caller announces these
   * publicly. Empty on idempotent (already-ticked-today) returns.
   */
  collapsedNames: string[];
}

export interface NearbyEntity {
  name: string;
  classOrType: string;
  description: string | null;
  isPlayer: boolean;
}

export interface LeaderboardEntry {
  name: string;
  class: string;
  /** The ranked value — coin for the wealth board, ability score for the might board. */
  value: number;
  /** For the might board: which ability (physical/wisdom/intelligence/charisma) is highest. */
  stat?: string;
}

export interface Leaderboards {
  /** Richest characters, descending by wealth. */
  wealth: LeaderboardEntry[];
  /** Mightiest characters, descending by their single highest ability score. */
  might: LeaderboardEntry[];
}

/** One resolved action flattened for the weekly recap (character name + outcome). */
export interface WeeklyActionSummary {
  character: string;
  type: string;
  outcome: string;
  narrative: string;
}

// ── The one cohesive interface ──

export interface WorldEngine {
  // Character lifecycle
  createCharacter(discordUserId: string, data: CharCreateData): CharacterData;
  getCharacter(discordUserId: string): CharacterData | null;
  characterExists(discordUserId: string): boolean;

  // Action state machine (S3)
  startAction(characterId: number, rawInput: string, opts?: { kind?: ActionKind; wage?: number }): Promise<ActionStartResult>;
  stepAction(characterId: number, choice: string): Promise<ActionStepResult>;
  resumeAction(characterId: number): ActionResumeResult;

  // Location
  getLocation(name: string): LocationInfo | null;

  /** Entities at the character's current location (NPCs + other players). */
  getNearbyEntities(characterId: number): NearbyEntity[];

  // Items
  getItems(characterId: number): ItemData[];

  /** Stamp the current time as the player's last interaction. */
  updateLastPlayed(characterId: number): void;

  /**
   * Count player characters currently at unsafe locations. Read live by the
   * evening "goodnight" announcement (souls still out as night falls).
   */
  countSoulsInUnsafe(): number;

  // Journal
  getJournal(characterId: number): JournalData;

  // Feedback & bugs
  submitFeedback(characterId: number, text: string): void;
  submitBug(characterId: number, text: string): void;

  // Rest & recovery
  restAtOak(discordUserId: string): CharacterData | null;

  /** Apply a flat health delta (signed, clamped 0..max). Returns updated char or null. */
  modifyHealth(discordUserId: string, amount: number): CharacterData | null;

  /**
   * Introduce an NPC at a location from engine-driven events (scheduled threats,
   * not the LLM mutation path). The NPC has no `created_by_action_id`.
   */
  spawnNpc(data: {
    name: string;
    class?: string;
    race?: string;
    description?: string;
    location: string;
  }): void;

  /**
   * Top-N leaderboards across all player characters: richest by wealth and
   * mightiest by highest single ability score. Used by the Wed/Sun announcements.
   */
  getLeaderboards(limit: number): Leaderboards;

  /**
   * All resolved actions in the half-open window [startIso, endIso), each joined
   * to its character's name, oldest first. Feeds the weekly recap. Bounds are
   * compared lexically against the `actions.created_at` ('YYYY-MM-DD HH:MM:SS'
   * UTC) column, so 'YYYY-MM-DD' day boundaries work.
   */
  getActionsBetween(startIso: string, endIso: string): WeeklyActionSummary[];

  // World tick (S5)
  tick(isAdmin: boolean): TickResult;

  // Meta
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}
