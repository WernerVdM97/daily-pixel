// Typed "the LLM never came back with something usable" fault, raised by every
// `ProdPipelineLlmGateway` stage and consumed by the two live call sites that fail open on it
// (`PipelineActionStateMachine.start` → divine intervention, `WorldEngineImpl.stepActionPipeline`
// → timed_out).
//
// Why a type rather than a bare `catch`: those call sites must swallow an LLM fault and must NOT
// swallow an engine fault. A bare catch would dress a DB error, a bad mutation, or an outright
// programming mistake in the in-voice "the world stutters" card and hide it from every log and
// every QA run. Discriminating on the error's type keeps the fail-open surface exactly as wide as
// the LLM boundary.

export type PipelineStageFailureKind =
  /** Non-2xx from the API, or the request never completed (DNS, socket, etc). */
  | 'transport'
  /** The request was aborted — almost always `deepseek-transport`'s own abort timeout. */
  | 'timeout'
  /** 2xx, but the body carried no content (null, empty, or whitespace-only). */
  | 'empty'
  /** Content came back but was not JSON. */
  | 'parse'
  /** Valid JSON the stage's own parser rejected (missing/invalid required field). */
  | 'validation';

export class PipelineStageError extends Error {
  /** Stage label — 'classify' | 'decide' | 'resolveMutate' | 'resolveNarrate'. */
  readonly stage: string;
  readonly kind: PipelineStageFailureKind;

  constructor(
    stage: string,
    kind: PipelineStageFailureKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PipelineStageError';
    this.stage = stage;
    this.kind = kind;
  }
}

export function isPipelineStageError(err: unknown): err is PipelineStageError {
  return err instanceof PipelineStageError;
}

/**
 * The fail-open predicate both live call sites gate on: did this throw come from the LLM
 * boundary, or from the engine?
 *
 * The `AbortError` arm is belt-and-braces. Every abort raised inside a pipeline stage is already
 * wrapped as `kind: 'timeout'` above, but the name/message check is what the pre-0.3.4 engine
 * catch used, and a non-pipeline LLM path (or a future gateway that forgets to wrap) still reads
 * correctly through it. Matching on the message too mirrors that original check — undici has
 * historically raised aborts under more than one error name.
 */
export function isLlmStageFailure(err: unknown): boolean {
  if (isPipelineStageError(err)) return true;
  const e = err as { name?: string; message?: string } | null | undefined;
  return e?.name === 'AbortError' || (e?.message ?? '').toLowerCase().includes('abort');
}
