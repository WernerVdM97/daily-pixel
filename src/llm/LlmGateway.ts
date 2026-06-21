export interface LlmContext {
  character: {
    class: string;
    stats: { physical: number; wisdom: number; intelligence: number; charisma: number };
    health: number;
    stamina: number;
    alignment: string;
    dayJob: string;
  };
  location: { name: string };
  nearbyNpcs: { name: string; description: string }[];
  nearbyPcs: { name: string; class: string }[];
  recentActions: { type: string; outcome: string; narrative?: string | null }[];
  /** Every charted location name. Injected as a `KNOWN LOCATIONS` block (v8+) so the
   *  LLM reuses real names for set_location and only invents for true off-map
   *  exploration. Optional: the stripped retry context omits it. */
  knownLocations?: string[];
  rawInput: string;
  previousDecisions?: { prompt: string; chosen: string; dcModifier: number }[];
  scalingHint: string;
  /** Set by FallbackLlmGateway to tag retry attempts in the audit log (0 = primary, 1 = stripped retry). */
  attemptTier?: number;
  /**
   * Set on the second (narration) call of a rolled resolution: the dice have already
   * decided this verdict, so the LLM must narrate THIS outcome and emit matching
   * mutations (failure → costs only, no rewards). See machine.resolveWithRoll.
   */
  rollOutcome?: 'success' | 'failure';
}

export interface LlmDecision {
  prompt?: string;
  distilledType: string;
  stat: 'physical' | 'wisdom' | 'intelligence' | 'charisma';
  baseDc: number;
  required: boolean;
  done: boolean;
  decision: LlmDecisionOption[];
  mutations?: unknown[];
  outcomeText?: string;
  /** Id of the llm_calls audit row this decision came from (for action linkage). */
  _llmCallId?: number;
}

export interface LlmDecisionOption {
  label: string;
  dcModifier: number | null; // null = bail
  /**
   * Optional per-option ability stat. When present, choosing this option makes it the
   * stat the resolution roll tests (overriding the action's top-level `stat`). Lets a
   * single decision offer genuinely different approaches — a clever (wisdom) option and a
   * direct (physical) one — that test different attributes. See ADR
   * [[per-option-stat-and-ability-checks]].
   */
  stat?: 'physical' | 'wisdom' | 'intelligence' | 'charisma';
}

export interface LlmGateway {
  decide(context: LlmContext): Promise<LlmDecision>;
}

/** Input to the async D3 "cartographer" — the world it must place a new spot into. */
export interface CartographerInput {
  /** The new (provisional) location name the player was just moved to. */
  newName: string;
  /** Every already-charted location name (so the cartographer can flag a dup). */
  existingNames: string[];
  /** The narrative that produced the move — the fiction the place should fit. */
  narrative: string;
}

/** Structured result from the cartographer. All fields optional/defaulted by the caller. */
export interface CartographerResult {
  /** If set, the new name is really an existing location (a synonym) — caller may skip enrichment. */
  matchesExisting?: string;
  /** Whether the place is safe (1) or wild (0). */
  is_safe?: 0 | 1;
  /** A proper one-paragraph description to replace the placeholder. */
  description?: string;
}

/**
 * Async world-builder for D3 lazy location creation — a focused, separate call
 * from the decision gateway (but reusing the same transport). Fills a provisional
 * location's is_safe + description off the player's critical path.
 */
export interface CartographerGateway {
  enrich(input: CartographerInput): Promise<CartographerResult>;
}
