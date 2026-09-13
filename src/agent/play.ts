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
 * AGENT_START_DATE (the run's start instant, ISO-8601 — an ISO date or a full timestamp; default
 * the real now. The process clock is pinned to it for the whole run and ADVANCES one day per
 * nightly tick (spec § G "the time axis"), so a fast multi-day run crosses weekdays like a real
 * one: the Saturday bonus roll, the weekend greeting and the five-day absence nudge all read the
 * game's calendar instead of whichever day the process happens to run on. The same value is
 * stamped into the protocol header's `recordedAt`, so a recording and its replay agree by
 * construction. An unparseable value is a config error: the run exits 1 before any LLM call.),
 * AGENT_SKIP_DAYS (default 0 — the interrupted-panel knob, spec § G: after day 1 closes, the world
 * advances this many days with NO play at all (the absence), and the run then plays the remaining
 * AGENT_DAYS-1 days. Only reached when day 1 ended cleanly. The day numbers of the resumed days
 * are the real ones — the world moved on),
 * AGENT_OUT (transcript path; default a timestamped file under the OS temp dir),
 * AGENT_PROTOCOL_OUT (protocol-log path; default `<AGENT_OUT>.protocol.json`),
 * AGENT_PROTOCOL_BEATS (record router beats into the protocol log, default off),
 * AGENT_FORCE_FREE_ACTIONS ("1" = force the brain to take at least one free-text (non-work)
 * action per day: each day's first menu offers the free slot only; the RA-2 measurement aid —
 * day-job work is inspiration-stripped by design, so a plain run cannot observe the dial),
 * AGENT_BRAIN_CHOOSES_CHAR ("1" = the opt-in realism arm: the brain authors the character
 * through the join wizard — name + step choices — instead of the deterministic scripted walk;
 * non-deterministic + token-heavy, live runs only),
 * AGENT_PERSONA (the persona this run plays as, one of the ten roster names: explorer, socialite,
 * soldier, homesteader, grinder, collector, storyteller, tourist, casual, lapsed-returner. Its
 * fragment joins the brain's SYSTEM prompt after brain.md and the handbook, and the run is stamped
 * `agent-v2/<name>`. Unset = no persona fragment at all, which is today's behaviour and the
 * baseline arm a panel is read against. An unknown name is a config error: the run exits 1 naming
 * the valid personas before any LLM call is constructed. WHEN SET it also turns on the persona
 * REVIEW (spec § F): a second, persona-voiced LLM call after the expert critique, printed to stderr
 * and written to `<AGENT_OUT>.reviews.json` for `agent:panel`. Unset runs review nothing and write
 * nothing extra — the review is the persona's, so there is no voice to review in without one),
 * AGENT_USER_ID (session id; default a per-session unique `agent:play-<timestamp>`),
 * AGENT_INHERIT ("1" = play as the existing AGENT_USER_ID player, no creation walk),
 * ENABLE_COHERENCE_CRITIC (RA-4 Finding 1, default on — "false" opts out, same as index.ts),
 * CRITIC_GATE_MODE (RA-4c, "always" default | "anomaly" — see src/engine/action/critic-gate.ts,
 * only relevant while the critic above is enabled).
 */

import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAgentEngine } from './engineHarness.js';
import { createAgentHarness } from './harness.js';
import { ProdAgentPlayerGateway } from './ProdAgentPlayerGateway.js';
import { ProdPlaytestCriticGateway } from './ProdPlaytestCriticGateway.js';
import { LlmCallRepository } from '../db/repositories/llm-call.js';
import type { CharCreateData } from '../engine/WorldEngine.js';
import { loadYamlFile } from '../assets/yaml-loader.js';
import { parseCriticGateMode, type CriticGateMode } from '../engine/action/critic-gate.js';
import { summarizeLlmCosts, formatLlmCostSummary } from './llmCostSummary.js';
import { pinAdvancingClock } from './clock.js';
import { buildReviewFile, formatPersonaReview, personaReviewInput } from './reviewFile.js';
import { PERSONA_NAMES } from './agentPrompt.js';
import { GameRouter } from '../protocol/router.js';
import type { RouterBackend } from '../protocol/router.js';
import { SessionController } from '../controller/SessionController.js';
import { WizardSession } from '../controller/WizardSession.js';
import type { CharDefs } from '../controller/joinWizard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CC_DIR = path.join(__dirname, '..', '..', 'assets', 'char-creation');

