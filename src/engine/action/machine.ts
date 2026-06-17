import type { LlmGateway, LlmContext, LlmDecision } from '../../llm/LlmGateway.js';
import type {
  ActionState,
  ActionDecision,
  ActionOption,
  ActionDecisionRecord,
  ActionOutcome,
  WorldMutation,
  CharacterData,
  ItemData,
} from '../WorldEngine.js';
import { accumulateDc, itemStatModifier, abilityCheckBonus, resolveRoll, validateDcModifier } from './dc.js';
import { DIVINE_INTERVENTION_TYPE } from '../../llm/FallbackLlmGateway.js';

/**
 * Injectable resolver for world context — NPCs, other PCs, and recent actions.
 * Passed to ActionStateMachine so it can populate the LLM context with live world state
 * without coupling to specific repositories.
 */
export interface WorldContextResolver {
  getNearbyNpcs(location: string): Array<{ name: string; description: string }>;
  getNearbyPcs(location: string, excludeCharId: number): Array<{ name: string; class: string }>;
  getRecentActions(characterId: number): Array<{ type: string; outcome: string; narrative?: string | null }>;
  /** All known location names — so the LLM can generate valid set_location mutations. */
  getKnownLocations(): string[];
}

/**
 * Extends ActionState with internal fields stored in the JSON column
 * but not exposed on the public ActionState interface.
 */
export interface InternalActionState extends ActionState {
  /** The current pending decision (for resume). Stored in last_action_state JSON. */
  pendingDecision: ActionDecision;
  /** The distilled action type from the LLM. */
  distilledType: string;
  /** The stat used for this action's roll. */
  rollStat: string;
  /** Whether this is a reactive action — bail is not allowed. */
  required: boolean;
  /** Epoch ms when this state was last persisted. Used by the 30-min timeout hook. */
  lastActionAt: number;
  /** Mutations from the LLM when it resolved immediately (done: true).
   *  Used so bail on a pre-resolved action applies the LLM's mutations instead of empty arrays. */
  preResolvedMutations?: WorldMutation[];
  preResolvedOutcomeText?: string;
  /** Id of the llm_calls audit row that produced the pre-resolved mutations. */
  preResolvedLlmCallId?: number;
}

export class ActionStateMachine {
  constructor(
    private llm: LlmGateway,
    private rollD20: () => number = () => Math.floor(Math.random() * 20) + 1,
    private resolver: WorldContextResolver = {
      getNearbyNpcs: () => [],
      getNearbyPcs: () => [],
      getRecentActions: () => [],
      getKnownLocations: () => [],
    },
  ) {}

