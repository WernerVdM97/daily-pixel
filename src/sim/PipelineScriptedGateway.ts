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
} from '../llm/pipeline/types.js';
import type { PipelineScript } from './types.js';

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

  constructor(private script: PipelineScript) {}

  async classify(rawInput: string, context: LlmContext): Promise<ClassifyHit> {
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
  }

  async decide(input: PipelineDecideInput): Promise<PipelineDecideResult> {
    return this.script.decide(input, this.decideCallCount++);
  }

  async resolveMutate(input: PipelineResolveMutateInput): Promise<PipelineResolveMutateResult> {
    return this.script.resolveMutate(input);
  }

  async resolveNarrate(input: PipelineResolveNarrateInput): Promise<PipelineResolveNarrateResult> {
    return this.script.resolveNarrate(input);
  }
}
