/**
 * The deterministic real-backend session wiring (M8.5 stage 7, DC-S2) — the shared src-side
 * source of the deterministic pipeline script, the seed character profile, and the
 * SessionController→router construction that BOTH the harness tests and the replay runner
 * use. Before this module the deterministic `buildHarness` wiring existed as per-file copies
 * in tests/agent/harness.test.ts + tests/agent/protocol-log.test.ts; the replay runner needs
 * a src-side source (tests are not importable from src), so the copies moved here and the
 * test files import them — one source of truth. A drift between what the tests drive and
 * what byte-replay proves would otherwise change what the deterministic class's
 * byte-for-byte reproducer actually reproduces.
 */

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { AgentEngine } from './engineHarness.js';
import { SessionController } from '../controller/SessionController.js';
import { GameRouter } from '../protocol/router.js';
import type { RouterBackend } from '../protocol/router.js';
import { WizardSession } from '../controller/WizardSession.js';
import { loadYamlFile } from '../assets/yaml-loader.js';
import type { CharDefs } from '../controller/joinWizard.js';
import type { PipelineScript } from '../sim/types.js';
import type { CharCreateData } from '../engine/WorldEngine.js';
import type { AgentMove } from './AgentPlayerGateway.js';
import type { ProtocolEntry } from './transcript.js';
import { buildAgentEngine } from './engineHarness.js';
import { createAgentHarness } from './harness.js';
import { ScriptedAgentPlayerGateway } from './ScriptedAgentPlayerGateway.js';
import { PipelineScriptedGateway } from '../sim/PipelineScriptedGateway.js';
import { pinClock } from './clock.js';
import { establishBootParity } from './bootParity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CC_DIR = path.join(__dirname, '..', '..', 'assets', 'char-creation');

/** The real char-creation defs the controller's wizard renders from (DC-M7.3.10) — the same
 *  YAMLs the engine harness loads for its day jobs. */
export function loadRealDefs(): CharDefs {
  const load = <T>(file: string): T[] => loadYamlFile(path.join(CC_DIR, file)) as T[];
  return {
    classes: load('classes.yml'),
    backgrounds: load('backgrounds.yml'),
    races: load('races.yml'),
    alignments: load('alignments.yml'),
    dayJobs: load('day-jobs.yml'),
    itemSets: load('item-sets.yml'),
  };
}

/** The proven goblin-skirmish shape: "attack the goblin" → combat hit → two real options + bail. */
export const deterministicPipelineScript: PipelineScript = {
  classify: () => ({
    kind: 'hit',
    actionType: 'combat',
    flags: { unsafe_location: false, needs_roll: true, target_present: true },
  }),
  decide: () => ({
    distilledType: 'combat',
    stat: 'physical',
    baseDc: 8,
    required: false,
    decision: [
      { label: 'Press the attack', dcModifier: 0 },
      { label: 'Feint and strike', dcModifier: 1 },
      { label: 'Step back', dcModifier: null },
    ],
  }),
  resolveMutate: () => ({ mutations: [{ type: 'modify_wealth', amount: 5 }] }),
  resolveNarrate: () => ({ outcomeText: 'Your blade finds its mark; the goblin falls.' }),
};

/** The deterministic seed character (DC-S7 fresh arm) — the same profile the harness tests
 *  and the replay corpus use: real first-option def values the wizard validates against. The
 *  wizard persists step-5 values lowercase and the controller validates the value against the
 *  defs (DC-M7.3.9); the walk can't reach step 8 without the step-7 kit (DC-S3). */
export const SEED: CharCreateData = {
  name: 'Bram',
  class: 'Warrior',
  upbringing: 'Soldier',
  race: 'Human',
  alignment: 'lawful good',
  dayJob: 'Town Guard',
  itemSetName: "Soldier's Kit",
};

/** The SessionController→router wiring the deterministic real-backend sessions share — the
 *  same construction the harness tests' `buildHarness` used (real SessionController over the
 *  harness engine with the real defs + resolveScene + a deterministic idle), lifted to src so
 *  the replay runner and future corpus recorders build the identical backend. */
