/**
 * The deterministic real-backend session wiring, shared by the harness tests and the replay runner:
 * tests are not importable from src, so one src-side source keeps the two from drifting apart.
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
import { pinAdvancingClock } from './clock.js';
import { establishBootParity } from './bootParity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CC_DIR = path.join(__dirname, '..', '..', 'assets', 'char-creation');

/** The real char-creation defs the controller's wizard renders from — the same YAMLs the engine
 *  harness loads. */
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

/** The deterministic seed character, shared by the harness tests and the replay corpus: real
 *  first-option def values, which the wizard validates against the defs. */
export const SEED: CharCreateData = {
  name: 'Bram',
  class: 'Warrior',
  upbringing: 'Soldier',
  race: 'Human',
  alignment: 'lawful good',
  dayJob: 'Town Guard',
  itemSetName: "Soldier's Kit",
};

/** The SessionController→router wiring every deterministic real-backend session shares: the real
 *  controller over the harness engine, with the real defs, `resolveScene` and a deterministic idle. */
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

// ── Deterministic real-backend recorder ──

/** The canned day the real-backend corpus entry records: open the menu, take the first option twice,
 *  then sleep through the nightly tick. Small on purpose — the entry proves byte-green replay. */
export const REAL_DAY_MOVES: AgentMove[] = [
  { kind: 'menu-pick', index: 0 },
  { kind: 'choice', index: 0 },
  { kind: 'choice', index: 0 },
  { kind: 'sleep' },
];

/** The corpus entry's session id and clock, both fixed so the deep-equality-pinned transcript does not
 *  break on run two. A Wednesday keeps the greeting's and the tick's weekday branches off the weekend. */
export const REAL_USER_ID = 'agent:real-corpus';
export const REAL_RECORDED_AT = '2026-07-15T09:00:00.000Z';

/**
 * Record a deterministic real-backend session: the real `SessionController` over `WorldEngineImpl`,
 * scripted pipeline and fixed d20, so it costs no tokens — run on the clock it stamps into the header.
 */
export async function recordDeterministicRealSession(
  opts: { moves?: AgentMove[]; recordBeats?: boolean; recordedAt?: string; userId?: string; days?: number } = {},
): Promise<ProtocolEntry[]> {
  const recordedAt = opts.recordedAt ?? REAL_RECORDED_AT;
  const days = opts.days ?? 1;
  const agentEngine = buildAgentEngine({
    pipelineLlmGateway: new PipelineScriptedGateway(deterministicPipelineScript),
    rollD20: () => 20,
  });
  establishBootParity(agentEngine.db);
  const clock = pinAdvancingClock(recordedAt);
  const harness = createAgentHarness(
    agentEngine.engine,
    buildDeterministicRouter(agentEngine),
    new ScriptedAgentPlayerGateway(
      // One day's moves per played day by default: the scripted brain has no idea which day it
      // is on, so a multi-day run needs the day repeated, exactly as `stubRun` arranges.
      opts.moves ?? Array.from({ length: days }, () => REAL_DAY_MOVES).flat(),
    ),
    opts.userId ?? REAL_USER_ID,
    { recordedAt, backend: 'real', pinnedClock: clock, ...(opts.recordBeats ? { recordBeats: true } : {}) },
  );
  try {
    await harness.createCharacter(SEED);
    await harness.playDays(days);
  } finally {
    clock.restore();
  }
  return JSON.parse(JSON.stringify(harness.transcript.protocol)) as ProtocolEntry[];
}

/** CLI: write the deterministic real-backend corpus entry to a caller-named path, so regenerating the
 *  committed fixture is always explicit. Runs only when executed directly, never on import. */
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
