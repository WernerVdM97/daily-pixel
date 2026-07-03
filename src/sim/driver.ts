import type Database from 'better-sqlite3';
import type { WorldEngineImpl } from '../engine/WorldEngineImpl.js';
import type { ActionOption, ActionOutcome } from '../engine/WorldEngine.js';
import { buildSimEngine } from './engine-factory.js';
import { advanceDays, currentDayNumber } from './time.js';
import type { CharacterSeed, ChoicePolicy, Scenario, SimResult, TurnScript, TurnTrace } from './types.js';

/**
 * `createCharacter` (WorldEngineImpl.ts) only takes class/upbringing/race/alignment/dayJob —
 * stats/health/stamina/wealth/location are derived (computeStats + fixed defaults), not
 * settable at creation. The sim needs a scenario to pin exact starting numbers so curves are
 * reproducible, so this patches the row directly after creation. Raw SQL (not charRepo.update)
 * because CharacterRepository's allow-list omits `max_stamina` — a pre-existing gap in the repo,
 * out of scope to fix here.
 */
function applySeedOverrides(db: Database.Database, characterId: number, seed: CharacterSeed): void {
  db.prepare(
    `UPDATE player_characters
        SET stats = ?, health = ?, max_health = ?, stamina = ?, max_stamina = ?, wealth = ?, location = ?
      WHERE id = ?`,
  ).run(
    JSON.stringify(seed.stats),
    seed.health,
    seed.maxHealth,
    seed.stamina,
    seed.maxStamina,
    seed.wealth,
    seed.location,
    characterId,
  );
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
 *  applying the same choice policy at every beat, until the action resolves. */
async function runTurn(
  engine: WorldEngineImpl,
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
 * Run a scenario end-to-end against a fresh in-memory WorldEngineImpl: seed the character,
 * then drive every turn's input through startAction/stepAction to resolution. No network
 * call and no Math.random — the roll is fully determined by `scenario.rollSource`.
 *
 * `scenario.week` is an explicit sequence of day routines (one DayScript per day). The driver
 * walks each day in order, then repeats the whole week `weeks` times (default 1), ticking
 * (advanceDays) between every day so the roll allowance actually refills and resources
 * regen/drain — the roll economy this exists to exercise, not just a single day's snapshot.
 * A day whose DayScript is empty is a rest day: the clock ticks but no turn is driven.
 */
export async function runScenario(scenario: Scenario): Promise<SimResult> {
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
