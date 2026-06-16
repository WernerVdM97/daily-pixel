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
  recentActions: { type: string; outcome: string }[];
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
