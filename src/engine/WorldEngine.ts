import type { CombatBeatLog } from './action/combat-dc.js';

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
  /** Already rested at the Oak today (`last_rested_day === day_number`). Drives Rest button visibility. */
  hasRestedToday: boolean;
  createdAt: string;
}

export interface StatBlock {
  physical: number;
  wisdom: number;
  intelligence: number;
  charisma: number;
}

/** Banded enemy condition plus the player's HP movement, for a combat continue-screen. */
export interface CombatStatusData {
  enemyName: string;
  woundWord: string;
  pips: { filled: number; total: number };
  /** DISPLAY value only: `playerHpDelta` is already applied and clamped >= 0 so a lethal round never
   *  shows negative HP. A consumer must render this as-is, never adding the delta again. */
  playerHp: number;
  playerMaxHp: number;
  playerHpDelta: number;
}

export interface ActionDecision {
  prompt: string;
  options: ActionOption[];
  /** DECIDE's scene-framing prose for this beat, authored on CONTINUE only (absent on the first
   *  beat). Threaded onto the record too, so the story-thread renders it per beat. */
  narration?: string;
  /** Banding maths only, never exact enemy HP, and never persisted onto `ActionDecisionRecord`.
   *  `string` is the legacy in-flight shape (a pre-composed frame an older action still carries), so tolerate both. */
  combatStatus?: CombatStatusData | string;
  /** Every `CombatBeatLog` fought so far this encounter, in order. Lives on the decision shape
   *  serialized to the action's JSON state column each beat. Missing (not just empty) on older fights: read `?? []`. */
  combatRounds?: CombatBeatLog[];
}

export interface ActionOption {
  label: string;
  dcModifier: number | null; // signed -5..+5; null = bail
  /** Per-option override of the roll stat; absent = inherit the action's top-level stat. */
  stat?: string;
}

/** Selects which pending-decision option a player clicked, for `resolvePendingChoice` — 'option'
 *  picks by button index, 'bail' asks for the bail option's label. */
export type PendingChoiceSelector = { kind: 'option'; index: number } | { kind: 'bail' };

export interface ActionDecisionRecord {
  prompt: string;
  options: ActionOption[];
  chosen: string;
  dcModifier: number;
  /** The LLM's `distilled_type` for the beat this choice was made on. */
  distilledType?: string;
  /** The scene-framing narration shown alongside this beat's prompt (see `ActionDecision.narration`). */
  narration?: string;
}

/** Drives the story-thread label ("Work:" vs "Quest:"). Defaults to 'quest' when unset. */
export type ActionKind = 'work' | 'quest';

/** The seven `classify`-routed action types. Duplicated rather than importing `ActionCategory` from `llm/LlmGateway.ts`,
 *  and kept in lockstep with the classifier's own enum. Exposed on `ActionStartResult` only, never persisted onto `ActionState`. */
export type ClassifiedActionType = 'combat' | 'travel' | 'social' | 'skill' | 'search' | 'rest' | 'other';

export interface ActionState {
  rawInput: string;
  decisions: ActionDecisionRecord[];
  accumulatedDc: number;
  /** How the action was initiated. Set at start, carried through every beat. */
  kind?: ActionKind;
  /** Day-job wage paid on RESOLVE, added after the failure-strip so it survives a failed roll; not
   *  paid if the player bails. */
  wage?: number;
}

// Canonical list — the SINGLE source of truth for the mutation-op-name set. `WorldMutation.type`
// below is TYPE-DERIVED from it, and `mutations.ts` imports this same array, so the two cannot drift.
export const WORLD_MUTATION_TYPES = [
  'move_to', 'set_location', 'cross_frontier',
  'modify_health', 'modify_stamina', 'modify_wealth',
  'modify_rolls_remaining', 'modify_max_stamina',
  'add_item', 'remove_item',
  'add_npc', 'update_npc', 'remove_npc', 'spawn_npc',
  'reveal_location',
  // Edge-shaped relation ops — op name (`type`) vs relationship kind (`relType`) is deliberate.
  'set_relation', 'update_relation',
] as const;

export interface WorldMutation {
  type: (typeof WORLD_MUTATION_TYPES)[number];
  [key: string]: unknown;
}

