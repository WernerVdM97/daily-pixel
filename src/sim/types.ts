// Stage 0a sim harness — shared contracts (docs/engine/stage-0a-sim-harness-plan.md).
//
// This is an offline replay tool, not a game sim: it drives the real WorldEngineImpl
// through a scripted character with a mocked LLM and a scripted/seeded d20, so the
// balance curves (roll success rate, resource drain, reward gain) are observable
// before Thread B/C tuning happens blind.
import type { LlmContext, LlmDecision } from '../llm/LlmGateway.js';

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

export interface Scenario {
  name: string;
  character: CharacterSeed;
  rollSource: RollSource;
  llm: { kind: 'scripted'; script: DecisionScript };
  turns: TurnScript[];
  /** Consumed by the time module (T3): spans the scenario across N weeks of ticks. */
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

export interface SimResult {
  scenario: string;
  turns: TurnTrace[];
}
