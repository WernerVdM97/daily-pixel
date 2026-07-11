import type { LlmContext } from '../../src/llm/LlmGateway.js';
import type {
  ClassifyHit,
  PipelineDecideInput,
  PipelineDecideResult,
  PipelineLlmGateway,
  PipelineResolveMutateInput,
  PipelineResolveMutateResult,
  PipelineResolveNarrateInput,
  PipelineResolveNarrateResult,
  PipelineStageResult,
} from '../../src/llm/pipeline/types.js';

/**
 * MockPipelineGateway — test fixture for pipeline action tests.
 * Default responses let most tests run without per-test setup.
 * Call `setClassifyResponse` / `setDecideResponse` / etc. to override.
 * Tracks which stages were invoked via `calls`.
 */
export class MockPipelineGateway implements PipelineLlmGateway {
  private _classify: ((rawInput: string, context: LlmContext) => PipelineStageResult<ClassifyHit>) | null = null;
  private _decide: ((input: PipelineDecideInput) => PipelineStageResult<PipelineDecideResult>) | null = null;
  private _resolveMutate: ((input: PipelineResolveMutateInput) => PipelineStageResult<PipelineResolveMutateResult>) | null = null;
  private _resolveNarrate: ((input: PipelineResolveNarrateInput) => PipelineStageResult<PipelineResolveNarrateResult>) | null = null;

  /** Stages that have been called, in order. */
  readonly calls: string[] = [];

  /** Set the classify response. Call with null to reset to default. */
  setClassifyResponse(fn: ((rawInput: string, context: LlmContext) => PipelineStageResult<ClassifyHit>) | null): void {
    this._classify = fn;
  }

  /** Set the decide response. Call with null to reset to default. */
  setDecideResponse(fn: ((input: PipelineDecideInput) => PipelineStageResult<PipelineDecideResult>) | null): void {
    this._decide = fn;
  }

  /** Set the resolveMutate response. Call with null to reset to default. */
  setResolveMutateResponse(fn: ((input: PipelineResolveMutateInput) => PipelineStageResult<PipelineResolveMutateResult>) | null): void {
    this._resolveMutate = fn;
  }

  /** Set the resolveNarrate response. Call with null to reset to default. */
  setResolveNarrateResponse(fn: ((input: PipelineResolveNarrateInput) => PipelineStageResult<PipelineResolveNarrateResult>) | null): void {
    this._resolveNarrate = fn;
  }

  private defaultClassify(_rawInput: string, _context: LlmContext): PipelineStageResult<ClassifyHit> {
    return {
      result: {
        kind: 'hit',
        actionType: 'search',
        flags: { unsafe_location: false, needs_roll: false, target_present: false },
      },
      callId: 0,
    };
  }

  private defaultDecide(): PipelineStageResult<PipelineDecideResult> {
    return {
      result: {
        distilledType: 'search',
        stat: 'physical',
        baseDc: 12,
        required: false,
        decision: [
          { label: 'Search carefully', dcModifier: 0 },
          { label: 'Rush in', dcModifier: 2 },
          { label: 'Step back', dcModifier: null },
        ],
      },
      callId: 0,
    };
  }

  private defaultResolveMutate(): PipelineStageResult<PipelineResolveMutateResult> {
    return { result: { mutations: [] }, callId: 0 };
  }

  private defaultResolveNarrate(): PipelineStageResult<PipelineResolveNarrateResult> {
    return { result: { outcomeText: 'The moment passes.' }, callId: 0 };
  }

  async classify(rawInput: string, context: LlmContext): Promise<PipelineStageResult<ClassifyHit>> {
    this.calls.push('classify');
    return this._classify ? this._classify(rawInput, context) : this.defaultClassify(rawInput, context);
  }

  async decide(input: PipelineDecideInput): Promise<PipelineStageResult<PipelineDecideResult>> {
    this.calls.push('decide');
    return this._decide ? this._decide(input) : this.defaultDecide();
  }

  async resolveMutate(input: PipelineResolveMutateInput): Promise<PipelineStageResult<PipelineResolveMutateResult>> {
    this.calls.push('resolveMutate');
    return this._resolveMutate ? this._resolveMutate(input) : this.defaultResolveMutate();
  }

  async resolveNarrate(input: PipelineResolveNarrateInput): Promise<PipelineStageResult<PipelineResolveNarrateResult>> {
    this.calls.push('resolveNarrate');
    return this._resolveNarrate ? this._resolveNarrate(input) : this.defaultResolveNarrate();
  }
}