  async start(
    char: CharacterData,
    rawInput: string,
    items: ItemData[],
  ): Promise<
    | { resolved: false; state: InternalActionState; firstDecision: ActionDecision }
    | { resolved: true; state: InternalActionState; outcome: ActionOutcome }
  > {
    if (char.rollsRemaining <= 0) {
      throw new Error('No rolls remaining');
    }

    const context = this.buildContext(char, rawInput, [], items);
    const decision = await this.llm.decide(context);

    // Auto-finish: the action has no real choices and isn't a forced reaction
    // (e.g. travel/rest). We *infer* completion from the absence of real options
    // rather than trusting the LLM's `done` flag — if it omits `done` but also
    // gives nothing to choose, the only alternative is a lone red "Step back"
    // dead-end, so resolve it immediately as a neutral `done`. Divine intervention
    // is excluded — it has its own handling in the engine (no action row).
    const realOptions = decision.decision.filter(o => o.dcModifier !== null);
    if (
      !decision.required &&
      realOptions.length === 0 &&
      decision.distilledType !== DIVINE_INTERVENTION_TYPE
    ) {
      console.log(
        `[action] auto-finished char=${char.id} ${decision.distilledType} — ` +
        `LLM returned ${decision.decision.length} option(s), 0 real (only step-back)` +
        `${decision.done ? '' : '; done:false → inferred from no options'} | input: "${rawInput}"`,
      );
      const state: InternalActionState = {
        rawInput,
        decisions: [],
        accumulatedDc: decision.baseDc,
        pendingDecision: this.toActionDecision(decision, decision.required),
        distilledType: decision.distilledType,
        rollStat: decision.stat,
        required: decision.required,
        lastActionAt: Date.now(),
      };
      return {
        resolved: true,
        state,
        outcome: {
          distilledType: decision.distilledType,
          finalDc: decision.baseDc,
          playerRolled: null,
          outcome: 'done',
          mutations: Array.isArray(decision.mutations) ? decision.mutations as WorldMutation[] : [],
          outcomeText: decision.outcomeText ?? 'The moment passes.',
          ...(decision._llmCallId !== undefined ? { llmCallId: decision._llmCallId } : {}),
        },
      };
    }

    const firstDecision = this.toActionDecision(decision, decision.required);

    // When the LLM resolves immediately (done: true), stash the mutations and
    // audit call id so the bail path can apply them instead of returning empty arrays.
    const preResolvedMutations = decision.done && Array.isArray(decision.mutations)
      ? decision.mutations as WorldMutation[]
      : undefined;
    const preResolvedOutcomeText = decision.done ? (decision.outcomeText ?? undefined) : undefined;
    const preResolvedLlmCallId = decision.done ? decision._llmCallId : undefined;

    const state: InternalActionState = {
      rawInput,
      decisions: [],
      accumulatedDc: decision.baseDc,
      pendingDecision: firstDecision,
      distilledType: decision.distilledType,
      rollStat: decision.stat,
      required: decision.required,
      lastActionAt: Date.now(),
      ...(preResolvedMutations ? { preResolvedMutations } : {}),
      ...(preResolvedOutcomeText ? { preResolvedOutcomeText } : {}),
      ...(preResolvedLlmCallId !== undefined ? { preResolvedLlmCallId } : {}),
    };

    return { resolved: false, state, firstDecision };
  }

