// Stage 0a sim harness — shared contracts (docs/engine/stage-0a-sim-harness-plan.md).
//
// This is an offline replay tool, not a game sim: it drives the real WorldEngineImpl
// through a scripted character with a mocked LLM and a scripted/seeded d20, so the
// balance curves (roll success rate, resource drain, reward gain) are observable
// before Thread B/C tuning happens blind.
import type { LlmContext, LlmDecision } from '../llm/LlmGateway.js';
import type { ActionKind, ActionStartResult, ActionStepResult, CharacterData, ItemData } from '../engine/WorldEngine.js';
import type {
  ClassifyHit,
  PipelineDecideInput,
  PipelineDecideResult,
  PipelineResolveMutateInput,
  PipelineResolveMutateResult,
  PipelineResolveNarrateInput,
  PipelineResolveNarrateResult,
} from '../llm/pipeline/types.js';

/** Which action-state machine drives a scenario (Thread D Task 4). */
export type MachineKind = 'legacy' | 'pipeline';

/**
 * The narrow surface `driver.ts`'s `runTurn`/`runScenario` actually call — satisfied
 * structurally by both the real `WorldEngineImpl` (legacy) and `PipelineSimEngine` (Task 4),
 * so per-turn driving code needs zero machine-specific branching; only engine *construction*
 * (`engine-factory.ts`'s `buildSimEngine`) picks the machine.
 */
export interface SimEngine {
  startAction(
    characterId: number,
    rawInput: string,
    opts?: { kind?: ActionKind; wage?: number },
  ): Promise<ActionStartResult>;
  stepAction(characterId: number, choice: string): Promise<ActionStepResult>;
  getCharacter(discordUserId: string): CharacterData | null;
  getItems(characterId: number): ItemData[];
}

/**
 * Per-stage canned outputs for `PipelineScriptedGateway` (Task 4) — the pipeline's 4-stage
 * contract (classify-fallback/decide/resolveMutate/resolveNarrate) can't be expressed by the
 * legacy single-method `DecisionScript` above, so this is a parallel script shape, not an
 * extension of it. Each callback receives the exact input the real stage would and must return
 * a valid output OR throw a clear scenario-author error — `PipelineScriptedGateway` never
 * manufactures a guessed output on the caller's behalf (mirrors `driver.ts`'s `pickChoice`
 * philosophy: a scenario-author bug should fail loudly, not silently skew the curve).
 */
export interface PipelineScript {
  /** Only invoked on a heuristic CLASSIFY miss (`classifier.ts::heuristicClassify`). Optional:
   *  a well-formed scenario's raw inputs should all hit the heuristic table, so most scripts
   *  never need this. Omitting it means any miss surfaces as `PipelineActionStateMachine`'s own
   *  typed divine-intervention fallback-of-fallback outcome — a legitimate, clearly-flagged
   *  result (`isDivineIntervention: true`), not silently wrong data. */
  classify?: (rawInput: string, context: LlmContext) => ClassifyHit;
  /** @param callNo 0-based count of decide() calls made so far on this `PipelineScriptedGateway`
   *  instance — a gateway-instance-global counter across the ENTIRE scenario run, not scoped to
   *  the current action or beat (same underlying semantics as the legacy `DecisionScript`'s
   *  `callNo`, documented below). A scenario with more than one action/turn must NOT rely on
   *  `callNo` to distinguish beats within a single action — use
   *  `input.context.previousDecisions.length` instead, which resets to 0 at the start of each
   *  new action. */
  decide: (input: PipelineDecideInput, callNo: number) => PipelineDecideResult;
  resolveMutate: (input: PipelineResolveMutateInput) => PipelineResolveMutateResult;
  resolveNarrate: (input: PipelineResolveNarrateInput) => PipelineResolveNarrateResult;
}

/** How resolveWithRoll's single d20 call is answered — deterministic, never Math.random. */
export type RollSource =
  | { kind: 'fixed'; value: number }
  | { kind: 'sequence'; values: number[] } // consumed in order, one per resolveWithRoll call
  | { kind: 'seeded'; seed: number }; // mulberry32, mapped to 1..20

/**
 * How a turn picks among the presented options once a decision beat is shown.
 * Applied at every beat within a turn (a turn may take 1-2 stepAction calls to resolve).
 */
export type ChoicePolicy = 'first-real' | 'highest-dc' | 'lowest-dc' | 'bail' | { index: number };

/** callNo is the 0-based count of decide() calls made so far on this gateway instance —
 *  a resolving beat calls decide() twice (decision, then narration); a simple script can
 *  ignore it and return the same shape for both. */
export type DecisionScript = (ctx: LlmContext, callNo: number) => LlmDecision;

