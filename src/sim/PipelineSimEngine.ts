import { PipelineActionStateMachine, type PipelineInternalActionState } from '../engine/action/PipelineActionStateMachine.js';
import { applyMutations, collapseStackedDeltas, validateMutations, type MutationContext } from '../engine/action/mutations.js';
import type {
  ActionKind,
  ActionOutcome,
  ActionStartResult,
  ActionState,
  ActionStepResult,
  CharacterData,
  ItemData,
  WorldMutation,
} from '../engine/WorldEngine.js';
import type { PipelineLlmGateway } from '../llm/pipeline/types.js';
import { makeRollD20 } from './roll-source.js';
import type { CharacterSeed, RollSource } from './types.js';

// Fresh-character default, duplicated from WorldEngineImpl.ts's private DAILY_ROLL_ALLOWANCE
// (createCharacter, WorldEngineImpl.ts:76,409) — `CharacterSeed` has no rollsRemaining field
// (a real character's is always the day-one default, never scenario-authored), and this
// in-memory adapter has no DB row to read the constant off of. Same duplication rationale as
// engine-factory.ts's own mulberry32 copy: isolated, not meant to track engine internals.
const DAILY_ROLL_ALLOWANCE = 3;

// Stage 1 Task 4 scope fence: this adapter's finalize is collapse+validate ONLY, no geography.
// Geography-in-pipeline fidelity was already proven at the WorldEngineImpl.finalizeMutations
// level in Task 3 (a WorldEngineImpl-bound closure needing DB-backed location/edge repos this
// in-memory sim adapter doesn't have and doesn't need) — Task 4's goal is proving the pipeline
// machine mechanically runs end-to-end through the sim and produces comparable metrics, not
// proving geography works in the pipeline path. A dropped/rewritten mutation from validation
// still lands correctly (matches `finalizeMutations`' own drop-on-invalid contract); only the
// geography step (minting/binding frontier crossings) is absent here.
function finalizeCollapseValidateOnly(
  proposed: WorldMutation[],
  ctx: MutationContext,
): { mutations: WorldMutation[]; minted: string[] } {
  const collapsed = collapseStackedDeltas(proposed);
  const v = validateMutations(collapsed, ctx);
  const mutations = v.valid ? collapsed : collapsed.filter((_, i) => !v.errors.some((e) => e.index === i));
  return { mutations, minted: [] };
}

function toPublicState(internal: PipelineInternalActionState): ActionState {
  return {
    rawInput: internal.rawInput,
    decisions: internal.decisions,
    accumulatedDc: internal.accumulatedDc,
    ...(internal.kind ? { kind: internal.kind } : {}),
  };
}

/**
 * Sim-only adapter satisfying the same narrow surface `driver.ts`'s `runTurn` needs
 * (`startAction`/`stepAction`/`getCharacter`/`getItems` — see `SimEngine` in `types.ts`), but
 * backed by `PipelineActionStateMachine` + in-memory character/item state instead of a real
 * `WorldEngineImpl` (which has no seam to swap the legacy `ActionStateMachine` for the pipeline
 * one — see the Stage 1 Thread D plan's Task 4 "core design decision").
 *
 * Seeds and drives exactly ONE character (id fixed at 1) — the sim harness has never needed
 * more than one per scenario, and a single-character adapter keeps this file's bookkeeping
 * trivial (no user/character repos to fake).
 */
export class PipelineSimEngine {
  private readonly machine: PipelineActionStateMachine;
  private char: CharacterData;
  private items: ItemData[] = [];
  private pendingState: PipelineInternalActionState | null = null;
  private nextItemId = 1;

  constructor(
    rollSource: RollSource,
    llm: PipelineLlmGateway,
    seed: CharacterSeed,
    private readonly discordUserId = 'sim:pipeline',
  ) {
    this.machine = new PipelineActionStateMachine(llm, makeRollD20(rollSource), undefined, finalizeCollapseValidateOnly);
    this.char = {
      id: 1,
      userId: 1,
      name: `Sim ${seed.class}`,
      class: seed.class,
      upbringing: 'Sim',
      race: 'Sim',
      alignment: seed.alignment,
      dayJob: seed.dayJob,
      stats: seed.stats,
      health: seed.health,
      maxHealth: seed.maxHealth,
      stamina: seed.stamina,
      maxStamina: seed.maxStamina,
      rollsRemaining: DAILY_ROLL_ALLOWANCE,
      location: seed.location,
      wealth: seed.wealth,
      lastActionState: null,
      hasRestedToday: false,
      createdAt: new Date(0).toISOString(),
    };
  }

