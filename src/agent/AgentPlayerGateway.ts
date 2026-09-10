/**
 * The agent-player brain seam (JSON-seam M4.1, see docs/engine/json-seam-build-plans.md, DA-6).
 *
 * `AgentPlayerGateway` is the agent-player's peer to the pipeline's `PipelineLlmGateway`: a single
 * `chooseMove` method the harness calls once per turn. It has a real implementation
 * (`ProdAgentPlayerGateway`, a DeepSeek call) and a deterministic stub
 * (`ScriptedAgentPlayerGateway`) — exactly the split `ProdPipelineLlmGateway` /
 * `PipelineScriptedGateway` established, so the real brain is opt-in on a harness run and CI never
 * touches the network.
 *
 * This module imports NOTHING from `discord.js` or the engine's runtime — only the small value
 * types below — so the seam stays transport-neutral (parent decision 3).
 */

/**
 * A move the brain can commit to. The discriminated union feeds a controller/engine call directly
 * (DA-6): the harness maps each kind to the right seam call.
 *
 * - `menu-pick` / `choice` carry the VIEW's positional button index (from `viewMoves`), not the
 *   list position in `ChooseMoveInput.moves` — so the harness acts on the real button.
 * - `custom` is a free-text action (no screen enumerates it — the harness offers it as a slot).
 * - `bail` abandons the current decision; `sleep` ends the day.
 */
export type AgentMove =
  | { kind: 'menu-pick'; index: number }
  | { kind: 'custom'; text: string }
  | { kind: 'choice'; index: number }
  | { kind: 'bail' }
  | { kind: 'sleep' };

/** A legal move for the current turn, paired with the label the brain reads. The harness builds
 *  this list from `viewMoves(view)` (choice/bail/menu buttons) plus the contextual moves a screen
 *  never enumerates (`custom`, `sleep`). A `custom` entry is a SLOT: its `move.text` is a
 *  placeholder the brain fills in by returning free text. */
export interface LegalMove {
  move: AgentMove;
  label: string;
}

/** The brief character state the brain sees each turn — enough to reason about resources without
 *  leaking engine internals. Mirrors the fields a Discord player reads off their status line. */
export interface AgentCharView {
  name: string;
  class: string;
  health: number;
  maxHealth: number;
  stamina: number;
  maxStamina: number;
  rollsRemaining: number;
  wealth: number;
  location: string;
}

/** One turn of input to the brain: the rendered screen (from `viewToText`), the legal moves, and
 *  the character state. */
export interface ChooseMoveInput {
  screenText: string;
  moves: LegalMove[];
  character: AgentCharView;
}

export interface AgentPlayerGateway {
  /** Pick one of `input.moves` for the current screen. Returns the chosen `AgentMove` (a `custom`
   *  slot is returned with the brain's free text filled in). Implementations THROW on an
   *  unresolvable pick (unparseable response, out-of-range choice, empty custom text) — the
   *  harness owns re-prompt-vs-log (M4.4), not the gateway. */
  chooseMove(input: ChooseMoveInput): Promise<AgentMove>;
}
