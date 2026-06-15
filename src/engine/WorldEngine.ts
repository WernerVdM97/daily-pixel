// ── Seam data types (plain serializable — no discord.js, no ASCII, no SQL rows) ──

export interface CharCreateData {
  name: string;
  class: string;
  upbringing: string;
  race: string;
  alignment: string;
  dayJob: string;
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
  rollsRemaining: number;
  location: string;
  wealth: number;
  lastActionState: ActionState | null;
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
}

export interface ActionDecisionRecord {
  prompt: string;
  options: ActionOption[];
  chosen: string;
  dcModifier: number;
}

export interface ActionState {
  rawInput: string;
  decisions: ActionDecisionRecord[];
  accumulatedDc: number;
}

export interface WorldMutation {
  type: 'set_location' | 'modify_health' | 'modify_stamina'
      | 'modify_wealth' | 'modify_rolls_remaining'
      | 'add_item' | 'remove_item' | 'spawn_npc';
  [key: string]: unknown;
}

export interface ActionStartResult {
  state: ActionState;
  firstDecision: ActionDecision;
}

export type ActionStepResult =
  | { resolved: false; state: ActionState; nextDecision: ActionDecision }
  | { resolved: true;  state: ActionState; outcome: ActionOutcome };

export interface ActionOutcome {
  distilledType: string;
  finalDc: number;
  playerRolled: number | null;
  outcome: 'success' | 'failure' | 'skipped' | 'timed_out';
  mutations: WorldMutation[];
  outcomeText: string;
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
}

// ── The one cohesive interface ──

export interface WorldEngine {
  // Character lifecycle
  createCharacter(discordUserId: string, data: CharCreateData): CharacterData;
  getCharacter(discordUserId: string): CharacterData | null;
  characterExists(discordUserId: string): boolean;

  // Action state machine (S3)
  startAction(characterId: number, rawInput: string): Promise<ActionStartResult>;
  stepAction(characterId: number, choice: string): Promise<ActionStepResult>;
  resumeAction(characterId: number): ActionResumeResult;

  // Location
  getLocation(name: string): LocationInfo | null;

  // Items
  getItems(characterId: number): ItemData[];

  // Journal
  getJournal(characterId: number): JournalData;

  // Feedback & bugs
  submitFeedback(characterId: number, text: string): void;
  submitBug(characterId: number, text: string): void;

  // World tick (S5)
  tick(isAdmin: boolean): TickResult;

  // Meta
  getMeta(key: string): string | null;
}
