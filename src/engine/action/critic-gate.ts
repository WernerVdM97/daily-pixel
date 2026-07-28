/**
 * RA-4c: the anomaly gate for the coherence critic (SL-3, measure-before-gate). Split into its
 * own module (rather than inlined in `PipelineActionStateMachine.ts`) because the owner expects
 * the trigger set to be tuned after the A/B numbers come back — a named, independently-testable
 * predicate is cheap to retune; logic buried in the two call sites is not.
 */

import type { ActionType } from '../../llm/pipeline/types.js';

/** Selects WHEN the coherence critic fires. 'always' (the default) is today's behaviour —
 *  unconditional, on every decide and every narrate beat. 'anomaly' gates it to beats
 *  `isAnomalousDecide` below flags as risky. Kept as an explicit union rather than a boolean so a
 *  later third arm (e.g. a sampled/percentage gate) has somewhere to land without another
 *  signature break. Defaulted to 'always' deliberately: SL-3 is measure-first, so the owner sets
 *  the real default only after seeing the A/B call/token numbers this gate exists to produce. */
export type CriticGateMode = 'always' | 'anomaly';

/**
 * `baseDc` anomaly band. WHY these numbers: `accumulateDc` clamps the post-modifier DC to
 * [0,30] (dc.ts:12) and `validateDcModifier` bounds only the ±5 delta (dc.ts:17) — neither
 * clamps the raw authored `baseDc` itself, so a decide beat is free to author anything. The
 * authored guidance (`decide/BASE.md:29,46`) ladders "10-12 routine, 14-16 hard, 17+ daunting"
 * with NO stated ceiling, so a band tight around that ladder would misfire constantly once RA-1
 * pushes daunting attempts well past 17. Instead this band only flags the tails near the
 * engine's own absolute range: below MIN is under even the routine floor with real headroom
 * (an unusually trivial authored DC), above MAX is deep into "daunting-and-then-some", close
 * enough to the hard [0,30] clamp edge that it reads as a miscalibration/hallucination rather
 * than an intentionally brutal beat. Tune these once the A/B data shows where real authored DCs
 * actually land.
 */
export const BASE_DC_ANOMALY_MIN = 5;
export const BASE_DC_ANOMALY_MAX = 25;

export interface AnomalyCheckInput {
  /** The decide result's raw authored `baseDc` (pre-modifier). */
  baseDc: number;
  /** `decideResult.decision.length` — checked raw (pre `realOptions` filtering, pre `ensureBail`),
   *  matching the point in the pipeline where `critiqueDecide` is actually called (:185, :350). */
  decisionLength: number;
  actionType: ActionType;
}

/**
 * RA-4c trigger predicate: true when a decide beat "looks risky" enough to spend an LLM critic
 * call on under `anomaly` mode. Reused for BOTH gate sites — `critiqueDecide` (checks the decide
 * result about to be critiqued) and `critiqueNarration` (checks the ORIGINAL decide result the
 * narration is being resolved against, since a narrate beat's coherence risk traces back to how
 * risky its authoring decide beat was) — see the two call sites in
 * `PipelineActionStateMachine.ts`.
 *
 * Trigger set (per the RA-4 build plan):
 *  (a) `baseDc` outside the authored band above.
 *  (b) an empty `decision[]` on a NON-combat beat — combat's first beat is synthesized with a
 *      guaranteed 2-option shape (`start()`'s combat auto-resolve guard) and its continuation
 *      rounds never reach `critiqueDecide` at all (combat truth is engine-owned — see the
 *      T4 comment at `PipelineActionStateMachine.ts:681-682`), so an empty `decision[]` is only
 *      ever a genuine anomaly off combat.
 *
 * Deliberately EXCLUDED: "exactly one option" (the third candidate the plan doc names as a
 * legacy anomaly-gate trigger). `validateSingleOption` already catches and deterministically
 * re-decides a single-option non-combat beat for free (PipelineActionStateMachine.ts:1132) —
 * triggering the critic on the same signal would stack an LLM critic call (plus a possible
 * critic-driven re-decide) on top of a validator re-decide that already fires for the identical
 * shape, pure double-spend for one signal. Flagged as a tuning question for the owner: if the
 * validator's re-decide itself sometimes still lands wrong, single-option may be worth adding
 * back once the A/B data shows how often that happens.
 *
 * Also NOT implemented: a parse-warning/degradation trigger. `PipelineDecideResult` (the
 * pipeline machine's decide-result type) carries no such field, and `CriticInput.warnings` is
 * unconditionally passed `[]` at both call sites today — there is no live signal to key off, so
 * this is omitted rather than invented (see the RA-4 handoff report for the schema gap this
 * implies for `llmCostSummary.ts`'s actionable-critic count too).
 */
export function isAnomalousDecide(input: AnomalyCheckInput): boolean {
  const { baseDc, decisionLength, actionType } = input;
  if (baseDc < BASE_DC_ANOMALY_MIN || baseDc > BASE_DC_ANOMALY_MAX) return true;
  if (decisionLength === 0 && actionType !== 'combat') return true;
  return false;
}