/** The real char-creation defs the controller's wizard renders from — same files main() loads. */
function loadDefs(): CharDefs {
  return {
    classes: loadYamlFile(path.join(CC_DIR, 'classes.yml')) as CharDefs['classes'],
    backgrounds: loadYamlFile(path.join(CC_DIR, 'backgrounds.yml')) as CharDefs['backgrounds'],
    races: loadYamlFile(path.join(CC_DIR, 'races.yml')) as CharDefs['races'],
    alignments: loadYamlFile(path.join(CC_DIR, 'alignments.yml')) as CharDefs['alignments'],
    dayJobs: loadYamlFile(path.join(CC_DIR, 'day-jobs.yml')) as CharDefs['dayJobs'],
    itemSets: loadYamlFile(path.join(CC_DIR, 'item-sets.yml')) as CharDefs['itemSets'],
  };
}

const SEED: CharCreateData = {
  name: 'Ashwin',
  class: 'Warrior',
  upbringing: 'Soldier',
  race: 'Human',
  // The wizard persists step-5 values lowercase and the controller validates the value
  // against the defs (DC-M7.3.9) — the pre-seam title-case fixture would be rejected.
  alignment: 'lawful good',
  dayJob: 'Town Guard',
  // The walk can't reach step 8 without the step-7 kit (a Warrior's "Soldier's Kit" —
  // the profile fixture gains the wizard's itemSet field the current SEED lacks, DC-S3).
  itemSetName: "Soldier's Kit",
};

// DC-S7 session identity: the default is a per-session unique fake id — userId is the only
// collision key (names are not unique in the DB), so a fresh spawn always lands on a fresh
// player. AGENT_USER_ID overrides: inherit mode (AGENT_INHERIT=1) must set it to the recorded
// session id the protocol header carries.
const userId = process.env.AGENT_USER_ID ?? `agent:play-${Date.now()}`;
const inherit = process.env.AGENT_INHERIT === '1';
// The persona this run plays as. Read here, in the runner, so the harness library stays env-free
// (DC-S1, same as the AGENT_PROTOCOL_BEATS knob). `AGENT_PERSONA=` (empty) reads as unset, and so
// does an unset variable. T5's persona review reads the same value to decide whether to review.
const persona = process.env.AGENT_PERSONA || undefined;

