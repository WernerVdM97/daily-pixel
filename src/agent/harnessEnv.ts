/** Parsed here rather than in `agent:play`, which runs `main()` at module scope and cannot be imported by a test. */

import { DeepCapturePolicy } from '../llm/capture-policy.js';
import { isReasoningEffort, type ReasoningEffort } from '../llm/chat-transport.js';
import { readLoggingEnv, type ThinkingLogMode } from '../config/env.js';

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';

/** The knob, or the default. `null` = a value the model does not serve, for the caller to refuse. */
export function parseReasoningEffort(raw: string | undefined): ReasoningEffort | null {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === '') return DEFAULT_REASONING_EFFORT;
  return isReasoningEffort(value) ? value : null;
}

/** On unless the operator opts out with the literal `false`, prod's `ENABLE_COHERENCE_CRITIC` convention. */
export function llmCallsDumpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_LLM_CALLS_DUMP !== 'false';
}

/** The `LLM_LOG_THINKING` mode this run captures under: `all` unless the operator pinned one. */
export function agentCaptureMode(env: NodeJS.ProcessEnv = process.env): ThinkingLogMode {
  const pinned = (env.LLM_LOG_THINKING ?? '').trim();
  return pinned === '' ? 'all' : readLoggingEnv(env).llmLogThinking;
}

/** Deep capture for a live run, so a recorded row keeps the prompt and reasoning the run paid for. */
export function agentCapturePolicy(env: NodeJS.ProcessEnv = process.env): DeepCapturePolicy {
  return new DeepCapturePolicy(agentCaptureMode(env), readLoggingEnv(env).llmSpiralChars);
}
