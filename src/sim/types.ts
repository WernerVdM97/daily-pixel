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
  llm: { kind: 'scripted'; script: DecisionScript };
  /**
   * The week's routine — one DayScript per day (1..7 entries). The driver walks each day in
   * order, ticking a game day between days, then repeats the whole week `weeks` times. A week
   * is an explicit sequence of (possibly distinct) days, not one day repeated: this is what
   * lets a scenario mix e.g. grind days, a market day, and a rest day.
   */
  week: DayScript[];
  /** How many times to repeat `week`. Consumed by the time module (T3). Defaults to 1. */
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