  async startAction(
    characterId: number,
    rawInput: string,
    opts: { kind?: ActionKind; wage?: number } = {},
  ): Promise<ActionStartResult> {
    this.assertCharacterId(characterId);
    if (this.pendingState) {
      throw new Error('An action is already being processed. Finish your current action first.');
    }

    // machine.start() itself throws "No rolls remaining" before doing anything if
    // char.rollsRemaining <= 0 — no separate guard needed here.
    const result = await this.machine.start(this.char, rawInput, this.items, opts.kind, opts.wage);

    // A roll is drained once per action at start, never per beat (matches
    // WorldEngineImpl.startAction's "normal path" — stepAction below never drains further).
    // Divine intervention (the only path start() can resolve synchronously, since DECIDE never
    // authors mutations/outcome_text) drains it too and it is never refunded, same as legacy.
    //
    // CAVEAT for runComparison output: legacy WorldEngineImpl.startAction has a third path this
    // one has no equivalent for — the auto-finish/no-op-refund (`systemRefund`, once-per-day
    // no-op grace), which can make a legacy action free. `PipelineActionStateMachine` doesn't
    // implement that degenerate-shape/no-op-refund path at all (an accepted scope reduction from
    // Task 2's review), so every pipeline-machine action costs exactly 1 roll, unconditionally.
    // Net effect: rollsRemaining/roll-economy curves between runComparison's legacy and pipeline
    // results are NOT apples-to-apples for scenarios that would trigger a legacy no-op refund.
    this.char = { ...this.char, rollsRemaining: Math.max(0, this.char.rollsRemaining - 1) };

    if (result.resolved) {
      this.applyOutcome(result.outcome);
      return {
        state: toPublicState(result.state),
        firstDecision: result.state.pendingDecision,
        outcome: result.outcome,
      };
    }

    this.pendingState = result.state;
    return { state: toPublicState(result.state), firstDecision: result.firstDecision };
  }

  async stepAction(characterId: number, choice: string): Promise<ActionStepResult> {
    this.assertCharacterId(characterId);
    if (!this.pendingState) {
      throw new Error('No action in progress');
    }

    const state = this.pendingState;
    const result = await this.machine.step(state, choice, this.char, this.items);

    if (result.resolved) {
      this.pendingState = null;
      this.applyOutcome(result.outcome);
      return { resolved: true, state: toPublicState(result.state), outcome: result.outcome };
    }

    this.pendingState = result.state;
    return { resolved: false, state: toPublicState(result.state), nextDecision: result.nextDecision };
  }

  getCharacter(discordUserId: string): CharacterData | null {
    return discordUserId === this.discordUserId ? { ...this.char } : null;
  }

  getItems(characterId: number): ItemData[] {
    if (characterId !== this.char.id) return [];
    return this.items.map((i) => ({ ...i }));
  }

  /**
   * Applies a resolved outcome's mutations to in-memory char/item state via the same pure
   * `applyMutations` `WorldEngineImpl.applyResolution` uses — the slice this adapter needs
   * (health/stamina/maxStamina/wealth/rollsRemaining/location, item add/remove). Deliberately
   * skips every DB-only concern the real engine's `applyResolution` also does: no action-row
   * persistence, no NPC spawning/fog-of-war/visit-recording, no cartographer (Task 4 scope
   * fence) — those mutation kinds are silently no-ops via `applyMutations`' own AppliedState
   * shape, which reports them without this adapter acting on them.
   */
  private applyOutcome(outcome: ActionOutcome): void {
    const ctx: MutationContext = {
      currentHealth: this.char.health,
      maxHealth: this.char.maxHealth,
      stamina: this.char.stamina,
      maxStamina: this.char.maxStamina,
      wealth: this.char.wealth,
      rollsRemaining: this.char.rollsRemaining,
      location: this.char.location,
      // No location graph in this in-memory adapter (scope fence: no geography fidelity) —
      // move_to/cross_frontier always succeeds and lands on whatever name the resolution
      // proposed, unvalidated against a known-locations set.
    };
    const applied = applyMutations(outcome.mutations, ctx);

    this.char = {
      ...this.char,
      health: applied.currentHealth,
      stamina: applied.stamina,
      maxStamina: applied.maxStamina,
      wealth: applied.wealth,
      rollsRemaining: applied.rollsRemaining,
      location: applied.location,
    };

    for (const item of applied.itemsToAdd) {
      if (item.quantity <= 0) continue;
      this.items.push({
        id: this.nextItemId++,
        characterId: this.char.id,
        name: item.name,
        emoji: item.emoji,
        stat: item.stat,
        modifier: item.modifier,
        quantity: item.quantity,
      });
    }

    for (const { name, quantity } of applied.itemsToRemove) {
      this.decrementItemByName(name, quantity);
    }
  }

  private decrementItemByName(name: string, quantity: number): void {
    const idx = this.items.findIndex((i) => i.name === name);
    if (idx === -1) return; // hallucinated remove of an unowned item — repo-equivalent no-op
    const item = this.items[idx];
    if (item.quantity <= quantity) {
      this.items.splice(idx, 1);
    } else {
      this.items[idx] = { ...item, quantity: item.quantity - quantity };
    }
  }

  private assertCharacterId(characterId: number): void {
    if (characterId !== this.char.id) {
      throw new Error(
        `PipelineSimEngine: unknown characterId ${characterId} (this adapter seeds exactly one character, id ${this.char.id})`,
      );
    }
  }
}
