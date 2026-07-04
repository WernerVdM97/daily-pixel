/**
 * Sim harness Task 3 — time advancement. `advanceDays` drives the engine's own daily tick
 * (WorldEngineImpl.ts:1543) so a scenario can span N weeks and exercise the roll economy.
 *
 * [!] Pinned to a Monday: the tick's Saturday bonus-roll reads the real (faked) wall clock,
 * so a Saturday pin would perturb the rollsRemaining expectations below.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDb } from '../../src/db/connection.js';
import { buildSimEngine } from '../../src/sim/engine-factory.js';
import { advanceDays, currentDayNumber } from '../../src/sim/time.js';
import { runScenario } from '../../src/sim/driver.js';
import type { CharacterSeed, DecisionScript, Scenario } from '../../src/sim/types.js';

const noopScript: DecisionScript = () => ({
  distilledType: 'noop',
  stat: 'physical',
  baseDc: 10,
  required: false,
  done: true,
  decision: [],
});

/** A single real choice, then a resolution — same shape as driver.test.ts's huntScript. */
function huntScript(): DecisionScript {
  return (ctx) => {
    if (!ctx.previousDecisions || ctx.previousDecisions.length === 0) {
      return {
        prompt: 'A wolf circles in the gloom.',
        distilledType: 'hunt',
        stat: 'physical',
        baseDc: 12,
        required: false,
        done: false,
        decision: [
          { label: 'Press the attack', dcModifier: 0 },
          { label: 'Circle around', dcModifier: 1 },
          { label: 'Bail', dcModifier: null },
        ],
      };
    }
    return {
      prompt: '',
      distilledType: 'hunt',
      stat: 'physical',
      baseDc: 12,
      required: false,
      done: true,
      decision: [{ label: 'Finish it', dcModifier: 0 }],
      mutations: [],
      outcomeText: 'Your blade finds its mark.',
    };
  };
}

const BASE_CHARACTER: CharacterSeed = {
  class: 'Warrior',
  stats: { physical: 5, wisdom: 0, intelligence: 0, charisma: 0 },
  health: 10,
  maxHealth: 10,
  stamina: 10,
  maxStamina: 10,
  wealth: 0,
  location: "The Warden's Oak",
  alignment: 'lawful good',
  dayJob: 'Blacksmith',
};

describe('sim time — advanceDays', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z')); // Monday
  });

  afterEach(() => {
    closeDb();
    vi.useRealTimers();
  });

  it('advances day_number by n and refills rolls_remaining to the daily allowance', () => {
    const { engine, charRepo } = buildSimEngine({ kind: 'fixed', value: 15 }, noopScript);
    const char = engine.createCharacter('sim-time-user', {
      name: 'Timey',
      class: 'Warrior',
      upbringing: 'Sim',
      race: 'Sim',
      alignment: 'neutral',
      dayJob: 'Blacksmith',
    });
    charRepo.update(char.id, { rolls_remaining: 0 }); // simulate an exhausted day

    expect(currentDayNumber(engine)).toBe(1);
    advanceDays(engine, 7);
    expect(currentDayNumber(engine)).toBe(8);

    const after = engine.getCharacter('sim-time-user')!;
    expect(after.rollsRemaining).toBe(3); // DAILY_ROLL_ALLOWANCE, non-Saturday
  });
});

describe('sim time — weeks-spanning scenario', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z')); // Monday
  });

  afterEach(() => {
    closeDb();
    vi.useRealTimers();
  });

  function weeklyScenario(weeks: number): Scenario {
    return {
      name: 'grind',
      character: BASE_CHARACTER,
      rollSource: { kind: 'fixed', value: 20 },
      llm: { kind: 'scripted', script: huntScript() },
      // A full 7-day week, each day exactly DAILY_ROLL_ALLOWANCE (3) turns — each day's tick
      // refills the pool before the next day's routine runs, so a multi-week span never
      // exhausts mid-week.
      week: Array.from({ length: 7 }, () => [
        { input: 'hunt', choicePolicy: 'first-real' as const },
        { input: 'hunt', choicePolicy: 'first-real' as const },
        { input: 'hunt', choicePolicy: 'first-real' as const },
      ]),
      weeks,
    };
  }

  it('runs turns across the full span, tagging each TurnTrace with its game day', async () => {
    const result = await runScenario(weeklyScenario(2));

    expect(result.turns).toHaveLength(2 * 7 * 3); // 2 weeks * 7 days * 3 turns/day
    expect(result.turns.every((t) => t.outcome === 'success')).toBe(true);

    // Day tag climbs 1..14, three turns per day.
    expect(result.turns[0].day).toBe(1);
    expect(result.turns[2].day).toBe(1);
    expect(result.turns[3].day).toBe(2);
    expect(result.turns.at(-1)!.day).toBe(14);
  });

  it('never runs out of rolls mid-week — each day fully refills before its routine runs', async () => {
    const result = await runScenario(weeklyScenario(2));

    // rollsRemaining drains 3 -> 2 -> 1 -> 0 across each day's 3 turns, then refills to 3
    // at the start of the next day. It must never go negative or leave a turn unresolved.
    for (const t of result.turns) {
      expect(t.rollsRemaining).toBeGreaterThanOrEqual(0);
    }
    const lastOfDay1 = result.turns[2];
    const firstOfDay2 = result.turns[3];
    expect(lastOfDay1.rollsRemaining).toBe(0);
    expect(firstOfDay2.rollsRemaining).toBe(2); // day 2 started at 3, this turn drained 1
  });
});
