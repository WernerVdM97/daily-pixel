/**
 * The anomaly gate for the coherence critic, its own module because the trigger set is expected to
 * be retuned: a named, independently-testable predicate is cheap to retune, logic in two call sites is not.
 */

import type { ActionType } from '../../llm/pipeline/types.js';

/**
 * `'always'` gates nothing, `'anomaly'` gates both beats, `'narrate-gated'` (the default) gates
 * narrate only: the decide critic earns its calls, while a `major` narrate verdict is discarded outright.
 */
export type CriticGateMode = 'always' | 'narrate-gated' | 'anomaly';

/** Which authored beat is being critiqued — mirrors `CriticInput.beat`. */
export type CriticBeat = 'decision' | 'resolution';

/** Parses `CRITIC_GATE_MODE`, shared by both entry points so an A/B arm selected for the harness
 *  matches what prod does with the same env. An unrecognised value falls back to the default: a typo'd env var must not take the bot down at boot. */
export function parseCriticGateMode(raw: string | undefined): CriticGateMode {
  return raw === 'always' || raw === 'anomaly' || raw === 'narrate-gated' ? raw : 'narrate-gated';
}

/**
 * Single decision point for "does the critic fire on this beat?", shared by the two call sites in
 * `PipelineActionStateMachine` so they cannot drift. The asymmetry is in the MODE: when a beat is gated at all, both test the decide result, since a narrate beat has no anomaly signal of its own.
 */
export function criticShouldFire(
  mode: CriticGateMode,
  beat: CriticBeat,
  input: AnomalyCheckInput,
): boolean {
  const gated = mode === 'anomaly' || (mode === 'narrate-gated' && beat === 'resolution');
  return gated ? isAnomalousDecide(input) : true;
}

/** The band on the raw authored `baseDc`: nothing clamps it — `accumulateDc` clamps the post-modifier DC,
 *  `validateDcModifier` only the ±5 delta — so it brackets an anchor, not an attempt difficulty, firing on miscalibrated tails alone. */
export const BASE_DC_ANOMALY_MIN = 5;
export const BASE_DC_ANOMALY_MAX = 25;

export interface AnomalyCheckInput {
  /** The decide result's raw authored `baseDc` (pre-modifier). */
  baseDc: number;
  /** `decideResult.decision.length` — checked raw, before `realOptions` filtering and the bail
   *  injection, matching where `critiqueDecide` is actually called. */
  decisionLength: number;
  actionType: ActionType;
}

/**
 * True when a decide beat looks risky enough to spend an LLM critic call on: an out-of-band `baseDc`,
 * or an empty `decision[]` on a non-combat beat.
 */
export function isAnomalousDecide(input: AnomalyCheckInput): boolean {
  const { baseDc, decisionLength, actionType } = input;
  // Deliberately not triggers: "exactly one option" (`validateSingleOption` re-decides that shape
  // with its own LLM call, so a critic call would stack on top) and parse warnings (no such field).

  // MUST come before the band tests: `baseDc` arrives unvalidated (`ProdPipelineGateway`'s coercion),
  // so a non-numeric authored value yields NaN, which fails BOTH `< MIN` and `> MAX`.
  if (!Number.isFinite(baseDc)) return true;
  if (baseDc < BASE_DC_ANOMALY_MIN || baseDc > BASE_DC_ANOMALY_MAX) return true;
  if (decisionLength === 0 && actionType !== 'combat') return true;
  return false;
}
