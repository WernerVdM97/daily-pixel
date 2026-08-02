import type { AgentMove, AgentPlayerGateway, ChooseMoveInput } from './AgentPlayerGateway.js';

/**
 * Deterministic, network-free `AgentPlayerGateway` for tests + CI (JSON-seam M4.1) — the
 * agent-player's counterpart to `PipelineScriptedGateway`. It plays back a scripted move
 * sequence in order, so a harness test drives a fully-determined playthrough with no LLM call.
 *
 * Like `PipelineScriptedGateway`, it does NOT reinterpret or soften the script: running past the
 * end of the sequence throws loudly rather than looping or idling, so a scenario that under-runs
 * fails the test visibly instead of hanging the harness on a silently-repeated move.
 */
export class ScriptedAgentPlayerGateway implements AgentPlayerGateway {
  private cursor = 0;

  /** Every input the harness handed the brain, in call order — for test assertions on what the
   *  agent actually saw (screen text, legal moves, character state). */
  readonly calls: ChooseMoveInput[] = [];

  constructor(private readonly moves: AgentMove[]) {}

  async chooseMove(input: ChooseMoveInput): Promise<AgentMove> {
    this.calls.push(input);
    if (this.cursor >= this.moves.length) {
      throw new Error(
        `ScriptedAgentPlayerGateway: script exhausted after ${this.moves.length} move(s) but the ` +
          'harness asked for another. Extend the scripted sequence, or the run went further than ' +
          'the scenario expected.',
      );
    }
    return this.moves[this.cursor++];
  }
}
