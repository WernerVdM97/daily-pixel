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
  /** Already rested at the Oak today (last_rested_day === day_number). Drives Rest button visibility. */
  hasRestedToday: boolean;
  createdAt: string;
}

export interface StatBlock {
  physical: number;
  wisdom: number;
  intelligence: number;
  charisma: number;
}

/** Structured combat-continue status (ANSI-C): the engine emits only the banding maths (never
 *  exact enemy HP); the presentation layer composes the frame from this data. Screen-only —
 *  never persisted onto `ActionDecisionRecord`. */
export interface CombatStatusData {
  enemyName: string;
  woundWord: string;
  pips: { filled: number; total: number };
  /** DISPLAY value only — already has playerHpDelta applied and is clamped >= 0 so a lethal
   *  round never displays negative HP mid-resolution. A future consumer must render this as-is
   *  and must NOT add playerHpDelta again. */
  playerHp: number;
  playerMaxHp: number;
  playerHpDelta: number;
}

export interface ActionDecision {
  prompt: string;
  options: ActionOption[];
  /** decide-scene-narration follow-up: DECIDE's scene-framing prose for this beat, authored on
   *  CONTINUE only — absent on the first beat, so it stays lean. Threaded onto the record too
   *  (`ActionDecisionRecord.narration`) so the story-thread can render it per beat. */
  narration?: string;
  /** Engine-composed status for a combat continue-screen (banded enemy condition plus exact
   *  player HP movement). Screen-only — never persisted onto the record. `string` is the legacy
   *  in-flight shape (a pre-composed ANSI frame, persisted by the engine before ANSI-C) — an
   *  action mid-flight across the deploy still carries it in its saved state JSON, so the
   *  presentation layer's read must tolerate both shapes. */
  combatStatus?: CombatStatusData | string;
  /** Every `CombatBeatLog` fought so far this encounter, in order (ANSI-D). Lives beside
   *  `combatStatus` on the seam per the same pattern (ANSI-C, commit 62cc332): this type is
   *  `PipelineInternalActionState.pendingDecision`'s shape, and that field IS what's serialized
   *  to the action's JSON state column each beat, so accumulating here is what makes the list
   *  survive between decisions of a multi-round fight. Missing (not just empty) on any in-flight
   *  fight saved before this field existed — read it as `?? []`, never assume presence. */
  combatRounds?: CombatBeatLog[];
}

export interface ActionOption {
  label: string;
  dcModifier: number | null; // signed -5..+5; null = bail
  /** Per-option override of the roll stat; absent = inherit the action's top-level stat.
   *  See ADR [[per-option-stat-and-ability-checks]]. */
  stat?: string;
}

export interface ActionDecisionRecord {
  prompt: string;
  options: ActionOption[];
  chosen: string;
  dcModifier: number;
  /** The LLM's distilled_type for the beat this choice was made on — the breadcrumb trail. */
  distilledType?: string;
  /** The scene-framing narration shown alongside this beat's prompt (see `ActionDecision.narration`),
   *  carried onto the record so the story-thread can render it per beat. Absent on the first beat. */
  narration?: string;
}

/** Drives the story-thread label ("Work:" vs "Quest:"). Defaults to 'quest' when unset. */
export type ActionKind = 'work' | 'quest';

/** The seven `classify`-routed action types (ANSI-F). Duplicated here rather than importing
 *  `ActionCategory` from `llm/LlmGateway.ts` — this seam file takes no llm/ imports (same
 *  reasoning as `ActionKind` above); the two are kept in lockstep by construction since both are
 *  the closed enum the classifier itself owns. Exposed on `ActionStartResult` only (not
 *  persisted `ActionState`) so presentation can pick the OPENING register (classification
 *  framework §3.0) without engine internals (`PipelineInternalActionState.actionType`) leaking
 *  into the public seam. */
export type ClassifiedActionType = 'combat' | 'travel' | 'social' | 'skill' | 'search' | 'rest' | 'other';

