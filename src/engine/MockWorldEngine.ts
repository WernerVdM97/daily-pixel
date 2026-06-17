import type {
  WorldEngine,
  CharCreateData,
  CharacterData,
  ActionStartResult,
  ActionStepResult,
  ActionResumeResult,
  LocationInfo,
  ItemData,
  NearbyEntity,
  JournalData,
  TickResult,
  StatBlock,
} from "./WorldEngine.js";

/**
 * MockWorldEngine — test fixture.
 * Returns canned data; tracks calls for verification.
 */
export class MockWorldEngine implements WorldEngine {
  // ── Configurable return values ──

  private _character: CharacterData | null = null;
  private _characterExists = false;
  private _startActionResult: ActionStartResult | null = null;
  private _stepActionResult: ActionStepResult | null = null;
  private _location: LocationInfo | null = null;
  private _locationSet = false;
  private _items: ItemData[] = [];
  private _nearbyEntities: NearbyEntity[] = [];
  private _journal: JournalData | null = null;
  private _tickResult: TickResult | null = null;
  private _meta: Map<string, string> = new Map();

  // ── Call tracking ──

  calls: {
    createCharacter: { discordUserId: string; data: CharCreateData }[];
    getCharacter: string[];
    characterExists: string[];
    startAction: { characterId: number; rawInput: string }[];
    stepAction: { characterId: number; choice: string }[];
    resumeAction: number[];
    getLocation: string[];
    getItems: number[];
    getNearbyEntities: number[];
    getJournal: number[];
    submitFeedback: { characterId: number; text: string }[];
    submitBug: { characterId: number; text: string }[];
    updateLastPlayed: number[];
    modifyHealth: { discordUserId: string; amount: number }[];
    countSoulsInUnsafe: void[];
    tick: boolean[];
    restAtOak: string[];
    getMeta: string[];
  } = {
    createCharacter: [],
    getCharacter: [],
    characterExists: [],
    startAction: [],
    stepAction: [],
    resumeAction: [],
    getLocation: [],
    getItems: [],
    getNearbyEntities: [],
    getJournal: [],
    submitFeedback: [],
    submitBug: [],
    updateLastPlayed: [],
    modifyHealth: [],
    countSoulsInUnsafe: [],
    restAtOak: [],
    tick: [],
    getMeta: [],
  };

  // ── Setters for canned responses ──

  setCharacter(char: CharacterData | null): void {
    this._character = char;
  }
  setCharacterExists(exists: boolean): void {
    this._characterExists = exists;
  }
  setStartActionResult(result: ActionStartResult): void {
    this._startActionResult = result;
  }
  setStepActionResult(result: ActionStepResult): void {
    this._stepActionResult = result;
  }
  setLocation(loc: LocationInfo | null): void {
    this._location = loc;
    this._locationSet = true;
  }
  setNearbyEntities(entities: NearbyEntity[]): void {
    this._nearbyEntities = entities;
  }
  setItems(items: ItemData[]): void {
    this._items = items;
  }
  setJournal(journal: JournalData): void {
    this._journal = journal;
  }
  setTickResult(result: TickResult): void {
    this._tickResult = result;
  }
  setMeta(key: string, value: string): void {
    this._meta.set(key, value);
  }

  // ── Default character factory for test convenience ──

  static defaultCharacter(overrides?: Partial<CharacterData>): CharacterData {
    const stats: StatBlock = {
      physical: 3,
      wisdom: -1,
      intelligence: 0,
      charisma: 0,
    };
    const { stats: overStats, ...restOverrides } = overrides ?? {};
    return {
      id: 1,
      userId: 1,
      name: "Aldric",
      class: "Warrior",
      upbringing: "Village",
      race: "Human",
      alignment: "lawful good",
      dayJob: "Blacksmith",
      stats: { ...stats, ...overStats },
      health: 12,
      maxHealth: 12,
      stamina: 10,
      maxStamina: 10,
      rollsRemaining: 2,
      location: "The Warden's Oak",
      wealth: 5,
      lastActionState: null,
      createdAt: "2026-01-01T00:00:00Z",
      ...restOverrides,
    };
  }

  // ── Interface methods ──

  restAtOak(discordUserId: string): CharacterData | null {
    this.calls.restAtOak.push(discordUserId);
    if (!this._character) return null;
    return {
      ...this._character,
      location: "The Warden's Oak",
    };
  }

  createCharacter(discordUserId: string, data: CharCreateData): CharacterData {
    this.calls.createCharacter.push({ discordUserId, data });
    return (
      this._character ??
      MockWorldEngine.defaultCharacter({ name: data.name, class: data.class })
    );
  }

  getCharacter(discordUserId: string): CharacterData | null {
    this.calls.getCharacter.push(discordUserId);
    return this._character;
  }

  characterExists(discordUserId: string): boolean {
    this.calls.characterExists.push(discordUserId);
    return this._characterExists;
  }

  async startAction(
    characterId: number,
    rawInput: string,
  ): Promise<ActionStartResult> {
    this.calls.startAction.push({ characterId, rawInput });
    if (!this._startActionResult) {
      throw new Error("MockWorldEngine.startAction: no canned result set");
    }
    return this._startActionResult;
  }

  async stepAction(
    characterId: number,
    choice: string,
  ): Promise<ActionStepResult> {
    this.calls.stepAction.push({ characterId, choice });
    if (!this._stepActionResult) {
      throw new Error("MockWorldEngine.stepAction: no canned result set");
    }
    return this._stepActionResult;
  }

  resumeAction(characterId: number): ActionResumeResult {
    this.calls.resumeAction.push(characterId);
    throw new Error("MockWorldEngine.resumeAction: no canned result set");
  }

  getNearbyEntities(characterId: number): NearbyEntity[] {
    this.calls.getNearbyEntities.push(characterId);
    return this._nearbyEntities;
  }

  getLocation(name: string): LocationInfo | null {
    this.calls.getLocation.push(name);
    if (!this._locationSet) {
      return {
        name,
        description: "A mock location.",
        tags: ["mock"],
        isSafe: true,
      };
    }
    return this._location;
  }

  getItems(characterId: number): ItemData[] {
    this.calls.getItems.push(characterId);
    return this._items;
  }

  getJournal(characterId: number): JournalData {
    this.calls.getJournal.push(characterId);
    return (
      this._journal ?? {
        knownLocations: [],
        currentLocation: "The Warden's Oak",
        npcsEncountered: [],
        recentActions: [],
      }
    );
  }

  submitFeedback(characterId: number, text: string): void {
    this.calls.submitFeedback.push({ characterId, text });
  }

  submitBug(characterId: number, text: string): void {
    this.calls.submitBug.push({ characterId, text });
  }

  tick(isAdmin: boolean): TickResult {
    this.calls.tick.push(isAdmin);
    return (
      this._tickResult ?? {
        dayNumber: 1,
        playersAffected: 0,
        npcMovements: [],
      }
    );
  }

  getMeta(key: string): string | null {
    this.calls.getMeta.push(key);
    return this._meta.get(key) ?? null;
  }

  updateLastPlayed(characterId: number): void {
    this.calls.updateLastPlayed.push(characterId);
  }

  modifyHealth(discordUserId: string, amount: number): CharacterData | null {
    this.calls.modifyHealth.push({ discordUserId, amount });
    if (!this._character) return null;
    const newHealth = Math.max(0, Math.min(this._character.maxHealth, this._character.health + amount));
    return { ...this._character, health: newHealth };
  }

  countSoulsInUnsafe(): number {
    this.calls.countSoulsInUnsafe.push();
    return 0;
  }
}
