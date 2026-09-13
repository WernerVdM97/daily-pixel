import type { AgentMove, AgentPlayerGateway, BrainTurn, ChooseMoveInput } from './AgentPlayerGateway.js';

/**
 * Deterministic, network-free `AgentPlayerGateway` for tests + CI (JSON-seam M4.1) — the
 * agent-player's counterpart to `PipelineScriptedGateway`. It plays back a scripted move
 * sequence in order, so a harness test drives a fully-determined playthrough with no LLM call.
 *
 * The script is either a list of bare moves (each wrapped into a single-move {@link BrainTurn},
 * so every pre-recon scenario reads as it always did) or a list of whole turns when the scenario
 * exercises the brain's own notes (intent, arc note, day note, dropped notes).
 *
 * Like `PipelineScriptedGateway`, it does NOT reinterpret or soften the script: running past the
 * end of the sequence throws loudly rather than looping or idling, so a scenario that under-runs
 * fails the test visibly instead of hanging the harness on a silently-repeated move.
 */
export class ScriptedAgentPlayerGateway implements AgentPlayerGateway {
  private cursor = 0;

  /** Every input the harness handed the brain, in call order — for test assertions on what the
   *  agent actually saw (screen text, legal moves, character state, and the working-memory block
   *  the turn carried). */
  readonly calls: ChooseMoveInput[] = [];

  private readonly turns: BrainTurn[];

  constructor(script: AgentMove[] | BrainTurn[]) {
    this.turns = script.map((entry) => ('move' in entry ? entry : { move: entry }));
  }

  async chooseMove(input: ChooseMoveInput): Promise<BrainTurn> {
    this.calls.push(input);
    if (this.cursor >= this.turns.length) {
      throw new Error(
        `ScriptedAgentPlayerGateway: script exhausted after ${this.turns.length} move(s) but the ` +
          'harness asked for another. Extend the scripted sequence, or the run went further than ' +
          'the scenario expected.',
      );
    }
    return this.turns[this.cursor++];
  }
}