export interface ActionState {
  rawInput: string;
  decisions: ActionDecisionRecord[];
  accumulatedDc: number;
  /** How the action was initiated. Set at start, carried through every beat. */
  kind?: ActionKind;
  /** Day-job wage paid on RESOLVE, added after the failure-strip so it survives a failed roll.
   *  Set at start; not paid if the player bails. */
  wage?: number;
}

// Canonical list — the SINGLE source of truth for the mutation-op-name set. `WorldMutation.type`
// below is TYPE-DERIVED from this array (never a hand-copied literal union), and
// `mutations.ts`'s runtime `MUTATION_TYPES` Set imports this same array, so a new op can't be
// added to one without the other silently drifting (mirrors the `ACTION_CATEGORIES` pattern,
// commit 62b102b).
export const WORLD_MUTATION_TYPES = [
  'move_to', 'set_location', 'cross_frontier',
  'modify_health', 'modify_stamina', 'modify_wealth',
  'modify_rolls_remaining', 'modify_max_stamina',
  'add_item', 'remove_item',
  'add_npc', 'update_npc', 'remove_npc', 'spawn_npc',
  'reveal_location',
  // Stage 2 T2 — edge-shaped relation ops (scene-state graph). Op name (`type`) vs
  // relationship kind (`relType`) is deliberate — see the doc-to-code mapping note beside
  // `RelationEndpoint` in `action/mutations.ts` (design doc's `op`/`type` → code's `type`/`relType`).
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
  /** The type `classify` routed this action to (ANSI-F) — pinned once at CLASSIFY, so it's
   *  stable for the whole action even though it's only surfaced here, at start. Presentation
   *  uses it to pick the OPENING frame register (classification framework §3.0); never
   *  persisted onto `ActionState` (unlike `kind`), since nothing downstream of the first
   *  decision needs it. */
  actionType: ClassifiedActionType;
}

export type ActionStepResult =
  | { resolved: false; state: ActionState; nextDecision: ActionDecision }
  | { resolved: true;  state: ActionState; outcome: ActionOutcome };

export interface ActionOutcome {
  distilledType: string;
  /** v11 closed category enum — machine key for mutation-map deviation telemetry. Optional: absent
   *  pre-v11 or when the LLM omits it. Typed as string here; validated as ActionCategory by the engine. */
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
  /** Every llm_calls row id across this action (decisions, narration, critics), linked at
   *  resolution so the full call chain is mineable. */
  llmCallIds?: number[];
  /** Id of the persisted `actions` row this outcome wrote — set by the engine after insert,
   *  so the Feedback/Bug buttons on this outcome can attribute a report to its action.
   *  Undefined when no row is written (e.g. divine intervention). */
  actionId?: number;
  /** Actual net change to rollsRemaining the engine applied, set where the renderer can't infer
   *  it (the auto-finish no-op refund/charge). Undefined elsewhere — the renderer then infers
   *  −1 per resolved roll plus any modify_rolls_remaining mutation. */
  rollsDelta?: number;
  /** True when a no-op refund returned the roll (nothing changed, so the action was free). Drives
   *  the footer's "(refunded)" tag so an unchanged roll count isn't mistaken for a bug. */
  rollRefunded?: boolean;
  /** True when the engine must ALWAYS hand the roll back regardless of the per-day no-op/timeout/bail
   *  graces — a system-side fault, not a player choice. Set by the degenerate decision-shape guard
   *  (≤1 real option after a retry): the player never got a real choice, so the roll is free. */
  systemRefund?: boolean;
  /** True when the pipeline machine's classify-fallback exhausted (heuristic miss + LLM fallback
   *  rejection) and the action resolved as a canned divine-intervention outcome. Typed replacement
   *  for the legacy `distilledType === '__divine__'` sentinel (Stage 1 Thread D backbone plan,
   *  Task 2) — legacy code never sets this field. */
  isDivineIntervention?: boolean;
  /** True when this outcome involved player HP reaching 0 (the hp_zero trace marker,
   *  Stage 3 decision 10). Always undefined (absent) in legacy/v11 outcomes — set only
   *  by the pipeline's combat spine. */
  hpZero?: boolean;
  /** Per-round combat telemetry beat (T5) — set only by the pipeline combat spine's terminal
   *  path (win / loss / cap-derive). Always undefined (absent) in legacy/v11 outcomes and on
   *  non-combat pipeline outcomes. */
  combatBeat?: CombatBeatLog;
  /** Combat-frame display data for the terminal AnsiRenderer reveal — set only by the pipeline
   *  combat spine's terminal path, alongside combatBeat. enemyMaxHp + margin aren't on the
   *  telemetry CombatBeatLog; enemyName is nowhere else on the outcome. Absent on non-combat. */
  combatFrame?: { enemyName: string; enemyMaxHp: number; margin: number };
  /** Full per-fight round log (ANSI-D), terminal round inclusive — the same accumulation as
   *  `ActionDecision.combatRounds`, surfaced here too so the terminal presentation layer reads
   *  the whole fight off the outcome without reaching into engine state. Absent on non-combat
   *  outcomes. */
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
  /** Where the action happened (origin snapshot, §6) + its map glyph, for the chronicle. */
  location?: string | null;
  locationEmoji?: string | null;
  /** Player-facing "intel gathered" facts derived from this action's applied mutations
   *  (a location revealed, an NPC met) — read-only intel already sitting on the action
   *  row, surfaced for the journal rather than tracked separately (F#6). */
  discoveries?: string[];
}

