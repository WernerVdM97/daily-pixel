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
import { fileURLToPath } from 'node:url';

import type { AgentEngine } from './engineHarness.js';
import { SessionController } from '../controller/SessionController.js';
import { GameRouter } from '../protocol/router.js';
import type { RouterBackend } from '../protocol/router.js';
import { WizardSession } from '../controller/WizardSession.js';
import { loadYamlFile } from '../assets/yaml-loader.js';
import type { CharDefs } from '../controller/joinWizard.js';
import type { PipelineScript } from '../sim/types.js';
import type { CharCreateData } from '../engine/WorldEngine.js';

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
