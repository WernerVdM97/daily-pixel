#!/usr/bin/env node
// T1 — sim calibration harness (docs/engine/T1-combat-calibration.md): a reproducible,
// seeded multi-fight sweep across player-strength x baseDc, recording the scale-neutral
// (`scale = 1`) win/loss/floor-save/rounds/reward curves that back the v11->v12 cutover's
// balance-defensibility record. Does NOT tune combat-dc.ts's constants — that verdict is the
// lead's call (see the note's `## Verdict` section).
//
// `npm run calibrate` — runs the full 9-config grid and writes combat-calibration.json
// beside this script (mirrors run.ts's convention of writing results next to the driver).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from './driver.js';
import type { CharacterSeed, PipelineScript, Scenario } from './types.js';

/** Fights per (physical, baseDc) config. Bump for a tighter curve; kept as a top-level
 *  const so re-running at a different sample size is a one-line change. */
const N = 300;

const PHYSICAL_VALUES = [2, 5, 8] as const;
const BASE_DC_VALUES = [8, 12, 16] as const;

/** Mirrors `combatScript` in combat-scenario.ts (T5's proven shape) — not imported because
 *  that module's copy is a private helper (unexported), and the scope fence here is
 *  "don't touch existing scenarios," not "never reuse their shape." */
function combatScript(baseDc: number): PipelineScript {
  return {
    decide: (_input, callNo) => ({
      distilledType: 'combat',
      stat: 'physical',
      baseDc,
      required: true,
      decision: [{ label: 'Press the attack', dcModifier: 0 }],
      ...(callNo === 0 ? { combatEnemy: { name: 'Goblin', anchor: 'location' as const } } : {}),
    }),
    resolveMutate: () => ({ mutations: [{ type: 'modify_wealth', amount: 1 }] }),
    resolveNarrate: () => ({ outcomeText: 'The goblin falls.' }),
  };
}

/** Fresh full-HP warrior at the config's `physical` stat — same shape as combat-scenario.ts's
 *  `BASE_CHARACTER`, duplicated here because that const isn't exported. */
function buildCharacter(physical: number): CharacterSeed {
  return {
    class: 'Warrior',
    stats: { physical, wisdom: 0, intelligence: 0, charisma: 0 },
    health: 10,
    maxHealth: 10,
    stamina: 10,
    maxStamina: 10,
    wealth: 0,
    location: "The Warden's Oak",
    alignment: 'lawful good',
    dayJob: 'Blacksmith',
  };
}

interface ConfigResult {
  physical: number;
  baseDc: number;
  winRate: number;
  lossRate: number;
  floorSaveRate: number;
  meanRounds: number;
  meanReward: number;
}

/**
 * Runs N fresh, independent fights for one (physical, baseDc) config and aggregates
 * `SimResult.combatMetrics`. One fight = one scenario run (HP carries across turns with no
 * regen in the pipeline-sim path, so N separate runs — never N fights packed into one
 * scenario's week). Each fight's roll source is `{ kind: 'seeded', seed: fightIndex + 1 }` —
 * deterministic and reproducible, never Math.random.
 */
async function runConfig(physical: number, baseDc: number): Promise<ConfigResult> {
  let wins = 0;
  let losses = 0;
  let floorSaveFights = 0;
  let totalRounds = 0;
  let totalReward = 0;

  for (let fightIndex = 0; fightIndex < N; fightIndex++) {
    const seed = fightIndex + 1;
    const scenario: Scenario = {
      name: `calibrate-p${physical}-dc${baseDc}-${seed}`,
      character: buildCharacter(physical),
      rollSource: { kind: 'seeded', seed },
      llm: { kind: 'pipeline-scripted', script: combatScript(baseDc) },
      machine: 'pipeline',
      week: [[{ input: 'attack the goblin', choicePolicy: 'first-real' }]],
    };

    const result = await runScenario(scenario);
    const metrics = result.combatMetrics;
    if (!metrics) {
      throw new Error(`calibrate-combat: scenario "${scenario.name}" produced no combatMetrics`);
    }

    wins += metrics.wins;
    losses += metrics.losses;
    if (metrics.floorSaves > 0) floorSaveFights += 1;
    totalRounds += metrics.roundsFought;
    // Exactly one TurnTrace per fight (one action, one 'attack the goblin' turn) — see
    // pipeline-sim.test.ts's combatWin/Floor/Cap end-to-end assertions.
    totalReward += result.turns[result.turns.length - 1].wealth;
  }

  return {
    physical,
    baseDc,
    winRate: wins / N,
    lossRate: losses / N,
    floorSaveRate: floorSaveFights / N,
    meanRounds: totalRounds / N,
    meanReward: totalReward / N,
  };
}

function renderTable(rows: ConfigResult[]): string {
  const header =
    'physical | baseDc | winRate | lossRate | floorSaveRate | meanRounds | meanReward';
  const sep =
    '---------|--------|---------|----------|---------------|------------|------------';
  const lines = rows.map((r) => {
    const winRate = `${(r.winRate * 100).toFixed(1)}%`;
    const lossRate = `${(r.lossRate * 100).toFixed(1)}%`;
    const floorSaveRate = `${(r.floorSaveRate * 100).toFixed(1)}%`;
    return (
      `${String(r.physical).padStart(8)} | ${String(r.baseDc).padStart(6)} | ` +
      `${winRate.padStart(7)} | ${lossRate.padStart(8)} | ${floorSaveRate.padStart(13)} | ` +
      `${r.meanRounds.toFixed(2).padStart(10)} | ${r.meanReward.toFixed(3).padStart(10)}`
    );
  });
  return [header, sep, ...lines].join('\n');
}

async function main(): Promise<void> {
  const results: ConfigResult[] = [];
  for (const physical of PHYSICAL_VALUES) {
    for (const baseDc of BASE_DC_VALUES) {
      results.push(await runConfig(physical, baseDc));
    }
  }

  console.log(`Combat calibration — N=${N} fights/config, seeded rollSource, scale=1\n`);
  console.log(renderTable(results));

  const outDir = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.join(outDir, 'combat-calibration.json');
  writeFileSync(outPath, JSON.stringify({ n: N, results }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error('calibrate-combat failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
