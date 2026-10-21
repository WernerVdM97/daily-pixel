/** Parsed here rather than in `agent:play`, which runs `main()` at module scope and cannot be imported by a test. */

import { DeepCapturePolicy } from '../llm/capture-policy.js';
import { isReasoningEffort, type ReasoningEffort } from '../llm/chat-transport.js';
import { readLoggingEnv } from '../config/env.js';

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';

/** The knob, or the default. `null` = a value the model does not serve, for the caller to refuse. */
export function parseReasoningEffort(raw: string | undefined): ReasoningEffort | null {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === '') return DEFAULT_REASONING_EFFORT;
  return isReasoningEffort(value) ? value : null;
}

/** The run's audit dump is on unless the operator opts out with the literal `false`, the same
 *  convention as prod's `ENABLE_COHERENCE_CRITIC`: a paid run should not discard its own audit. */
export function llmCallsDumpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_LLM_CALLS_DUMP !== 'false';
}

/**
 * Deep capture for a live run: `LLM_LOG_THINKING=all` unless the operator pinned a mode, so every
 * recorded stage and critic row keeps the prompt and the reasoning the run paid for. The mode is
 * written back onto `env` so anything else reading the process's logging contract agrees with the
 * capture this run actually selected.
 */
export function agentCapturePolicy(env: NodeJS.ProcessEnv = process.env): DeepCapturePolicy {
  if ((env.LLM_LOG_THINKING ?? '').trim() === '') env.LLM_LOG_THINKING = 'all';
  const logging = readLoggingEnv(env);
  return new DeepCapturePolicy(logging.llmLogThinking, logging.llmSpiralChars);
}
