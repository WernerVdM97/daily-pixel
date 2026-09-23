import type { AgentMove, AgentPlayerGateway, BrainTurn, ChooseMoveInput } from './AgentPlayerGateway.js';

/**
 * Deterministic, network-free `AgentPlayerGateway` for tests + CI, the agent-player's counterpart to
 * `PipelineScriptedGateway`: a scripted sequence of bare moves or whole turns, replayed in order.
 */
export class ScriptedAgentPlayerGateway implements AgentPlayerGateway {
  private cursor = 0;

  /** Every input the harness handed the brain, in call order — for test assertions on what the agent
   *  actually saw. */
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
