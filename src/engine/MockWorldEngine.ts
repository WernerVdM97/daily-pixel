import type {
  WorldEngine,
  CharCreateData,
  CharacterData,
  RestAtOakResult,
  ActionStartResult,
  ActionKind,
  ActionStepResult,
  ActionResumeResult,
  LocationInfo,
  ItemData,
  NearbyEntity,
  JournalData,
  DiscoveredGraph,
  TravelRoute,
  LocationExits,
  TickResult,
  StatBlock,
  Leaderboards,
  WeeklyActionSummary,
  ActionOption,
  PendingChoiceSelector,
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
  private _resumeResult: ActionResumeResult | null = null;
  private _location: LocationInfo | null = null;
  private _locationSet = false;
  private _items: ItemData[] = [];
  private _nearbyEntities: NearbyEntity[] = [];
  private _journal: JournalData | null = null;
  private _discoveredGraph: DiscoveredGraph | null = null;
  private _route: TravelRoute | null = null;
  private _exits: LocationExits | null = null;
  private _tickResult: TickResult | null = null;
  private _soulsInUnsafe = 0;
  private _activePlayersSince = 0;
  private _leaderboards: Leaderboards = { wealth: [], might: [] };
  private _weeklyActions: WeeklyActionSummary[] = [];
  private _meta: Map<string, string> = new Map();
  private _commuteResult: { to: string; stamina: number } | null = null;
  private _pendingChoiceOptions: ActionOption[] = [];

  // ── Call tracking ──

  calls: {
    createCharacter: { discordUserId: string; data: CharCreateData }[];
    getCharacter: string[];
    characterExists: string[];
    startAction: { characterId: number; rawInput: string; opts: { kind?: ActionKind; wage?: number } }[];
    stepAction: { characterId: number; choice: string }[];
    resumeAction: number[];
    getLocation: string[];
    getItems: number[];
    getNearbyEntities: number[];
    getJournal: number[];
    // M8.1 (obligation O3): `getExits`/`getDiscoveredGraph` log like every other read — the
    // M8.0 residual that left the screens-oracle zero-read assertions byte-proven instead of
    // log-proven. The oracle transcripts 1/3/6/7 now assert these logs.
    getExits: string[];
    getDiscoveredGraph: number[];
    submitFeedback: { characterId: number; text: string; actionId?: number }[];
    submitBug: { characterId: number; text: string; actionId?: number }[];
    updateLastPlayed: number[];
    modifyHealth: { discordUserId: string; amount: number }[];
    countSoulsInUnsafe: void[];
    countActivePlayersSince: string[];
    tick: boolean[];
    restAtOak: string[];
    spawnNpc: { name: string; location: string }[];
    getLeaderboards: number[];
    getMeta: string[];
    commuteToWorkplace: { characterId: number; workplace: string | null }[];
    resolvePendingChoice: { characterId: number; selector: PendingChoiceSelector }[];
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
    getExits: [],
    getDiscoveredGraph: [],
    submitFeedback: [],
    submitBug: [],
    updateLastPlayed: [],
    modifyHealth: [],
    countSoulsInUnsafe: [],
    countActivePlayersSince: [],
    restAtOak: [],
    tick: [],
    spawnNpc: [],
    getLeaderboards: [],
    getMeta: [],
    commuteToWorkplace: [],
    resolvePendingChoice: [],
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
  setResumeResult(result: ActionResumeResult): void {
    this._resumeResult = result;
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

  setDiscoveredGraph(graph: DiscoveredGraph): void {
    this._discoveredGraph = graph;
  }

  setRoute(route: TravelRoute | null): void {
    this._route = route;
  }

  setExits(exits: LocationExits): void {
    this._exits = exits;
  }
  setSoulsInUnsafe(count: number): void {
    this._soulsInUnsafe = count;
  }

  setActivePlayersSince(count: number): void {
    this._activePlayersSince = count;
  }

  setCommuteResult(result: { to: string; stamina: number } | null): void {
    this._commuteResult = result;
  }

  /** Stashes the option list `resolvePendingChoice` resolves against, standing in for the
   *  real engine's `last_action_state.pendingDecision.options` (M3.2 DC-F). */
  setPendingChoiceOptions(options: ActionOption[]): void {
    this._pendingChoiceOptions = options;
  }

  setTickResult(result: TickResult): void {
    this._tickResult = result;
  }
  setLeaderboards(result: Leaderboards): void {
    this._leaderboards = result;
  }

  setWeeklyActions(actions: WeeklyActionSummary[]): void {
    this._weeklyActions = actions;
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
      health: 10,
      maxHealth: 10,
      stamina: 10,
      maxStamina: 10,
      rollsRemaining: 3,
      location: "The Warden's Oak",
      wealth: 5,
      lastActionState: null,
      hasRestedToday: false,
      createdAt: "2026-01-01T00:00:00Z",
      ...restOverrides,
    };
  }

  // ── Interface methods ──

  /** Replicates the real engine's M7.1 restAtOak: records the FIRST ARG ONLY (so the call
   *  log stays `[userId]`, the shape the M7.0 transcripts assert) and applies the unsafe-rest
   *  −1 penalty through its own `modifyHealth` (so `calls.modifyHealth` records the same
   *  `{ discordUserId, amount: -1 }`), mirroring the real engine's internal call. */
  restAtOak(discordUserId: string, opts?: { workplace?: string | null }): RestAtOakResult {
    this.calls.restAtOak.push(discordUserId);
    if (!this._character) return { character: null, wasUnsafe: false, unsafeFromName: "" };

    const oakName = "The Warden's Oak";
    const alreadyThere = this._character.location === oakName;
    const atWorkplace = opts?.workplace != null && this._character.location === opts.workplace;
    const here = this._locationSet
      ? this._location
      : { name: this._character.location, description: "A mock location.", tags: ["mock"], isSafe: true, emoji: "📍" };
    const wasUnsafe = here !== null && !here.isSafe && !alreadyThere && !atWorkplace;
    const unsafeFromName = this._character.location;

    let updated: CharacterData = { ...this._character, location: oakName };
    if (wasUnsafe) {
      const penalised = this.modifyHealth(discordUserId, -1);
      if (penalised) updated = { ...penalised, location: oakName };
    }
    return { character: updated, wasUnsafe, unsafeFromName };
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
    opts: { kind?: ActionKind; wage?: number } = {},
  ): Promise<ActionStartResult> {
    this.calls.startAction.push({ characterId, rawInput, opts });
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
    if (!this._resumeResult) {
      throw new Error("MockWorldEngine.resumeAction: no canned result set");
    }
    return this._resumeResult;
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
        emoji: "📍",
      };
    }
    return this._location;
  }

  getExits(location: string): LocationExits {
    this.calls.getExits.push(location);
    return this._exits ?? { neighbours: [], frontiers: [] };
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

  getDiscoveredGraph(characterId: number): DiscoveredGraph {
    this.calls.getDiscoveredGraph.push(characterId);
    return this._discoveredGraph ?? { current: "The Warden's Oak", nodes: [], edges: [], frontiers: [] };
  }

  routeBetween(_from: string, _to: string): TravelRoute | null {
    return this._route ?? null;
  }

  commuteToWorkplace(characterId: number, workplace: string | null): { to: string; stamina: number } | null {
    this.calls.commuteToWorkplace.push({ characterId, workplace });
    // Mirror WorldEngineImpl's persist-then-reread semantics (M3.4): the real engine writes
    // the commute onto the character row, so a later `getCharacter` re-read reflects it —
    // callers no longer patch a locally-held snapshot themselves.
    if (this._commuteResult && this._character) {
      this._character = { ...this._character, stamina: this._commuteResult.stamina, location: this._commuteResult.to };
    }
    return this._commuteResult;
  }

  resolvePendingChoice(characterId: number, selector: PendingChoiceSelector): string | null {
    this.calls.resolvePendingChoice.push({ characterId, selector });
    // An empty/unset stash mirrors "no last_action_state" — the mock has no separate
    // flag for "state exists but options is empty", so it collapses the two (M3.2 DC-F).
    if (this._pendingChoiceOptions.length === 0) {
      return selector.kind === 'bail' ? 'Bail' : null;
    }
    if (selector.kind === 'bail') {
      return this._pendingChoiceOptions.find((o) => o.dcModifier === null)?.label ?? 'Bail';
    }
    return this._pendingChoiceOptions[selector.index]?.label ?? null;
  }

  submitFeedback(characterId: number, text: string, actionId?: number): void {
    this.calls.submitFeedback.push({ characterId, text, actionId });
  }

  submitBug(characterId: number, text: string, actionId?: number): void {
    this.calls.submitBug.push({ characterId, text, actionId });
  }

  spawnNpc(data: {
    name: string;
    class?: string;
    race?: string;
    description?: string;
    location: string;
  }): void {
    this.calls.spawnNpc.push({ name: data.name, location: data.location });
  }

  getLeaderboards(limit: number): Leaderboards {
    this.calls.getLeaderboards.push(limit);
    return this._leaderboards;
  }

  getActionsBetween(_startIso: string, _endIso: string): WeeklyActionSummary[] {
    return this._weeklyActions;
  }

  tick(isAdmin: boolean): TickResult {
    this.calls.tick.push(isAdmin);
    return (
      this._tickResult ?? {
        dayNumber: 1,
        playersAffected: 0,
        npcMovements: [],
        absentWarnings: [],
        collapsedNames: [],
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
    return this._soulsInUnsafe;
  }

  countActivePlayersSince(startIso: string): number {
    this.calls.countActivePlayersSince.push(startIso);
    return this._activePlayersSince;
  }
}
