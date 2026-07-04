import type { LlmDecisionOption } from '../../llm/LlmGateway.js';
import type {
  ActionType,
  RoutingFlags,
  PipelineDecideResult,
  PipelineLlmGateway,
} from '../../llm/pipeline/types.js';
import { heuristicClassify } from '../../llm/pipeline/classifier.js';
import type {
  ActionState,
  ActionDecision,
  ActionOption,
  ActionDecisionRecord,
  ActionOutcome,
  ActionKind,
  WorldMutation,
  CharacterData,
  ItemData,
} from '../WorldEngine.js';
import { accumulateDc, abilityCheckBonus, resolveRoll, validateDcModifier } from './dc.js';
import { buildPipelineContext, type PipelineContextResolver } from './pipeline-context.js';
import type { MutationContext } from './mutations.js';
import { applyTravelCoherenceGate } from './travel-gate.js';

/** ActionState plus the pipeline's internal fields, stored in the JSON column (mirrors
 *  `InternalActionState` in machine.ts, but with `actionType`/`flags` pinned at classify
 *  instead of re-derived per beat — settled decision #4). */
export interface PipelineInternalActionState extends ActionState {
  /** Pinned once at CLASSIFY (NEW_ACTION only); a CONTINUE beat has already been routed. */
  actionType: ActionType;
  flags: RoutingFlags;
  /** Current pending decision, for resume. */
  pendingDecision: ActionDecision;
  /** Free-text narrative/display label (settled decision #5) — decoupled from routing. */
  distilledType: string;
  /** Stat tested by this action's roll. */
  rollStat: string;
  /** The actual `PipelineDecideResult` the last `decide()` call returned — threaded through to
   *  `resolve()`'s RESOLVE-MUTATE/RESOLVE-NARRATE handoff unchanged. Deliberately NOT
   *  reconstructed from pinned fields at handoff time: `accumulatedDc` drifts from decide's raw
   *  `baseDc` once dcModifiers accumulate, and `pendingDecision.options` may carry
   *  `ensureBail`'s synthetic bail option plus clamped `dcModifier` values decide() never
   *  actually returned. */
  lastDecideResult: PipelineDecideResult;
  /** Reactive action — bail not allowed. */
  required: boolean;
  /** Epoch ms last persisted. Used by the 30-min timeout hook. */
  lastActionAt: number;
  /** All llm_calls ids in this action. Task 5 built the per-stage stamp/callKind derivation
   *  (`src/llm/pipeline/stamping.ts`) but nothing wires it into an actual `LlmCallRecorder` call
   *  yet — no live gateway/persistence exists for the pipeline machine in Stage 1 (scope fence).
   *  Stays empty (`state.llmCallIds ?? []` at every read site) until that wiring lands. */
  llmCallIds?: number[];
}

export type PipelineStartResult =
  | { resolved: false; state: PipelineInternalActionState; firstDecision: ActionDecision }
  | { resolved: true; state: PipelineInternalActionState; outcome: ActionOutcome };

export type PipelineStepResult =
  | { resolved: false; state: PipelineInternalActionState; nextDecision: ActionDecision }
  | { resolved: true; state: PipelineInternalActionState; outcome: ActionOutcome };

/** Canned fallback text for the classify-fallback-total-failure path (heuristic miss AND the
 *  LLM fallback call rejects). Self-contained by design — mirrors the flavour of
 *  `FallbackLlmGateway.ts`'s divine intervention message without importing it, since that
 *  module belongs to the legacy string-sentinel path this machine deliberately does not use. */
const PIPELINE_DIVINE_MESSAGE =
  "A flash of light. The Warden's hand on your shoulder. " +
  'You wake beneath the Oak, your action lost to forces beyond mortal ken.';

/** Stamina cost for bailing out of a real (consequential) decision. Same value as legacy's
 *  private `BAIL_STAMINA_COST` — duplicated locally since that constant isn't exported. */
const BAIL_STAMINA_COST = 1;

