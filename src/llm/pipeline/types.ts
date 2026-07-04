import type { ActionCategory, LlmContext, LlmDecisionOption } from '../LlmGateway.js';

/**
 * Pipeline routing key. Reuses the canonical `ActionCategory` union (LlmGateway.ts) rather
 * than a parallel enum — Stage 1 settled decision #5: ActionType replaces `category` as the
 * machine's routing key, but the value set is unchanged.
 */
export type ActionType = ActionCategory;

/** Routing flags the classifier derives alongside `ActionType`, consumed downstream to pick
 *  templates and gate rolls without re-deriving them per stage. */
export interface RoutingFlags {
  /** Heuristic-only at classify time (raw input has no world data yet) — a rough signal for
   *  danger-pacing prompts, not the authoritative `location.isSafe` decide/resolve read from
   *  `LlmContext`. */
  unsafe_location: boolean;
  /** Whether resolving this action is expected to need a dice roll (gates the DICE stage). */
  needs_roll: boolean;
  /** Whether the raw input names/implies a specific target (NPC, object, direction). */
  target_present: boolean;
}

/** CLASSIFY succeeded: the heuristic table (or, later, the LLM fallback) is confident. */
export interface ClassifyHit {
  kind: 'hit';
  actionType: ActionType;
  flags: RoutingFlags;
}

/** CLASSIFY found no confident match — the heuristic table must never guess wrong, so
 *  ambiguous/unmatched input surfaces this instead of an `ActionType`. Callers route a miss
 *  to the LLM classify-fallback seam (`PipelineLlmGateway.classify` below). */
export interface ClassifyMiss {
  kind: 'miss';
  rawInput: string;
}

export type ClassifyResult = ClassifyHit | ClassifyMiss;

/** Input to DECIDE: routing already resolved by CLASSIFY: pick a v12 template for `actionType`
 *  and author options only — no mutations, no outcome_text (settled decision: decide never
 *  authors either; that is D5b's job, split across resolveMutate/resolveNarrate below). */
export interface PipelineDecideInput {
  actionType: ActionType;
  flags: RoutingFlags;
  context: LlmContext;
}

/** DECIDE's output: options + per-option stat/dc only. Deliberately has no `mutations` /
 *  `outcomeText` fields — Task 2 asserts this shape stays empty of both. */
export interface PipelineDecideResult {
  distilledType: string;
  stat: 'physical' | 'wisdom' | 'intelligence' | 'charisma';
  baseDc: number;
  required: boolean;
  decision: LlmDecisionOption[];
  /** D6 — doc's `scene_location` (prompt-v12-scene-state.md) → code camelCase. The location the
   *  decided scene is set in, declared as structured data rather than derived from prose. Optional:
   *  absent means "no scene declared," and the travel-coherence gate (`travel-gate.ts`) is then a
   *  strict no-op — every existing scripted decide result stays valid unchanged. */
  sceneLocation?: string;
  /** Signal for combat establishment: the enemy's identity and anchor kind, authored by
   *  DECIDE on the first combat beat (T3 decision 3). Absent or failing to resolve → defaults
   *  to a location-anchored minion named generically. */
  combatEnemy?: { name: string; anchor: 'npc' | 'location' };
}

/** Input to RESOLVE-MUTATE: a structured (not re-parsed prose) handoff of the decision that
 *  was made, the option the player/dice picked, and the roll verdict. Fresh session per the
 *  pipeline contract — no memory of the DECIDE call. Includes the raw d20 value so crits
 *  (nat 1 / nat 20) can modify rewards and costs. */
export interface PipelineResolveMutateInput {
  actionType: ActionType;
  decision: PipelineDecideResult;
  chosenOption: LlmDecisionOption;
  verdict: 'success' | 'failure';
  /** The raw d20 roll (1-20), or 0 for auto-resolve (no-roll types like rest/travel). */
  d20Roll: number;
  context: LlmContext;
}

/** RESOLVE-MUTATE's output: PROPOSED mutations only — pre-finalize. The engine's pure
 *  finalize fn (Task 3) transforms these into FINAL mutations before RESOLVE-NARRATE runs. */
export interface PipelineResolveMutateResult {
  mutations: unknown[];
}

/** Input to RESOLVE-NARRATE: the FINAL (post-finalize) mutations, not the proposed ones — the
 *  D5b inversion this whole pipeline exists to deliver, so outcome_text is authored against
 *  what actually landed. Includes the raw d20 value so crit narration can call it out. */
export interface PipelineResolveNarrateInput {
  actionType: ActionType;
  decision: PipelineDecideResult;
  chosenOption: LlmDecisionOption;
  verdict: 'success' | 'failure';
  /** The raw d20 roll (1-20), or 0 for auto-resolve (no-roll types like rest/travel). */
  d20Roll: number;
  finalMutations: unknown[];
  context: LlmContext;
}

export interface PipelineResolveNarrateResult {
  outcomeText: string;
}

/**
 * Stage-tagged gateway the future `PipelineActionStateMachine` (Task 2) calls. `classify` here
 * is ONLY the LLM fallback for a heuristic miss — the heuristic table itself
 * (`classifier.ts::heuristicClassify`) is a plain sync function called first and does not go
 * through this interface. Task 1 defines the shape; no implementation is wired up here beyond
 * the stub in `classifier.ts` (`notImplementedClassifyFallback`).
 */
export interface PipelineLlmGateway {
  /** Called only on a heuristic miss. Must resolve to a hit — the fallback is the last stage
   *  that can still route the action; it has no further fallback beneath it. */
  classify(rawInput: string, context: LlmContext): Promise<ClassifyHit>;
  decide(input: PipelineDecideInput): Promise<PipelineDecideResult>;
  resolveMutate(input: PipelineResolveMutateInput): Promise<PipelineResolveMutateResult>;
  resolveNarrate(input: PipelineResolveNarrateInput): Promise<PipelineResolveNarrateResult>;
}
