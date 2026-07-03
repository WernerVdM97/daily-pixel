#!/usr/bin/env node
// CLI entry — `npm run sim -- <scenario.json>`. Reads a scenario file, drives it through
// runScenario, prints the summary table, and writes `<name>.result.json` + `<name>.csv`
// next to the input file.
//
// `npm run sim -- --compare` (Task 4) instead drives the built-in example comparison scenario
// through BOTH machines (legacy vs pipeline) and prints both summary tables side by side, so a
// human can eyeball the metrics. It intentionally ignores a scenario-path argument: existing
// `src/sim/scenarios/*.json` fixtures only carry a legacy DecisionScript, and porting every one
// of them to a pipeline-equivalent script is out of scope (Task 4 spec) — see
// example-comparison-scenario.ts for why the two scripts can't be auto-derived from each other.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadScenarioFile } from './scenario-load.js';
import { runScenario, runComparison } from './driver.js';
import { renderTable, summarize, toCsv } from './metrics.js';
import { exampleComparisonScenario } from './example-comparison-scenario.js';

async function runCompare(): Promise<void> {
  const { legacy, pipeline } = await runComparison(exampleComparisonScenario);

  console.log(`Comparison scenario: ${exampleComparisonScenario.name}\n`);
  console.log('── legacy machine ──');
  console.log(renderTable(summarize(legacy)));
  console.log('\n── pipeline machine ──');
  console.log(renderTable(summarize(pipeline)));
}

async function main(): Promise<void> {
  const arg = process.argv[2];

  if (arg === '--compare') {
    await runCompare();
    return;
  }

  const scenarioPath = arg;
  if (!scenarioPath) {
    console.error('Usage: npm run sim -- <scenario.json>\n   or: npm run sim -- --compare');
    process.exitCode = 1;
    return;
  }

  const scenario = loadScenarioFile(scenarioPath);
  const result = await runScenario(scenario);
  const summary = summarize(result);

  console.log(renderTable(summary));

  const outBase = path.join(path.dirname(scenarioPath), scenario.name);
  writeFileSync(`${outBase}.result.json`, JSON.stringify({ summary, result }, null, 2));
  writeFileSync(`${outBase}.csv`, toCsv(result));
  console.log(`\nWrote ${outBase}.result.json and ${outBase}.csv`);
}

main().catch((err) => {
  console.error('sim run failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
