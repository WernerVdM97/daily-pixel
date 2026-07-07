import type { LlmContext } from '../llm/LlmGateway.js';
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
} from '../llm/pipeline/types.js';
import type { PipelineStage } from '../llm/pipeline/stamping.js';
import type { PipelineScript, PipelineStageCall } from './types.js';

/**
 * Scripted, deterministic `PipelineLlmGateway` for the sim harness (Thread D Task 4) —
 * the pipeline-machine counterpart to `ScriptedLlmGateway`, which only implements the legacy
 * single-method `LlmGateway` and can't express the pipeline's 4 distinct stage shapes.
 *
 * Unlike `ScriptedLlmGateway`, this class does NOT swallow/reinterpret a script's exceptions.
 * `ScriptedLlmGateway`'s "never throw" discipline exists because `WorldEngineImpl` wraps the
 * legacy gateway in `FallbackLlmGateway`, which retries on a throw and silently swaps in a
 * canned divine-intervention decision on a second one — corrupting a curve without a trace.
 * `PipelineSimEngine` never wraps this gateway in an equivalent decorator, so that specific trap
 * doesn't exist here (`decide`/`resolveMutate`/`resolveNarrate` have no catch anywhere in
 * `PipelineActionStateMachine` either) — a script bug in those three stages propagates straight
 * up through the whole call stack and fails the sim run loudly, which is exactly what we want
 * (mirrors `driver.ts`'s `pickChoice`: a scenario-author bug should fail loudly, not silently
 * skew the curve).
 *
 * `classify` is the one exception worth calling out: `PipelineActionStateMachine.start()` DOES
 * catch a `classify()` rejection locally and turns it into the typed divine-intervention
 * fallback-of-fallback outcome (`isDivineIntervention: true`) — a legitimate, clearly-flagged
 * result, not the silent trap the legacy decorator sets. So a script that omits `classify`
 * deliberately throws here on a heuristic miss, routing into that typed outcome by design.
 */
export class PipelineScriptedGateway implements PipelineLlmGateway {
  private decideCallCount = 0;

  /**
   * Per-call stage + wall-clock latency (Thread D Task 5's latency-tail measurement). Scripted
   * calls are near-instant, so these numbers are not meaningful timings — the point is exercising
   * the measurement plumbing a real gateway would also feed (`summarizePipelineStages`,
   * src/sim/metrics.ts), matching Stage 1's "stub prompts, prove the pipe works" spirit. Recorded
   * even when a call throws (`timed` below uses try/finally): the stage WAS invoked either way,
   * and a script bug still costs wall-clock time worth seeing in the tail.
   */
  readonly stageCalls: PipelineStageCall[] = [];

  constructor(private script: PipelineScript) {}

  private timed<T>(stage: PipelineStage, fn: () => T): T {
    const startedAt = performance.now();
    try {
      return fn();
    } finally {
      this.stageCalls.push({ stage, latencyMs: performance.now() - startedAt });
    }
  }

  async classify(rawInput: string, context: LlmContext): Promise<PipelineStageResult<ClassifyHit>> {
    const result = this.timed('classify', () => {
      if (!this.script.classify) {
        throw new Error(
          `PipelineScriptedGateway: heuristic classify missed on "${rawInput}" and this scenario's ` +
            "script has no classify() callback wired up. Either the scenario's raw input should hit " +
            'the heuristic table (classifier.ts), or the script needs a classify() callback — this is ' +
            'not itself a bug (PipelineActionStateMachine turns it into a typed divine-intervention ' +
            'outcome), but check it was intentional.',
        );
      }
      return this.script.classify(rawInput, context);
    });
    return { result, callId: 0 };
  }

  async decide(input: PipelineDecideInput): Promise<PipelineStageResult<PipelineDecideResult>> {
    const result = this.timed('decide', () => this.script.decide(input, this.decideCallCount++));
    return { result, callId: 0 };
  }

  async resolveMutate(input: PipelineResolveMutateInput): Promise<PipelineStageResult<PipelineResolveMutateResult>> {
    const result = this.timed('resolve-mutate', () => this.script.resolveMutate(input));
    return { result, callId: 0 };
  }

  async resolveNarrate(input: PipelineResolveNarrateInput): Promise<PipelineStageResult<PipelineResolveNarrateResult>> {
    const result = this.timed('resolve-narrate', () => this.script.resolveNarrate(input));
    return { result, callId: 0 };
  }
}
