import type Database from 'better-sqlite3';
import { WorldEngineImpl } from '../engine/WorldEngineImpl.js';
import { initDb, closeDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { UserRepository } from '../db/repositories/user.js';
import { CharacterRepository } from '../db/repositories/character.js';
import { ItemRepository } from '../db/repositories/item.js';
import { ActionRepository } from '../db/repositories/action.js';
import { NpcRepository } from '../db/repositories/npc.js';
import { ScriptedLlmGateway } from './ScriptedLlmGateway.js';
import { PipelineScriptedGateway } from './PipelineScriptedGateway.js';
import { PipelineSimEngine } from './PipelineSimEngine.js';
import { makeRollD20 } from './roll-source.js';
import type { CharacterSeed, DecisionScript, PipelineScript, RollSource } from './types.js';
import type { PipelineLlmGateway } from '../llm/pipeline/types.js';

export interface SimEngineHandle {
  engine: WorldEngineImpl;
  llm: ScriptedLlmGateway;
  db: Database.Database;
  userRepo: UserRepository;
  charRepo: CharacterRepository;
  itemRepo: ItemRepository;
  actionRepo: ActionRepository;
  npcRepo: NpcRepository;
}

/** Handle for the pipeline machine (Task 4) — no DB/repos at all, since `PipelineSimEngine`
 *  is a pure in-memory adapter (see its file header for why the legacy handle's shape doesn't
 *  apply here). */
export interface PipelineSimEngineHandle {
  engine: PipelineSimEngine;
  llm: PipelineScriptedGateway;
}

/** Opt into the pipeline machine (Task 4 machine-selector knob). `script`/`seed` replace the
 *  legacy `script`/character-creation dance (`engine.createCharacter` + `applySeedOverrides` in
 *  driver.ts) — `PipelineSimEngine`'s constructor seeds its one character directly, since it has
 *  no DB row to create/patch. */
export interface PipelineMachineOptions {
  machine: 'pipeline';
  script: PipelineScript;
  seed: CharacterSeed;
  discordUserId?: string;
}

/**
 * Mirrors tests/e2e/happy-path.test.ts:70-91 — a real in-memory DB driving the real
 * WorldEngineImpl, with only the LLM and d20 swapped for deterministic sim fixtures.
 *
 * `initDb`/`closeDb` (src/db/connection.ts) hold a module-level singleton connection —
 * a stray open connection from a prior scenario run (same process, e.g. a test file with
 * several `it()`s, or a multi-scenario CLI batch) would leak into this one. closeDb() first
 * is defensive and a safe no-op when nothing is open, guaranteeing each call gets an
 * isolated `:memory:` DB.
 *
 * Two overloads, not one widened signature: every existing call site (`driver.ts`,
 * `tests/sim/time.test.ts`) calls the 3-arg legacy form and destructures the concrete legacy
 * fields (`charRepo`, etc.) without narrowing — widening the return type to a
 * `SimEngineHandle | PipelineSimEngineHandle` union would break that destructuring at the type
 * level even though nothing behavioral changed. Overloading keeps the legacy call shape's
 * inferred type EXACTLY what it was pre-Task-4 (zero behavior/type change), and only a caller
 * that explicitly opts into `{ machine: 'pipeline', ... }` sees the pipeline handle type.
 */
export function buildSimEngine(
  rollSource: RollSource,
  script: DecisionScript,
  dayJobIncome?: Record<string, number>,
): SimEngineHandle;
export function buildSimEngine(
  rollSource: RollSource,
  script: DecisionScript | undefined,
  dayJobIncome: Record<string, number> | undefined,
  pipelineOptions: PipelineMachineOptions,
): PipelineSimEngineHandle;
export function buildSimEngine(
  rollSource: RollSource,
  script?: DecisionScript,
  dayJobIncome: Record<string, number> = {},
  pipelineOptionsOrGateway?: PipelineMachineOptions | PipelineLlmGateway,
): SimEngineHandle | PipelineSimEngineHandle {
  const pipelineOptions = pipelineOptionsOrGateway && 'machine' in pipelineOptionsOrGateway
    ? (pipelineOptionsOrGateway as PipelineMachineOptions)
    : undefined;
  const gateway = pipelineOptionsOrGateway && !('machine' in pipelineOptionsOrGateway)
    ? (pipelineOptionsOrGateway as PipelineLlmGateway)
    : undefined;

  if (pipelineOptions?.machine === 'pipeline') {
    if (script) {
      throw new Error(
        'buildSimEngine: a legacy DecisionScript was passed alongside pipelineOptions — pick one machine, not both',
      );
    }

    // No baseline/world DB set up by THIS FACTORY on this branch — spinning one up here would be
    // wasted work the pipeline machine never touches. `PipelineSimEngine` itself now owns a
    // separate, private `:memory:` world DB internally (full migration chain + seed), used for
    // both scene-state relations (Stage 2 T3) and geography reachability-gating (Stage 2 T5b);
    // that's encapsulated inside the engine, not something this factory builds or sees.
    const llm = new PipelineScriptedGateway(pipelineOptions.script);
    const engine = new PipelineSimEngine(rollSource, llm, pipelineOptions.seed, pipelineOptions.discordUserId);
    return { engine, llm };
  }

  if (!script) {
    throw new Error('buildSimEngine: a DecisionScript is required for the legacy machine');
  }

  closeDb();
  const db = initDb(':memory:');
  migrate(db);

  const llm = new ScriptedLlmGateway(script);
  const userRepo = new UserRepository(db);
  const charRepo = new CharacterRepository(db);
  const itemRepo = new ItemRepository(db);
  const actionRepo = new ActionRepository(db);
  const npcRepo = new NpcRepository(db);

  const engine = new WorldEngineImpl({
    db,
    llm,
    userRepo,
    charRepo,
    itemRepo,
    actionRepo,
    npcRepo,
    pipelineLlm: gateway ? undefined : { apiKey: 'sim-key', model: 'sim-model' },
    pipelineLlmGateway: gateway,
    rollD20: makeRollD20(rollSource),
    dayJobIncome,
  });

  return { engine, llm, db, userRepo, charRepo, itemRepo, actionRepo, npcRepo };
}
