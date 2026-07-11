import type Database from 'better-sqlite3';
import { CharacterRepository } from '../db/repositories/character.js';
import type { ActionOption, ActionOutcome } from '../engine/WorldEngine.js';
import { buildSimEngine } from './engine-factory.js';
import { advanceDays, currentDayNumber } from './time.js';
import type {
  CharacterSeed,
  ChoicePolicy,
  ComparisonScenario,
  Scenario,
  SimEngine,
  SimResult,
  TurnScript,
  TurnTrace,
} from './types.js';

/**
 * `createCharacter` (WorldEngineImpl.ts) only takes class/upbringing/race/alignment/dayJob —
 * stats/health/stamina/wealth/location are derived (computeStats + fixed defaults), not
 * settable at creation. The sim needs a scenario to pin exact starting numbers so curves are
 * reproducible, so this patches the row directly after creation.
 */
function applySeedOverrides(db: Database.Database, characterId: number, seed: CharacterSeed): void {
  new CharacterRepository(db).update(characterId, {
    stats: JSON.stringify(seed.stats),
    health: seed.health,
    max_health: seed.maxHealth,
    stamina: seed.stamina,
    max_stamina: seed.maxStamina,
    wealth: seed.wealth,
    location: seed.location,
  });
}

/** Pick a label from the presented options per the turn's ChoicePolicy. Throws (rather than
 *  guessing) when the policy can't be satisfied — a scenario author bug should fail loudly,
 *  not silently skew the curve. */
function pickChoice(options: ActionOption[], policy: ChoicePolicy): string {
  if (typeof policy === 'object') {
    const opt = options[policy.index];
    if (!opt) {
      throw new Error(`sim: choicePolicy index ${policy.index} out of range (${options.length} option(s))`);
    }
    return opt.label;
  }

  const real = options.filter((o) => o.dcModifier !== null);
  const bail = options.find((o) => o.dcModifier === null);

  switch (policy) {
    case 'bail':
      if (!bail) throw new Error('sim: choicePolicy "bail" but no bail option was presented');
      return bail.label;
    case 'first-real':
      if (real.length === 0) throw new Error('sim: choicePolicy "first-real" but no real options were presented');
      return real[0].label;
    case 'highest-dc':
      if (real.length === 0) throw new Error('sim: choicePolicy "highest-dc" but no real options were presented');
      return real.reduce((a, b) => (b.dcModifier! > a.dcModifier! ? b : a)).label;
    case 'lowest-dc':
      if (real.length === 0) throw new Error('sim: choicePolicy "lowest-dc" but no real options were presented');
      return real.reduce((a, b) => (b.dcModifier! < a.dcModifier! ? b : a)).label;
  }
}

/** Drive one turn to resolution: startAction, then stepAction repeatedly (a beat may take up
 *  to two steps — the machine forces resolution on the third decision, machine.ts:238)
 *  applying the same choice policy at every beat, until the action resolves.
 *
 *  Typed against the narrow `SimEngine` interface (not `WorldEngineImpl` directly) so this
 *  function is machine-agnostic (Task 4): `WorldEngineImpl` and `PipelineSimEngine` both
 *  satisfy it structurally, and only the caller's engine construction picks which one runs. */
async function runTurn(
  engine: SimEngine,
  characterId: number,
  discordUserId: string,
  index: number,
  turn: TurnScript,
  day: number,
): Promise<TurnTrace> {
  const start = await engine.startAction(characterId, turn.input);

  let outcome: ActionOutcome;
  if (start.outcome) {
    // Auto-finished (e.g. a no-op/rest): the LLM resolved outright, no buttons to press.
    outcome = start.outcome;
  } else {
    let options = start.firstDecision.options;
    for (;;) {
      const choice = pickChoice(options, turn.choicePolicy);
      const step = await engine.stepAction(characterId, choice);
      if (step.resolved) {
        outcome = step.outcome;
        break;
      }
      options = step.nextDecision.options;
    }
  }

  const char = engine.getCharacter(discordUserId)!;
  const items = engine.getItems(characterId);

  return {
    index,
    input: turn.input,
    distilledType: outcome.distilledType,
    finalDc: outcome.finalDc,
    playerRolled: outcome.playerRolled,
    rollBonus: outcome.rollBonus ?? null,
    outcome: outcome.outcome,
    health: char.health,
    stamina: char.stamina,
    wealth: char.wealth,
    rollsRemaining: char.rollsRemaining,
    itemCount: items.length,
    mutationsApplied: outcome.mutations.length,
    day,
  };
}