export function buildDeterministicRouter(engine: AgentEngine): GameRouter {
  const controller = new SessionController(
    engine.engine,
    engine.getCurrentScene,
    engine.dayJobs,
    undefined,
    new WizardSession(),
    loadRealDefs(),
    engine.resolveScene,
  );
  return new GameRouter(controller as RouterBackend, { idle: () => '' });
}

// ── Deterministic real-backend recorder (M10.1d / DC-M10.6) ──

/** The canned day the real-backend corpus entry records: open the menu, take the first
 *  option twice, then sleep through the nightly tick. Small on purpose — the entry exists to
 *  prove the REAL backend replays byte-green, not to exercise breadth. */
export const REAL_DAY_MOVES: AgentMove[] = [
  { kind: 'menu-pick', index: 0 },
  { kind: 'choice', index: 0 },
  { kind: 'choice', index: 0 },
  { kind: 'sleep' },
];

/** The corpus entry's session id and recording clock. Both fixed, for the same reason
 *  `STUB_RECORDED_AT` is: the committed transcript is pinned by deep-equality against a
 *  fresh run, so anything drawn from the wall clock or a counter would break it on run two.
 *  A Wednesday, so the weekday branches the greeting and the tick read stay off the weekend
 *  path — the Saturday arm is exercised by the tamper in `replay.test.ts`, not here. */
export const REAL_USER_ID = 'agent:real-corpus';
export const REAL_RECORDED_AT = '2026-07-15T09:00:00.000Z';

/**
 * Record a deterministic real-backend session and return its protocol log.
 *
 * "Real backend" means the real `SessionController` over a real `WorldEngineImpl` — the LLM
 * is a scripted pipeline gateway and the d20 is fixed, so this costs no tokens and needs no
 * API key. That is what makes a committed real-backend corpus entry possible at all.
 *
 * Both DC-M10.6 halves apply: the run executes on the same pinned clock it stamps into the
 * header, so the greeting's `isWeekend()` and the tick's Saturday bonus see the day the
 * replay will see.
 */
export async function recordDeterministicRealSession(
  opts: { moves?: AgentMove[]; recordBeats?: boolean; recordedAt?: string; userId?: string } = {},
): Promise<ProtocolEntry[]> {
  const recordedAt = opts.recordedAt ?? REAL_RECORDED_AT;
  const agentEngine = buildAgentEngine({
    pipelineLlmGateway: new PipelineScriptedGateway(deterministicPipelineScript),
    rollD20: () => 20,
  });
  establishBootParity(agentEngine.db);
  const harness = createAgentHarness(
    agentEngine.engine,
    buildDeterministicRouter(agentEngine),
    new ScriptedAgentPlayerGateway(opts.moves ?? REAL_DAY_MOVES),
    opts.userId ?? REAL_USER_ID,
    { recordedAt, backend: 'real', ...(opts.recordBeats ? { recordBeats: true } : {}) },
  );
  const restoreClock = pinClock(recordedAt);
  try {
    await harness.createCharacter(SEED);
    await harness.playDays(1);
  } finally {
    restoreClock();
  }
  return JSON.parse(JSON.stringify(harness.transcript.protocol)) as ProtocolEntry[];
}

/** CLI: write the deterministic real-backend corpus entry (M10.1d). Deliberately writes to a
 *  caller-named path rather than defaulting into the corpus, so regenerating the committed
 *  fixture is always an explicit act. Runs only when executed directly — importing this
 *  module (the corpus test, replay's real arm) must not trigger it. */
async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) {
    console.error('agent:record-real: usage: npm run agent:record-real -- <out.protocol.json>');
    process.exitCode = 1;
    return;
  }
  const protocol = await recordDeterministicRealSession();
  writeFileSync(out, `${JSON.stringify(protocol, null, 2)}\n`);
  console.log(`agent:record-real: ${protocol.length} entries → ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