  async step(
    state: InternalActionState,
    choice: string,
    char: CharacterData,
    items: ItemData[],
  ): Promise<
    | { resolved: false; state: InternalActionState; nextDecision: ActionDecision }
    | { resolved: true; state: InternalActionState; outcome: ActionOutcome }
  > {
    const option = state.pendingDecision.options.find(o => o.label === choice);
    if (!option) {
      throw new Error(`Invalid choice: "${choice}"`);
    }

    // Bail / Finish
    if (option.dcModifier === null) {
      const record: ActionDecisionRecord = {
        prompt: state.pendingDecision.prompt,
        options: state.pendingDecision.options,
        chosen: choice,
        dcModifier: 0,
        distilledType: state.distilledType,
      };
      const nextState: InternalActionState = {
        ...state,
        decisions: [...state.decisions, record],
        pendingDecision: state.pendingDecision,
      };

      // Pre-resolved (done) action that still surfaced options — finish it,
      // applying the LLM's mutations. Neutral `done`, no bail cost.
      if (state.preResolvedMutations) {
        return {
          resolved: true,
          state: nextState,
          outcome: {
            distilledType: state.distilledType,
            finalDc: state.accumulatedDc,
            playerRolled: null,
            outcome: 'done',
            mutations: state.preResolvedMutations,
            outcomeText: state.preResolvedOutcomeText ?? 'The moment passes.',
            ...(state.preResolvedLlmCallId !== undefined ? { llmCallId: state.preResolvedLlmCallId } : {}),
          },
        };
      }

      // Genuine bail — the player retreats from a real decision. Costs stamina.
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
        },
      };
    }

    // Apply choice
    const record: ActionDecisionRecord = {
      prompt: state.pendingDecision.prompt,
      options: state.pendingDecision.options,
      chosen: choice,
      dcModifier: option.dcModifier,
      distilledType: state.distilledType,
    };
    const newDecisions = [...state.decisions, record];
    const newDc = accumulateDc(state.accumulatedDc, [option.dcModifier]);

    // The chosen approach selects which stat the roll tests. A per-option `stat`
    // overrides the action default; the last choice wins on a multi-step action.
    // See ADR per-option-stat-and-ability-checks.
    const chosenStat = option.stat ?? state.rollStat;
    const stateWithStat: InternalActionState = { ...state, rollStat: chosenStat };

    const isLastDecision = state.decisions.length >= 1; // third+ decision capped

    // Call LLM to determine next step
    const context = this.buildContext(char, state.rawInput, recordToPrev(newDecisions), items);
    const decision = await this.llm.decide(context);

    // Resolve — at the decision cap, or when the LLM says the action is done.
    // Roll FIRST, then make a narration call so the LLM's prose + mutations match
    // the dice (the first `decision` above only told us whether to resolve).
    if (isLastDecision || decision.done) {
      return this.resolveWithRoll(stateWithStat, char, items, newDc, newDecisions);
    }

    // Continue — advance the current beat's distilled type to the new decision's.
    const nextDecision = this.toActionDecision(decision, state.required);
    const nextState: InternalActionState = {
      ...stateWithStat,
      decisions: newDecisions,
      accumulatedDc: newDc,
      pendingDecision: nextDecision,
      distilledType: decision.distilledType || state.distilledType,
    };

    return {
      resolved: false,
      state: nextState,
      nextDecision,
    };
  }

  /**
   * Roll-first resolution: roll d20 + item bonus vs the accumulated DC to decide
   * the verdict, THEN make a second LLM call telling it that verdict so the
   * narration and mutations match the dice. `applyOutcomeToMutations` still guards
   * the failure case (strips any stray rewards, adds the stamina penalty).
   */
  private async resolveWithRoll(
    state: InternalActionState,
    char: CharacterData,
    items: ItemData[],
    newDc: number,
    newDecisions: ActionDecisionRecord[],
  ): Promise<{ resolved: true; state: InternalActionState; outcome: ActionOutcome }> {
    const d20 = this.rollD20();
    // Ability check: d20 + character's own stat + item bonus for that stat.
    const bonus = abilityCheckBonus(char.stats, items, state.rollStat);
    const outcome = resolveRoll(d20, bonus, newDc);

    // Narration call — same gateway, with the verdict attached to the context.
    const narrationCtx = this.buildContext(char, state.rawInput, recordToPrev(newDecisions), items);
    narrationCtx.rollOutcome = outcome === 'success' ? 'success' : 'failure';
    const narration = await this.llm.decide(narrationCtx);

    const mutations = applyOutcomeToMutations(
      outcome,
      Array.isArray(narration.mutations) ? narration.mutations as WorldMutation[] : [],
    );

    const finalState: InternalActionState = {
      ...state,
      decisions: newDecisions,
      accumulatedDc: newDc,
      pendingDecision: this.toActionDecision(narration, state.required),
    };

    return {
      resolved: true,
      state: finalState,
      outcome: {
        distilledType: state.distilledType,
        finalDc: newDc,
        playerRolled: d20,
        rollBonus: bonus,
        rollStat: state.rollStat,
        outcome,
        mutations,
        outcomeText: narration.outcomeText ?? (outcome === 'success'
          ? `Your ${state.distilledType} succeeds.`
          : `Your ${state.distilledType} fails.`),
        ...(narration._llmCallId !== undefined ? { llmCallId: narration._llmCallId } : {}),
      },
    };
  }

  resume(state: InternalActionState): { state: InternalActionState; nextDecision: ActionDecision } {
    return {
      state,
      nextDecision: state.pendingDecision,
    };
  }

  private toActionDecision(llm: LlmDecision, required = false): ActionDecision {
    // Enforce required: strip bail options when action is reactive
    let options = required
      ? llm.decision.filter(o => o.dcModifier !== null)
      : [...llm.decision];

    // Validate dcModifier range on non-bail options, clamp out-of-range
    options = options.map(o => {
      if (o.dcModifier !== null && !validateDcModifier(o.dcModifier)) {
        return { ...o, dcModifier: Math.max(-5, Math.min(5, o.dcModifier)) };
      }
      return o;
    });

    // When resolved immediately (done: true) with no options, show the outcome text
    const prompt = llm.done && llm.outcomeText
      ? llm.outcomeText
      : (llm.prompt ?? `${capitalize(llm.distilledType)} — choose your approach:`);

    return {
      prompt,
      options: ensureBail(options, required),
    };
  }

  private buildContext(
    char: CharacterData,
    rawInput: string,
    previous: { prompt: string; chosen: string; dcModifier: number }[],
    items: ItemData[],
  ): LlmContext {
    const hintParts: string[] = [];

    // Item bonuses for every stat — the LLM authors per-option stats and needs to
    // see which approaches the player's gear favours. Character ability scores are
    // already in the CHARACTER line. See ADR per-option-stat-and-ability-checks.
    const itemBonuses = ALL_STATS
      .map(s => ({ s, b: itemStatModifier(items, s) }))
      .filter(x => x.b !== 0)
      .map(x => `${x.s} ${x.b >= 0 ? '+' : ''}${x.b}`);
    hintParts.push(itemBonuses.length > 0 ? `item bonuses: ${itemBonuses.join(', ')}` : 'no item stat bonuses');

    // Full inventory — lets the LLM decide remove_item targets and avoid duplicate add_item
    if (items.length > 0) {
      hintParts.push(`inventory: ${items.map(i => `${i.emoji} ${i.name} (${i.stat}+${i.modifier}, qty ${i.quantity})`).join(', ')}`);
    }

    // Known locations — the LLM MUST use exact names from this list for set_location
    const locations = this.resolver.getKnownLocations();
    if (locations.length > 1) {
      hintParts.push(`locations: ${locations.join(', ')}`);
    }

    return {
      character: {
        class: char.class,
        stats: char.stats,
        health: char.health,
        stamina: char.stamina,
        alignment: char.alignment,
        dayJob: char.dayJob,
      },
      location: { name: char.location },
      nearbyNpcs: this.resolver.getNearbyNpcs(char.location),
      nearbyPcs: this.resolver.getNearbyPcs(char.location, char.id),
      recentActions: this.resolver.getRecentActions(char.id),
      rawInput,
      ...(previous.length > 0 ? { previousDecisions: previous } : {}),
      scalingHint: hintParts.join(' | ') || 'No relevant items',
    };
  }
}

