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
 * Injectable resolver for world context — decouples ActionStateMachine from specific
 * repositories while letting it populate the LLM context with live world state.
 */
export interface WorldContextResolver {
  getNearbyNpcs(location: string): Array<{ name: string; description: string }>;
  getNearbyPcs(location: string, excludeCharId: number): Array<{ name: string; class: string }>;
  getRecentActions(characterId: number): Array<{ type: string; outcome: string; narrative?: string | null }>;
  /** All known location names — retained for the audit digest + stripped retry context. */
  getKnownLocations(): string[];
  /** Whether the named location is safe (true) or wild (false). Drives the scene safety tag. */
  isLocationSafe(location: string): boolean;
  /** v10 "here + exits": the current node's region + charted exits (move targets) and frontier
   *  exits (cross_frontier invitations), so travel is local and geographic. */
  getLocalGeography(location: string): {
    region: string | null;
    neighbours: { name: string; direction: string; difficulty: number }[];
    frontiers: { direction: string; teaser: string | null; difficulty: number }[];
  };
}

/** ActionState plus internal fields stored in the JSON column, not on the public interface. */
export interface InternalActionState extends ActionState {
  /** Current pending decision, for resume. */
  pendingDecision: ActionDecision;
  distilledType: string;
  /** Stat tested by this action's roll. */
  rollStat: string;
  /** Reactive action — bail not allowed. */
  required: boolean;
  /** Epoch ms last persisted. Used by the 30-min timeout hook. */
  lastActionAt: number;
  /** All llm_calls ids in this action (decisions + critics); narration + resolution-critic
   *  ids are appended at resolve, then the engine links them all. */
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
      getLocalGeography: () => ({ region: null, neighbours: [], frontiers: [] }),
    },
    /** Optional coherence critic (Thread 2). When present, the resolution beat is critiqued after
     *  applyOutcomeToMutations (where final mutations exist) and a minor outcome_text defect is
     *  rewritten to match the verdict/mutations. Absent = disabled. */
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

    // Auto-finish: no real choices and not a forced reaction (e.g. travel/rest). Infer completion
    // from the absence of real options rather than trusting the LLM's `done` flag — without it the
    // only alternative is a lone "Step back" dead-end, so resolve immediately as neutral `done`.
    // Divine intervention is excluded — the engine handles it separately (no action row).
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
      // Day-job wage is guaranteed for completing work — pay it into this outcome so it lands in
      // the footer (💰), not as a separate pre-work message.
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

      // Genuine bail — retreating from a real decision costs stamina.
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

    // Chosen approach selects the stat tested. Per-option `stat` overrides the action default;
    // last choice wins on a multi-step action. See ADR per-option-stat-and-ability-checks.
    const chosenStat = option.stat ?? state.rollStat;
    const stateWithStat: InternalActionState = { ...state, rollStat: chosenStat };

    const isLastDecision = state.decisions.length >= 1; // third+ decision capped

    const context = this.buildContext(char, state.rawInput, recordToPrev(newDecisions), items);
    const decision = await this.llm.decide(context);

    // Resolve at the decision cap, on the legacy `done` flag, or (canonical v8 signal) when no real
    // options are returned. E3 contract: empty real-options is the primary "resolve now" signal;
    // `done` is a backstop so a model still emitting it resolves cleanly rather than dead-ending on
    // a lone "Step back". Roll FIRST, then narrate so prose + mutations match the dice. Accumulate
    // this beat's call id(s) onto the running chain.
    const callIds = [...(state.llmCallIds ?? []), ...decisionCallIds(decision)];

    const realOptions = decision.decision.filter(o => o.dcModifier !== null);
    if (isLastDecision || decision.done || realOptions.length === 0) {
      return this.resolveWithRoll({ ...stateWithStat, llmCallIds: callIds }, char, items, newDc, newDecisions);
    }

    // Continue — adopt the new decision's distilled type.
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
   * Roll-first resolution: roll d20 + bonus vs the accumulated DC for the verdict, THEN a second
   * LLM call narrating with that verdict so prose + mutations match the dice. applyOutcomeToMutations
   * still guards the failure case (strips stray rewards, adds the stamina penalty).
   */
  private async resolveWithRoll(
    state: InternalActionState,
    char: CharacterData,
    items: ItemData[],
    newDc: number,
    newDecisions: ActionDecisionRecord[],
  ): Promise<{ resolved: true; state: InternalActionState; outcome: ActionOutcome }> {
    const d20 = this.rollD20();
    // Ability check: d20 + character's stat + item bonus for that stat.
    const bonus = abilityCheckBonus(char.stats, items, state.rollStat);
    const outcome = resolveRoll(d20, bonus, newDc);

    // Narration call — same gateway, verdict attached to the context.
    const narrationCtx = this.buildContext(char, state.rawInput, recordToPrev(newDecisions), items);
    narrationCtx.rollOutcome = outcome === 'success' ? 'success' : 'failure';
    const narration = await this.llm.decide(narrationCtx);

    const mutations = applyOutcomeToMutations(
      outcome,
      Array.isArray(narration.mutations) ? narration.mutations as WorldMutation[] : [],
    );
    // Day-job wage — added AFTER the failure-strip so it's paid win or lose, shown in the footer (💰).
    if (state.wage && state.wage > 0) {
      mutations.push({ type: 'modify_wealth', amount: state.wage });
    }

    let outcomeText = narration.outcomeText ?? (outcome === 'success'
      ? `Your ${state.distilledType} succeeds.`
      : `Your ${state.distilledType} fails.`);

    // The narration is its own llm_call — add it to the chain.
    const callIds = [...(state.llmCallIds ?? []), ...decisionCallIds(narration)];

    // Coherence critic (Thread 2): runs HERE, after applyOutcomeToMutations, so it sees the verdict
    // and FINAL mutations. Dice + engine own the truth; the critic may only rewrite prose to match.
    // A minor defect patches outcome_text; anything else keeps the verdict-shaped text. Best-effort
    // — critique() never throws.
    // Skip the critic when the narration call fell back to canned divine-intervention text —
    // it carries no real mutations and can't be improved, so a critic pass just wastes a call.
    if (this.critic && narration.distilledType !== DIVINE_INTERVENTION_TYPE) {
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
        // Dice + mutations are fixed; a structural defect can't be re-narrated safely, so keep the
        // verdict-shaped text. Logged for mining (the critic call is already recorded).
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
    // Reactive actions strip bail options.
    let options = required
      ? llm.decision.filter(o => o.dcModifier !== null)
      : [...llm.decision];

    // Clamp out-of-range dcModifier on non-bail options.
    options = options.map(o => {
      if (o.dcModifier !== null && !validateDcModifier(o.dcModifier)) {
        return { ...o, dcModifier: Math.max(-5, Math.min(5, o.dcModifier)) };
      }
      return o;
    });

    // On outright resolve with outcome text supplied, use it as the prompt. Resolve signal is
    // "no rollable options" (v8) OR the legacy `done` flag (E3 backstop) — consistent with step()/start().
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

    // Item bonuses per stat — the LLM authors per-option stats and needs to see which approaches
    // the player's gear favours. Ability scores are already in the CHARACTER line.
    // See ADR per-option-stat-and-ability-checks.
    const itemBonuses = ALL_STATS
      .map(s => ({ s, b: itemStatModifier(items, s) }))
      .filter(x => x.b !== 0)
      .map(x => `${x.s} ${x.b >= 0 ? '+' : ''}${x.b}`);
    hintParts.push(itemBonuses.length > 0 ? `item bonuses: ${itemBonuses.join(', ')}` : 'no item stat bonuses');

    // Full inventory — for remove_item targets and avoiding duplicate add_item.
    if (items.length > 0) {
      hintParts.push(`inventory: ${items.map(i => `${i.emoji} ${i.name} (${i.stat}+${i.modifier}, qty ${i.quantity})`).join(', ')}`);
    }

    // Known locations: retained for the digest + stripped retry. The PROMPT now renders the
    // local "here + exits" block (v10) from localGeography instead of this global list.
    const knownLocations = this.resolver.getKnownLocations();
    const localGeography = this.resolver.getLocalGeography(char.location);

    // Structured item data for the v9 markdown prompt: per-stat summed bonus (table `Gear` column)
    // and inventory list. The legacy `scalingHint` above carries the same data for the audit digest.
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
      location: { name: char.location, isSafe: this.resolver.isLocationSafe(char.location), region: localGeography.region },
      nearbyNpcs: this.resolver.getNearbyNpcs(char.location),
      nearbyPcs: this.resolver.getNearbyPcs(char.location, char.id),
      recentActions: this.resolver.getRecentActions(char.id),
      knownLocations,
      localGeography: { neighbours: localGeography.neighbours, frontiers: localGeography.frontiers },
      rawInput,
      ...(previous.length > 0 ? { previousDecisions: previous } : {}),
      itemBonuses: itemBonusByStat,
      inventory: items.map(i => ({ emoji: i.emoji, name: i.name, stat: i.stat, modifier: i.modifier, quantity: i.quantity })),
      scalingHint: hintParts.join(' | ') || 'No relevant items',
    };
  }
}

