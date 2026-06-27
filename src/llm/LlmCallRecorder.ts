// LlmCallRecorder — sink for per-attempt LLM audit rows.
//
// Defined in the llm layer so the gateway depends only on this interface, not on
// the db repository. LlmCallRepository (db/repositories/llm-call.ts) implements it.

/** One LLM call attempt, success or failure. Mirrors the llm_calls table. */
export interface LlmCallRecord {
  /** App build (VERSION) that produced this call. */
  appVersion: string;
  promptVersion: string;
  /** Which pipeline stage produced this call: 'decision' (default) or 'critic'. Lets the
   *  coherence critic be mined separately from the decision call. */
  callKind?: string;
  /** Critic verdict for a critic call: 'ok' | 'minor' | 'major'. NULL/absent on decision calls
   *  and on critic calls that failed before producing a verdict. */
  criticSeverity?: string | null;
  model: string;
  temperature: number;
  /** 0 = primary call, 1 = stripped-context retry (FallbackLlmGateway tier 1). */
  tier: number;
  playerInput: string;
  /** Compact JSON snapshot of the context (deduped, no boilerplate). */
  contextDigest: string;
  /** Full user message — populated only for diagnostic calls (error/parse-fail/retry), else null. */
  rawPrompt: string | null;
  /** Full LLM thinking — populated only for diagnostic calls, else null. */
  reasoning: string | null;
  /** Raw LLM content — only on a successful parse, else null. */
  responseJson: string | null;
  parseOk: boolean;
  /** validateDecision warnings; empty array when clean. */
  validationWarnings: string[];
  /** Error message when the call failed, else null. */
  error: string | null;
  httpStatus: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** Length of reasoning_content — gauges thinking volume without storing it. */
  reasoningChars: number | null;
  latencyMs: number;
  finishReason: string | null;
}

export interface LlmCallRecorder {
  /** Persist one call attempt and return its row id (for action linkage). */
  record(rec: LlmCallRecord): number;
  /**
   * Backfill `raw_prompt` / `reasoning` on an already-recorded call — used when the coherence
   * critic flags a beat that wasn't deep-captured at record time. Only fills NULL columns
   * (never erases an existing capture). Best-effort; passing a null leaves that column as-is.
   */
  promoteDeepCapture(callId: number, fields: { rawPrompt?: string | null; reasoning?: string | null }): void;
}
