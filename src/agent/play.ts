#!/usr/bin/env node
/**
 * Opt-in real-LLM agent-player run (JSON-seam M4.3, DA-5 entry point).
 *
 * NEVER imported by `npm test` — this is the manual `npm run agent:play` entry, gated on
 * `DEEPSEEK_API_KEY`. It stands up the prod-faithful engine with a REAL DeepSeek pipeline (the
 * action LLM) AND a REAL DeepSeek brain (the move-picker), seeds a character, plays N days, writes
 * the transcript to a file, and prints the day summaries + critique. Every LLM call is DeepSeek —
 * the real network — so this costs money and stays out of CI by construction (tests inject the
 * scripted stubs instead).
 *
 * The transcript (the repro artefact, goal a) is written to a FILE, not stdout: the engine, the
 * verbose gateways, npm, and migrations all log to stdout during a run, so a `> run.json` redirect
 * would co-mingle that noise into the JSON (a real defect the M4 smoke runs caught). The file is
 * always clean regardless of stdout chatter, and is written in `finally` so a throwing run still
 * leaves the repro up to the failure point.
 *
 * Env: DEEPSEEK_API_KEY (required), DEEPSEEK_MODEL (optional override), AGENT_DAYS (default 1),
 * AGENT_OUT (transcript path; default a timestamped file under the OS temp dir),
 * ENABLE_COHERENCE_CRITIC (RA-4 Finding 1, default on — "false" opts out, same as index.ts),
 * CRITIC_GATE_MODE (RA-4c, "always" default | "anomaly" — see src/engine/action/critic-gate.ts,
 * only relevant while the critic above is enabled).
 */

import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildAgentEngine } from './engineHarness.js';
import { createAgentHarness } from './harness.js';
import { ProdAgentPlayerGateway } from './ProdAgentPlayerGateway.js';
import { ProdPlaytestCriticGateway } from './ProdPlaytestCriticGateway.js';
import { LlmCallRepository } from '../db/repositories/llm-call.js';
import type { CharCreateData } from '../engine/WorldEngine.js';
import type { CriticGateMode } from '../engine/action/critic-gate.js';
import { summarizeLlmCosts, formatLlmCostSummary } from './llmCostSummary.js';

const SEED: CharCreateData = {
  name: 'Ashwin',
  class: 'Warrior',
  upbringing: 'Soldier',
  race: 'Human',
  alignment: 'Lawful Good',
  dayJob: 'Town Guard',
};

const USER_ID = 'agent:play';

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('agent:play needs DEEPSEEK_API_KEY set — this is the opt-in real-LLM run.');
    process.exitCode = 1;
    return;
  }
  const model = process.env.DEEPSEEK_MODEL;
  const days = Number(process.env.AGENT_DAYS ?? '1');
  if (!Number.isFinite(days) || days < 1) {
    console.error(`agent:play: AGENT_DAYS must be a positive integer (got "${process.env.AGENT_DAYS}").`);
    process.exitCode = 1;
    return;
  }
  const outPath = process.env.AGENT_OUT ?? path.join(os.tmpdir(), `agent-run-${Date.now()}.json`);
  // RA-4 Finding 1: honour the SAME switch and default as prod (`index.ts`'s ENABLE_COHERENCE_CRITIC
  // — default on, the literal string "false" opts out) — without this, a live run always pays
  // critic cost with no way to disable it, which defeats the "critic off" arm of the A/B.
  const criticEnabled = process.env.ENABLE_COHERENCE_CRITIC !== 'false';
  // RA-4c A/B: same switch and default as prod (`index.ts`'s CRITIC_GATE_MODE wiring, gated by the
  // criticEnabled switch above) — "always" fires the critic on every decide/narrate beat (this
  // harness's prior behaviour once RA-4 wires a live critic in), "anomaly" gates it. Pick the arm
  // per run, no code edit needed.
  const criticGateMode: CriticGateMode = process.env.CRITIC_GATE_MODE === 'anomaly' ? 'anomaly' : 'always';

  // Real pipeline gateway (built from apiKey inside buildAgentEngine) + real brain, both DeepSeek.
  // recordLlmCalls persists every pipeline stage; the brain records its own picks into the same DB.
  // RA-4: buildAgentEngine now also wires a real coherence-critic gateway from this apiKey (it never
  // did before), so a live run actually has a critic to gate — see engineHarness.ts. criticEnabled
  // gates that wiring off entirely (RA-4 Finding 1), giving the A/B its three measurable arms: off,
  // always, anomaly-gated.
  const agentEngine = buildAgentEngine({
    apiKey,
    ...(model ? { model } : {}),
    recordLlmCalls: true,
    criticGateMode,
    criticEnabled,
  });
  const brain = new ProdAgentPlayerGateway({
    apiKey,
    ...(model ? { model } : {}),
    recorder: new LlmCallRepository(agentEngine.db),
    verbose: true,
  });
  const harness = createAgentHarness(agentEngine, brain, USER_ID);

  const char = harness.seedCharacter(SEED);
  console.error(`Seeded ${char.name} (${char.class}) — playing ${days} day(s)…\n`);

  // The transcript is the repro (goal a): dump it in `finally` so a run that throws before finishing
  // still writes what it saw up to the failure, not just an opaque stack.
  let summaries: Awaited<ReturnType<typeof harness.playDays>> = [];
  try {
    summaries = await harness.playDays(days);
  } finally {
    // Transcript → a file (always clean JSON, immune to stdout log noise); everything human-readable
    // → stderr. Written in finally so a throwing run still leaves the repro up to the failure point.
    writeFileSync(outPath, JSON.stringify(harness.transcript.events, null, 2));
    console.error(`\n── transcript written to ${outPath} ──`);
    console.error('\n── day summaries ──');
    for (const s of summaries) {
      console.error(`  day ${s.dayNumber}: ${s.outcomes} outcome(s), ended ${s.ended}`);
    }
    const run = harness.transcript.summary();
    console.error(
      `\n── run summary ──\n  ${run.turns} turns, ${run.outcomes} outcomes, ${run.deadEnds} dead-ends, ` +
        `${run.commutes} commutes, ${run.dayBoundaries} nights\n  findings: ${run.findings.error} error(s), ` +
        `${run.findings.warning} warning(s)`,
    );
    // RA-4a: queried from the SAME `:memory:` db `recordLlmCalls` wrote into — must run here,
    // before the process exits and that db (and its llm_calls rows) is gone for good.
    console.error(`\n${formatLlmCostSummary(summarizeLlmCosts(agentEngine.db))}`);
  }

  // M4.5 feedback pass (goal b): a critic reads the completed transcript and writes a qualitative
  // playtest report. Only reached when the run itself didn't throw (the try above rethrows past
  // here) — a completed run, crashes-captured-as-findings included, is what the critic reviews.
  try {
    const critic = new ProdPlaytestCriticGateway({
      apiKey,
      ...(model ? { model } : {}),
      recorder: new LlmCallRepository(agentEngine.db),
      verbose: true,
    });
    const report = await critic.critique({
      events: harness.transcript.events,
      summary: harness.transcript.summary(),
    });
    console.error(
      '\n── playtest critique ──' +
        `\n  pacing:     ${report.pacing}` +
        `\n  clarity:    ${report.clarity}` +
        `\n  fun:        ${report.fun}` +
        `\n  difficulty: ${report.difficulty}` +
        `\n  summary:    ${report.summary}`,
    );
  } catch (err) {
    // A critic failure must not bury the run output already printed above — report it and move on.
    console.error('\n── playtest critique failed ──\n ', err instanceof Error ? err.message : String(err));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
