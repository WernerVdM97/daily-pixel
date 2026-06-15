import type { LlmGateway, LlmContext, LlmDecision } from '../../llm/LlmGateway.js';
import type {
  ActionState,
  ActionDecision,
  ActionDecisionRecord,
  ActionOutcome,
  WorldMutation,
  CharacterData,
  ItemData,
} from '../WorldEngine.js';
import { accumulateDc, computeItemBonus, resolveRoll, validateDcModifier } from './dc.js';

/**
 * Injectable resolver for world context — NPCs, other PCs, and recent actions.
 * Passed to ActionStateMachine so it can populate the LLM context with live world state
 * without coupling to specific repositories.
 */
export interface WorldContextResolver {
  getNearbyNpcs(location: string): Array<{ name: string; description: string }>;
  getNearbyPcs(location: string, excludeCharId: number): Array<{ name: string; class: string }>;
  getRecentActions(characterId: number): Array<{ type: string; outcome: string }>;
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
  ): Promise<{ state: InternalActionState; firstDecision: ActionDecision }> {
    if (char.rollsRemaining <= 0) {
      throw new Error('No rolls remaining');
    }

    const context = this.buildContext(char, rawInput, [], items);
    const decision = await this.llm.decide(context);

    const firstDecision = this.toActionDecision(decision, decision.required);
    const state: InternalActionState = {
      rawInput,
      decisions: [],
      accumulatedDc: decision.baseDc,
      pendingDecision: firstDecision,
      distilledType: decision.distilledType,
      rollStat: decision.stat,
      required: decision.required,
      lastActionAt: Date.now(),
    };

    return { state, firstDecision };
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

    // Bail
    if (option.dcModifier === null) {
      const record: ActionDecisionRecord = {
        prompt: state.pendingDecision.prompt,
        options: state.pendingDecision.options,
        chosen: choice,
        dcModifier: 0,
      };
      return {
        resolved: true,
        state: {
          ...state,
          decisions: [...state.decisions, record],
          pendingDecision: state.pendingDecision,
        },
        outcome: {
          distilledType: state.distilledType,
          finalDc: state.accumulatedDc,
          playerRolled: null,
          outcome: 'skipped',
          mutations: [],
          outcomeText: 'You retreat from the situation.',
        },
      };
    }

    // Apply choice
    const record: ActionDecisionRecord = {
      prompt: state.pendingDecision.prompt,
      options: state.pendingDecision.options,
      chosen: choice,
      dcModifier: option.dcModifier,
    };
    const newDecisions = [...state.decisions, record];
    const newDc = accumulateDc(state.accumulatedDc, [option.dcModifier]);

    const isLastDecision = state.decisions.length >= 1; // third+ decision capped

    // Call LLM to determine next step
    const context = this.buildContext(char, state.rawInput, recordToPrev(newDecisions), items, state.rollStat);
    const decision = await this.llm.decide(context);

    // Force-resolve if this is the last allowed decision
    if (isLastDecision) {
      const d20 = this.rollD20();
      const bonus = computeItemBonus(items, state.rollStat);
      const outcome = resolveRoll(d20, bonus, newDc);

      const finalState: InternalActionState = {
        ...state,
        decisions: newDecisions,
        accumulatedDc: newDc,
        pendingDecision: this.toActionDecision(decision, state.required),
      };

      return {
        resolved: true,
        state: finalState,
        outcome: {
          distilledType: state.distilledType,
          finalDc: newDc,
          playerRolled: d20,
          outcome,
          mutations: Array.isArray(decision.mutations) ? decision.mutations as WorldMutation[] : [],
          outcomeText: decision.outcomeText ?? (outcome === 'success'
            ? `Your ${state.distilledType} succeeds.`
            : `Your ${state.distilledType} fails.`),
        },
      };
    }

    if (decision.done) {
      // Resolve: roll + outcome
      const d20 = this.rollD20();
      const bonus = computeItemBonus(items, state.rollStat);
      const outcome = resolveRoll(d20, bonus, newDc);

      const finalState: InternalActionState = {
        ...state,
        decisions: newDecisions,
        accumulatedDc: newDc,
        pendingDecision: this.toActionDecision(decision, state.required),
      };

      return {
        resolved: true,
        state: finalState,
        outcome: {
          distilledType: state.distilledType,
          finalDc: newDc,
          playerRolled: d20,
          outcome,
          mutations: Array.isArray(decision.mutations) ? decision.mutations as WorldMutation[] : [],
          outcomeText: decision.outcomeText ?? 'The action resolves.',
        },
      };
    }

    // Continue
    const nextDecision = this.toActionDecision(decision, state.required);
    const nextState: InternalActionState = {
      ...state,
      decisions: newDecisions,
      accumulatedDc: newDc,
      pendingDecision: nextDecision,
    };

    return {
      resolved: false,
      state: nextState,
      nextDecision,
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
    stat?: string,
  ): LlmContext {
    const hintParts: string[] = [];

    // Item bonus for the current stat
    if (stat) {
      const bonus = computeItemBonus(items, stat);
      hintParts.push(bonus !== 0 ? `${stat} item bonus: ${bonus >= 0 ? '+' : ''}${bonus}` : `no ${stat} items`);
    }

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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ensureBail(
  options: Array<{ label: string; dcModifier: number | null }>,
  required: boolean,
): Array<{ label: string; dcModifier: number | null }> {
  if (required) return options;
  if (options.some(o => o.dcModifier === null)) return options;
  return [...options, { label: 'Step back', dcModifier: null }];
}

function recordToPrev(records: ActionDecisionRecord[]): { prompt: string; chosen: string; dcModifier: number }[] {
  return records.map(r => ({
    prompt: r.prompt,
    chosen: r.chosen,
    dcModifier: r.dcModifier,
  }));
}
