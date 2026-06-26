export interface LlmContext {
  character: {
    class: string;
    stats: { physical: number; wisdom: number; intelligence: number; charisma: number };
    health: number;
    /** Health ceiling for `health/maxHealth` render. Optional: stripped retry context / bare fixtures omit it. */
    maxHealth?: number;
    stamina: number;
    /** Stamina ceiling for `stamina/maxStamina`. Optional, as above. */
    maxStamina?: number;
    alignment: string;
    dayJob: string;
  };
  /** `isSafe` drives danger pacing (safe/unsafe tag). Optional: omitted by stripped retry context / bare fixtures. */
  location: { name: string; isSafe?: boolean };
  nearbyNpcs: { name: string; description: string }[];
  nearbyPcs: { name: string; class: string }[];
  recentActions: { type: string; outcome: string; narrative?: string | null }[];
  /** Charted location names, injected as a `KNOWN LOCATIONS` block (v8+) so the LLM reuses real
   *  names for set_location and only invents for true off-map exploration. Optional: stripped retry context omits it. */
  knownLocations?: string[];
  rawInput: string;
  previousDecisions?: { prompt: string; chosen: string; dcModifier: number }[];
  /** Per-stat summed item bonus (v9 ability-checks `Gear` column). Optional: stripped retry context / bare
   *  fixtures omit it. Legacy `scalingHint` still carries the same data for the audit digest. */
  itemBonuses?: { physical: number; wisdom: number; intelligence: number; charisma: number };
  /** Structured inventory — v9 markdown `Inventory` list and remove_item targets. */
  inventory?: { emoji: string; name: string; stat: string; modifier: number; quantity: number }[];
  scalingHint: string;
  /** Set by FallbackLlmGateway to tag retry attempts in the audit log (0 = primary, 1 = stripped retry). */
  attemptTier?: number;
  /** Second (narration) call of a rolled resolution: dice already decided, so the LLM narrates THIS
   *  outcome with matching mutations (failure → costs only, no rewards). See machine.resolveWithRoll. */
  rollOutcome?: 'success' | 'failure';
  /** Coherence-critic feedback (Thread 2) for a single re-decide on a MAJOR defect. Absent on first attempt. */
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
  /** Id of the coherence-critic call on THIS beat (set by CritiquedLlmGateway), for action linkage. */
  _critiqueCallId?: number;
  /** Id of a decision call this beat SUPERSEDED — the flagged decision discarded by a major
   *  re-decide. Kept so its audit row still links to the action (the critic captured its
   *  reasoning via promoteDeepCapture; without this its action_id would stay NULL). */
  _supersededCallId?: number;
  /** Transient (in-memory only): full prompt + reasoning that produced this decision, so the critic
   *  can backfill the audit row if it flags the beat. Never persisted. */
  _rawPrompt?: string;
  _reasoning?: string | null;
  /** validateDecision warnings, surfaced as the coherence critic's checklist of suspicions.
   *  Set by DeepseekLlmGateway.decide; absent on gateways that don't validate. */
  _warnings?: string[];
}

export interface LlmDecisionOption {
  label: string;
  dcModifier: number | null; // null = bail
  /** Per-option ability stat: when present, the resolution roll tests this stat (overriding the action's
   *  top-level `stat`), letting one decision offer approaches that test different attributes —
   *  clever (wisdom) vs direct (physical). See ADR [[per-option-stat-and-ability-checks]]. */
  stat?: 'physical' | 'wisdom' | 'intelligence' | 'charisma';
}

export interface LlmGateway {
  decide(context: LlmContext): Promise<LlmDecision>;
}

/**
 * What the coherence critic checks (Thread 2): the deterministically-normalised authored output
 * plus engine truths to anchor against — never the player. Job: catch contradictions before display.
 */
export interface CriticInput {
  /** 'decision' = an options beat (NEW_ACTION/CONTINUE); 'resolution' = a narrated verdict. */
  beat: 'decision' | 'resolution';
  /** The dice verdict — present on resolution beats. The narration MUST match it. */
  rollOutcome?: 'success' | 'failure';
  /** The authored decision/narration, after parse + deterministic normalisation. */
  decision: LlmDecision;
  /** Final mutations after applyOutcomeToMutations (resolution beats); outcome_text must reference
   *  these and they must match the verdict. Omitted on decision beats. */
  finalMutations?: unknown[];
  /** Compact snapshot of the context the author saw — the digest and the critic's anchor. */
  contextDigest: string;
  /** The original player input — recorded on the audit row for action linkage. */
  playerInput: string;
  /** validateDecision warnings handed to the critic as its checklist of suspicions. */
  warnings: string[];
}

/**
 * The critic's verdict. A TEXTURE-corrector, not a truth-arbiter: `patch` only touches narrative
 * prose (`prompt`, `outcomeText`), never mutations/DC/stat/roll. A `major` defect (wrong intent,
 * dead turn, structural) triggers a single re-decide rather than a patch. Output is re-normalised.
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
 * Async world-builder for D3 lazy location creation — a separate call from the decision gateway
 * (same transport), filling a provisional location's is_safe + description off the critical path.
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
 * Weekly-recap LLM call: from the week's resolved actions, judge what's notable (ignoring
 * bland/routine) and return a short world digest plus highlight lines. Reporting, separate from `decide`.
 */
export interface RecapGateway {
  summarizeWeek(actions: RecapActionInput[]): Promise<RecapResult>;
}
