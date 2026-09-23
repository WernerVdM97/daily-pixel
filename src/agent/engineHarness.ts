/**
 * Discord-free `WorldEngineImpl` construction for the agent-player harness: a real `:memory:` DB, full
 * migration, the five repos and the real assets. The action LLM is pluggable, as in prod vs sim.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

import { WorldEngineImpl } from '../engine/WorldEngineImpl.js';
import { initDb, closeDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { UserRepository } from '../db/repositories/user.js';
import { CharacterRepository } from '../db/repositories/character.js';
import { ItemRepository } from '../db/repositories/item.js';
import { ActionRepository } from '../db/repositories/action.js';
import { NpcRepository } from '../db/repositories/npc.js';
import { LlmCallRepository } from '../db/repositories/llm-call.js';
import {
  loadAndValidate,
  validateStatDef,
  validateAlignment,
  validateDayJob,
  validateItemSet,
} from '../assets/asset-schemas.js';
import { SceneLoader } from '../scenes/SceneLoader.js';
import { TagResolver } from '../scenes/TagResolver.js';
import type { DayJobDef } from '../controller/dayJob.js';
import type { PipelineLlmGateway } from '../llm/pipeline/types.js';
import type { ClassDef, ModifierDef } from '../engine/StatComputer.js';
import type { CriticGateway } from '../llm/LlmGateway.js';
import { ProdLlmGateway } from '../llm/ProdLlmGateway.js';
import type { CriticGateMode } from '../engine/action/critic-gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');
const CHAR_CREATION_DIR = path.join(ASSETS_DIR, 'char-creation');
const SCENES_DIR = path.join(ASSETS_DIR, 'scenes');

export interface AgentEngineConfig {
  /** Real pipeline gateway config (opt-in live-LLM run). Ignored when `pipelineLlmGateway` is set. */
  apiKey?: string;
  model?: string;
  /** Pre-built pipeline gateway for deterministic tests — bypasses the real network transport. */
  pipelineLlmGateway?: PipelineLlmGateway;
  /** Injected d20 for deterministic tests. Omit for the real (random) roll on a live run. */
  rollD20?: () => number;
  /** If true, records an `llm_calls` row per pipeline stage on the real path (into the same
   *  in-memory DB). Off by default — the harness DB is ephemeral. */
  recordLlmCalls?: boolean;
  /** Pre-built coherence-critic gateway for deterministic tests — bypasses the real OpenRouter
   *  transport. Omit on a live (apiKey) run for the real `ProdLlmGateway`; omit otherwise for none. */
  criticGateway?: CriticGateway;
  /** WHEN the critic (if any) fires. Absent → machine default (`'narrate-gated'`). */
  criticGateMode?: CriticGateMode;
  /** Mirrors prod's `ENABLE_COHERENCE_CRITIC` opt-out (`index.ts`), resolved by the caller — this
   *  library never reads `process.env`. `false` wires NO critic, even over an injected gateway. */
  criticEnabled?: boolean;
}

export interface AgentEngine {
  engine: WorldEngineImpl;
  /** The real day-job defs (from day-jobs.yml) — the 3rd `SessionController` constructor arg. */
  dayJobs: DayJobDef[];
  /** The `getCurrentScene` closure the controller needs — real scene text via the tag resolver,
   *  reproducing `index.ts`'s definition exactly. */
  getCurrentScene: (userId: string) => string;
  /** The real tag→scene resolver (`screen.look`'s scene renderer). Built from the same scenes +
   *  TagResolver as `getCurrentScene`; `play.ts` passes it so a live run renders real art. */
  resolveScene: (tags: string[]) => { sceneName: string; ascii: string };
  /** The engine's `:memory:` DB — exposed so a harness can inspect state for QA invariants. */
  db: Database.Database;
}

