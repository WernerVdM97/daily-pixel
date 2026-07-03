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
import type { DecisionScript, RollSource } from './types.js';

/** mulberry32 PRNG, deterministic and seedable. Duplicated (not imported) because the
 *  engine's own copies (WorldEngineImpl.ts, discord/commands/hi.ts) are module-private —
 *  the sim's roll determinism doesn't need to track the engine's internal NPC-movement
 *  seeding, just be reproducible on its own. */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build the injected rollD20 the machine calls once per resolution (machine.ts:307). */
export function makeRollD20(source: RollSource): () => number {
  switch (source.kind) {
    case 'fixed':
      return () => source.value;
    case 'sequence': {
      let i = 0;
      return () => {
        if (i >= source.values.length) {
          throw new Error(`sim: rollSource sequence exhausted after ${source.values.length} roll(s)`);
        }
        return source.values[i++];
      };
    }
    case 'seeded': {
      const rng = mulberry32(source.seed);
      return () => Math.floor(rng() * 20) + 1; // maps [0,1) -> 1..20
    }
  }
}

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

/**
 * Mirrors tests/e2e/happy-path.test.ts:70-91 — a real in-memory DB driving the real
 * WorldEngineImpl, with only the LLM and d20 swapped for deterministic sim fixtures.
 *
 * `initDb`/`closeDb` (src/db/connection.ts) hold a module-level singleton connection —
 * a stray open connection from a prior scenario run (same process, e.g. a test file with
 * several `it()`s, or a multi-scenario CLI batch) would leak into this one. closeDb() first
 * is defensive and a safe no-op when nothing is open, guaranteeing each call gets an
 * isolated `:memory:` DB.
 */
export function buildSimEngine(
  rollSource: RollSource,
  script: DecisionScript,
  dayJobIncome: Record<string, number> = {},
): SimEngineHandle {
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
    rollD20: makeRollD20(rollSource),
    dayJobIncome,
  });

  return { engine, llm, db, userRepo, charRepo, itemRepo, actionRepo, npcRepo };
}
