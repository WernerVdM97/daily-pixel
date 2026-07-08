// Deep-capture (raw prompt + thinking) gating, shared by DeepseekLlmGateway and
// ProdPipelineLlmGateway so both v11 and v12 honour the same LLM_LOG_THINKING contract —
// the pipeline previously ignored the spiral threshold entirely (the prod gap this closes).

import type { ThinkingLogMode } from '../config/env.js';

/** "Spiral" threshold (reasoning chars) past which thinking + prompt are always kept. ~p90 of observed lengths. */
export const SPIRAL_CHARS_DEFAULT = 6000;

export interface CaptureSignals {
  /** Transport error, parse failure, or retry tier > 0. */
  diagnostic: boolean;
  reasoningChars: number | null;
  /** Critic flagged the decision (promoteDeepCapture path). */
  flagged?: boolean;
}

export class DeepCapturePolicy {
  constructor(
    private readonly mode: ThinkingLogMode = 'spiral',
    private readonly spiralChars: number = SPIRAL_CHARS_DEFAULT,
  ) {}

  shouldCapture(signals: CaptureSignals): boolean {
    // Diagnostic/flagged calls are the floor — always captured regardless of mode.
    if (signals.diagnostic || signals.flagged) return true;
    if (this.mode === 'all') return true;
    // A long reasoning chain is itself a "spiral" signal worth mining, even outside 'all' mode.
    if (this.mode === 'spiral' && (signals.reasoningChars ?? 0) > this.spiralChars) return true;
    return false;
  }
}