export interface CharacterSeed {
  class: string;
  stats: { physical: number; wisdom: number; intelligence: number; charisma: number };
  health: number;
  maxHealth: number;
  stamina: number;
  maxStamina: number;
  wealth: number;
  location: string;
  alignment: string;
  dayJob: string;
}

export interface TurnScript {
  input: string;
  choicePolicy: ChoicePolicy;
}

/**
 * One day's routine: the ordered turns the character takes that day. An empty array is a
 * rest day — the clock still ticks (rolls refill, resources regen in safe locations / drain
 * in unsafe ones) but the character takes no action.
 */
export type DayScript = TurnScript[];

export interface Scenario {
  name: string;
  character: CharacterSeed;
  rollSource: RollSource;
  llm: { kind: 'scripted'; script: DecisionScript } | { kind: 'pipeline-scripted'; script: PipelineScript };
  /**
   * The week's routine — one DayScript per day (1..7 entries). The driver walks each day in
   * order, ticking a game day between days, then repeats the whole week `weeks` times. A week
   * is an explicit sequence of (possibly distinct) days, not one day repeated: this is what
   * lets a scenario mix e.g. grind days, a market day, and a rest day.
   */
  week: DayScript[];
  /** How many times to repeat `week`. Consumed by the time module (T3). Defaults to 1. */
  weeks?: number;
  /** Which action-state machine drives this scenario (Task 4). Defaults to 'legacy' — every
   *  existing JSON fixture omits this field and is unaffected. A 'pipeline' scenario's `llm`
   *  must be the `pipeline-scripted` variant, not the legacy `scripted` one — `driver.ts`'s
   *  `runScenario` throws a clear error on a mismatch rather than silently ignoring it. */
  machine?: MachineKind;
}

/**
 * A scenario run through BOTH machines for comparison (Task 4's `runComparison`). Shares the
 * character seed / roll source / week routine so the two runs are genuinely comparable, but
 * carries a script per machine — decide's shape differs and resolve is split in two, so a
 * legacy `DecisionScript` and a `PipelineScript` are never equivalent/auto-derivable from one
 * another (see driver.ts's `runComparison` doc comment).
 */
export interface ComparisonScenario {
  name: string;
  character: CharacterSeed;
  rollSource: RollSource;
  legacyScript: DecisionScript;
  pipelineScript: PipelineScript;
  week: DayScript[];
  weeks?: number;
}

export interface TurnTrace {
  index: number;
  input: string;
  distilledType: string;
  finalDc: number | null;
  playerRolled: number | null;
  rollBonus: number | null;
  outcome: string;
  health: number;
  stamina: number;
  wealth: number;
  rollsRemaining: number;
  itemCount: number;
  mutationsApplied: number;
  /** Game day_number this turn resolved on (T3: time.ts stamps this as weeks advance). */
  day?: number;
}

/** One scripted pipeline-stage invocation's wall-clock timing (Task 5), as recorded by
 *  `PipelineScriptedGateway.stageCalls`. `stage` is a plain `string` here (not the `PipelineStage`
 *  union from `src/llm/pipeline/stamping.ts`) so this sim-layer type doesn't couple to that
 *  module's exact union — a `PipelineStage` value is always assignable into it. */
export interface PipelineStageCall {
  stage: string;
  latencyMs: number;
}

/** Scenario-level combat aggregates (T5). Pipeline-only, mirroring stageCalls/relationsPersisted. */
export interface CombatMetrics {
  /** Total combat rounds fought across the scenario (one per emitted combatBeat). */
  roundsFought: number;
  /** Rounds where the once-per-day survive-at-1 floor fired. */
  floorSaves: number;
  /** Combat fights resolved as a win (terminal combat beat, outcome 'success'). */
  wins: number;
  /** Combat fights resolved as a loss (terminal combat beat, outcome 'failure'). */
  losses: number;
}

export interface SimResult {
  scenario: string;
  turns: TurnTrace[];
  /** Per-stage call timings (Task 5) — populated only for pipeline-machine runs
   *  (`runPipelineScenario` in driver.ts); `undefined` for legacy runs, which have no pipeline
   *  stages to report. */
  stageCalls?: PipelineStageCall[];
  /** Relation rows persisted at scenario end (Stage 2 T5c), read from `PipelineSimEngine`'s
   *  private `RelationRepository` — mirrors `stageCalls`' optional pipeline-only precedent above.
   *  Populated only for pipeline-machine runs (`runPipelineScenario`); `undefined` for legacy
   *  runs, which have no relation repo. Demonstrates edges written on earlier beats survive to
   *  scenario end (persistence across beats). */
  relationsPersisted?: number;
  /** Combat round/outcome aggregates (T5), read from `PipelineSimEngine.getCombatMetrics()`.
   *  Pipeline-only — `undefined` for legacy runs, which have no combat sub-mode. */
  combatMetrics?: CombatMetrics;
}
