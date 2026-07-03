// Per-stage prompt-version stamping for the pipeline machine (Thread D Task 5,
// docs/engine/stage-1-thread-d-backbone-plan.md). Every derivation here goes through the
// EXISTING `stampFor` (prompt-builder.ts) rather than hand-building `${version}/${template}`
// strings, so the pipeline's stamps and the prompt-set's own stamps can never drift apart.
import { stampFor } from '../prompt-builder.js';
import type { ActionType } from './types.js';

/**
 * The pipeline's four call sites (see the plan's pipeline contract diagram). `resolve-mutate`
 * and `resolve-narrate` are two distinct STAGES but not two distinct TEMPLATES — see
 * `stampForPipelineStage` below.
 */
export type PipelineStage = 'classify' | 'decide' | 'resolve-mutate' | 'resolve-narrate';

/**
 * Derive the `promptVersion` stamp an `llm_calls` row for this stage should carry.
 *
 * `resolve-mutate` and `resolve-narrate` both stamp `stampFor('resolve')` — this is correct,
 * not a bug: `PromptSet` (prompt-builder.ts) has exactly one `resolve` template slot, not a
 * separate mutate/narrate pair. The pipeline's D5b inversion splits mutation-authoring from
 * text-authoring at the STAGE level (two calls, a finalize step between them) while both calls
 * still draw their system prompt from the same v12 resolve template. If a future prompt-set
 * version ever needs genuinely different prose per resolve sub-stage, that's a `PromptSet`
 * shape change (a new slot), not something to route around here.
 *
 * `decide` has no default template — it's ALWAYS per-`ActionType` (loadPromptSet(...).decide[type]
 * in prompt-builder.ts) — so calling this for 'decide' without an `actionType` throws rather
 * than silently guessing a category.
 */
export function stampForPipelineStage(stage: PipelineStage, actionType?: ActionType): string {
  if (stage === 'classify') {
    return stampFor('classify');
  }
  if (stage === 'decide') {
    if (!actionType) {
      throw new Error(
        "stampForPipelineStage('decide', ...): an actionType is required — decide selects a " +
          'per-ActionType template (no default/shared decide template exists), so there is ' +
          'nothing sensible to stamp without one.',
      );
    }
    return stampFor(actionType);
  }
  // stage is 'resolve-mutate' | 'resolve-narrate' here — both share the single `resolve` slot.
  return stampFor('resolve');
}

/**
 * Canonical `LlmCallRecord.callKind` value for a pipeline stage's `llm_calls` row — the
 * "extend callKind to carry the stage" half of Task 5. `LlmCallRecord.callKind` stays a loose
 * `string` (see its doc comment in LlmCallRecorder.ts) rather than a closed union, so this is
 * documentation-by-convention, not a type constraint: `'pipeline-classify'`, `'pipeline-decide'`,
 * `'pipeline-resolve-mutate'`, `'pipeline-resolve-narrate'`.
 */
export function callKindForPipelineStage(stage: PipelineStage): string {
  return `pipeline-${stage}`;
}
