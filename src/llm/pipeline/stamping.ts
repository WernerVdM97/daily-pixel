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
 * `resolve-mutate` and `resolve-narrate` both stamp `stampFor('resolve-' + actionType + '-' +
 * verdict)` — they share the same per-type-per-verdict resolve template (e.g.
 * 'v12/resolve-combat-success'), mirroring how `decide` selects per-ActionType
 * ('v12/combat'). The pipeline's D5b inversion splits mutation-authoring from text-authoring
 * at the STAGE level (two calls, a finalize step between them) while both calls still draw
 * their system prompt from the same per-type-per-verdict resolve template. If a future
 * prompt-set version ever needs genuinely different prose per resolve sub-stage, that's a
 * `PromptSet` shape change (new slots), not something to route around here.
 *
 * `decide` and `resolve-mutate`/`resolve-narrate` have no default template — they're ALWAYS
 * per-`ActionType` — so calling these without an `actionType` throws rather than silently
 * guessing a category. The resolve stages also require `verdict`.
 */
export function stampForPipelineStage(
  stage: PipelineStage,
  actionTypeAndVerdict?: { actionType: ActionType; verdict: 'success' | 'failure' } | ActionType,
): string {
  if (stage === 'classify') {
    return stampFor('classify');
  }
  if (stage === 'decide') {
    const actionType = actionTypeAndVerdict as ActionType | undefined;
    if (!actionType) {
      throw new Error(
        "stampForPipelineStage('decide', ...): an actionType is required — decide selects a " +
          'per-ActionType template (no default/shared decide template exists), so there is ' +
          'nothing sensible to stamp without one.',
      );
    }
    return stampFor(`decide/${actionType}`);
  }
  // stage is 'resolve-mutate' | 'resolve-narrate' — both share the per-type-per-verdict resolve slot.
  const av = actionTypeAndVerdict as { actionType: ActionType; verdict: 'success' | 'failure' } | undefined;
  if (!av) {
    throw new Error(
      `stampForPipelineStage('${stage}', ...): actionType and verdict are required — ${stage} selects a ` +
        'per-ActionType-per-verdict template (no default/shared template exists), so there is ' +
        'nothing sensible to stamp without them.',
    );
  }
  return stampFor(`resolve/${av.actionType}/${av.verdict}`);
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
