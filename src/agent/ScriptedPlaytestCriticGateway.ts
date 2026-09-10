import type { CritiqueInput, PlaytestCriticGateway, PlaytestReport } from './PlaytestCriticGateway.js';

/**
 * Deterministic, network-free `PlaytestCriticGateway` for tests + CI (JSON-seam M4.5) — the
 * critic's counterpart to `ScriptedAgentPlayerGateway`. Returns a fixed `PlaytestReport` and
 * records every input it was handed, so a test can drive the full feedback plumbing (render →
 * critique → report) and assert on what the critic actually read, with no LLM call.
 */
export class ScriptedPlaytestCriticGateway implements PlaytestCriticGateway {
  /** Every input the critic was handed, in call order — for assertions on what it read. */
  readonly calls: CritiqueInput[] = [];

  constructor(private readonly report: PlaytestReport) {}

  async critique(input: CritiqueInput): Promise<PlaytestReport> {
    this.calls.push(input);
    return this.report;
  }
}