// ── Module-level helpers ──

/** Stamina cost for bailing out of a real (consequential) decision. Skip/Finish cost nothing. */
const BAIL_STAMINA_COST = 1;

/** Flat extra stamina cost on a failed roll, so a loss carries real weight. */
const FAILURE_STAMINA_PENALTY = 2;

/**
 * Shape an outcome's mutations to its roll result. A failed action yields no
 * reward: beneficial mutations (positive stat/wealth/roll deltas, gained items)
 * are dropped, costs and world changes (set_location, remove_item, spawn_npc)
 * are kept, and a flat stamina penalty is added. Success passes through unchanged.
 *
 * NOTE: the LLM's outcome_text is still written before the roll, so on a failure
 * the narration may read as a partial success — the deeper fix is rolling before
 * the flavour is generated (see [[mvp-llm-prompt-architecture]]).
 */
export function applyOutcomeToMutations(outcome: string, mutations: WorldMutation[]): WorldMutation[] {
  if (outcome !== 'failure') return mutations;
  const kept = mutations.filter((m) => {
    switch (m.type) {
      case 'modify_wealth':
      case 'modify_stamina':
      case 'modify_health':
      case 'modify_rolls_remaining':
      case 'modify_max_stamina':
        return Number(m.amount ?? 0) < 0; // keep only costs, drop gains
      case 'add_item':
        return false; // no rewards on a failed action
      default:
        return true; // set_location, remove_item, spawn_npc stay
    }
  });
  kept.push({ type: 'modify_stamina', amount: -FAILURE_STAMINA_PENALTY });
  return kept;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ensureBail(
  options: ActionOption[],
  required: boolean,
): ActionOption[] {
  if (required) return options;
  if (options.some(o => o.dcModifier === null)) return options;
  return [...options, { label: 'Step back', dcModifier: null }];
}

/** The four ability stats, in display order. */
const ALL_STATS = ['physical', 'wisdom', 'intelligence', 'charisma'] as const;

function recordToPrev(records: ActionDecisionRecord[]): { prompt: string; chosen: string; dcModifier: number }[] {
  return records.map(r => ({
    prompt: r.prompt,
    chosen: r.chosen,
    dcModifier: r.dcModifier,
  }));
}