export interface ActionStartResult {
  state: ActionState;
  firstDecision: ActionDecision;
  /** Present on auto-finish (LLM resolved immediately): mutations already applied and
   *  action row written; caller renders the outcome instead of showing buttons. */
  outcome?: ActionOutcome;
  /** The type `classify` routed this action to — pinned once at CLASSIFY. Presentation picks the
   *  OPENING register with it; never persisted onto `ActionState`, unlike `kind`. */
  actionType: ClassifiedActionType;
  /** Combat enemy name for the opening frame's enemy nameplate, surfaced from the pipeline's
   *  `combatEnemy` hint when the LLM signalled one; undefined when not combat or unnamed. */
  combatEnemyName?: string;
  /** The enemy's BANDED condition (wound word + pip fill, never exact HP) for the opening frame,
   *  when a persisted `in_combat` edge from a prior bail is re-entered; undefined for a fresh fight. */
  combatEnemyCondition?: { woundWord: string; filled: number; total: number };
}

export type ActionStepResult =
  | { resolved: false; state: ActionState; nextDecision: ActionDecision }
  | { resolved: true;  state: ActionState; outcome: ActionOutcome };

export interface ActionOutcome {
  distilledType: string;
  /** Machine key for mutation-map deviation telemetry; optional (absent pre-v11 or when omitted),
   *  typed as string here and validated by the engine. */
  category?: string;
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
  /** Every llm_calls row id across this action (decisions, narration, critics), linked at resolution. */
  llmCallIds?: number[];
  /** Id of the persisted `actions` row this outcome wrote, set by the engine after insert so the
   *  Feedback/Bug buttons can attribute a report; undefined when no row is written. */
  actionId?: number;
  /** Net change to `rollsRemaining` the engine applied, set where the renderer cannot infer it
   *  (the auto-finish refund/charge). */
  rollsDelta?: number;
  /** A no-op refund returned the roll. Drives the footer's "(refunded)" tag, so an unchanged roll
   *  count is not read as a bug. */
  rollRefunded?: boolean;
  /** True when the engine must hand the roll back regardless of the per-day no-op/timeout/bail
   *  graces — a system-side fault, not a player choice. The timeout return is its only producer. */
  systemRefund?: boolean;
  /** The classify-fallback exhausted (heuristic miss + LLM fallback rejection) and the action
   *  resolved as a canned divine-intervention outcome; legacy code never sets it. */
  isDivineIntervention?: boolean;
  /** This outcome involved player HP reaching 0. Set only by the pipeline's combat spine; always
   *  absent in legacy/v11 outcomes. */
  hpZero?: boolean;
  /** Per-round combat telemetry beat, set only by the pipeline combat spine's terminal path
   *  (win / loss / cap-derive); absent in legacy/v11 and on non-combat outcomes. */
  combatBeat?: CombatBeatLog;
  /** Display data for the terminal combat-frame reveal, set alongside `combatBeat`. `enemyMaxHp`
   *  and `margin` are not on the telemetry log, and `enemyName` is nowhere else on the outcome. */
  combatFrame?: { enemyName: string; enemyMaxHp: number; margin: number };
  /** Full per-fight round log, terminal round inclusive — surfaced so the terminal presentation
   *  layer reads the whole fight off the outcome. Absent on non-combat outcomes. */
  combatRounds?: CombatBeatLog[];
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
  /** Map glyph for the location (fallback 📍 at render). */
  emoji: string | null;
}

/** The edges leaving a location — charted neighbours + unexplored frontier exits. */
export interface LocationExits {
  neighbours: { name: string; direction: string; difficulty: number }[];
  frontiers: { direction: string; teaser: string | null; difficulty: number }[];
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
  /** Where the action happened (origin snapshot) + its map glyph, for the chronicle. */
  location?: string | null;
  locationEmoji?: string | null;
  /** Player-facing "intel gathered" facts derived from this action's applied mutations (a location
   *  revealed, an NPC met); read-only intel already on the action row, surfaced for the journal. */
  discoveries?: string[];
}

/** A discovered node in a player's fog-of-war view of the shared graph. */
export interface DiscoveredNode {
  name: string;
  emoji: string | null;
  isSafe: boolean;
  nodeTier: number;
  region: string | null;
  lastVisitedAt: string;
}

/** A charted edge between two discovered nodes. */
export interface DiscoveredEdge {
  from: string;
  to: string;
  direction: string;
  difficulty: number;
  flavour: string | null;
}

/** An unexplored frontier exit radiating from a discovered node. */
export interface DiscoveredFrontier {
  from: string;
  direction: string;
  teaser: string | null;
  difficulty: number;
}