/** A discovered node in a player's fog-of-war view of the shared graph (§5). */
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

/** A player's discovered subgraph — the masked view `/map` renders (§5). */
export interface DiscoveredGraph {
  current: string;
  nodes: DiscoveredNode[];
  edges: DiscoveredEdge[];
  frontiers: DiscoveredFrontier[];
}

/** Result of routing between two charted nodes (§2). */
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

  /** Player characters currently at unsafe locations. Read live by the evening
   *  "goodnight" announcement (souls still out as night falls). */
  countSoulsInUnsafe(): number;

  // Journal
  getJournal(characterId: number): JournalData;

  // Map — the player's fog-of-war view of the shared graph (§5).
  getDiscoveredGraph(characterId: number): DiscoveredGraph;

  /** The edges leaving a location (charted neighbours + frontier exits) — what
   *  /look shows: the roads you can see from where you stand. */
  getExits(location: string): LocationExits;

  /** Least-cost route (Dijkstra over edge difficulty) between two charted nodes; null
   *  when unreachable (§2). Used today to validate movement reachability — the cost is
   *  computed but not yet charged as stamina (deferred to fast-travel, §9). */
  routeBetween(from: string, to: string): TravelRoute | null;

  /** Mark a location discovered (fog-of-war). For non-engine movement paths (the
   *  daily-work commute) that set location directly — the resolution path records
   *  visits itself. The target is a seeded node, so no edge is minted. */
  recordVisit(characterId: number, locationName: string): void;

  // Feedback & bugs — actionId links the report to the action whose outcome the button was
  // on (undefined for the /feedback, /bug slash commands and the nightly/release prompts).
  submitFeedback(characterId: number, text: string, actionId?: number): void;
  submitBug(characterId: number, text: string, actionId?: number): void;

  // Rest & recovery
  restAtOak(discordUserId: string): CharacterData | null;

  /** Apply a flat health delta (signed, clamped 0..max). Returns updated char or null. */
  modifyHealth(discordUserId: string, amount: number): CharacterData | null;

  /** Introduce an NPC from engine-driven events (scheduled threats, not the LLM
   *  mutation path). The NPC has no `created_by_action_id`. */
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

  /** Resolved actions in the half-open window [startIso, endIso), joined to character
   *  name, oldest first; feeds the weekly recap. Bounds compare lexically against
   *  `actions.created_at` ('YYYY-MM-DD HH:MM:SS' UTC), so 'YYYY-MM-DD' boundaries work. */
  getActionsBetween(startIso: string, endIso: string): WeeklyActionSummary[];

  // World tick (S5)
  tick(isAdmin: boolean): TickResult;

  // Meta
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}
