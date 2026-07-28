import type { Migration } from './types.js';

/**
 * Add `llm_calls.beat` — which authored beat ('decision' | 'resolution', `CriticInput.beat`) a
 * critic call reviewed. NULL on non-critic calls, and on critic rows written before this column
 * existed. Without this, `llmCostSummary.ts`'s actionable-critic count could only report an upper
 * bound (every minor+major verdict): a `major` verdict from a narrate beat is a logged-and-
 * discarded no-op (see `critiqueNarration`), indistinguishable from a `major` from a decide beat
 * (which fires a bounded re-decide) without knowing which beat produced the row. This column
 * closes that gap — see `DeepseekLlmGateway.critique()`'s recorder call. Guarded for idempotency.
 */
export const migration: Migration = {
  id: '202607281200_llm_call_beat',
  up(db) {
    const cols = db.prepare('PRAGMA table_info(llm_calls)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'beat')) {
      db.exec('ALTER TABLE llm_calls ADD COLUMN beat TEXT');
    }
  },
};
