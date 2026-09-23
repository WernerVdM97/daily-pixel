import type { LlmContext, LlmDecision, LlmDecisionOption, SceneStateEdge, CriticGateway, CriticInput } from '../../llm/LlmGateway.js';
import { buildContextDigest } from '../../llm/prompt-builder.js';
import type {
  ActionType,
  RoutingFlags,
  PipelineDecideResult,
  PipelineLlmGateway,
} from '../../llm/pipeline/types.js';
import { heuristicClassify } from '../../llm/pipeline/classifier.js';
import { isLlmStageFailure } from '../../llm/pipeline/PipelineStageError.js';
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
  CombatStatusData,
} from '../WorldEngine.js';
import { accumulateDc, abilityCheckBonus, resolveRoll, validateDcModifier } from './dc.js';
import { MAX_DECISIONS_PER_ACTION } from '../../llm/prompt-builder.js';
import { buildPipelineContext, type PipelineContextResolver } from './pipeline-context.js';
import type { MutationContext } from './mutations.js';
import { applyTravelCoherenceGate } from './travel-gate.js';
import {
  resolveCombatRound,
  deriveEnemyMaxHp,
  ENEMY_BONUS_MAX,
  ENEMY_HP_MIN,
  ENEMY_HP_MAX,
  MAX_COMBAT_ROUNDS,
  dangerTier,
  type CombatBeatLog,
  type CombatRoundOutcome,
} from './combat-dc.js';
import {
  readCombatState,
  readCombatSave,
  combatSaveUpdate,
  combatRoundUpdate,
  type CombatState,
} from './combat-state.js';
import { resolveRelationEndpoint, type NearbyNpc } from './relation-wiring.js';
import { criticShouldFire, type CriticGateMode } from './critic-gate.js';

/** ActionState plus the pipeline's internal fields, stored in the JSON column. Mirrors
 *  `InternalActionState` in machine.ts, except `actionType`/`flags` are pinned at classify. */
export interface PipelineInternalActionState extends ActionState {
  /** Pinned once at CLASSIFY (NEW_ACTION only); a CONTINUE beat has already been routed. */
  actionType: ActionType;
  flags: RoutingFlags;
  /** Current pending decision, for resume. */
  pendingDecision: ActionDecision;
  /** Free-text narrative/display label, decoupled from routing. */
  distilledType: string;
  rollStat: string;
  /** The real `PipelineDecideResult` the last `decide()` returned, carried to the resolve handoff
   *  unchanged: rebuilding it from pinned fields would lose the bail option and the dcModifier clamps. */
  lastDecideResult: PipelineDecideResult;
  /** Reactive action — bail not allowed. */
  required: boolean;
  /** The authored relation endpoint resolved on combat establishment, held across rounds so the
   *  npc-name→id resolution gap isn't paid every beat. Undefined when no combat is in progress. */
  combatAnchor?: { node: 'npc' | 'location'; name: string };
  /** Set at establish when an `anchor: 'npc'` foe failed to match a nearby NPC: the model named a
   *  specific foe the DB doesn't have. `resolveCombat` mints it as a real NPC if it survives. */
  unresolvedNpcMint?: { name: string };
  /** Set when a would-be-lethal blow lands after the once-per-day survive-at-1 floor
   *  has already been spent — the hp_zero trace marker on the resolved outcome. */
  hpZero?: boolean;
  /** Set when a desperate-choice beat is pending. The next step() clears it before falling
   *  through: only `last stand` reaches handleCombatStep, `bail bloodied` never gets that far. */
  desperateChoice?: boolean;
  /** Set when the finish/spare fatal-blow beat is pending, carrying the round result computed
   *  before it: the resume must not re-enter the roll logic above and re-roll `rollD20()` twice. */
  fatalBlow?: {
    cs: CombatState;
    roundResult: CombatRoundOutcome;
    playerHpDelta: number;
    playerBonus: number;
    enemyBonus: number;
    dc: number;
  };
  /** Epoch ms last persisted. Used by the 30-min timeout hook. Under the agent harness's advancing
   *  clock a pending action left overnight reads as a day stale and times out on the next step. */
  lastActionAt: number;
  /** Every llm_calls id in this action. Nothing records one yet, so read sites tolerate it
   *  being absent (`state.llmCallIds ?? []`). */
  llmCallIds?: number[];
}

export type PipelineStartResult =
  | { resolved: false; state: PipelineInternalActionState; firstDecision: ActionDecision }
  | { resolved: true; state: PipelineInternalActionState; outcome: ActionOutcome };

export type PipelineStepResult =
  | {
      resolved: false;
      state: PipelineInternalActionState;
      nextDecision: ActionDecision;
      mutations?: WorldMutation[];
      /** Per-round combat telemetry beat, set on every fought round: never on the generic
       *  (non-combat) beat flow or the voluntary bail path. */
      combatBeat?: CombatBeatLog;
    }
  | { resolved: true; state: PipelineInternalActionState; outcome: ActionOutcome };

/** Canned text for the classify-heuristic miss whose LLM fallback also rejects. The voice is
 *  copied from the legacy sentinel path's divine message rather than imported from it. */
const PIPELINE_DIVINE_MESSAGE =
  '⚙️ The world stutters. Your action could not be processed and your action roll ' +
  'has been refunded.';

/** Stamina cost for bailing out of a real (consequential) decision. Same value as legacy's
 *  private `BAIL_STAMINA_COST` — duplicated locally since that constant isn't exported. */
const BAIL_STAMINA_COST = 1;

/** Label of the engine-appended voluntary flee — must stay unique, or `step()`'s label lookup
 *  could land on a wayward LLM-authored option instead of the guaranteed-null bail. */
const COMBAT_FLEE_LABEL = 'Flee the fight';

/** Fatal-blow interstitial labels. Order matters: `combatWinScenario`'s `choicePolicy: 'first-real'`
 *  auto-picks the first non-bail option, so the lethal one must stay listed first. */