// ── Module-level helpers ──

/** The llm_calls ids a decision spawned: its own decide call plus any decision-beat
 *  coherence-critic call attached by CritiquedLlmGateway. */
function decisionCallIds(d: LlmDecision): number[] {
  const ids: number[] = [];
  if (d._llmCallId !== undefined) ids.push(d._llmCallId);
  if (d._critiqueCallId !== undefined) ids.push(d._critiqueCallId);
  // A major re-decide discards the flagged decision but keeps its call id here so it still links.
  if (d._supersededCallId !== undefined) ids.push(d._supersededCallId);
  return ids;
}

/** Stamina cost for bailing out of a real (consequential) decision. Skip/Finish cost nothing. */
const BAIL_STAMINA_COST = 1;

/** Flat extra stamina cost on a failed roll, so a loss carries real weight. */
const FAILURE_STAMINA_PENALTY = 2;

/**
 * Shape an outcome's mutations to its roll result. On failure: drop beneficial mutations (positive
 * stat/wealth/roll deltas, gained items), keep costs and world changes (set_location, remove_item,
 * spawn_npc), add a flat stamina penalty. Success passes through unchanged.
 *
 * NOTE: outcome_text is still written before the roll, so on failure the narration may read as a
 * partial success — the deeper fix is rolling before flavour (see [[mvp-llm-prompt-architecture]]).
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
      case 'cross_frontier':
        return false; // a failed roll doesn't break new ground (per the v10 prompt); fall back instead
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
