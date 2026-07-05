import type { LlmGateway, LlmContext, LlmDecision } from '../llm/LlmGateway.js';
import type { DecisionScript } from './types.js';

/**
 * Scripted, deterministic LLM stand-in for the sim harness. The engine re-wraps
 * `config.llm` in FallbackLlmGateway (WorldEngineImpl.ts:313) — a gateway that THROWS
 * triggers the two-tier retry and, on a second throw, silently swaps in a canned divine-
 * intervention decision. That would corrupt every curve the harness exists to produce,
 * so this gateway must always RETURN a valid LlmDecision, never throw.
 */
export class ScriptedLlmGateway implements LlmGateway {
  private callCount = 0;
  calls: { context: LlmContext }[] = [];

  constructor(private script: DecisionScript) {}

  async decide(context: LlmContext): Promise<LlmDecision> {
    this.calls.push({ context });
    const callNo = this.callCount++;
    return this.script(context, callNo);
  }
}
