#!/usr/bin/env node
/**
 * Opt-in real-LLM agent-player run (`npm run agent:play`), gated on `AGENT_OPENROUTER_API_KEY`, a key separate
 * from the bot's. NEVER imported by `npm test` — every call is real and paid; env knobs live in `.pi/skills/agent-smoke/SKILL.md`.
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

/** The real char-creation defs the controller's wizard renders from. */
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
  // The wizard persists step-5 values lowercase and the controller validates the value against the
  // defs, so a title-case alignment would be rejected.
  alignment: 'lawful good',
  dayJob: 'Town Guard',
  // The walk can't reach step 8 without the step-7 kit, so this is a Warrior's own kit.
  itemSetName: "Soldier's Kit",
};

// userId is the only collision key (a character name is not unique in the DB), so a fresh spawn
// always lands on a fresh player; inherit mode must pass the recorded session id instead.
const userId = process.env.AGENT_USER_ID ?? `agent:play-${Date.now()}`;
const inherit = process.env.AGENT_INHERIT === '1';
// The persona this run plays as, read here in the runner so the harness library stays env-free.
// `AGENT_PERSONA=` (empty) reads as unset; the persona review reads the same value.
const persona = process.env.AGENT_PERSONA || undefined;

async function main(): Promise<void> {
  // Validate the persona before anything is constructed: a typo'd AGENT_PERSONA must cost a start-up
  // error, not a run that spends its tokens under the wrong (or no) persona fragment.
  if (persona !== undefined && !PERSONA_NAMES.includes(persona)) {
    console.error(
      `agent:play: AGENT_PERSONA="${persona}" is not a known persona; valid personas: ${PERSONA_NAMES.join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }
  // Inherit mode needs the recorded session id to find the existing player: there is no name→userId
  // lookup, so a missing AGENT_USER_ID is a hard config error.
  if (inherit && !process.env.AGENT_USER_ID) {
    console.error('agent:play: AGENT_INHERIT=1 requires AGENT_USER_ID (the recorded session id to inherit)');
    process.exitCode = 1;
    return;
  }
  // The agent key, not the bot's. No fallback on purpose: this run is a playtest, its spend has a
  // different owner, and a silent slide onto the bot's key is the failure the split exists to stop.
  const apiKey = process.env.AGENT_OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    console.error(
      'agent:play needs AGENT_OPENROUTER_API_KEY set (a separate key from the bot\'s OPENROUTER_API_KEY) — this is the opt-in real-LLM run.',
    );
    process.exitCode = 1;
    return;
  }
  const model = process.env.AGENT_MODEL?.trim() || undefined;
  const days = Number(process.env.AGENT_DAYS ?? '1');
  if (!Number.isFinite(days) || days < 1) {
    console.error(`agent:play: AGENT_DAYS must be a positive integer (got "${process.env.AGENT_DAYS}").`);
    process.exitCode = 1;
    return;
  }
  // Validated here rather than in the pin: an unparseable stamp would pin the clock to Invalid Date
  // and turn every weekday branch into a silent NaN comparison, after a paid call has already run.
  const startDate = process.env.AGENT_START_DATE || new Date().toISOString();
  if (Number.isNaN(new Date(startDate).getTime())) {
    console.error(`agent:play: AGENT_START_DATE must be an ISO-8601 date or timestamp (got "${process.env.AGENT_START_DATE}").`);
    process.exitCode = 1;
    return;
  }
  // Validated like AGENT_DAYS above: a bad value must cost a start-up error, not a run that silently
  // skips nothing or skips the wrong number of days.
  const skipDays = Number(process.env.AGENT_SKIP_DAYS ?? '0');
  if (!Number.isFinite(skipDays) || skipDays < 0) {
    console.error(`agent:play: AGENT_SKIP_DAYS must be a non-negative integer (got "${process.env.AGENT_SKIP_DAYS}").`);
    process.exitCode = 1;
    return;
  }
  const outPath = process.env.AGENT_OUT ?? path.join(os.tmpdir(), `agent-run-${Date.now()}.json`);
  // Honour the SAME switch and default as prod (`index.ts`): on, with the literal "false" opting out.
  // Without this a live run always pays critic cost, so the A/B has no "critic off" arm.
  const criticEnabled = process.env.ENABLE_COHERENCE_CRITIC !== 'false';
  // Shares prod's parser, so an arm selected here matches what prod would do with the same env:
  // 'always' gates nothing (the baseline arm), 'anomaly' gates both beats.
  const criticGateMode: CriticGateMode = parseCriticGateMode(process.env.CRITIC_GATE_MODE);

  // Pin BEFORE anything that reads the clock is constructed: the wizard session's TTL stamp, the
  // engine's per-action stamps and the greeting all read `new Date()`.

  // `outPath` is computed first on purpose: the default filename's timestamp must stay real, or two
  // personas of one panel collide on one output file.
  const clock = pinAdvancingClock(startDate);

  // Real pipeline gateway (built from apiKey inside buildAgentEngine) + real brain, both on
  // OpenRouter; `recordLlmCalls` persists every pipeline stage, the brain recording its own picks.
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
  // The router is hoisted so the SEED walk dispatches through the same router the harness plays
  // through, with the controller owning the wizard store and the defs.
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
  // The header's brain class is 'prod' (this is the real-LLM run), so a recorded transcript's
  // protocol header is honest for replay; `recordBeats` honours the AGENT_PROTOCOL_BEATS knob.
  const harness = createAgentHarness(agentEngine.engine, router, brain, userId, {
    brain: 'prod',
    // The pinned start is the header stamp too, so a recording and its replay agree by construction
    // rather than by the operator copying a value across runs.
    recordedAt: startDate,
    pinnedClock: clock,
    ...(process.env.AGENT_PROTOCOL_BEATS === '1' ? { recordBeats: true } : {}),
    // AGENT_FORCE_FREE_ACTIONS — the runner's knob, like AGENT_PROTOCOL_BEATS above.
    ...(process.env.AGENT_FORCE_FREE_ACTIONS === '1' ? { forceFreeActions: true } : {}),
    // The persona is stamped onto the protocol-log header so the recording is attributable in
    // replay; an absent key when unset keeps the pre-persona shape.
    ...(persona ? { persona } : {}),
  });

  // The cost summary prints from this OUTER finally, so the operator's total includes the critique and
  // the persona review; a throwing play block still leaves the spend to the failure on the terminal.
  try {
    // The transcript is the repro: dumped in `finally` so a run that throws still writes what it saw,
    // and the creation walk sits inside the try so a mid-walk rejection still lands the partial walk.
    let summaries: Awaited<ReturnType<typeof harness.playDays>> = [];
    try {
      if (inherit) {
        // No creation walk: the session starts at menu.open as that player.
        console.error(`Inheriting ${userId} — playing ${days} day(s)…\n`);
      } else {
        // Fresh spawn: the full join wizard walk through the harness's recorded dispatch, so the walk
        // lands in the protocol log — a real-backend replay re-seeds from it.
        if (process.env.AGENT_BRAIN_CHOOSES_CHAR === '1') {
          // The brain authors the character (name + wizard steps) like a real user: non-deterministic
          // and token-heavy, so live runs only.
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
        // Day 1 as normal, then the world advances `skipDays` days with no play, then the rest — only
        // when day 1 ended cleanly, or a stalled run would fabricate an interruption that never happened.
        summaries = await harness.playDays(1);
        const firstDay = summaries.at(-1);
        if (firstDay?.ended === 'slept' || firstDay?.ended === 'no-rolls') {
          console.error(`Skipping ${skipDays} day(s) — the world advances with no play…\n`);
          harness.skipDays(skipDays);
          summaries = summaries.concat(await harness.playDays(days - 1));
        }
      }
    } finally {
      // Always clean JSON, immune to stdout log noise; everything human-readable goes to stderr.
      writeFileSync(outPath, JSON.stringify(harness.transcript.events, null, 2));
      // The parallel protocol log lands beside the semantic transcript (default
      // `<AGENT_OUT>.protocol.json`), the replayable instrument, with the same finally guarantee.
      const protocolOut = process.env.AGENT_PROTOCOL_OUT ?? `${outPath}.protocol.json`;
      writeFileSync(protocolOut, JSON.stringify(harness.transcript.protocol, null, 2));
      console.error(`\n── transcript written to ${outPath} ──`);
      console.error(`── protocol log written to ${protocolOut} ──`);
      console.error('\n── day summaries ──');
      // Criterion 3 reads per day, so the scoreboard the operator reads carries the per-day
      // free-action count, not just the run total.
      const freeByDay = harness.transcript.freeActionsByDay();
      summaries.forEach((s, i) => {
        console.error(
          `  day ${s.dayNumber}: ${s.outcomes} outcome(s), ${freeByDay[i] ?? 0} free action(s), ended ${s.ended}`,
        );
      });
      const run = harness.transcript.summary();
      // The recorded dispatch stream's free (non-work) actions: the denominator an inspiration grant
      // rate is read against, and the reason AGENT_FORCE_FREE_ACTIONS exists.
      const freeActions = harness.transcript.freeActions();
      console.error(
        `\n── run summary ──\n  ${run.turns} turns, ${run.outcomes} outcomes, ${run.deadEnds} dead-ends, ` +
          `${run.commutes} commutes, ${run.dayBoundaries} nights, ${freeActions} free action(s)\n  ` +
          `findings: ${run.findings.error} error(s), ${run.findings.warning} warning(s)`,
      );
    }

    // A stale/missing AGENT_USER_ID plays zero turns and would otherwise exit 0 like a success; the
    // fresh arm fails loud on a walk rejection, so this arm must too — automation keys on exit code.
    if (inherit && summaries.some((s) => s.ended === 'no-character')) {
      console.error(`agent:play: no character found for ${userId} (AGENT_INHERIT=1) — nothing played (exit 1).`);
      process.exitCode = 1;
    }

    // Anything but a clean night (`slept`/`no-rolls`) is a TRUNCATED run: the exit code is all QA
    // automation reads, and the complement of `playDays`' continue-condition cannot go stale.
    const truncated = summaries.filter((s) => s.ended !== 'slept' && s.ended !== 'no-rolls');
    if (truncated.length > 0) {
      console.error(
        `agent:play: run ended early — ${truncated.map((s) => `day ${s.dayNumber} ${s.ended}`).join(', ')} ` +
          `(played ${summaries.length} day(s); exit 1).`,
      );
      process.exitCode = 1;
    }

    // A critic reads the completed transcript and writes a qualitative playtest report. Only reached
    // when the run itself didn't throw — a completed run is what the critic reviews.
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

    // A SECOND artefact, not a replacement for the critique above: one call per persona per run, and
    // only when a persona played, so the baseline arm stays critic-only and writes nothing extra.
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

        // Written here, not in the `finally` above, so a throwing reviewer leaves no file rather than a
        // hole. The cost query must run after it, in-process: the `:memory:` DB dies with the run.
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
        // Same contract as a failed critique: the run is complete and its transcript is on disk, so a
        // failing reviewer must not turn a paid run into a failed process.
        console.error('\n── persona review failed ──\n ', err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    // Queried from the SAME `:memory:` db `recordLlmCalls` wrote into, before the process exits and
    // those `llm_calls` rows are gone for good; printed once and last, from the outer finally.
    console.error(`\n${formatLlmCostSummary(summarizeLlmCosts(agentEngine.db))}`);
    // Unconditional: the pin is process-wide, and restoring only on the success path would leave the
    // global swapped for whatever runs after.
    clock.restore();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