async function main(): Promise<void> {
  // Validate the persona before anything is constructed: a typo'd AGENT_PERSONA must cost a start-up
  // error, not a run that spends tokens under the wrong (or no) persona fragment.
  if (persona !== undefined && !PERSONA_NAMES.includes(persona)) {
    console.error(
      `agent:play: AGENT_PERSONA="${persona}" is not a known persona; valid personas: ${PERSONA_NAMES.join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }
  // Inherit mode needs the recorded session id to find the existing player — there is no
  // name→userId lookup (DC-S7), so a missing AGENT_USER_ID is a hard config error.
  if (inherit && !process.env.AGENT_USER_ID) {
    console.error('agent:play: AGENT_INHERIT=1 requires AGENT_USER_ID (the recorded session id to inherit)');
    process.exitCode = 1;
    return;
  }
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
  // The run's start instant: the pinned clock's base AND the header's recordedAt. `AGENT_START_DATE=`
  // (empty) reads as unset, like AGENT_PERSONA. Validated here rather than in the pin: an
  // unparseable stamp would pin the clock to Invalid Date and turn every weekday branch into a
  // silent NaN comparison, in a run that has already paid for its first LLM call.
  const startDate = process.env.AGENT_START_DATE || new Date().toISOString();
  if (Number.isNaN(new Date(startDate).getTime())) {
    console.error(`agent:play: AGENT_START_DATE must be an ISO-8601 date or timestamp (got "${process.env.AGENT_START_DATE}").`);
    process.exitCode = 1;
    return;
  }
  // The interrupted-panel knob (spec § G): validated like AGENT_DAYS above — a bad value must cost
  // a start-up error, not a run that silently skips nothing (or skips the wrong number of days).
  const skipDays = Number(process.env.AGENT_SKIP_DAYS ?? '0');
  if (!Number.isFinite(skipDays) || skipDays < 0) {
    console.error(`agent:play: AGENT_SKIP_DAYS must be a non-negative integer (got "${process.env.AGENT_SKIP_DAYS}").`);
    process.exitCode = 1;
    return;
  }
  const outPath = process.env.AGENT_OUT ?? path.join(os.tmpdir(), `agent-run-${Date.now()}.json`);
  // RA-4 Finding 1: honour the SAME switch and default as prod (`index.ts`'s ENABLE_COHERENCE_CRITIC
  // — default on, the literal string "false" opts out) — without this, a live run always pays
  // critic cost with no way to disable it, which defeats the "critic off" arm of the A/B.
  const criticEnabled = process.env.ENABLE_COHERENCE_CRITIC !== 'false';
  // RA-4c A/B: shares prod's parser so an arm selected here matches what prod would do with the
  // same env. Default 'narrate-gated' (SL-3); 'always' is the pre-RA-4 baseline arm, 'anomaly'
  // gates both beats. Pick the arm per run, no code edit needed.
  const criticGateMode: CriticGateMode = parseCriticGateMode(process.env.CRITIC_GATE_MODE);

  // Pin BEFORE anything that reads the clock is constructed: the wizard session's TTL stamp, the
  // engine's per-action stamps and the greeting all read `new Date()`, and a run that pinned after
  // its first dispatch would straddle two clocks. `outPath` above is deliberately computed first —
  // the default filename's timestamp must stay real, or two personas of one panel would collide on
  // one output file. Silent when the run is stopped early by an error after this point.
  const clock = pinAdvancingClock(startDate);

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
    ...(persona ? { persona } : {}),
    recorder: new LlmCallRepository(agentEngine.db),
    verbose: true,
  });
  // M7.3 (DC-M7.3.10): the router is hoisted so the SEED walk dispatches through it (the
  // same router the harness plays through). The controller now owns the wizard store + defs.
  const router = new GameRouter(
    new SessionController(
      agentEngine.engine,
      agentEngine.getCurrentScene,
      agentEngine.dayJobs,
      undefined,
      new WizardSession(),
      loadDefs(),
      agentEngine.resolveScene,
    ) as RouterBackend,
    { idle: () => '' },
  );
  // The header's brain class is 'prod' (this is the real-LLM run) so a recorded transcript's
  // protocol header is honest for replay (DC-S1/DC-S2). recordBeats honors the
  // AGENT_PROTOCOL_BEATS knob — read here, in the runner, so the library stays env-free (DC-S1).
  const harness = createAgentHarness(agentEngine.engine, router, brain, userId, {
    brain: 'prod',
    // The pinned start is the header stamp too (contract §10), so a recording and its replay agree
    // by construction rather than by the operator copying a value across runs.
    recordedAt: startDate,
    pinnedClock: clock,
    ...(process.env.AGENT_PROTOCOL_BEATS === '1' ? { recordBeats: true } : {}),
    // AGENT_FORCE_FREE_ACTIONS — read here, in the runner: the harness library stays env-free
    // (DC-S1), same as the AGENT_PROTOCOL_BEATS knob above.
    ...(process.env.AGENT_FORCE_FREE_ACTIONS === '1' ? { forceFreeActions: true } : {}),
    // The persona is stamped onto the protocol-log header (DC-S1/spec § H) so the recording is
    // attributable in replay: absent key when unset, which keeps the pre-persona shape.
    ...(persona ? { persona } : {}),
  });

  // T6 fix: the cost summary is printed from this OUTER finally, after the critique and the persona
  // review have run. The play block's own finally used to print it, so the operator's total excluded
  // both of those calls while `.reviews.json` cost included the review — the printed number and the
  // panel's number disagreed, and the review is the expensive half. The outer finally keeps the
  // guarantee the inner one had: a play block that throws still leaves the spend up to the failure
  // on the terminal.
  try {
    // The transcript is the repro (goal a): dump it in `finally` so a run that throws before finishing
    // still writes what it saw up to the failure, not just an opaque stack. The creation walk is inside
    // the try for the same reason — a mid-walk rejection (e.g. a has-character collision on a shared
    // backend) must still land the partial walk in the protocol log via finally, and the walk IS the
    // repro (DC-S7's recording-gap fix).
    let summaries: Awaited<ReturnType<typeof harness.playDays>> = [];
    try {
      if (inherit) {
        // DC-S7 inherit mode: no creation walk — the session starts at menu.open as that player.
        console.error(`Inheriting ${userId} — playing ${days} day(s)…\n`);
      } else {
        // DC-S7 fresh spawn: the full join wizard walk through the harness's recorded dispatch,
        // so the creation walk lands in the protocol log (stage 7's replay re-seeding depends on it).
        if (process.env.AGENT_BRAIN_CHOOSES_CHAR === '1') {
          // DC-S3 opt-in realism arm: the brain authors the character (name + wizard steps) like
          // a real user — non-deterministic + token-heavy, live runs only (the standard fleet
          // keeps the deterministic scripted walk below).
          await harness.createCharacterWithBrain();
          console.error('Brain chose the character — playing …\n');
        } else {
          await harness.createCharacter(SEED);
          console.error(`Seeded ${SEED.name} (${SEED.class}) — playing ${days} day(s)…\n`);
        }
      }
      if (skipDays === 0) {
        summaries = await harness.playDays(days);
      } else {
        // Spec § G's interruption: day 1 as normal, then the world advances `skipDays` days with no
        // play at all, then the remaining days are played. Only engaged when day 1 ended cleanly —
        // `playDays` stops the run on a stalled/crashed day, and skipping on into a dead run would
        // fabricate an interruption that never happened. `days - 1` may be zero (`AGENT_DAYS=1` with
        // a skip is the absence and nothing to resume from); `playDays(0)` is an empty no-op.
        summaries = await harness.playDays(1);
        const firstDay = summaries.at(-1);
        if (firstDay?.ended === 'slept' || firstDay?.ended === 'no-rolls') {
          console.error(`Skipping ${skipDays} day(s) — the world advances with no play…\n`);
          harness.skipDays(skipDays);
          summaries = summaries.concat(await harness.playDays(days - 1));
        }
      }
    } finally {
      // Transcript → a file (always clean JSON, immune to stdout log noise); everything human-readable
      // → stderr. Written in finally so a throwing run still leaves the repro up to the failure point.
      writeFileSync(outPath, JSON.stringify(harness.transcript.events, null, 2));
      // DC-S1: the parallel protocol log lands beside the semantic transcript (default
      // `<AGENT_OUT>.protocol.json`) — the replayable instrument, same finally-guarantee.
      const protocolOut = process.env.AGENT_PROTOCOL_OUT ?? `${outPath}.protocol.json`;
      writeFileSync(protocolOut, JSON.stringify(harness.transcript.protocol, null, 2));
      console.error(`\n── transcript written to ${outPath} ──`);
      console.error(`── protocol log written to ${protocolOut} ──`);
      console.error('\n── day summaries ──');
      // Criterion 3 reads per day ("at least one non-work action per day"), so the scoreboard the
      // operator/critic actually reads carries the per-day free-action count, not just the run total.
      const freeByDay = harness.transcript.freeActionsByDay();
      summaries.forEach((s, i) => {
        console.error(
          `  day ${s.dayNumber}: ${s.outcomes} outcome(s), ${freeByDay[i] ?? 0} free action(s), ended ${s.ended}`,
        );
      });
      const run = harness.transcript.summary();
      // RA-2 instrument: the recorded dispatch stream's free (non-work) actions — the denominator
      // an inspiration grant rate is read against, and the reason AGENT_FORCE_FREE_ACTIONS exists.
      const freeActions = harness.transcript.freeActions();
      console.error(
        `\n── run summary ──\n  ${run.turns} turns, ${run.outcomes} outcomes, ${run.deadEnds} dead-ends, ` +
          `${run.commutes} commutes, ${run.dayBoundaries} nights, ${freeActions} free action(s)\n  ` +
          `findings: ${run.findings.error} error(s), ${run.findings.warning} warning(s)`,
      );
    }

    // Inherit-mode asymmetry (review c022d1f): a stale/missing AGENT_USER_ID plays zero turns and
    // would otherwise exit 0 like a success — the fresh arm fails loud on a walk rejection, so the
    // inherit arm must too (smoke-run automation keys on the exit code).
    if (inherit && summaries.some((s) => s.ended === 'no-character')) {
      console.error(`agent:play: no character found for ${userId} (AGENT_INHERIT=1) — nothing played (exit 1).`);
      process.exitCode = 1;
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

    // T5 (spec § F): the persona review — a SECOND artefact, not a replacement for the critique above.
    // One call per persona per run, and only when a persona played: the baseline arm stays critic-only
    // and writes nothing extra, which is what keeps the ARM comparison the panel reads clean.
    if (persona !== undefined) {
      try {
        const reviewer = new ProdPlaytestCriticGateway({
          apiKey,
          ...(model ? { model } : {}),
          recorder: new LlmCallRepository(agentEngine.db),
          verbose: true,
        });
        const review = await reviewer.review(personaReviewInput(persona, harness.transcript));
        console.error(`\n${formatPersonaReview(review)}`);

        // The reviews file the panel aggregates (contract §9). Written here, not in the `finally`
        // above, because it carries the review — a run whose reviewer threw leaves no file rather than
        // a file with a hole in the measurement. The cost query runs AFTER the review call for the
        // same reason it must run in-process at all: the `:memory:` DB holding `llm_calls` dies with
        // the run, and a per-run cost that omitted the review's own call would understate the panel's
        // price by one call per persona.
        const reviewsPath = `${outPath}.reviews.json`;
        writeFileSync(
          reviewsPath,
          JSON.stringify(
            buildReviewFile({
              persona,
              review,
              transcript: harness.transcript,
              cost: summarizeLlmCosts(agentEngine.db),
            }),
            null,
            2,
          ),
        );
        console.error(`── persona review written to ${reviewsPath} ──`);
      } catch (err) {
        // Same contract as a failed critique: report it and move on. The run itself is complete and
        // its transcript is on disk; a failing reviewer must not turn a paid run into a failed process.
        console.error('\n── persona review failed ──\n ', err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    // RA-4a: queried from the SAME `:memory:` db `recordLlmCalls` wrote into — must run here,
    // before the process exits and that db (and its llm_calls rows) is gone for good. Printed exactly
    // once, and last, so one cost line covers every LLM call the run made.
    console.error(`\n${formatLlmCostSummary(summarizeLlmCosts(agentEngine.db))}`);
    // Unconditional, like the stub/replay halves: the pin is process-wide, and a runner that
    // restored only on its success path would leave the global swapped for anything after it.
    clock.restore();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
