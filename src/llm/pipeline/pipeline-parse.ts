// Small, deliberate duplication (T2 spec §4) of DeepseekLlmGateway.ts's private parse helpers
// (`stripCR`, `parseStat`, `parseOptionStat`, and the NPC-handle resolution in `parseDecision`).
// The pipeline gateway's parse layer is kept independent of the legacy gateway's — sharing them
// would couple two modules that Stage 1's zero-risk-to-v11 constraint (and T7's eventual deletion
// of the legacy gateway) require to stay decoupled.
import type { LlmContext } from '../LlmGateway.js';

/** Strip carriage returns from LLM-authored prose so they don't render as `␍` in Discord. */
export function stripCR(s: string): string {
  return s.replace(/\r/g, '');
}

export function parseStat(raw: unknown): 'physical' | 'wisdom' | 'intelligence' | 'charisma' {
  const s = String(raw ?? 'physical');
  if (['physical', 'wisdom', 'intelligence', 'charisma'].includes(s)) {
    return s as 'physical' | 'wisdom' | 'intelligence' | 'charisma';
  }
  return 'physical';
}

/** Per-option stat override: a valid stat string, or undefined when absent/invalid. */
export function parseOptionStat(raw: unknown): 'physical' | 'wisdom' | 'intelligence' | 'charisma' | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw);
  return ['physical', 'wisdom', 'intelligence', 'charisma'].includes(s)
    ? (s as 'physical' | 'wisdom' | 'intelligence' | 'charisma')
    : undefined;
}

/**
 * Resolve `update_npc`/`remove_npc` `handle` (`[N#]`) references into `npcId`, mirroring
 * `DeepseekLlmGateway.parseDecision`'s `resolveMutations` closure. Handles are ephemeral,
 * index-assigned per turn (`### Present`'s NPC list) — the engine must never see a raw handle.
 */
export function resolveNpcHandles(muts: unknown[], nearbyNpcs: LlmContext['nearbyNpcs']): unknown[] {
  const handleMap = new Map<string, number>();
  nearbyNpcs.forEach((n, i) => handleMap.set(`[N${i + 1}]`, n.id));

  return muts.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const mut = m as Record<string, unknown>;
    const type = String(mut.type ?? '');
    if (type === 'update_npc' || type === 'remove_npc') {
      const handle = String(mut.handle ?? '');
      const npcId = handleMap.get(handle);
      if (npcId === undefined) {
        // Unknown handle — engine has no matching NPC in context; use 0 as sentinel (mirrors legacy).
        console.warn(`[pipeline:parse] ${type}: unknown handle "${handle}" — no matching NPC in context`);
        return { ...mut, npcId: 0 };
      }
      // Destructure handle out so it is truly removed, not set to undefined.
      const { handle: _h, ...rest } = mut;
      return { ...rest, npcId };
    }
    return mut;
  });
}