const FATAL_BLOW_FINISH_LABEL = 'Finish it';
const FATAL_BLOW_SPARE_LABEL = 'Show mercy';

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
    // Identity pass-through by default: nothing wires a mutation-aware closure in, so proposed
    // mutations pass through as final.
    private finalize: (
      proposed: WorldMutation[],
      ctx: MutationContext,
    ) => { mutations: WorldMutation[]; minted: string[] } = (proposed) => ({ mutations: proposed, minted: [] }),
    // Optional: absent by default, and both critic helpers below are unconditional no-ops
    // without one.
    private critic?: CriticGateway,
    // 'narrate-gated' by default: the decide critic earns its calls on every beat, the narrate
    // critic is structurally near-inert. Pass 'always' for the previous behaviour.
    private criticGateMode: CriticGateMode = 'narrate-gated',
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

    // CLASSIFY fires once per action: heuristic first, LLM fallback only on a miss, and a
    // fallback rejection resolves outright. DECIDE itself never authors mutations or outcome text.
    const classifyResult = heuristicClassify(rawInput);
    let actionType: ActionType;
    let flags: RoutingFlags;
    const gatewayCallIds: number[] = [];
    if (classifyResult.kind === 'hit') {
      actionType = classifyResult.actionType;
      flags = classifyResult.flags;
    } else {
      try {
        const { result: hit, callId: classifyCallId } = await this.llm.classify(rawInput, context);
        actionType = hit.actionType;
        flags = hit.flags;
        if (classifyCallId !== 0) gatewayCallIds.push(classifyCallId);
      } catch {
        return this.resolveDivineIntervention(rawInput, kind, wage);
      }
    }

    // Every LLM stage failure on beat 1 fails open as divine intervention, the shape this situation
    // already has: a system fault with the roll unspent. Beat 2+, where the roll IS spent, cannot.
    let decideResult: PipelineDecideResult;
    let criticCallIds: number[];
    let validatorCallIds: number[];
    try {
      const { result: rawDecideResult, callId: decideCallId } = await this.llm.decide({ actionType, flags, context });
      if (decideCallId !== 0) gatewayCallIds.push(decideCallId);
      const critiqued = await this.critiqueDecide(rawDecideResult, actionType, flags, context);
      criticCallIds = critiqued.criticCallIds;
      const validated = await this.validateSingleOption(critiqued.result, actionType, flags, context);
      decideResult = validated.result;
      validatorCallIds = validated.validatorCallIds;
    } catch (err) {
      if (!isLlmStageFailure(err)) throw err;
      return this.divineOnStageFailure(rawInput, kind, wage, err, 'decide');
    }

    // Auto-resolve on an empty first-beat decision: the model signalled this action needs no
    // player branching, so go straight to resolve rather than serving a bail-only screen.
    if (decideResult.decision.length === 0) {
      // Guard: combat must never auto-resolve on an empty decision[] — it must fight at least one
      // contested round — so synthesise a single required option that routes step() to handleCombatStep.
      if (actionType === 'combat') {
        const allCallIds = [...gatewayCallIds, ...criticCallIds, ...validatorCallIds];
        const combatFirstDecision: ActionDecision = {
          prompt: `${capitalize(decideResult.distilledType)} — what do you do?`,
          options: [
            { label: 'Press the attack', dcModifier: 0, stat: decideResult.stat },
            { label: COMBAT_FLEE_LABEL, dcModifier: null },
          ],
          ...(decideResult.narration ? { narration: decideResult.narration } : {}),
        };
        const combatState: PipelineInternalActionState = {
          rawInput,
          decisions: [],
          accumulatedDc: decideResult.baseDc,
          kind,
          wage,
          actionType,
          flags,
          pendingDecision: combatFirstDecision,
          distilledType: decideResult.distilledType,
          rollStat: decideResult.stat,
          required: decideResult.required,
          lastDecideResult: decideResult,
          lastActionAt: Date.now(),
          ...(allCallIds.length > 0 ? { llmCallIds: allCallIds } : {}),
        };
        return { resolved: false, state: combatState, firstDecision: combatFirstDecision };
      }

      const syntheticOption: ActionOption = { label: rawInput, dcModifier: 0, stat: decideResult.stat };
      const allCallIds = [...gatewayCallIds, ...criticCallIds, ...validatorCallIds];
      const preState: PipelineInternalActionState = {
        rawInput,
        decisions: [],
        accumulatedDc: decideResult.baseDc,
        kind,
        wage,
        actionType,
        flags,
        pendingDecision: { prompt: '', options: [] },
        distilledType: decideResult.distilledType,
        rollStat: decideResult.stat,
        required: decideResult.required,
        lastDecideResult: decideResult,
        lastActionAt: Date.now(),
        ...(allCallIds.length > 0 ? { llmCallIds: allCallIds } : {}),
      };
      let resolved: { state: PipelineInternalActionState; outcome: ActionOutcome };
      try {
        resolved = await this.resolve(preState, char, items, decideResult.baseDc, [], syntheticOption);
      } catch (err) {
        if (!isLlmStageFailure(err)) throw err;
        return this.divineOnStageFailure(rawInput, kind, wage, err, 'auto-resolve');
      }
      return { resolved: true, state: resolved.state, outcome: resolved.outcome };
    }

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
      // Filter zeros: callId === 0 means no recorder was wired for that call.
      ...([...gatewayCallIds, ...criticCallIds, ...validatorCallIds].length > 0
        ? { llmCallIds: [...gatewayCallIds, ...criticCallIds, ...validatorCallIds] }
        : {}),
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
        ...(state.pendingDecision.narration ? { narration: state.pendingDecision.narration } : {}),
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
      ...(state.pendingDecision.narration ? { narration: state.pendingDecision.narration } : {}),
    };
    const newDecisions = [...state.decisions, record];
    const newDc = accumulateDc(state.accumulatedDc, [option.dcModifier]);

    // Chosen approach selects the stat tested (per-option `stat` overrides the action default).
    const chosenStat = option.stat ?? state.rollStat;
    const stateWithStat: PipelineInternalActionState = { ...state, rollStat: chosenStat };

    // ─── COMBAT SUB-MODE GATE ───
    // Reactive combat actions short-circuit the generic beat-cap/decide/resolve flow;
    // `handleCombatStep` owns everything about the round from here.
    if (state.actionType === 'combat' && state.required) {
      return this.handleCombatStep(stateWithStat, char, items, newDc, newDecisions, option);
    }

    // Beat cap: `PipelineDecideResult` has no `done` flag, so this cap plus the zero-real-options
    // check below are the ONLY resolve-trigger signals available here.
    const isLastDecision = state.decisions.length >= MAX_DECISIONS_PER_ACTION - 1;
    if (isLastDecision) {
      return this.resolve(stateWithStat, char, items, newDc, newDecisions, option);
    }

    const context = buildPipelineContext(this.resolver, char, state.rawInput, recordToPrev(newDecisions), items);
    const { result: rawDecideResult, callId: stepDecideCallId } = await this.llm.decide({ actionType: state.actionType, flags: state.flags, context });
    // The gate runs on the fresh decideResult BEFORE the realOptions split below, so one critic
    // pass feeds both the zero-real-options resolve trigger and the normal continue branch.
    const { result: afterCritic, criticCallIds } = await this.critiqueDecide(
      rawDecideResult, state.actionType, state.flags, context,
    );
    const { result: decideResult, validatorCallIds } = await this.validateSingleOption(afterCritic, state.actionType, state.flags, context);
    const beatCallIds = [stepDecideCallId, ...criticCallIds, ...validatorCallIds].filter(id => id !== 0);
    const realOptions = decideResult.decision.filter(o => o.dcModifier !== null);

    if (realOptions.length === 0) {
      // A terminating decide can still declare a fresh scene_location even with no options, so
      // refresh ONLY that for the travel gate; the handoff keeps the prior decide's real options.
      const stateForResolve: PipelineInternalActionState = {
        ...stateWithStat,
        lastDecideResult: {
          ...stateWithStat.lastDecideResult,
          sceneLocation: decideResult.sceneLocation ?? stateWithStat.lastDecideResult.sceneLocation,
        },
        ...(beatCallIds.length > 0
          ? { llmCallIds: [...(stateWithStat.llmCallIds ?? []), ...beatCallIds] }
          : {}),
      };
      return this.resolve(stateForResolve, char, items, newDc, newDecisions, option);
    }

    const nextDecision = toActionDecision(decideResult, state.required);
    const nextState: PipelineInternalActionState = {
      ...stateWithStat,
      decisions: newDecisions,
      accumulatedDc: newDc,
      pendingDecision: nextDecision,
      distilledType: decideResult.distilledType || state.distilledType,
      lastDecideResult: decideResult,
      ...(beatCallIds.length > 0
        ? { llmCallIds: [...(stateWithStat.llmCallIds ?? []), ...beatCallIds] }
        : {}),
    };

    return { resolved: false, state: nextState, nextDecision };
  }

  resume(state: PipelineInternalActionState): { state: PipelineInternalActionState; nextDecision: ActionDecision } {
    return { state, nextDecision: state.pendingDecision };
  }

  /**
   * Builds this round's telemetry beat: the single choke point every beat-emitting path goes
   * through. The bonuses and dc arrive from the caller, so they match what fed `resolveCombatRound`.
   */
  private buildCombatBeat(
    cs: CombatState,
    roundResult: CombatRoundOutcome,
    enemyHpAfter: number,
    appliedPlayerHpDelta: number,
    ops: string[],
    playerBonus: number,
    enemyBonus: number,
    dc: number,
    opts: { floorSave?: boolean; emptyDecisionFallback?: boolean; fatalBlow?: 'finish' | 'spare' } = {},
  ): CombatBeatLog {
    // `set_relation` alone (a round-counter bump) is bookkeeping, not material; HP deltas and loot are.
    const materialMutationFired =
      roundResult.enemyHpDelta !== 0 || roundResult.playerHpDelta !== 0 || ops.some(o => o !== 'set_relation');
    return {
      round: cs.round,
      band: roundResult.band,
      enemyHpBefore: cs.enemyHp,
      enemyHpAfter,
      playerHpDelta: appliedPlayerHpDelta,
      playerD20: roundResult.playerD20,
      playerBonus,
      dc,
      enemyD20: roundResult.enemyD20,
      enemyBonus,
      margin: roundResult.margin,
      materialMutationFired,
      ops,
      marker: 'combat_round',
      ...(opts.floorSave ? { floorSave: true } : {}),
      ...(opts.emptyDecisionFallback ? { emptyDecisionFallback: true } : {}),
      ...(opts.fatalBlow ? { fatalBlow: opts.fatalBlow } : {}),
    };
  }

  /**
   * Combat sub-mode handler: owns the contested roll, band application, persistence and the
   * termination ladder (win / cap-derive / hpZero→failure / continue).
   */
  private async handleCombatStep(
    state: PipelineInternalActionState,
    char: CharacterData,
    items: ItemData[],
    newDc: number,
    newDecisions: ActionDecisionRecord[],
    chosenOption: ActionOption,
  ): Promise<PipelineStepResult> {
    // Build context for scene-state read-back (includes the in_combat edge from any prior beat).
    const context = buildPipelineContext(this.resolver, char, state.rawInput, recordToPrev(newDecisions), items);

    // ── Desperate-choice clear ──
    // `bail bloodied` is caught by step()'s bail check and never reaches here, so a set flag
    // means `last stand`: clear it and fall through to the normal continue flow.
    if (state.desperateChoice) {
      state = { ...state, desperateChoice: undefined };
    }

    // ── Fatal-blow resume ──
    // The interstitial fought no round of its own, so resolve on the result computed before it.
    // Rolling again below would break the one-roll-pair-per-fought-round fixture assumption.
    if (state.fatalBlow) {
      const saved = state.fatalBlow;
      const lethal = chosenOption.label === FATAL_BLOW_FINISH_LABEL;
      const resumedState: PipelineInternalActionState = { ...state, fatalBlow: undefined };
      return this.resolveCombat(
        saved.cs, saved.roundResult, saved.playerHpDelta, lethal ? 0 : 1, 'success',
        resumedState, char, items, newDc, newDecisions, chosenOption,
        saved.playerBonus, saved.enemyBonus, saved.dc,
        lethal ? 'finish' : 'spare',
      );
    }

    // ── Establish or read combat state ──
    let cs = readCombatState(context.sceneState ?? []);

    // Reset on every fresh establish: a new fight's foe is not the old one's, and one action can
    // hold several fights. The `cs.mintName` fallback below covers the cross-action case instead.
    let unresolvedNpcMint: { name: string } | undefined = state.unresolvedNpcMint;

    if (!cs || cs.enemyHp <= 0) {
      unresolvedNpcMint = undefined;
      const enemy = state.lastDecideResult.combatEnemy;
      if (enemy) {
        // Resolve the anchor: npc -> try nearby lookup, default to location.
        let anchor: { node: 'npc' | 'location'; name: string };
        let resolvedNpc: NearbyNpc | undefined;
        if (enemy.anchor === 'npc') {
          const nearbyNpcs = this.resolver.getNearbyNpcs(char.location) as NearbyNpc[];
          const resolved = resolveRelationEndpoint({ node: 'npc', name: enemy.name }, { id: char.id }, nearbyNpcs);
          if (resolved && resolved.type === 'npc') {
            anchor = { node: 'npc', name: resolved.ref };
            resolvedNpc = nearbyNpcs.find((n) => String(n.id) === resolved.ref);
          } else {
            // NPC resolution failed, so fall back to a location-anchored minion. This is the one
            // case that mints, so remember the name: the model named an NPC the DB doesn't have.
            anchor = { node: 'location', name: char.location };
            unresolvedNpcMint = { name: enemy.name };
          }
        } else {
          // Ambient/wildlife foe: may still carry a name, but the mint is gated on the anchor
          // signal rather than on name-presence, so this branch never mints.
          anchor = { node: 'location', name: char.location };
        }

        // Max-HP priority: the resolved NPC's real health, else an `enemy.maxHp` hint (unpopulated
        // in production), else derived from baseDc. A non-positive max falls through.
        const rawMaxHp = resolvedNpc?.health != null && resolvedNpc.health > 0
          ? resolvedNpc.health
          : enemy.maxHp != null
            ? enemy.maxHp
            : deriveEnemyMaxHp(state.lastDecideResult.baseDc);
        const enemyMaxHp = Math.max(ENEMY_HP_MIN, Math.min(ENEMY_HP_MAX, rawMaxHp));
        cs = {
          enemyName: resolvedNpc?.name ?? enemy.name,
          enemyHp: enemyMaxHp,
          enemyMaxHp,
          round: 1,
          anchor,
          baseDc: state.lastDecideResult.baseDc,
          // Also persist the intent on the edge, not just on the per-action marker: the marker
          // dies when the action resolves, and `combatRoundUpdate`'s spread carries this prop on.
          ...(unresolvedNpcMint ? { mintName: unresolvedNpcMint.name } : {}),
        };
      } else {
        // No combatEnemy signal — default to a location-anchored minion (always establishes).
        const enemyMaxHp = deriveEnemyMaxHp(state.lastDecideResult.baseDc);
        cs = {
          enemyName: 'Minion',
          enemyHp: enemyMaxHp,
          enemyMaxHp,
          round: 1,
          anchor: { node: 'location', name: char.location },
          baseDc: state.lastDecideResult.baseDc,
        };
      }
    }

    // Cross-action fallback: the per-action marker is gone once an action resolves (a bail
    // included), so the edge prop is the only carrier left. The marker wins when it is set.
    if (unresolvedNpcMint === undefined && cs.mintName) {
      unresolvedNpcMint = { name: cs.mintName };
    }

    // Pinned on the first write for this fight, so a continue round's re-authored `baseDc` is
    // ignored. The fold below is what bounds the pre-pin fallback to a single round.
    const fightDc = cs.baseDc ?? state.lastDecideResult.baseDc;
    if (cs.baseDc === undefined) cs = { ...cs, baseDc: fightDc };

    // Prefer the state-held anchor: for npc fights `cs.anchor` carries the id-as-name that would
    // fail re-resolution.
    const heldAnchor: { node: 'npc' | 'location'; name: string } =
      state.combatAnchor ?? (cs.anchor as { node: 'npc' | 'location'; name: string });

    // ── Contested roll (both player and engine roll from the same injected rollD20) ──
    const playerD20 = this.rollD20();
    const enemyD20 = this.rollD20();
    const playerBonus = abilityCheckBonus(char.stats, items, state.rollStat);
    const enemyBonus = Math.max(0, Math.min(ENEMY_BONUS_MAX, fightDc - 10));
    const roundResult = resolveCombatRound(playerD20, playerBonus, enemyD20, enemyBonus, 1);

    // ── Apply the band ──
    const newEnemyHp = Math.max(0, Math.min(cs.enemyMaxHp, cs.enemyHp + roundResult.enemyHpDelta));
    const playerHpDelta = roundResult.playerHpDelta;

    // hpZero detection: player HP would drop to ≤0 (the save floor is applied below).
    const hpZeroReached = playerHpDelta < 0 && (char.health + playerHpDelta) <= 0;

    // ── Termination ladder ──
    // 1. WIN: offer the finish/spare interstitial rather than resolving straight through — no LLM
    // call, no roll, no beat, and the computed result rides on `fatalBlow` for the resume.
    if (newEnemyHp <= 0) {
      // Display-only nominal HP: the foe is still alive until the player answers, so banding on the
      // real 0 would read 'Slain' beside the prompt asking whether to kill it. Nothing else changes.
      const fatalStatus = composeCombatStatus(
        cs.enemyName, 1, cs.enemyMaxHp, playerHpDelta, char.health, char.maxHealth,
      );
      const nextDecision: ActionDecision = {
        prompt: `${cs.enemyName} is broken and cannot rise. Finish it, or let it live?`,
        options: [
          { label: FATAL_BLOW_FINISH_LABEL, dcModifier: 0 },
          { label: FATAL_BLOW_SPARE_LABEL, dcModifier: 0 },
        ],
        combatStatus: fatalStatus,
        combatRounds: state.pendingDecision.combatRounds ?? [],
      };
      const nextState: PipelineInternalActionState = {
        ...state,
        decisions: newDecisions,
        accumulatedDc: newDc,
        pendingDecision: nextDecision,
        combatAnchor: heldAnchor,
        unresolvedNpcMint,
        fatalBlow: { cs, roundResult, playerHpDelta, playerBonus, enemyBonus, dc: fightDc },
      };
      return {
        resolved: false,
        state: nextState,
        nextDecision,
      };
    }

    // 2. hpZero → floor + save ladder: survive at 1 HP, once per day.
    if (hpZeroReached) {
      const currentDay = this.resolver.getCurrentDay?.() ?? 0;
      const savedDay = readCombatSave(context.sceneState ?? []);

      if (savedDay === null || savedDay !== currentDay) {
        // ── Desperate-choice beat (first lethal blow today) ──
        // Floor the player to 1 HP and author the combat_save edge. The combat edge keeps this
        // round's number: `round` is a label, not a unique beat id, so the last-stand beat shares it.
        const floorPlayerHpDelta = 1 - char.health;
        const saveRelation = combatSaveUpdate(currentDay);
        const combatEdge = combatRoundUpdate(cs, roundResult.enemyHpDelta, cs.round);

        const floorMutations: WorldMutation[] = [
          { type: 'modify_health' as const, amount: floorPlayerHpDelta },
          { ...combatEdge, type: 'set_relation' } as unknown as WorldMutation,
          { ...saveRelation, type: 'set_relation' } as unknown as WorldMutation,
        ];
        const floorBeat = this.buildCombatBeat(
          cs, roundResult, newEnemyHp, floorPlayerHpDelta, floorMutations.map(m => m.type),
          playerBonus, enemyBonus, fightDc, { floorSave: true },
        );

        // HP=1/delta=0, not the raw math: the floor guarantees survival, so showing the raw (≤0)
        // would put 0 HP beside a live player. The round log appends to the previous decision's.
        const desperateStatus = composeCombatStatus(
          cs.enemyName, newEnemyHp, cs.enemyMaxHp, 0, 1, char.maxHealth,
        );
        const nextDecision: ActionDecision = {
          prompt: 'The blow would be lethal — you feel death\'s cold touch. Make your stand or flee before it\'s too late.',
          options: [
            { label: 'Bail bloodied', dcModifier: null },
            { label: 'Last stand', dcModifier: 0 },
          ],
          combatStatus: desperateStatus,
          combatRounds: [...(state.pendingDecision.combatRounds ?? []), floorBeat],
        };

        const nextState: PipelineInternalActionState = {
          ...state,
          decisions: newDecisions,
          accumulatedDc: newDc,
          desperateChoice: true,
          pendingDecision: nextDecision,
          combatAnchor: heldAnchor,
          unresolvedNpcMint,
        };

        return {
          resolved: false,
          state: nextState,
          nextDecision,
          mutations: floorMutations,
          combatBeat: floorBeat,
        };
      } else {
        // ── Second lethal blow today → HP-zero, resolve failure ──
        // A fresh establish this same call may have just set `unresolvedNpcMint`/`heldAnchor`, so
        // `state` alone can be stale — merge them in.
        return this.resolveCombat(
          cs, roundResult, playerHpDelta, newEnemyHp, 'failure',
          { ...state, combatAnchor: heldAnchor, unresolvedNpcMint }, char, items, newDc, newDecisions, chosenOption,
          playerBonus, enemyBonus, fightDc,
        );
      }
    }

    // 3. Cap-derive: round exceeds MAX_COMBAT_ROUNDS → compare remaining HP fractions
    if (cs.round > MAX_COMBAT_ROUNDS) {
      const playerFraction = (char.health + playerHpDelta) / char.maxHealth;
      const enemyFraction = newEnemyHp / cs.enemyMaxHp;
      const capVerdict = playerFraction >= enemyFraction ? 'success' : 'failure';
      return this.resolveCombat(
        cs, roundResult, playerHpDelta, newEnemyHp, capVerdict,
        { ...state, combatAnchor: heldAnchor, unresolvedNpcMint }, char, items, newDc, newDecisions, chosenOption,
        playerBonus, enemyBonus, fightDc,
      );
    }

    // 4. CONTINUE — apply band, persist combat edge, call DECIDE for the next round.
    const nextRound = cs.round + 1;
    const combatEdge = combatRoundUpdate(
      cs,
      roundResult.enemyHpDelta,
      nextRound,
    );

    // Build the updated scene state for the decide call (the caller hasn't persisted yet,
    // so we append the updated combat edge manually).
    const updatedSceneState: SceneStateEdge[] = [
      ...(context.sceneState ?? []).filter(
        (e) => !(e.relType === 'in_combat' && e.from.type === 'pc'),
      ),
      {
        from: { type: 'pc', ref: String(char.id) },
        to: {
          type: heldAnchor.node === 'npc' ? 'npc' : 'location',
          ref: heldAnchor.name,
        },
        relType: 'in_combat',
        props: { ...combatEdge.props },
      },
    ];

    // Hand DECIDE the just-resolved round's mechanical truth. `combatRoundSummary`, not `rollOutcome`:
    // the latter switches the phase to RESOLVE_ROLL, which this call is not.
    const updatedContext = {
      ...context,
      sceneState: updatedSceneState,
      combatRoundSummary: {
        band: roundResult.band,
        playerHpDelta: roundResult.playerHpDelta,
        enemyHpDelta: roundResult.enemyHpDelta,
        dc: fightDc,
        chosenOption: {
          label: chosenOption.label,
          ...(chosenOption.stat ? { stat: chosenOption.stat } : {}),
        },
      },
    };
    // Deliberately ungated: combat truth is engine-owned (the roll and band already decided this
    // round), so there is nothing authored here for a coherence critic to check.
    const { result: decideResult, callId: combatDecideCallId } = await this.llm.decide({
      actionType: state.actionType,
      flags: state.flags,
      context: updatedContext,
    });

    const nextDecision = toActionDecision(decideResult, state.required);

    // A round needs a genuine trade-off: two options differing on stat or dcModifier. Telemetry
    // only, no retry — icons over a non-choice is this path's quiet failure mode.
    if (nextDecision.options.length > 1) {
      const resolvedStat = (o: ActionOption) => o.stat ?? decideResult.stat;
      const [first, ...rest] = nextDecision.options;
      const allIdentical = rest.every(
        (o) => resolvedStat(o) === resolvedStat(first) && o.dcModifier === first.dcModifier,
      );
      if (allIdentical) {
        console.warn(
          '[combat] mechanical-diversity check failed — all options share stat + dcModifier',
          `rawInput: ${state.rawInput}`,
          `options: ${JSON.stringify(nextDecision.options)}`,
        );
      }
    }

    // Strip a stray LLM-authored flee BEFORE the emptiness backstop: counting it as real would let
    // the backstop skip, leaving a flee-only screen once it is stripped.
    nextDecision.options = nextDecision.options.filter(o => o.label !== COMBAT_FLEE_LABEL);

    // Backstop: never present a flee-only screen mid-fight. Inject before the guaranteed flee is
    // appended below, so even this degraded path stays a real choice.
    let emptyDecisionFallback = false;
    if (nextDecision.options.length === 0) {
      console.warn(
        '[combat] empty decision detected on a continue round — injecting fallback options',
        `rawInput: ${state.rawInput}`,
      );
      nextDecision.options = [
        { label: 'Press the attack', dcModifier: 0, stat: state.rollStat },
        { label: 'Fight defensively', dcModifier: -1, stat: state.rollStat },
      ];
      emptyDecisionFallback = true;
    }

    // Engaged combat always offers a voluntary flee (dcModifier: null → step()'s bail path), which
    // leaves the in_combat edge persisted. `ensureBail` can't add it: it skips required actions.
    nextDecision.options = [
      ...nextDecision.options,
      { label: COMBAT_FLEE_LABEL, dcModifier: null },
    ];
    nextDecision.combatStatus = composeCombatStatus(
      cs.enemyName, newEnemyHp, cs.enemyMaxHp, playerHpDelta, char.health, char.maxHealth,
    );

    const continueMutations: WorldMutation[] = [
      { ...combatEdge, type: 'set_relation' } as unknown as WorldMutation,
      ...(playerHpDelta < 0
        ? [{ type: 'modify_health' as const, amount: playerHpDelta }]
        : []),
    ];
    const continueBeat = this.buildCombatBeat(
      cs, roundResult, newEnemyHp, playerHpDelta, continueMutations.map(m => m.type),
      playerBonus, enemyBonus, fightDc,
      emptyDecisionFallback ? { emptyDecisionFallback: true } : {},
    );
    nextDecision.combatRounds = [...(state.pendingDecision.combatRounds ?? []), continueBeat];

    const nextState: PipelineInternalActionState = {
      ...state,
      decisions: newDecisions,
      accumulatedDc: newDc,
      pendingDecision: nextDecision,
      distilledType: decideResult.distilledType || state.distilledType,
      lastDecideResult: decideResult,
      combatAnchor: heldAnchor,
      unresolvedNpcMint,
      ...(combatDecideCallId !== 0
        ? { llmCallIds: [...(state.llmCallIds ?? []), combatDecideCallId] }
        : {}),
    };

    return {
      resolved: false,
      state: nextState,
      nextDecision,
      mutations: continueMutations,
      combatBeat: continueBeat,
    };
  }

  /**
   * Terminal combat beat: the verdict is pre-determined (no resolveRoll), but RESOLVE-MUTATE still
   * runs for ancillary loot, and the engine's own combat mutations are merged in before finalize.
   */
  private async resolveCombat(
    cs: CombatState,
    roundResult: import('./combat-dc.js').CombatRoundOutcome,
    playerHpDelta: number,
    finalEnemyHp: number,
    verdict: 'success' | 'failure',
    state: PipelineInternalActionState,
    char: CharacterData,
    items: ItemData[],
    newDc: number,
    newDecisions: ActionDecisionRecord[],
    chosenOption: ActionOption,
    playerBonus: number,
    enemyBonus: number,
    dc: number,
    // Set only by the fatal-blow resume: `'finish'` writes the surviving-HP edge, `'spare'` forces
    // that edge to 0 (closing the fight) and tells the mint check below the foe survived.
    fatalBlowMarker?: 'finish' | 'spare',
  ): Promise<{ resolved: true; state: PipelineInternalActionState; outcome: ActionOutcome }> {
    const context = buildPipelineContext(this.resolver, char, state.rawInput, recordToPrev(newDecisions), items);

    const d20Roll = roundResult.playerD20;
    const rollBonus = playerBonus;
    const decisionForHandoff = state.lastDecideResult;
    const chosenOptionForHandoff = chosenOption as LlmDecisionOption;

    // Only the fatal-blow resume supplies either field: `state.pendingDecision` is the interstitial
    // then, so its prompt is the real question. On an ordinary beat the two already agree.
    const fatalBlowHandoff = fatalBlowMarker
      ? { fatalBlow: fatalBlowMarker, decisionPrompt: state.pendingDecision.prompt }
      : {};

    // `dc` is the fight's own baseDc, the number the player saw on the combat card, NOT the
    // accumulated `newDc` this method also receives, which only threads the non-combat ladder through.
    const foeDangerHandoff = { foeDanger: dangerTier(dc) };

    // RESOLVE-MUTATE for ancillary loot only (the LLM never authors enemyHp/core damage).
    const { result: combatMutate, callId: combatMutateCallId } = await this.llm.resolveMutate({
      actionType: state.actionType,
      decision: decisionForHandoff,
      chosenOption: chosenOptionForHandoff,
      verdict,
      d20Roll,
      context,
      ...fatalBlowHandoff,
      ...foeDangerHandoff,
    });
    const proposedMutations = combatMutate.mutations;
    const combatResolveCallIds: number[] = combatMutateCallId !== 0 ? [combatMutateCallId] : [];

    // Travel-coherence gate: structural backstop, injects intent only.
    const gatedMutations = applyTravelCoherenceGate(
      proposedMutations as WorldMutation[],
      decisionForHandoff.sceneLocation,
      char.location,
    );

    // Inject the engine-authored combat mutations: the final combat edge plus the player HP delta.
    const finalRound = cs.round + 1;
    // The state-held anchor: for npc fights `cs.anchor` carries the id-as-name that won't re-resolve.
    const finalCsAnchor = state.combatAnchor ?? (cs.anchor as { node: 'npc' | 'location'; name: string });
    const finalEdge = combatRoundUpdate({ ...cs, enemyHp: cs.enemyHp, anchor: finalCsAnchor }, 0, finalRound);
    const survivingHp = Math.max(0, finalEnemyHp);
    // Sparing CLOSES the edge rather than persisting a 1-HP survivor: every band deals strictly
    // negative enemy HP, so that survivor was a guaranteed-win farm. The beat reports `survivingHp`.
    const edgeEnemyHp = fatalBlowMarker === 'spare' ? 0 : survivingHp;
    // `type: 'set_relation'` is required: combatRoundUpdate returns a bare AuthoredRelation, and
    // without it validateMutations drops the edge, leaving a defeated enemy at positive HP.
    const clampedFinalEdge = { ...finalEdge, type: 'set_relation', props: { ...finalEdge.props, enemyHp: edgeEnemyHp } };
    const engineMutations: WorldMutation[] = [
      clampedFinalEdge as unknown as WorldMutation,
      ...(playerHpDelta !== 0
        ? [{ type: 'modify_health' as const, amount: playerHpDelta }]
        : []),
    ];

    // Mint the named-but-unresolved foe if it notionally survived. Keyed off survival rather than
    // `edgeEnemyHp` (already 0 on a spare), and never on a kill: `'finish'` is the only dead outcome.
    const foeSurvived = fatalBlowMarker === 'spare'
      || (fatalBlowMarker === undefined && finalEnemyHp > 0);
    if (state.unresolvedNpcMint && foeSurvived) {
      engineMutations.push({
        type: 'add_npc',
        name: state.unresolvedNpcMint.name,
        // Non-empty `description` is mandatory, not cosmetic: `nearbyNpcsAt` filters out an NPC
        // with a falsy one, so the mint would be invisible to `getNearbyNpcs` and never re-resolve.
        description: 'A foe from a recent fight, left alive and wounded.',
        health: survivingHp,
        // Both taken from the fight's location, captured before this resolution's own mutations:
        // they must agree or the nightly wander-skip (`home_location === location`) never fires.
        location: char.location,
        homeLocation: char.location,
      } as WorldMutation);
    }

    const mutationsWithCombat = [...gatedMutations, ...engineMutations];

    // Finalize (geography → collapse → validate).
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
    const { mutations: finalisedMutations } = this.finalize(mutationsWithCombat, mutationCtx);
    // Strip after finalize but before the RESOLVE-NARRATE handoff below: the narration must never
    // describe an inspiration the player did not receive. Post-collapse is deliberate, see the helper.
    const finalMutations = stripWorkInspiration(finalisedMutations, state.kind);

    // RESOLVE-NARRATE.
    const { result: combatNarrate, callId: combatNarrateCallId } = await this.llm.resolveNarrate({
      actionType: state.actionType,
      decision: decisionForHandoff,
      chosenOption: chosenOptionForHandoff,
      verdict,
      d20Roll,
      finalMutations: finalMutations as unknown[],
      context,
      ...fatalBlowHandoff,
      ...foeDangerHandoff,
    });
    const rawOutcomeText = combatNarrate.outcomeText;
    if (combatNarrateCallId !== 0) combatResolveCallIds.push(combatNarrateCallId);

    // The prose critic may only patch outcomeText; `finalMutations` is never handed back for edits.
    const { outcomeText, criticCallIds } = await this.critiqueNarration(
      rawOutcomeText, verdict, decisionForHandoff, finalMutations as unknown[], context, state.actionType,
    );

    const mutations = [...finalMutations];
    if (state.wage && state.wage > 0) {
      mutations.push({ type: 'modify_wealth', amount: state.wage });
    }

    // Built after `mutations` is fully assembled, so the beat's `ops` matches what the outcome reports.
    // Clamp to the delta that actually applied: a nominal -5 from 3 HP lands as -3, not the band nominal.
    const appliedPlayerHpDelta = Math.max(playerHpDelta, -char.health);
    const combatBeat = this.buildCombatBeat(
      cs,
      roundResult,
      survivingHp,
      appliedPlayerHpDelta,
      mutations.map(m => m.type),
      playerBonus,
      enemyBonus,
      dc,
      fatalBlowMarker ? { fatalBlow: fatalBlowMarker } : {},
    );
    // Close out the fight's round log: prior rounds off the last pendingDecision plus this beat.
    const combatRounds = [...(state.pendingDecision.combatRounds ?? []), combatBeat];

    const finalState: PipelineInternalActionState = {
      ...state,
      decisions: newDecisions,
      accumulatedDc: newDc,
      pendingDecision: { prompt: outcomeText, options: [] },
      hpZero: (playerHpDelta < 0 && (char.health + playerHpDelta) <= 0) || undefined,
    };

    return {
      resolved: true,
      state: finalState,
      outcome: {
        distilledType: state.distilledType,
        category: state.actionType,
        finalDc: newDc,
        playerRolled: d20Roll,
        rollBonus,
        rollStat: state.rollStat,
        outcome: verdict,
        mutations,
        outcomeText,
        llmCallIds: [...(state.llmCallIds ?? []), ...combatResolveCallIds, ...criticCallIds],
        hpZero: (playerHpDelta < 0 && (char.health + playerHpDelta) <= 0) || undefined,
        combatBeat,
        combatFrame: { enemyName: cs.enemyName, enemyMaxHp: cs.enemyMaxHp, margin: roundResult.margin },
        combatRounds,
      },
    };
  }

  /**
   * DICE → RESOLVE-MUTATE → finalize → RESOLVE-NARRATE. Mutation-authoring is split from
   * text-authoring so narration is written against FINAL, not proposed, mutations.
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
    let d20Roll = 0;
    if (state.flags.needs_roll) {
      d20Roll = this.rollD20();
      rollBonus = abilityCheckBonus(char.stats, items, state.rollStat);
      verdict = resolveRoll(d20Roll, rollBonus, newDc);
      playerRolled = d20Roll;
    } else {
      // rest/travel (this prototype's non-rollable types) resolve automatically — no dice stage.
      verdict = 'success';
    }

    const decisionForHandoff = state.lastDecideResult;
    const chosenOptionForHandoff = chosenOption as LlmDecisionOption;

    // Gate on `needs_roll`, the same condition the roll stage used, rather than on `d20Roll`
    // truthiness: rest/travel leaves the literal `0` there, which reads falsy by coincidence.
    const finalDcHandoff = state.flags.needs_roll ? { finalDc: newDc } : {};

    const { result: mutateResult, callId: resolveMutateCallId } = await this.llm.resolveMutate({
      actionType: state.actionType,
      decision: decisionForHandoff,
      chosenOption: chosenOptionForHandoff,
      verdict,
      d20Roll,
      context,
      ...finalDcHandoff,
    });
    const proposedMutations = mutateResult.mutations;
    const resolveCallIds: number[] = resolveMutateCallId !== 0 ? [resolveMutateCallId] : [];

    // Travel-coherence gate: backstop against a scene narrated elsewhere with no relocate
    // mutation. It injects intent only; geography enforces feasibility in finalize below.
    const gatedMutations = applyTravelCoherenceGate(
      proposedMutations as WorldMutation[],
      decisionForHandoff.sceneLocation,
      char.location,
    );

    // The inversion point: finalize (geography → collapse → validate) runs between
    // mutation-authoring and text-authoring, so RESOLVE-NARRATE sees what actually landed.
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
    const { mutations: finalisedMutations } = this.finalize(gatedMutations, mutationCtx);
    // Stripped after finalize but before the RESOLVE-NARRATE handoff, so the strip reads one net,
    // type-coerced amount per axis. See `stripWorkInspiration`.
    const finalMutations = stripWorkInspiration(finalisedMutations, state.kind);

    const { result: narrateResult, callId: resolveNarrateCallId } = await this.llm.resolveNarrate({
      actionType: state.actionType,
      decision: decisionForHandoff,
      chosenOption: chosenOptionForHandoff,
      verdict,
      d20Roll,
      finalMutations: finalMutations as unknown[],
      context,
      ...finalDcHandoff,
    });
    const rawOutcomeText = narrateResult.outcomeText;
    if (resolveNarrateCallId !== 0) resolveCallIds.push(resolveNarrateCallId);

    const { outcomeText, criticCallIds } = await this.critiqueNarration(
      rawOutcomeText, verdict, decisionForHandoff, finalMutations as unknown[], context, state.actionType,
    );

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
        category: state.distilledType,
        finalDc: newDc,
        playerRolled,
        ...(rollBonus !== undefined ? { rollBonus } : {}),
        rollStat: state.rollStat,
        outcome: verdict,
        mutations,
        outcomeText,
        llmCallIds: [...(state.llmCallIds ?? []), ...resolveCallIds, ...criticCallIds],
      },
    };
  }

  /**
   * Coherence critic over DECIDE; an injected critic is required, so without one this is
   * an unconditional no-op (as is `critiqueNarration`).
   */
  private async critiqueDecide(
    decideResult: PipelineDecideResult,
    actionType: ActionType,
    flags: RoutingFlags,
    context: LlmContext,
  ): Promise<{ result: PipelineDecideResult; criticCallIds: number[] }> {
    if (!this.critic) return { result: decideResult, criticCallIds: [] };

    // A clean beat under the gate skips the critic call entirely: no verdict, no criticCallIds.
    if (
      !criticShouldFire(this.criticGateMode, 'decision', {
        baseDc: decideResult.baseDc,
        decisionLength: decideResult.decision.length,
        actionType,
      })
    ) {
      return { result: decideResult, criticCallIds: [] };
    }

    const input: CriticInput = {
      beat: 'decision',
      decision: adaptDecideToLlmDecision(decideResult),
      contextDigest: buildContextDigest(context),
      playerInput: context.rawInput,
      warnings: [],
    };
    const verdict = await this.critic.critique(input);
    const criticCallIds = verdict._llmCallId !== undefined ? [verdict._llmCallId] : [];

    if (verdict.ok) return { result: decideResult, criticCallIds };

    // Minor: a decide beat is options-only (no player-facing prose field) — `patch` has nowhere
    // to land, so treat minor the same as ok (pass through unchanged).
    if (verdict.severity === 'minor') return { result: decideResult, criticCallIds };

    // One bounded re-decide with the critic's issues as guidance, not itself re-critiqued: a
    // correction is not subject to correction.
    const note = verdict.issues.join('; ') || 'incoherent with the scene';
    try {
      const { result: redecided, callId: redecideCallId } = await this.llm.decide({ actionType, flags, context: { ...context, criticNote: note } });
      const callIds = redecideCallId !== 0 ? [...criticCallIds, redecideCallId] : criticCallIds;
      return { result: redecided, criticCallIds: callIds };
    } catch (err) {
      console.warn('[critic] re-decide failed — keeping original', err instanceof Error ? err.message : String(err));
      return { result: decideResult, criticCallIds };
    }
  }

  /**
   * Deterministic single-option validator: exactly one option triggers one bounded re-decide
   * asking for real choices or `[]`.
   */
  private async validateSingleOption(
    decideResult: PipelineDecideResult,
    actionType: ActionType,
    flags: RoutingFlags,
    context: LlmContext,
  ): Promise<{ result: PipelineDecideResult; validatorCallIds: number[] }> {
    if (decideResult.decision.length !== 1) {
      return { result: decideResult, validatorCallIds: [] };
    }

    // Combat beats are linear per round, where a single-option "Press the attack" is expected.
    if (actionType === 'combat') {
      return { result: decideResult, validatorCallIds: [] };
    }

    console.warn(
      '[validator] single-option decision detected',
      `rawInput: ${context.rawInput}`,
      `option: ${JSON.stringify(decideResult.decision[0])}`,
    );

    const note = 'You returned only a single option. The player needs real choices. Generate 2-4 distinct approaches or return [] if this should resolve outright.';
    try {
      const { result: redecided, callId } = await this.llm.decide({
        actionType,
        flags,
        context: { ...context, criticNote: note },
      });
      return { result: redecided, validatorCallIds: callId !== 0 ? [callId] : [] };
    } catch (err) {
      console.warn('[validator] single-option re-decide failed — keeping original', err instanceof Error ? err.message : String(err));
      return { result: decideResult, validatorCallIds: [] };
    }
  }

  /**
   * Faithfulness prose critic over RESOLVE-NARRATE. Returns only a (possibly patched) string, so it
   * cannot alter the caller's already-finalized mutations.
   */
  private async critiqueNarration(
    outcomeText: string,
    verdict: 'success' | 'failure',
    decideResult: PipelineDecideResult,
    finalMutations: unknown[],
    context: LlmContext,
    actionType: ActionType,
  ): Promise<{ outcomeText: string; criticCallIds: number[] }> {
    if (!this.critic) return { outcomeText, criticCallIds: [] };

    // Gated because a `major` verdict here is discarded, with the dice and mutations already final,
    // so in practice only a patched `minor` can change anything.
    if (
      !criticShouldFire(this.criticGateMode, 'resolution', {
        baseDc: decideResult.baseDc,
        decisionLength: decideResult.decision.length,
        actionType,
      })
    ) {
      return { outcomeText, criticCallIds: [] };
    }

    const input: CriticInput = {
      beat: 'resolution',
      rollOutcome: verdict,
      decision: adaptNarrationToLlmDecision(decideResult, outcomeText, finalMutations),
      finalMutations,
      contextDigest: buildContextDigest(context),
      playerInput: context.rawInput,
      warnings: [],
    };
    const v = await this.critic.critique(input);
    const criticCallIds = v._llmCallId !== undefined ? [v._llmCallId] : [];

    if (!v.ok && v.severity === 'minor' && v.patch?.outcomeText) {
      outcomeText = v.patch.outcomeText;
    } else if (!v.ok && v.severity === 'major') {
      // Dice and mutations are already final, so a structural defect can't be safely re-narrated.
      // Keep the original text and log it.
      console.warn('[critic] major defect on resolution beat — keeping original text:', v.issues.join('; '));
    }

    return { outcomeText, criticCallIds };
  }

  /** Beat-1 LLM fault → the divine intervention below. The card says nothing about the model, so
   *  this console line is the only place a run of stage failures is distinguishable. */
  private divineOnStageFailure(
    rawInput: string,
    kind: ActionKind,
    wage: number,
    err: unknown,
    stage: string,
  ): { resolved: true; state: PipelineInternalActionState; outcome: ActionOutcome } {
    console.error(
      `[pipeline] beat-1 ${stage} failure — resolving as divine intervention:`,
      err instanceof Error ? err.message : String(err),
    );
    return this.resolveDivineIntervention(rawInput, kind, wage);
  }

  /**
   * The beat-1 system-fault path, typed rather than a `distilledType` sentinel:
   * `isDivineIntervention` on the outcome is the only signal, and the rejection never escapes `start()`.
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
      // Mirrors the other hardcoded fields above: this path resolves outright, so nothing reads it.
      lastDecideResult: { distilledType: 'divine_intervention', stat: 'physical', baseDc: 0, required: false, decision: [] },
      lastActionAt: Date.now(),
    };
    return {
      resolved: true,
      state,
      outcome: {
        distilledType: 'divine_intervention',
        category: 'divine_intervention',
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

/** Drops the `modify_rolls_remaining` grant on `kind: 'work'`: the day job pays coin, not cadence,
 *  and routing can't gate it (it never sees `kind`). Expects the POST-collapse set. */
