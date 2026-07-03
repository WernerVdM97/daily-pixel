import { readFileSync } from 'node:fs';
import { STATS } from '../assets/asset-schemas.js';
import type { LlmDecision } from '../llm/LlmGateway.js';
import type { CharacterSeed, DayScript, DecisionScript, RollSource, Scenario } from './types.js';

/**
 * JSON-serializable scenario shape (T4). A JSON file can't carry the `DecisionScript`
 * function T1's `Scenario` needs, so this inlines a canned `LlmDecision` list instead;
 * `parseScenario` adapts it into a `DecisionScript` (see `adaptDecisions` below).
 */
export interface ScenarioFile {
  name: string;
  character: CharacterSeed;
  rollSource: RollSource;
  decisions: LlmDecision[];
  week: DayScript[];
  weeks?: number;
}

export class ScenarioLoadError extends Error {
  constructor(
    public readonly source: string,
    public readonly problems: string[],
  ) {
    super(`Scenario load failed for ${source}:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ScenarioLoadError';
  }
}

// ── primitives (mirrors src/assets/asset-schemas.ts's style; its own guards are
//    module-private, so re-declared here rather than editing that file out of scope) ──

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function validateCharacterSeed(v: unknown, errs: string[]): void {
  if (!isRecord(v)) {
    errs.push('"character" must be an object');
    return;
  }
  if (!isNonEmptyString(v.class)) errs.push('character.class must be a non-empty string');

  if (!isRecord(v.stats)) {
    errs.push('character.stats must be an object');
  } else {
    for (const s of STATS) {
      if (!isFiniteNumber(v.stats[s])) errs.push(`character.stats.${s} must be a number`);
    }
  }

  for (const key of ['health', 'maxHealth', 'stamina', 'maxStamina', 'wealth'] as const) {
    if (!isFiniteNumber(v[key])) errs.push(`character.${key} must be a number`);
  }
  if (!isNonEmptyString(v.location)) errs.push('character.location must be a non-empty string');
  if (!isNonEmptyString(v.alignment)) errs.push('character.alignment must be a non-empty string');
  if (!isNonEmptyString(v.dayJob)) errs.push('character.dayJob must be a non-empty string');
}

function validateRollSource(v: unknown, errs: string[]): void {
  if (!isRecord(v)) {
    errs.push('"rollSource" must be an object');
    return;
  }
  switch (v.kind) {
    case 'fixed':
      if (!isFiniteNumber(v.value)) errs.push('rollSource.value must be a number for kind "fixed"');
      break;
    case 'sequence':
      if (!Array.isArray(v.values) || v.values.length === 0 || !v.values.every(isFiniteNumber)) {
        errs.push('rollSource.values must be a non-empty array of numbers for kind "sequence"');
      }
      break;
    case 'seeded':
      if (!isFiniteNumber(v.seed)) errs.push('rollSource.seed must be a number for kind "seeded"');
      break;
    default:
      errs.push(`rollSource.kind must be one of fixed|sequence|seeded (got ${JSON.stringify(v.kind)})`);
  }
}

function validateDecisionOption(v: unknown, path: string, errs: string[]): void {
  if (!isRecord(v)) {
    errs.push(`${path} must be an object`);
    return;
  }
  if (!isNonEmptyString(v.label)) errs.push(`${path}.label must be a non-empty string`);
  if (v.dcModifier !== null && !isFiniteNumber(v.dcModifier)) {
    errs.push(`${path}.dcModifier must be a number or null`);
  }
}

function validateDecision(v: unknown, path: string, errs: string[]): void {
  if (!isRecord(v)) {
    errs.push(`${path} must be an object`);
    return;
  }
  if (!isNonEmptyString(v.distilledType)) errs.push(`${path}.distilledType must be a non-empty string`);
  if (!(STATS as readonly string[]).includes(v.stat as string)) {
    errs.push(`${path}.stat must be one of ${STATS.join('|')} (got ${JSON.stringify(v.stat)})`);
  }
  if (!isFiniteNumber(v.baseDc)) errs.push(`${path}.baseDc must be a number`);
  if (!isBoolean(v.required)) errs.push(`${path}.required must be a boolean`);
  if (!isBoolean(v.done)) errs.push(`${path}.done must be a boolean`);
  if (!Array.isArray(v.decision)) {
    errs.push(`${path}.decision must be an array`);
  } else {
    v.decision.forEach((opt, i) => validateDecisionOption(opt, `${path}.decision[${i}]`, errs));
  }
}

function validateChoicePolicy(v: unknown, path: string, errs: string[]): void {
  if (typeof v === 'string') {
    if (!['first-real', 'highest-dc', 'lowest-dc', 'bail'].includes(v)) {
      errs.push(`${path} must be one of first-real|highest-dc|lowest-dc|bail or {"index": n} (got "${v}")`);
    }
    return;
  }
  if (isRecord(v) && isFiniteNumber(v.index)) return;
  errs.push(`${path} must be one of first-real|highest-dc|lowest-dc|bail or {"index": n}`);
}

function validateTurn(v: unknown, path: string, errs: string[]): void {
  if (!isRecord(v)) {
    errs.push(`${path} must be an object`);
    return;
  }
  if (!isNonEmptyString(v.input)) errs.push(`${path}.input must be a non-empty string`);
  validateChoicePolicy(v.choicePolicy, `${path}.choicePolicy`, errs);
}

/** A week is 1..7 days; each day is an array of turns (empty = a rest day, clock still ticks). */
function validateWeek(v: unknown, errs: string[]): void {
  if (!Array.isArray(v) || v.length === 0) {
    errs.push('"week" must be a non-empty array of days (each day an array of turns)');
    return;
  }
  if (v.length > 7) errs.push(`"week" must have at most 7 days (got ${v.length}); use "weeks" > 1 to span multiple weeks`);
  v.forEach((day, d) => {
    if (!Array.isArray(day)) {
      errs.push(`week[${d}] must be an array of turns (use [] for a rest day)`);
      return;
    }
    day.forEach((t, i) => validateTurn(t, `week[${d}][${i}]`, errs));
  });
}

function validateScenarioFile(v: unknown): string[] {
  if (!isRecord(v)) return ['scenario must be a JSON object'];

  const errs: string[] = [];
  if (!isNonEmptyString(v.name)) errs.push('"name" must be a non-empty string');
  validateCharacterSeed(v.character, errs);
  validateRollSource(v.rollSource, errs);

  if (!Array.isArray(v.decisions) || v.decisions.length === 0) {
    errs.push('"decisions" must be a non-empty array of LlmDecision');
  } else {
    v.decisions.forEach((d, i) => validateDecision(d, `decisions[${i}]`, errs));
  }

  validateWeek(v.week, errs);

  if (v.weeks !== undefined && (!isFiniteNumber(v.weeks) || !Number.isInteger(v.weeks) || v.weeks < 1)) {
    errs.push('"weeks" must be a positive integer when present');
  }

  return errs;
}

/**
 * Adapt the canned `decisions` list into a `DecisionScript`. Indexed by
 * `ctx.previousDecisions.length` — which resets to 0 at the start of every action — rather
 * than the raw decide()-call count, so the SAME short list replays identically for every
 * turn and every repeated day (a `weeks`-spanning scenario re-runs the `week` routine once
 * per repeat). `decisions[0]` is the opening beat; the last entry is reused for every call after,
 * matching the "one canned decision serves both the decision and narration call" convention
 * MockLlmGateway already establishes (tests/engine/decision-pipeline.test.ts).
 */
function adaptDecisions(decisions: LlmDecision[]): DecisionScript {
  return (ctx) => {
    const idx = Math.min(ctx.previousDecisions?.length ?? 0, decisions.length - 1);
    return decisions[idx];
  };
}

function toScenario(file: ScenarioFile): Scenario {
  return {
    name: file.name,
    character: file.character,
    rollSource: file.rollSource,
    llm: { kind: 'scripted', script: adaptDecisions(file.decisions) },
    week: file.week,
    weeks: file.weeks,
  };
}

/** Validate + adapt a parsed JSON value into a runnable Scenario. Throws ScenarioLoadError
 *  (never silently coerces) on any structural problem. */
export function parseScenario(raw: unknown, source = '<scenario>'): Scenario {
  const problems = validateScenarioFile(raw);
  if (problems.length > 0) throw new ScenarioLoadError(source, problems);
  return toScenario(raw as ScenarioFile);
}

export function loadScenarioFile(path: string): Scenario {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new ScenarioLoadError(path, [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`]);
  }
  return parseScenario(raw, path);
}
