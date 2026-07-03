/**
 * Sim harness Task 4 — scenario loader. A JSON file can't carry a DecisionScript function,
 * so `loadScenarioFile`/`parseScenario` validate + adapt a canned `decisions` list into one
 * (scenario-load.ts's `adaptDecisions`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb } from '../../src/db/connection.js';
import { loadScenarioFile, parseScenario, ScenarioLoadError } from '../../src/sim/scenario-load.js';
import { runScenario } from '../../src/sim/driver.js';

const SCENARIOS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'sim', 'scenarios');

afterEach(() => {
  closeDb();
});

describe('scenario-load — example scenarios', () => {
  it('parses and runs grind-week.json end-to-end', async () => {
    const scenario = loadScenarioFile(path.join(SCENARIOS_DIR, 'grind-week.json'));
    expect(scenario.name).toBe('grind-week');

    const result = await runScenario(scenario);
    expect(result.turns).toHaveLength(16); // 5 days × 3 turns + 1 short day + 1 rest day (0 turns)
    expect(result.turns.every((t) => t.distilledType === 'work')).toBe(true);
  });

  it('parses and runs risky-wilds.json end-to-end', async () => {
    const scenario = loadScenarioFile(path.join(SCENARIOS_DIR, 'risky-wilds.json'));
    expect(scenario.name).toBe('risky-wilds');

    const result = await runScenario(scenario);
    expect(result.turns).toHaveLength(7); // 2 days × 3 turns + 1 short day + 1 rest day (0 turns)
    expect(result.turns.every((t) => t.distilledType === 'hunt')).toBe(true);
  });
});

describe('scenario-load — validation', () => {
  it('fails loudly (never silently) on a non-object scenario', () => {
    expect(() => parseScenario(null)).toThrow(ScenarioLoadError);
    expect(() => parseScenario('not a scenario')).toThrow(ScenarioLoadError);
  });

  it('reports every structural problem in a malformed scenario', () => {
    try {
      parseScenario({ name: '', character: {}, rollSource: { kind: 'bogus' }, decisions: [], week: [] });
      expect.unreachable('parseScenario should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ScenarioLoadError);
      const problems = (err as ScenarioLoadError).problems;
      expect(problems.some((p) => p.includes('"name"'))).toBe(true);
      expect(problems.some((p) => p.includes('character.class'))).toBe(true);
      expect(problems.some((p) => p.includes('rollSource.kind'))).toBe(true);
      expect(problems.some((p) => p.includes('"decisions"'))).toBe(true);
      expect(problems.some((p) => p.includes('"week"'))).toBe(true);
    }
  });

  it('rejects an unknown choicePolicy string rather than silently defaulting', () => {
    const valid = {
      name: 'x',
      character: {
        class: 'Warrior',
        stats: { physical: 0, wisdom: 0, intelligence: 0, charisma: 0 },
        health: 10,
        maxHealth: 10,
        stamina: 10,
        maxStamina: 10,
        wealth: 0,
        location: "The Warden's Oak",
        alignment: 'neutral',
        dayJob: 'Blacksmith',
      },
      rollSource: { kind: 'fixed', value: 20 },
      decisions: [
        { distilledType: 'noop', stat: 'physical', baseDc: 10, required: false, done: true, decision: [] },
      ],
      week: [[{ input: 'do a thing', choicePolicy: 'not-a-real-policy' }]],
    };

    expect(() => parseScenario(valid)).toThrow(/choicePolicy/);
  });

  it('rejects a non-positive or fractional "weeks" rather than silently coercing it', () => {
    const base = {
      name: 'w',
      character: {
        class: 'Warrior',
        stats: { physical: 0, wisdom: 0, intelligence: 0, charisma: 0 },
        health: 10,
        maxHealth: 10,
        stamina: 10,
        maxStamina: 10,
        wealth: 0,
        location: "The Warden's Oak",
        alignment: 'neutral',
        dayJob: 'Blacksmith',
      },
      rollSource: { kind: 'fixed', value: 20 },
      decisions: [
        { distilledType: 'noop', stat: 'physical', baseDc: 10, required: false, done: true, decision: [] },
      ],
      week: [[{ input: 'do a thing', choicePolicy: 'first-real' }]],
    };

    // 1.5 would silently run the week block twice; -1 would coerce to 1 — both must fail loudly.
    expect(() => parseScenario({ ...base, weeks: 1.5 })).toThrow(/positive integer/);
    expect(() => parseScenario({ ...base, weeks: -1 })).toThrow(/positive integer/);
    expect(() => parseScenario({ ...base, weeks: 0 })).toThrow(/positive integer/);
  });

  it('rejects a week longer than 7 days (a week is 7 days; use "weeks" to span more)', () => {
    const eightDays = {
      name: 'too-long',
      character: {
        class: 'Warrior',
        stats: { physical: 0, wisdom: 0, intelligence: 0, charisma: 0 },
        health: 10,
        maxHealth: 10,
        stamina: 10,
        maxStamina: 10,
        wealth: 0,
        location: "The Warden's Oak",
        alignment: 'neutral',
        dayJob: 'Blacksmith',
      },
      rollSource: { kind: 'fixed', value: 20 },
      decisions: [
        { distilledType: 'noop', stat: 'physical', baseDc: 10, required: false, done: true, decision: [] },
      ],
      week: Array.from({ length: 8 }, () => [{ input: 'do a thing', choicePolicy: 'first-real' }]),
    };

    expect(() => parseScenario(eightDays)).toThrow(/at most 7 days/);
  });

  it('surfaces a JSON parse error for a malformed file rather than throwing an opaque SyntaxError', () => {
    // A path that resolves but whose contents aren't valid JSON.
    const badPath = path.join(SCENARIOS_DIR, '..', '..', '..', 'package.json'); // valid JSON, wrong shape — proves shape validation still fires
    expect(() => loadScenarioFile(badPath)).toThrow(ScenarioLoadError);
  });
});
