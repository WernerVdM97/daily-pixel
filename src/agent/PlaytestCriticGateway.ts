/**
 * The playtest-critic seam (JSON-seam M4.5, goal b — see docs/engine/json-seam-build-plans.md).
 *
 * `PlaytestCriticGateway` is the feedback-pass peer to the move-picker `AgentPlayerGateway`: a
 * single `critique` method that reads a COMPLETED run (the transcript + its scoreboard) and returns
 * a qualitative `PlaytestReport`. Like the brain, it has a real DeepSeek implementation
 * (`ProdPlaytestCriticGateway`) and a deterministic stub (`ScriptedPlaytestCriticGateway`), so the
 * real critic is opt-in on a harness run and CI never touches the network.
 *
 * Imports only the plain transcript value types — no `discord.js`, no engine runtime — so the seam
 * stays transport-neutral (parent decision 3).
 */

import type { TranscriptEvent, TranscriptSummary } from './transcript.js';

/** A completed run handed to the critic: the full ordered event log plus the derived scoreboard.
 *  Plain data (the same shape that serialises to a repro JSON), so the critic is fed exactly what a
 *  human reviewer would read back. */
export interface CritiqueInput {
  events: TranscriptEvent[];
  summary: TranscriptSummary;
}

/** The critic's qualitative playtest report (goal b): the four named dimensions plus an overall
 *  read. Each field is a short prose paragraph the critic writes — not a score. */
export interface PlaytestReport {
  pacing: string;
  clarity: string;
  fun: string;
  difficulty: string;
  /** Overall verdict plus the single most important thing to fix. */
  summary: string;
}

export interface PlaytestCriticGateway {
  /** Read a completed run and return a `PlaytestReport`. Implementations THROW on an unusable
   *  response (unparseable JSON, a missing/empty dimension) — the caller owns what to do with a
   *  failed critique, not the gateway (same fail-loud contract as the brain). */
  critique(input: CritiqueInput): Promise<PlaytestReport>;
}
