import type { RollSource } from './types.js';

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

/** Build the injected rollD20 the machine calls once per resolution (machine.ts:307). Shared
 *  by both engine-factory.ts's legacy WorldEngineImpl wiring and PipelineSimEngine — pulled
 *  out of engine-factory.ts (Task 4) so PipelineSimEngine.ts doesn't have to import from the
 *  module that constructs it (engine-factory.ts imports PipelineSimEngine to build the
 *  pipeline machine handle), which would otherwise be a circular import. */
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