/**
 * Run a scenario end-to-end: seed the character, then drive every turn's input through
 * startAction/stepAction to resolution. No network call and no Math.random — the roll is fully
 * determined by `scenario.rollSource`.
 *
 * `scenario.machine` (Task 4) picks which state machine drives it: 'legacy' (default, this
 * function's body below) against a fresh in-memory `WorldEngineImpl`, or 'pipeline' — delegated
 * to `runPipelineScenario` below — against the in-memory `PipelineSimEngine` adapter. Every
 * existing scenario (JSON fixtures, prior tests) omits `machine` entirely and is unaffected.
 *
 * `scenario.week` is an explicit sequence of day routines (one DayScript per day). The legacy
 * path walks each day in order, then repeats the whole week `weeks` times (default 1), ticking
 * (advanceDays) between every day so the roll allowance actually refills and resources
 * regen/drain — the roll economy this exists to exercise, not just a single day's snapshot.
 * A day whose DayScript is empty is a rest day: the clock ticks but no turn is driven. (The
 * pipeline path walks the same week/weeks shape but never ticks a clock — see
 * `runPipelineScenario`'s doc comment.)
 */
export async function runScenario(scenario: Scenario): Promise<SimResult> {
  const machine = scenario.machine ?? 'legacy';

  if (machine === 'pipeline') {
    return runPipelineScenario(scenario);
  }

  if (scenario.llm.kind !== 'scripted') {
    throw new Error(
      `sim: scenario "${scenario.name}" has machine 'legacy' but llm.kind is "${scenario.llm.kind}" ` +
        '(expected "scripted") — a pipeline scenario needs machine: \'pipeline\' set too.',
    );
  }

  const { engine, db } = buildSimEngine(scenario.rollSource, scenario.llm.script);

  const discordUserId = `sim:${scenario.name}`;
  const char = engine.createCharacter(discordUserId, {
    name: `Sim ${scenario.character.class}`,
    class: scenario.character.class,
    upbringing: 'Sim',
    race: 'Sim',
    alignment: scenario.character.alignment,
    dayJob: scenario.character.dayJob,
  });
  applySeedOverrides(db, char.id, scenario.character);

  const weeks = scenario.weeks && scenario.weeks > 0 ? scenario.weeks : 1;
  const turns: TurnTrace[] = [];
  let globalIndex = 0;
  let firstDay = true;

  for (let week = 0; week < weeks; week++) {
    for (const dayScript of scenario.week) {
      // Tick between days (not before the very first day, and across week boundaries too).
      if (!firstDay) advanceDays(engine, 1);
      firstDay = false;

      const day = currentDayNumber(engine);
      for (const turnScript of dayScript) {
        turns.push(await runTurn(engine, char.id, discordUserId, globalIndex++, turnScript, day));
      }
    }
  }

  return { scenario: scenario.name, turns };
}

