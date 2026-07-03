#!/usr/bin/env node
// CLI entry — `npm run sim -- <scenario.json>`. Reads a scenario file, drives it through
// runScenario, prints the summary table, and writes `<name>.result.json` + `<name>.csv`
// next to the input file.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadScenarioFile } from './scenario-load.js';
import { runScenario } from './driver.js';
import { renderTable, summarize, toCsv } from './metrics.js';

async function main(): Promise<void> {
  const scenarioPath = process.argv[2];
  if (!scenarioPath) {
    console.error('Usage: npm run sim -- <scenario.json>');
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