export class PipelineActionStateMachine {
  constructor(
    private llm: PipelineLlmGateway,
    private rollD20: () => number = () => Math.floor(Math.random() * 20) + 1,
    private resolver: PipelineContextResolver = {
      getNearbyNpcs: () => [],
      getNearbyPcs: () => [],
      getRecentActions: () => [],
      getKnownLocations: () => [],
      isLocationSafe: () => true,
      getLocalGeography: () => ({ region: null, neighbours: [], frontiers: [] }),
    },
    // Defaults to an identity pass-through: this machine never touches a repo or knows about
    // geography itself, so with nobody injecting a real closure (prod wiring is Stage 1
    // out-of-scope — see PipelineActionStateMachine.ts header/plan doc Task 3) proposed
    // mutations pass straight through as final, matching Task 2's prior inline behaviour.
    private finalize: (
      proposed: WorldMutation[],
      ctx: MutationContext,
    ) => { mutations: WorldMutation[]; minted: string[] } = (proposed) => ({ mutations: proposed, minted: [] }),
  ) {}

  async start(
    char: CharacterData,
    rawInput: string,
    items: ItemData[],
    kind: ActionKind = 'quest',
    wage = 0,
  ): Promise<PipelineStartResult> {
    if (char.rollsRemaining <= 0) {
      throw new Error('No rolls remaining');
    }

    const context = buildPipelineContext(this.resolver, char, rawInput, [], items);

    // CLASSIFY fires once per action (settled decision #4): heuristic first, LLM fallback only
    // on a miss. A fallback rejection is the one way `start()` resolves outright in this
    // pipeline — DECIDE itself never authors mutations/outcome_text (D5b split), so short of
    // this failure mode, start() always returns `resolved: false`.
    const classifyResult = heuristicClassify(rawInput);
    let actionType: ActionType;
    let flags: RoutingFlags;
    if (classifyResult.kind === 'hit') {
      actionType = classifyResult.actionType;
      flags = classifyResult.flags;
    } else {
      try {
        const hit = await this.llm.classify(rawInput, context);
        actionType = hit.actionType;
        flags = hit.flags;
      } catch {
        return this.resolveDivineIntervention(rawInput, kind, wage);
      }
    }

    const decideResult = await this.llm.decide({ actionType, flags, context });
    const firstDecision = toActionDecision(decideResult, decideResult.required);

    const state: PipelineInternalActionState = {
      rawInput,
      decisions: [],
      accumulatedDc: decideResult.baseDc,
      kind,
      wage,
      actionType,
      flags,
      pendingDecision: firstDecision,
      distilledType: decideResult.distilledType,
      rollStat: decideResult.stat,
      required: decideResult.required,
      lastDecideResult: decideResult,
      lastActionAt: Date.now(),
    };

    return { resolved: false, state, firstDecision };
  }

  async step(
    state: PipelineInternalActionState,
    choice: string,
    char: CharacterData,
    items: ItemData[],
  ): Promise<PipelineStepResult> {
    const option = state.pendingDecision.options.find(o => o.label === choice);
    if (!option) {
      throw new Error(`Invalid choice: "${choice}"`);
    }

    // Bail
    if (option.dcModifier === null) {
      const record: ActionDecisionRecord = {
        prompt: state.pendingDecision.prompt,
        options: state.pendingDecision.options,
        chosen: choice,
        dcModifier: 0,
        distilledType: state.distilledType,
      };
      const nextState: PipelineInternalActionState = {
        ...state,
        decisions: [...state.decisions, record],
      };
      return {
        resolved: true,
        state: nextState,
        outcome: {
          distilledType: state.distilledType,
          finalDc: state.accumulatedDc,
          playerRolled: null,
          outcome: 'bailed',
          mutations: [{ type: 'modify_stamina', amount: -BAIL_STAMINA_COST }],
          outcomeText: 'You step back from the situation, catching your breath.',
          llmCallIds: state.llmCallIds ?? [],
        },
      };
    }

    const record: ActionDecisionRecord = {
      prompt: state.pendingDecision.prompt,
      options: state.pendingDecision.options,
      chosen: choice,
      dcModifier: option.dcModifier,
      distilledType: state.distilledType,
    };
    const newDecisions = [...state.decisions, record];
    const newDc = accumulateDc(state.accumulatedDc, [option.dcModifier]);

    // Chosen approach selects the stat tested (per-option `stat` overrides the action default).
    const chosenStat = option.stat ?? state.rollStat;
    const stateWithStat: PipelineInternalActionState = { ...state, rollStat: chosenStat };

    // Beat cap mirrors the legacy machine's shape (parity acceptance criterion): after one
    // prior decision beat, resolve without presenting a third. `PipelineDecideResult` has no
    // `done` flag (options-only, by design) so this cap plus the zero-real-options check below
    // are the ONLY resolve-trigger signals available here.
    const isLastDecision = state.decisions.length >= 1;
    if (isLastDecision) {
      return this.resolve(stateWithStat, char, items, newDc, newDecisions, option);
    }

    const context = buildPipelineContext(this.resolver, char, state.rawInput, recordToPrev(newDecisions), items);
    const decideResult = await this.llm.decide({ actionType: state.actionType, flags: state.flags, context });
    const realOptions = decideResult.decision.filter(o => o.dcModifier !== null);

    if (realOptions.length === 0) {
      return this.resolve(stateWithStat, char, items, newDc, newDecisions, option);
    }

    const nextDecision = toActionDecision(decideResult, state.required);
    const nextState: PipelineInternalActionState = {
      ...stateWithStat,
      decisions: newDecisions,
      accumulatedDc: newDc,
      pendingDecision: nextDecision,
      distilledType: decideResult.distilledType || state.distilledType,
      lastDecideResult: decideResult,
    };

    return { resolved: false, state: nextState, nextDecision };
  }