function loadAssets() {
  return {
    classes: loadAndValidate(path.join(CHAR_CREATION_DIR, 'classes.yml'), validateStatDef),
    backgrounds: loadAndValidate(path.join(CHAR_CREATION_DIR, 'backgrounds.yml'), validateStatDef),
    races: loadAndValidate(path.join(CHAR_CREATION_DIR, 'races.yml'), validateStatDef),
    alignments: loadAndValidate(path.join(CHAR_CREATION_DIR, 'alignments.yml'), validateAlignment),
    dayJobs: loadAndValidate(path.join(CHAR_CREATION_DIR, 'day-jobs.yml'), validateDayJob),
    itemSets: loadAndValidate(path.join(CHAR_CREATION_DIR, 'item-sets.yml'), validateItemSet),
  };
}

/** Build the prod-faithful, Discord-free engine, mirroring `sim/engine-factory.ts`'s setup plus the
 *  real assets. `closeDb()` first defends against a leaked singleton connection in the same process. */
export function buildAgentEngine(config: AgentEngineConfig): AgentEngine {
  if (!config.pipelineLlmGateway && !config.apiKey) {
    throw new Error('buildAgentEngine: provide either a pipelineLlmGateway (tests) or an apiKey (real run)');
  }

  closeDb();
  const db = initDb(':memory:');
  migrate(db);

  const assets = loadAssets();
  const dayJobs = assets.dayJobs as DayJobDef[];
  const dayJobIncome: Record<string, number> = {};
  for (const job of dayJobs) dayJobIncome[job.name] = job.base_income;

  // A live (apiKey) run with no injected gateway gets the real `ProdLlmGateway`, so the A/B this
  // harness exists to run has a critic to gate; `criticEnabled: false` wins even over an injected one.
  const critic = config.criticEnabled === false
    ? undefined
    : (config.criticGateway ?? (config.apiKey
        ? new ProdLlmGateway({
            apiKey: config.apiKey,
            ...(config.model ? { model: config.model } : {}),
            ...(config.recordLlmCalls ? { recorder: new LlmCallRepository(db) } : {}),
          })
        : undefined));

  const engine = new WorldEngineImpl({
    db,
    userRepo: new UserRepository(db),
    charRepo: new CharacterRepository(db),
    itemRepo: new ItemRepository(db),
    actionRepo: new ActionRepository(db),
    npcRepo: new NpcRepository(db),
    ...(config.pipelineLlmGateway
      ? { pipelineLlmGateway: config.pipelineLlmGateway }
      : {
          pipelineLlm: {
            apiKey: config.apiKey!,
            ...(config.model ? { model: config.model } : {}),
            ...(config.recordLlmCalls ? { recorder: new LlmCallRepository(db) } : {}),
          },
        }),
    ...(config.rollD20 ? { rollD20: config.rollD20 } : {}),
    ...(critic ? { critic } : {}),
    ...(config.criticGateMode ? { criticGateMode: config.criticGateMode } : {}),
    classDefs: assets.classes as ClassDef[],
    upbringingDefs: assets.backgrounds as ModifierDef[],
    raceDefs: assets.races as ModifierDef[],
    dayJobIncome,
    itemSets: assets.itemSets as AgentEngineItemSets,
  });

  const scenes = new SceneLoader(SCENES_DIR).loadAll();
  const tagResolver = new TagResolver(scenes);
  const getCurrentScene = (userId: string): string => {
    const char = engine.getCharacter(userId);
    if (!char) return '';
    const loc = engine.getLocation(char.location);
    const sceneName = tagResolver.resolve(loc?.tags ?? []);
    return scenes.get(sceneName)?.body ?? '';
  };
  const resolveScene = (tags: string[]): { sceneName: string; ascii: string } => {
    const sceneName = tagResolver.resolve(tags);
    const scene = scenes.get(sceneName);
    return { sceneName, ascii: scene?.body ?? '...' };
  };

  return { engine, dayJobs, getCurrentScene, resolveScene, db };
}

/** The `itemSets` shape `WorldEngineImpl` accepts — spelled out here (not `any`) to keep the cast
 *  honest, matching the inline literal type `index.ts` uses. */
type AgentEngineItemSets = Array<{
  name: string;
  for_classes: string[];
  items: Array<{ name: string; emoji: string; stat: string; modifier: number; quantity?: number }>;
}>;
