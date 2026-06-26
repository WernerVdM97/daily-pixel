import type { LlmGateway, LlmContext, LlmDecision, CriticGateway } from '../../llm/LlmGateway.js';
import { buildContextDigest } from '../../llm/prompt-builder.js';
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
  /** Whether the named location is safe (true) or wild (false). Drives the scene safety tag. */
  isLocationSafe(location: string): boolean;
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
  /** Every llm_calls row id produced so far in this action (decisions + their critics). The
   *  narration + resolution-critic ids are appended at resolve; the engine links them all. */
  llmCallIds?: number[];
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
      isLocationSafe: () => true,
    },
    /** Optional coherence critic (Thread 2). When present, the resolution beat is critiqued after
     *  applyOutcomeToMutations — where the final mutations exist — and a minor prose defect in the
     *  outcome_text is rewritten to match the verdict/mutations. Absent = critic disabled. */
    private critic?: CriticGateway,
  ) {}

  async start(
    char: CharacterData,
    rawInput: string,
    items: ItemData[],
    kind: ActionKind = 'quest',
    wage = 0,
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
      const callIds = decisionCallIds(decision);
      const state: InternalActionState = {
        rawInput,
        decisions: [],
        accumulatedDc: decision.baseDc,
        pendingDecision: this.toActionDecision(decision, decision.required),
        distilledType: decision.distilledType,
        rollStat: decision.stat,
        required: decision.required,
        lastActionAt: Date.now(),
        kind,
        wage,
        llmCallIds: callIds,
      };
      // The day-job wage is a guaranteed reward for completing the work — pay it into this
      // auto-finished outcome so it lands in the footer (💰), not as a separate pre-work message.
      const autoMutations: WorldMutation[] = Array.isArray(decision.mutations) ? decision.mutations as WorldMutation[] : [];
      if (wage > 0) autoMutations.push({ type: 'modify_wealth', amount: wage });
      return {
        resolved: true,
        state,
        outcome: {
          distilledType: decision.distilledType,
          finalDc: decision.baseDc,
          playerRolled: null,
          outcome: 'done',
          mutations: autoMutations,
          outcomeText: decision.outcomeText ?? 'The moment passes.',
          ...(decision._llmCallId !== undefined ? { llmCallId: decision._llmCallId } : {}),
          llmCallIds: callIds,
        },
      };
    }

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
      kind,
      wage,
      llmCallIds: decisionCallIds(decision),
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
          llmCallIds: state.llmCallIds ?? [],
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

    // Resolve — at the decision cap, when the LLM still sets the legacy `done`
    // flag, or (the canonical v8 signal) when it returns no real options
    // (empty / all-bail `decision`). E3 contract: an empty real-options array is
    // the primary "resolve now" signal; `done` is honoured as a backstop so a
    // model that still emits it resolves cleanly rather than dead-ending on a lone
    // "Step back". Roll FIRST, then narrate so the prose + mutations match the dice.
    // Accumulate this beat's call id(s) onto the running chain.
    const callIds = [...(state.llmCallIds ?? []), ...decisionCallIds(decision)];

    const realOptions = decision.decision.filter(o => o.dcModifier !== null);
    if (isLastDecision || decision.done || realOptions.length === 0) {
      return this.resolveWithRoll({ ...stateWithStat, llmCallIds: callIds }, char, items, newDc, newDecisions);
    }

    // Continue — advance the current beat's distilled type to the new decision's.
    const nextDecision = this.toActionDecision(decision, state.required);
    const nextState: InternalActionState = {
      ...stateWithStat,
      decisions: newDecisions,
      accumulatedDc: newDc,
      pendingDecision: nextDecision,
      distilledType: decision.distilledType || state.distilledType,
      llmCallIds: callIds,
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
    // Day-job wage — a guaranteed reward for completing the work. Added AFTER the failure-strip so
    // it's paid win or lose, and shown in the outcome footer (💰) rather than a pre-work message.
    if (state.wage && state.wage > 0) {
      mutations.push({ type: 'modify_wealth', amount: state.wage });
    }

    let outcomeText = narration.outcomeText ?? (outcome === 'success'
      ? `Your ${state.distilledType} succeeds.`
      : `Your ${state.distilledType} fails.`);

    // The narration is its own llm_call — add it to the chain to be linked to the action.
    const callIds = [...(state.llmCallIds ?? []), ...decisionCallIds(narration)];

    // Coherence critic (Thread 2): runs HERE, after applyOutcomeToMutations, so it sees the verdict
    // and the FINAL mutations. The dice and engine own the truth; the critic may only rewrite the
    // prose to match it. A minor defect patches outcome_text; anything else keeps the verdict-shaped
    // text we already have. Best-effort — critique() never throws.
    if (this.critic) {
      const verdict = await this.critic.critique({
        beat: 'resolution',
        rollOutcome: outcome === 'success' ? 'success' : 'failure',
        decision: narration,
        finalMutations: mutations,
        contextDigest: buildContextDigest(narrationCtx),
        playerInput: state.rawInput,
        warnings: narration._warnings ?? [],
      });
      if (verdict._llmCallId !== undefined) callIds.push(verdict._llmCallId);
      if (!verdict.ok && verdict.severity === 'minor' && verdict.patch?.outcomeText) {
        outcomeText = verdict.patch.outcomeText;
      } else if (!verdict.ok && verdict.severity === 'major') {
        // The dice + mutations are fixed; a structural defect can't be re-narrated safely, so keep
        // the verdict-shaped text. Logged for mining (critic call itself is already recorded).
        console.warn('[critic] major defect on resolution beat — keeping verdict-shaped text:', verdict.issues.join('; '));
      }
    }

    const finalState: InternalActionState = {
      ...state,
      decisions: newDecisions,
      accumulatedDc: newDc,
      pendingDecision: this.toActionDecision(narration, state.required),
      llmCallIds: callIds,
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
        outcomeText,
        ...(narration._llmCallId !== undefined ? { llmCallId: narration._llmCallId } : {}),
        llmCallIds: callIds,
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

    // When the beat resolves outright and the LLM supplied outcome text, show that
    // as the prompt. The resolve signal is "no rollable options" (the v8 contract)
    // OR the legacy `done` flag (E3 backstop) — kept consistent with step()/start().
    const hasRealOption = options.some(o => o.dcModifier !== null);
    const prompt = (llm.done || !hasRealOption) && llm.outcomeText
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

    // Known locations now ride their own KNOWN LOCATIONS block (v8+), not the
    // scaling hint — see LlmContext.knownLocations and prompt-builder.
    const knownLocations = this.resolver.getKnownLocations();

    // Structured item data for the v9 markdown prompt: per-stat summed bonus (the table's
    // `Gear` column) and the full inventory list. The legacy `scalingHint` string above still
    // carries the same data for the audit digest (buildContextDigest).
    const itemBonusByStat = {
      physical: itemStatModifier(items, 'physical'),
      wisdom: itemStatModifier(items, 'wisdom'),
      intelligence: itemStatModifier(items, 'intelligence'),
      charisma: itemStatModifier(items, 'charisma'),
    };

    return {
      character: {
        class: char.class,
        stats: char.stats,
        health: char.health,
        maxHealth: char.maxHealth,
        stamina: char.stamina,
        maxStamina: char.maxStamina,
        alignment: char.alignment,
        dayJob: char.dayJob,
      },
      location: { name: char.location, isSafe: this.resolver.isLocationSafe(char.location) },
      nearbyNpcs: this.resolver.getNearbyNpcs(char.location),
      nearbyPcs: this.resolver.getNearbyPcs(char.location, char.id),
      recentActions: this.resolver.getRecentActions(char.id),
      knownLocations,
      rawInput,
      ...(previous.length > 0 ? { previousDecisions: previous } : {}),
      itemBonuses: itemBonusByStat,
      inventory: items.map(i => ({ emoji: i.emoji, name: i.name, stat: i.stat, modifier: i.modifier, quantity: i.quantity })),
      scalingHint: hintParts.join(' | ') || 'No relevant items',
    };
  }
}

// ── Module-level helpers ──

/** The llm_calls row id(s) a decision spawned: its own decide call, plus any decision-beat
 *  coherence-critic call attached by CritiquedLlmGateway. Used to link the full call chain. */
function decisionCallIds(d: LlmDecision): number[] {
  const ids: number[] = [];
  if (d._llmCallId !== undefined) ids.push(d._llmCallId);
  if (d._critiqueCallId !== undefined) ids.push(d._critiqueCallId);
  return ids;
}

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