/**
 * The pipeline-machine counterpart to `runScenario`'s legacy body above. `runTurn` itself is
 * shared/unchanged (Task 4: the driver's per-turn code is machine-agnostic) — only engine
 * construction and the setup around it (character seeding, day bookkeeping) differ, because
 * `PipelineSimEngine` has no DB/repos and no `createCharacter`/`tick` to call.
 *
 * No day-tick economy here: `PipelineSimEngine` is pure in-memory (no `db`/`meta` row for
 * `advanceDays`/`currentDayNumber` to read/write), so `day` is a locally counted sequence
 * number rather than the engine's real `day_number`, and rolls never refill mid-scenario. This
 * is a deliberate Task 4 simplification (proving the pipeline machine runs mechanically through
 * the sim, not proving the day/roll economy in the pipeline path) — a `week`/`weeks` routine
 * that would exhaust `rollsRemaining` under the legacy machine's day-refill economy will throw
 * "No rolls remaining" here instead once the seeded allowance runs out.
 */
async function runPipelineScenario(scenario: Scenario): Promise<SimResult> {
  if (scenario.llm.kind !== 'pipeline-scripted') {
    throw new Error(
      `sim: scenario "${scenario.name}" has machine 'pipeline' but llm.kind is "${scenario.llm.kind}" ` +
        '(expected "pipeline-scripted") — a legacy DecisionScript can\'t drive the pipeline machine.',
    );
  }

  const discordUserId = `sim:${scenario.name}`;
  const { engine, llm } = buildSimEngine(scenario.rollSource, undefined, undefined, {
    machine: 'pipeline',
    script: scenario.llm.script,
    seed: scenario.character,
    discordUserId,
  });

  const char = engine.getCharacter(discordUserId)!;

  const weeks = scenario.weeks && scenario.weeks > 0 ? scenario.weeks : 1;
  const turns: TurnTrace[] = [];
  let globalIndex = 0;
  let day = 1;

  for (let week = 0; week < weeks; week++) {
    for (const dayScript of scenario.week) {
      for (const turnScript of dayScript) {
        turns.push(await runTurn(engine, char.id, discordUserId, globalIndex++, turnScript, day));
      }
      day++;
    }
  }

  // `llm.stageCalls` (Task 5) accumulates for the lifetime of this one PipelineScriptedGateway
  // instance, i.e. across the whole scenario (all weeks/turns) — matching `decideCallCount`'s
  // existing gateway-instance-global scoping (see PipelineScript's doc comment in types.ts).
  // `relationsPersisted` (Stage 2 T5c) is read once at scenario end from the engine's private
  // RelationRepository — a running total across every beat, so it demonstrates edges written on
  // earlier beats survive to the end of the run.
  return {
    scenario: scenario.name,
    turns,
    stageCalls: llm.stageCalls,
    relationsPersisted: engine.getPersistedRelationCount(),
    combatMetrics: engine.getCombatMetrics(),
  };
}

/**
 * Runs the SAME scenario (character seed, roll source, week routine) through both machines and
 * returns both `SimResult`s side by side, so a human can eyeball legacy vs pipeline metrics for
 * an equivalent scenario (Task 4's comparison mode / `--compare` CLI flag, see run.ts).
 *
 * Deliberately takes a `ComparisonScenario` (one script per machine) rather than a single
 * `Scenario` — decide's shape differs and resolve is split in two between the machines, so a
 * legacy `DecisionScript` and a `PipelineScript` are never equivalent or auto-derivable from one
 * another (Task 4 spec: do NOT try). The two scripts are expected to be hand-authored to express
 * "the same" turn-by-turn behaviour for a given scenario, not literally shared code.
 */
export async function runComparison(
  scenario: ComparisonScenario,
): Promise<{ legacy: SimResult; pipeline: SimResult }> {
  const { name, character, rollSource, week, weeks, legacyScript, pipelineScript } = scenario;

  const legacy = await runScenario({
    name,
    character,
    rollSource,
    week,
    weeks,
    llm: { kind: 'scripted', script: legacyScript },
    machine: 'legacy',
  });

  const pipeline = await runScenario({
    name,
    character,
    rollSource,
    week,
    weeks,
    llm: { kind: 'pipeline-scripted', script: pipelineScript },
    machine: 'pipeline',
  });

  return { legacy, pipeline };
}