  resume(state: PipelineInternalActionState): { state: PipelineInternalActionState; nextDecision: ActionDecision } {
    return { state, nextDecision: state.pendingDecision };
  }

  /**
   * DICE → RESOLVE-MUTATE → [Task 3's finalize slots in here] → RESOLVE-NARRATE. The D5b
   * inversion this pipeline exists to deliver: mutation-authoring is split from text-authoring
   * so narration can (once Task 3 lands) be written against FINAL, not proposed, mutations.
   */
  private async resolve(
    state: PipelineInternalActionState,
    char: CharacterData,
    items: ItemData[],
    newDc: number,
    newDecisions: ActionDecisionRecord[],
    chosenOption: ActionOption,
  ): Promise<{ resolved: true; state: PipelineInternalActionState; outcome: ActionOutcome }> {
    const context = buildPipelineContext(this.resolver, char, state.rawInput, recordToPrev(newDecisions), items);

    let verdict: 'success' | 'failure';
    let playerRolled: number | null = null;
    let rollBonus: number | undefined;
    if (state.flags.needs_roll) {
      const d20 = this.rollD20();
      rollBonus = abilityCheckBonus(char.stats, items, state.rollStat);
      verdict = resolveRoll(d20, rollBonus, newDc);
      playerRolled = d20;
    } else {
      // rest/travel (this prototype's non-rollable types) resolve automatically — no dice stage.
      verdict = 'success';
    }

    // Structured, typed handoff (Task 2 acceptance criterion) — the actual `PipelineDecideResult`
    // the last `decide()` call returned, carried forward on `state.lastDecideResult`. `decision`
    // is a fresh session per the pipeline contract, so this is what RESOLVE-MUTATE is told was
    // decided, not a shared object.
    const decisionForHandoff = state.lastDecideResult;
    const chosenOptionForHandoff = chosenOption as LlmDecisionOption;

    const { mutations: proposedMutations } = await this.llm.resolveMutate({
      actionType: state.actionType,
      decision: decisionForHandoff,
      chosenOption: chosenOptionForHandoff,
      verdict,
      context,
    });

    // D6 travel-coherence gate: structural backstop against a scene that narrated elsewhere with
    // no relocate mutation (the forge→forest teleport). Injects intent only — geography enforces
    // feasibility once the augmented list flows through finalize below.
    const gatedMutations = applyTravelCoherenceGate(
      proposedMutations as WorldMutation[],
      decisionForHandoff.sceneLocation,
      char.location,
    );

    // The D5b inversion point: engine finalize (geography → collapse → validate) runs here,
    // between mutation-authoring and text-authoring, so RESOLVE-NARRATE below sees what
    // actually landed rather than what RESOLVE-MUTATE proposed. `this.finalize` defaults to an
    // identity pass-through (see constructor) — nobody wires the real WorldEngineImpl-bound
    // closure into a live call site in Stage 1; only this class's own tests inject one.
    const mutationCtx: MutationContext = {
      currentHealth: char.health,
      maxHealth: char.maxHealth,
      stamina: char.stamina,
      maxStamina: char.maxStamina,
      wealth: char.wealth,
      rollsRemaining: char.rollsRemaining,
      location: char.location,
      knownLocations: this.resolver.getKnownLocations(),
    };
    const { mutations: finalMutations } = this.finalize(gatedMutations, mutationCtx);

    const { outcomeText } = await this.llm.resolveNarrate({
      actionType: state.actionType,
      decision: decisionForHandoff,
      chosenOption: chosenOptionForHandoff,
      verdict,
      finalMutations: finalMutations as unknown[],
      context,
    });

    const mutations = [...finalMutations];
    if (state.wage && state.wage > 0) {
      mutations.push({ type: 'modify_wealth', amount: state.wage });
    }

    const finalState: PipelineInternalActionState = {
      ...state,
      decisions: newDecisions,
      accumulatedDc: newDc,
      pendingDecision: { prompt: outcomeText, options: [] },
    };

    return {
      resolved: true,
      state: finalState,
      outcome: {
        distilledType: state.distilledType,
        finalDc: newDc,
        playerRolled,
        ...(rollBonus !== undefined ? { rollBonus } : {}),
        rollStat: state.rollStat,
        outcome: verdict,
        mutations,
        outcomeText,
        llmCallIds: state.llmCallIds ?? [],
      },
    };
  }