function stripWorkInspiration(mutations: WorldMutation[], kind: ActionKind | undefined): WorldMutation[] {
  if (kind !== 'work') return mutations;
  return mutations.filter(m => !(m.type === 'modify_rolls_remaining' && Number(m.amount ?? 0) > 0));
}

/** Local reimplementation of legacy's private `ensureBail`: generic shape logic, duplicated
 *  rather than imported to keep this file self-contained. */
function ensureBail(options: ActionOption[], required: boolean): ActionOption[] {
  if (required) return options;
  if (options.some(o => o.dcModifier === null)) return options;
  return [...options, { label: 'Step back', dcModifier: null }];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** DECIDE authors options only, so the prompt is always the generic CTA. `narration` (CONTINUE
 *  beats only) passes through unchanged; it is absent on NEW_ACTION, so the first beat stays lean. */
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
    prompt: `${capitalize(result.distilledType)} — what do you do?`,
    options: ensureBail(options, required),
    ...(result.narration ? { narration: result.narration } : {}),
  };
}

/** Enemy HP fraction -> a 5-pip fill count + wound word. Banded only, never the exact HP, so the
 *  hidden number keeps tension. Returns the fill count, not glyphs: the presentation layer draws them. */
export function enemyConditionBand(hpFraction: number): { filled: number; woundWord: string } {
  // `NaN <= 0` is false, so unguarded NaN would fall through every tier and return `filled: NaN`,
  // a broken pip bar. Non-finite means unknown, not dead, so the wound word stays 'Critical'.
  const filled = Number.isFinite(hpFraction)
    ? Math.max(0, Math.min(5, Math.round(hpFraction * 5)))
    : 0;
  const woundWord =
    !Number.isFinite(hpFraction) ? 'Critical'
    : hpFraction <= 0 ? 'Slain'
    : hpFraction >= 0.8 ? 'Healthy'
    : hpFraction >= 0.4 ? 'Bloodied'
    : hpFraction >= 0.15 ? 'Battered'
    : 'Critical';
  return { filled, woundWord };
}

