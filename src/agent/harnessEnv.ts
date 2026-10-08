/** Parsed here rather than in `agent:play`, which runs `main()` at module scope and cannot be imported by a test. */

import { isReasoningEffort, type ReasoningEffort } from '../llm/chat-transport.js';

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';

/** The knob, or the default. `null` = a value the model does not serve, for the caller to refuse. */
export function parseReasoningEffort(raw: string | undefined): ReasoningEffort | null {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === '') return DEFAULT_REASONING_EFFORT;
  return isReasoningEffort(value) ? value : null;
}