  /**
   * The classify-fallback-total-failure path: heuristic missed AND the LLM fallback call
   * rejected. Typed, not string-sentinel (risk table: don't overload `distilledType` with
   * `'__divine__'` the way `FallbackLlmGateway.ts` does) — `isDivineIntervention: true` on the
   * outcome is the only signal. Never lets the rejection escape `start()`.
   */
  private resolveDivineIntervention(
    rawInput: string,
    kind: ActionKind,
    wage: number,
  ): { resolved: true; state: PipelineInternalActionState; outcome: ActionOutcome } {
    const state: PipelineInternalActionState = {
      rawInput,
      decisions: [],
      accumulatedDc: 0,
      kind,
      wage,
      actionType: 'other',
      flags: { unsafe_location: false, needs_roll: false, target_present: false },
      pendingDecision: { prompt: PIPELINE_DIVINE_MESSAGE, options: [] },
      distilledType: 'divine_intervention',
      rollStat: 'physical',
      required: false,
      // No real decide() call happens on this path (classify itself failed) — this mirrors the
      // other hardcoded fields above rather than being read by anything, since divine
      // intervention resolves outright and never reaches resolve()'s handoff.
      lastDecideResult: { distilledType: 'divine_intervention', stat: 'physical', baseDc: 0, required: false, decision: [] },
      lastActionAt: Date.now(),
    };
    return {
      resolved: true,
      state,
      outcome: {
        distilledType: 'divine_intervention',
        finalDc: 0,
        playerRolled: null,
        outcome: 'done',
        mutations: [],
        outcomeText: PIPELINE_DIVINE_MESSAGE,
        isDivineIntervention: true,
      },
    };
  }
}

// ── Module-level helpers ──

/** Small local reimplementation of legacy's private `ensureBail` — generic shape logic, not
 *  legacy-machine-owned, so duplicating it here (rather than importing the private helper)
 *  keeps this file self-contained per the Stage 1 zero-risk-to-v11 constraint. */
function ensureBail(options: ActionOption[], required: boolean): ActionOption[] {
  if (required) return options;
  if (options.some(o => o.dcModifier === null)) return options;
  return [...options, { label: 'Step back', dcModifier: null }];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** DECIDE authors options only (no `prompt`/outcome_text — settled decision), so the beat's
 *  prompt is always the generic approach-picker, never derived from LLM prose. */
function toActionDecision(result: PipelineDecideResult, required: boolean): ActionDecision {
  let options: ActionOption[] = required
    ? result.decision.filter(o => o.dcModifier !== null)
    : [...result.decision];

  // Clamp out-of-range dcModifier on non-bail options — same clamp behaviour as legacy.
  options = options.map(o => {
    if (o.dcModifier !== null && !validateDcModifier(o.dcModifier)) {
      return { ...o, dcModifier: Math.max(-5, Math.min(5, o.dcModifier)) };
    }
    return o;
  });

  return {
    prompt: `${capitalize(result.distilledType)} — choose your approach:`,
    options: ensureBail(options, required),
  };
}

function recordToPrev(records: ActionDecisionRecord[]): { prompt: string; chosen: string; dcModifier: number }[] {
  return records.map(r => ({
    prompt: r.prompt,
    chosen: r.chosen,
    dcModifier: r.dcModifier,
  }));
}
