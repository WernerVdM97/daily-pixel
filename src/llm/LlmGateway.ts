export interface LlmContext {
  character: {
    class: string;
    stats: { physical: number; wisdom: number; intelligence: number; charisma: number };
    health: number;
    /** Health ceiling — lets the prompt render `health/maxHealth` (e.g. `7/10`). Optional:
     *  the stripped retry context and bare test fixtures may omit it. */
    maxHealth?: number;
    stamina: number;
    /** Stamina ceiling — lets the prompt render `stamina/maxStamina`. Optional, as above. */
    maxStamina?: number;
    alignment: string;
    dayJob: string;
  };
  /** `isSafe` lets the prompt tag the location safe/unsafe — the lever for danger pacing.
   *  Optional: omitted by the stripped retry context and bare fixtures. */
  location: { name: string; isSafe?: boolean };
  nearbyNpcs: { name: string; description: string }[];
  nearbyPcs: { name: string; class: string }[];
  recentActions: { type: string; outcome: string; narrative?: string | null }[];
  /** Every charted location name. Injected as a `KNOWN LOCATIONS` block (v8+) so the
   *  LLM reuses real names for set_location and only invents for true off-map
   *  exploration. Optional: the stripped retry context omits it. */
  knownLocations?: string[];
  rawInput: string;
  previousDecisions?: { prompt: string; chosen: string; dcModifier: number }[];
  /** Per-stat summed item bonus (the `Gear` column of the v9 ability-checks table). Optional:
   *  the stripped retry context and bare fixtures omit it. The legacy `scalingHint` string still
   *  carries the same data for the audit digest. */
  itemBonuses?: { physical: number; wisdom: number; intelligence: number; charisma: number };
  /** Full inventory, structured — the v9 markdown `Inventory` list (and remove_item targets). */
  inventory?: { emoji: string; name: string; stat: string; modifier: number; quantity: number }[];
  scalingHint: string;
  /** Set by FallbackLlmGateway to tag retry attempts in the audit log (0 = primary, 1 = stripped retry). */
  attemptTier?: number;
  /**
   * Set on the second (narration) call of a rolled resolution: the dice have already
   * decided this verdict, so the LLM must narrate THIS outcome and emit matching
   * mutations (failure → costs only, no rewards). See machine.resolveWithRoll.
   */
  rollOutcome?: 'success' | 'failure';
  /**
   * Coherence-critic feedback for a single re-decide (Thread 2). When the critic flags a beat as a
   * MAJOR defect, the engine re-calls decide() once with the critic's issues here so the author can
   * produce a corrected beat. Absent on the normal first attempt.
   */
  criticNote?: string;
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
  /** Id of the coherence-critic call made on THIS beat (set by CritiquedLlmGateway on a
   *  decision beat), so it too can be linked to the action. */
  _critiqueCallId?: number;
  /** Transient (in-memory only): the full prompt + reasoning that produced this decision, held so
   *  the critic can backfill the decision's audit row if it flags the beat. Never persisted. */
  _rawPrompt?: string;
  _reasoning?: string | null;
  /** validateDecision warnings for this decision — surfaced so the coherence critic (Thread 2)
   *  can gate on "the deterministic validator smelled smoke" and hand them over as its checklist.
   *  Set by DeepseekLlmGateway.decide; absent on gateways that don't validate. */
  _warnings?: string[];
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

/**
 * What the coherence critic is asked to check (Thread 2). It sees the already
 * deterministically-normalised authored output plus the engine truths to anchor against —
 * never the player; its only job is to catch contradictions before the output is shown.
 */
export interface CriticInput {
  /** 'decision' = an options beat (NEW_ACTION/CONTINUE); 'resolution' = a narrated verdict. */
  beat: 'decision' | 'resolution';
  /** The dice verdict — present on resolution beats. The narration MUST match it. */
  rollOutcome?: 'success' | 'failure';
  /** The authored decision/narration, after parse + deterministic normalisation. */
  decision: LlmDecision;
  /** Final mutations after applyOutcomeToMutations (resolution beats) — the outcome_text must
   *  reference these, and they must match the verdict. Omitted on decision beats. */
  finalMutations?: unknown[];
  /** Compact snapshot of the context the author saw (character/scene/story) — for the digest
   *  and as the critic's against-context anchor. */
  contextDigest: string;
  /** The original player input — recorded on the audit row for action linkage. */
  playerInput: string;
  /** validateDecision warnings handed to the critic as its checklist of suspicions. */
  warnings: string[];
}

/**
 * The critic's verdict. It is a TEXTURE-corrector, not a truth-arbiter: any `patch` only
 * touches narrative prose (`prompt`, `outcomeText`) — never mutations, DC, stat, or roll. A
 * `major` defect (wrong intent, dead turn, structural) is signalled for a single re-decide
 * rather than patched. Whatever it returns is re-run through the deterministic normalisers.
 */
export interface CriticVerdict {
  /** true = coherent, pass through unchanged. */
  ok: boolean;
  /** 'minor' → apply the prose patch; 'major' → re-decide once with `issues` as guidance. */
  severity: 'minor' | 'major';
  /** Concrete contradictions found (empty when ok). */
  issues: string[];
  /** Prose-only correction, present only for a minor defect. */
  patch?: { prompt?: string; outcomeText?: string };
  /** Id of the llm_calls audit row this critic verdict came from (for action linkage). */
  _llmCallId?: number;
}

export interface CriticGateway {
  /** Review one authored beat for coherence. Best-effort: never throws (fails open to ok). */
  critique(input: CriticInput): Promise<CriticVerdict>;
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

/** One resolved action, flattened for the weekly recap prompt. */
export interface RecapActionInput {
  /** The acting character's name. */
  character: string;
  /** Distilled action type (travel, combat, forage, …). */
  type: string;
  /** success | failure | done | bailed | timed_out. */
  outcome: string;
  /** The narrative text shown to players (may be empty). */
  narrative: string;
}

/** Structured result of the weekly recap call. */
export interface RecapResult {
  /** A short (2–4 sentence) world-level skim of the week's narrative progress. */
  digest: string;
  /** One-line highlights of the week's notable beats (bland actions omitted). */
  highlights: string[];
}

/**
 * The weekly-recap LLM call: given the week's resolved actions, judge what's
 * notable (ignoring bland/routine actions) and return a short world digest plus
 * a list of highlight lines. A reporting concern, separate from `decide`.
 */
export interface RecapGateway {
  summarizeWeek(actions: RecapActionInput[]): Promise<RecapResult>;
}
