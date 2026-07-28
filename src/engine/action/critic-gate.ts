/**
 * RA-4c: the anomaly gate for the coherence critic (SL-3, measure-before-gate). Split into its
 * own module (rather than inlined in `PipelineActionStateMachine.ts`) because the owner expects
 * the trigger set to be tuned after the A/B numbers come back — a named, independently-testable
 * predicate is cheap to retune; logic buried in the two call sites is not.
 */

import type { ActionType } from '../../llm/pipeline/types.js';

/**
 * Selects WHICH beats the anomaly gate applies to.
 *
 * - `'always'` — gate nothing; the critic fires on every decide and every narrate beat. This was
 *   the behaviour before RA-4 and is retained as the A/B baseline arm.
 * - `'narrate-gated'` — **the default, per decision SL-3.** The decide critic fires
 *   unconditionally; only narrate beats are gated.
 * - `'anomaly'` — gate both beats.
 *
 * WHY `'narrate-gated'` is the default, from the RA-4 A/B (recorded in the Release A plan): the
 * decide critic earned 6 actionable catches across ~22 beats (~27%), so gating it measurably loses
 * real corrections — the anomaly triggers proved precise but insensitive, firing on 2 of ~22 beats
 * while the ungated arm found 6 catches, i.e. they do not predict what the critic objects to. The
 * narrate critic, by contrast, is near-inert *by construction*: `critiqueNarration` discards a
 * `major` verdict outright (dice and mutations are already finalized), so only a `minor` carrying a
 * `patch.outcomeText` can ever change anything — and the A/B saw zero `minor` verdicts across the
 * whole run, every narrate call paid for and inert. So this default keeps the half that works and
 * gates the half that structurally cannot.
 */
export type CriticGateMode = 'always' | 'narrate-gated' | 'anomaly';

/** Which authored beat is being critiqued — mirrors `CriticInput.beat`. */
export type CriticBeat = 'decision' | 'resolution';

/** Parses `CRITIC_GATE_MODE`. Shared by both entry points (`src/index.ts` and `src/agent/play.ts`)
 *  rather than duplicated: they must agree on the default, or an A/B arm selected for the harness
 *  would not match what prod would do with the same env. Anything unrecognised falls back to the
 *  SL-3 default rather than throwing — a typo'd env var must not take the bot down at boot. */
export function parseCriticGateMode(raw: string | undefined): CriticGateMode {
  return raw === 'always' || raw === 'anomaly' || raw === 'narrate-gated' ? raw : 'narrate-gated';
}

/**
 * Single decision point for "does the critic fire on this beat?", so the two call sites in
 * `PipelineActionStateMachine` can't drift apart on the mode semantics (they did not share a helper
 * in the first RA-4 cut, and the narrate site silently reused the decide predicate). Returns true
 * to spend an LLM critic call.
 *
 * Note the asymmetry is in the MODE, not the predicate: when a beat is gated at all, both beats use
 * `isAnomalousDecide` against the decide result — a narrate beat's coherence risk traces back to
 * how risky its authoring decide beat looked, which is the only anomaly signal available there.
 */
export function criticShouldFire(
  mode: CriticGateMode,
  beat: CriticBeat,
  input: AnomalyCheckInput,
): boolean {
  const gated = mode === 'anomaly' || (mode === 'narrate-gated' && beat === 'resolution');
  return gated ? isAnomalousDecide(input) : true;
}

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
  // MUST come before the band comparison. `baseDc` is `Number(raw.baseDc ?? raw.base_dc ?? 10)`
  // (`ProdPipelineGateway.ts:148`) with no validation, so a DECIDE beat that authored a
  // non-numeric value ("hard", "14-16", an object) yields NaN rather than a number. NaN fails
  // BOTH `< MIN` and `> MAX`, so without this guard the predicate would return false and the
  // gate would skip the critic on the single most malformed beat it could ever see — an
  // anomalous beat slipping through the anomaly gate, inverting the whole point.
  if (!Number.isFinite(baseDc)) return true;
  if (baseDc < BASE_DC_ANOMALY_MIN || baseDc > BASE_DC_ANOMALY_MAX) return true;
  if (decisionLength === 0 && actionType !== 'combat') return true;
  return false;
}