/** A player's discovered subgraph — the masked view `/map` renders. */
export interface DiscoveredGraph {
  current: string;
  nodes: DiscoveredNode[];
  edges: DiscoveredEdge[];
  frontiers: DiscoveredFrontier[];
}

/** Result of routing between two charted nodes. */
export interface TravelRoute {
  path: string[];
  cost: number;
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
  /** Discord ids of players crossing exactly 5 calendar days of absence on this tick;
   *  caller DMs each a "danger is nearby" warning. Empty on idempotent returns. */
  absentWarnings: string[];
  /** Names whose stamina hit 0 this tick (lingering in unsafe locations); caller
   *  announces publicly. Empty on idempotent returns. */
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

/** Result of a nightly rest at the Oak — the unsafe-rest penalty lives inside `restAtOak`, so the
 *  caller learns whether the rest was unsafe and from where. */
export interface RestAtOakResult {
  /** Post-rest, post-penalty character — null when the user/character is missing. */
  character: CharacterData | null;
  wasUnsafe: boolean;
  /** The pre-rest location — the place the penalty prose names. */
  unsafeFromName: string;
}

// ── The one cohesive interface ──

export interface WorldEngine {
  // Character lifecycle
  createCharacter(discordUserId: string, data: CharCreateData): CharacterData;
  getCharacter(discordUserId: string): CharacterData | null;
  characterExists(discordUserId: string): boolean;

  // Action state machine
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

  /** Player characters currently at unsafe locations. Read live by the evening "goodnight"
   *  announcement. */
  countSoulsInUnsafe(): number;

  /** Characters who engaged at/after `startIso` (lexical compare of `last_played_at`, so a
   *  'YYYY-MM-DD' boundary includes that day). Read live by the evening "goodnight" announcement. */
  countActivePlayersSince(startIso: string): number;

  // Journal
  getJournal(characterId: number): JournalData;

  // Map — the player's fog-of-war view of the shared graph.
  getDiscoveredGraph(characterId: number): DiscoveredGraph;

  /** The edges leaving a location (charted neighbours + frontier exits) — what /look shows. */
  getExits(location: string): LocationExits;

  /** Least-cost route (Dijkstra over edge difficulty) between two charted nodes, or null when
   *  unreachable. The cost is computed but not yet charged as stamina. */
  routeBetween(from: string, to: string): TravelRoute | null;

  /** The day-job commute rule: a character at The Warden's Oak whose workplace is elsewhere moves
   *  there for −1 stamina (floored at 0). Null when no commute applies: not at the Oak, no/unknown workplace, or already there. */
  commuteToWorkplace(characterId: number, workplace: string | null): { to: string; stamina: number } | null;

  /** Resolves a clicked decision button to its option label, re-reading
   *  `last_action_state.pendingDecision.options` off the row rather than trusting client-held state. */
  resolvePendingChoice(characterId: number, selector: PendingChoiceSelector): string | null;

  // Feedback & bugs — actionId links the report to the action whose outcome the button was on.
  submitFeedback(characterId: number, text: string, actionId?: number): void;
  submitBug(characterId: number, text: string, actionId?: number): void;

  // Rest & recovery
  /** Nightly rest at the Oak. The unsafe-rest −1 HP rule lives HERE: unsafe ground that is not the
   *  Oak and not `opts.workplace` costs 1 HP through `this.modifyHealth`, so the clamp is shared. */
  restAtOak(discordUserId: string, opts?: { workplace?: string | null }): RestAtOakResult;

  /** Apply a flat health delta (signed, clamped 0..max). Returns updated char or null. */
  modifyHealth(discordUserId: string, amount: number): CharacterData | null;

  /** Introduce an NPC from engine-driven events (scheduled threats, not the LLM mutation path);
   *  the row has no `created_by_action_id`. */
  spawnNpc(data: {
    name: string;
    class?: string;
    race?: string;
    description?: string;
    location: string;
  }): void;

  /** Top-N richest (wealth) and mightiest (highest single ability) characters.
   *  Used by the Wed/Sun announcements. */
  getLeaderboards(limit: number): Leaderboards;

  /** Resolved actions in the half-open window [startIso, endIso), joined to character name, oldest
   *  first. Bounds compare lexically against `actions.created_at`, so 'YYYY-MM-DD' boundaries work. */
  getActionsBetween(startIso: string, endIso: string): WeeklyActionSummary[];

  // World tick
  tick(isAdmin: boolean): TickResult;

  // Meta
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}