/** Combat-status data for a continue screen: the enemy stays banded, the player is exact and
 *  clamped at 0. Frame assembly lives in the presentation layer, never imported engine-side. */
function composeCombatStatus(
  enemyName: string,
  enemyHp: number,
  enemyMaxHp: number,
  playerHpDelta: number,
  playerHp: number,
  playerMaxHp: number,
): CombatStatusData {
  const { filled, woundWord } = enemyConditionBand(enemyMaxHp > 0 ? enemyHp / enemyMaxHp : 0);
  const displayedPlayerHp = Math.max(0, playerHp + playerHpDelta);
  return {
    enemyName,
    woundWord,
    pips: { filled, total: 5 },
    playerHp: displayedPlayerHp,
    playerMaxHp,
    playerHpDelta,
  };
}

function recordToPrev(records: ActionDecisionRecord[]): { prompt: string; chosen: string; dcModifier: number }[] {
  return records.map(r => ({
    prompt: r.prompt,
    chosen: r.chosen,
    dcModifier: r.dcModifier,
  }));
}

/** Adapts a DECIDE-beat result into the `LlmDecision` shape the critic-v1 prompt expects. */
function adaptDecideToLlmDecision(r: PipelineDecideResult): LlmDecision {
  return {
    distilledType: r.distilledType,
    stat: r.stat,
    baseDc: r.baseDc,
    required: r.required,
    done: false,
    decision: r.decision,
  };
}

/** Adapts a finalized RESOLVE-NARRATE beat into that same `LlmDecision` shape; the mutations and
 *  text ride along for the critic's context only, never back into the machine's own handling. */
function adaptNarrationToLlmDecision(r: PipelineDecideResult, outcomeText: string, finalMutations: unknown[]): LlmDecision {
  return {
    distilledType: r.distilledType,
    stat: r.stat,
    baseDc: r.baseDc,
    required: r.required,
    done: true,
    decision: [],
    mutations: finalMutations,
    outcomeText,
  };
}
