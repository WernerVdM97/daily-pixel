import type { LlmContext, LlmDecision, LlmDecisionOption, SceneStateEdge, CriticGateway, CriticInput } from '../../llm/LlmGateway.js';
import { buildContextDigest } from '../../llm/prompt-builder.js';
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
import { isAnomalousDecide, type CriticGateMode } from './critic-gate.js';

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
  /** The authored relation endpoint resolved on combat establishment, held across rounds
   *  so the npc-name→id resolution gap doesn't force re-resolution every beat (T3 decision 4).
   *  Undefined when no combat is in progress. */
  combatAnchor?: { node: 'npc' | 'location'; name: string };
  /** Set when a would-be-lethal blow lands after the once-per-day survive-at-1 floor
   *  has already been spent — the hp_zero trace marker on the resolved outcome. */
  hpZero?: boolean;
  /** Set when a desperate-choice beat is pending (iteration 2 floor + loss ladder).
   *  The next step() clears it before falling through to normal combat flow — only
   *  `last stand` reaches handleCombatStep; `bail bloodied` is caught by step()'s bail check. */
  desperateChoice?: boolean;
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
  | {
      resolved: false;
      state: PipelineInternalActionState;
      nextDecision: ActionDecision;
      mutations?: WorldMutation[];
      /** Per-round combat telemetry beat (T5) — set on every fought CONTINUE/desperate-choice
       *  round, never on the generic (non-combat) beat flow or the voluntary bail path. */
      combatBeat?: CombatBeatLog;
    }
  | { resolved: true; state: PipelineInternalActionState; outcome: ActionOutcome };

/** Canned fallback text for the classify-fallback-total-failure path (heuristic miss AND the
 *  LLM fallback call rejects). Self-contained by design — mirrors the flavour of
 *  `FallbackLlmGateway.ts`'s divine intervention message without importing it, since that
 *  module belongs to the legacy string-sentinel path this machine deliberately does not use. */
const PIPELINE_DIVINE_MESSAGE =
  '⚙️ The world stutters. Your action could not be processed and your action roll ' +
  'has been refunded.';

/** Stamina cost for bailing out of a real (consequential) decision. Same value as legacy's
 *  private `BAIL_STAMINA_COST` — duplicated locally since that constant isn't exported. */
const BAIL_STAMINA_COST = 1;

/** Label of the engine-appended voluntary combat flee option — must stay unique so `step()`'s
 *  `options.find(o => o.label === choice)` lookup always resolves to the guaranteed-null bail,
 *  never a wayward LLM-authored option sharing the same label. */
const COMBAT_FLEE_LABEL = 'Flee the fight';

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
    // Optional (D7): absent by default, so every existing caller (and the sim, which never
    // injects one) takes the no-critic path through `critiqueDecide`/`critiqueNarration` below —
    // both are unconditional no-ops without a critic, keeping this the zero-risk default.
    private critic?: CriticGateway,
    // RA-4c (SL-3 measure-first): defaults to 'always', today's unconditional-fire behaviour, so
    // every existing caller that doesn't pass this 7th arg is byte-identical to pre-RA-4 — the
    // owner opts a run into 'anomaly' only once the A/B numbers are in.
    private criticGateMode: CriticGateMode = 'always',
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
    // on a miss. A fallback rejection resolves outright. DECIDE itself never authors
    // mutations/outcome_text (D5b split), but when the LLM returns `decision: []` on beat 1,
    // the resolve pipeline runs inside start() and returns `resolved: true` — the auto-resolve
    // path restored per §2 v12 QA.
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

    const { result: rawDecideResult, callId: decideCallId } = await this.llm.decide({ actionType, flags, context });
    if (decideCallId !== 0) gatewayCallIds.push(decideCallId);
    const { result: afterCritic, criticCallIds } = await this.critiqueDecide(rawDecideResult, actionType, flags, context);
    const { result: decideResult, validatorCallIds } = await this.validateSingleOption(afterCritic, actionType, flags, context);

    // §2 v12 QA: auto-resolve on first-beat `decision: []` — the LLM returned an empty
    // decision array, signalling this action needs no player branching. Jump straight to
    // the resolve pipeline instead of serving a bail-only screen.
    if (decideResult.decision.length === 0) {
      // C6 guard: combat must never auto-resolve on an empty decision[] — it must run at
      // least one contested round. Synthesise a first decision with a single required
      // option so step() always routes to handleCombatStep. The mis-classification
      // (combat read as skill/rest) is a classify-prompt-template concern → deferred to
      // v13 via prompt-versioning ([[prompt-v13-roadmap]]).
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
      const resolved = await this.resolve(preState, char, items, decideResult.baseDc, [], syntheticOption);
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
      // llmCallIds accumulates every recorded LLM call in this action (gateway stages +
      // critic). Filter zeros: callId===0 means no recorder was wired for that call.
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
    // Reactive combat actions short-circuit the generic beat-cap/decide/resolve flow.
    // The combat handler owns the entire round: contested roll, band application,
    // mutation persistence, and termination ladder (win/cap-derive/hpZero→failure/continue).
    if (state.actionType === 'combat' && state.required) {
      return this.handleCombatStep(stateWithStat, char, items, newDc, newDecisions, option);
    }

    // Beat cap: after MAX_DECISIONS_PER_ACTION - 1 prior beats, the current one is the last.
    // `PipelineDecideResult` has no `done` flag (options-only, by design) so this cap plus the
    // zero-real-options check below are the ONLY resolve-trigger signals available here.
    const isLastDecision = state.decisions.length >= MAX_DECISIONS_PER_ACTION - 1;
    if (isLastDecision) {
      return this.resolve(stateWithStat, char, items, newDc, newDecisions, option);
    }

    const context = buildPipelineContext(this.resolver, char, state.rawInput, recordToPrev(newDecisions), items);
    const { result: rawDecideResult, callId: stepDecideCallId } = await this.llm.decide({ actionType: state.actionType, flags: state.flags, context });
    // Gate runs on the fresh decideResult BEFORE the realOptions split below, so a major re-decide
    // (or a pass-through) feeds BOTH the zero-real-options resolve-trigger check and the normal
    // continue branch from the same single critic pass — no second gate call for either branch.
    const { result: afterCritic, criticCallIds } = await this.critiqueDecide(
      rawDecideResult, state.actionType, state.flags, context,
    );
    const { result: decideResult, validatorCallIds } = await this.validateSingleOption(afterCritic, state.actionType, state.flags, context);
    const beatCallIds = [stepDecideCallId, ...criticCallIds, ...validatorCallIds].filter(id => id !== 0);
    const realOptions = decideResult.decision.filter(o => o.dcModifier !== null);

    if (realOptions.length === 0) {
      // The terminating decide (zero real options -> resolve now) can still declare a fresh
      // scene_location even though its options are empty. Refresh ONLY sceneLocation for the
      // travel gate; the resolveMutate/narrate handoff intentionally keeps the prior decide's
      // real options/baseDc (see the beat-cap handoff test), so we do not wholesale-replace it.
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
   * Builds this round's telemetry beat (T5) — the single choke point all four
   * beat-emitting paths in `handleCombatStep`/`resolveCombat` go through, so the shape stays
   * honest across CONTINUE, desperate-choice, and the terminal win/loss/cap paths.
   *
   * `materialMutationFired` is computed from the semantic HP deltas + a non-`set_relation` op,
   * NOT `ops.length > 0` — `set_relation` alone (a round-counter-only bump) is bookkeeping, not
   * material; enemyHp/player-HP deltas and any loot op ARE material.
   *
   * Round-numbering caveat: the floor beat persists `combatRoundUpdate(cs, ..., cs.round)` (same
   * round number, not incremented — see the desperate-choice branch below), so the floor beat and
   * the subsequent last-stand beat can share a `round` value. This is intended: `round` is the
   * in-fight round LABEL, not a unique beat id — "rounds fought" is the beat COUNT
   * (`combatBeats.length` in `PipelineSimEngine`), not the max round label.
   *
   * `playerBonus`/`enemyBonus`/`dc` (ANSI-D) are threaded in by every caller rather than
   * recomputed here — they're already local values at each call site (the same ones that fed
   * `resolveCombatRound`), so re-deriving them a second time would risk the two copies drifting.
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
    opts: { floorSave?: boolean; emptyDecisionFallback?: boolean } = {},
  ): CombatBeatLog {
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
    };
  }

  /**
   * Combat sub-mode handler — owns the contested roll, band application, persistence, and
   * termination ladder (win / cap-derive / hpZero→failure / continue). Replaces the generic
   * beat-cap/decide/resolve flow for reactive combat actions.
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
    // If returning from a desperate-choice beat via `last stand`, clear the flag and fall
    // through to the normal combat continue flow. `bail bloodied` is caught by step()'s bail
    // check and never reaches here.
    if (state.desperateChoice) {
      state = { ...state, desperateChoice: undefined };
    }

    // ── Establish or read combat state ──
    let cs = readCombatState(context.sceneState ?? []);

    if (!cs || cs.enemyHp <= 0) {
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
            // NPC resolution failed — default to location-anchored minion (decision 4 fallback).
            anchor = { node: 'location', name: char.location };
          }
        } else {
          anchor = { node: 'location', name: char.location };
        }

        // Enemy max-HP priority: the resolved NPC's real health (so a known 24-HP stag reads as
        // 24, not a DC-derived guess) > the LLM-authored maxHp hint > deriveEnemyMaxHp(baseDc) for
        // the location-anchored/ambient minion path. A non-positive health isn't a valid combat
        // max, so it falls through rather than seeding a dead-on-arrival foe.
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
        };
      }
    }

    // Resolve the anchor to use for edge writes: prefer the state-held anchor (across rounds),
    // fall back to the current CombatState's anchor (which for npc fights carries the id-as-name
    // that would fail re-resolution — T3 decision 4).
    const heldAnchor: { node: 'npc' | 'location'; name: string } =
      state.combatAnchor ?? (cs.anchor as { node: 'npc' | 'location'; name: string });

    // ── Contested roll (both player and engine roll from the same injected rollD20) ──
    const playerD20 = this.rollD20();
    const enemyD20 = this.rollD20();
    const playerBonus = abilityCheckBonus(char.stats, items, state.rollStat);
    const enemyBonus = Math.max(0, Math.min(ENEMY_BONUS_MAX, state.lastDecideResult.baseDc - 10));
    const roundResult = resolveCombatRound(playerD20, playerBonus, enemyD20, enemyBonus, 1);

    // ── Apply the band ──
    const newEnemyHp = Math.max(0, Math.min(cs.enemyMaxHp, cs.enemyHp + roundResult.enemyHpDelta));
    const playerHpDelta = roundResult.playerHpDelta;

    // hpZero detection: player HP would drop to ≤0 (deferred to iteration 2 for the save floor).
    const hpZeroReached = playerHpDelta < 0 && (char.health + playerHpDelta) <= 0;

    // ── Termination ladder ──
    // 1. WIN: enemy HP depleted
    if (newEnemyHp <= 0) {
      return this.resolveCombat(
        cs, roundResult, playerHpDelta, 0, 'success',
        state, char, items, newDc, newDecisions, chosenOption,
        playerBonus, enemyBonus, state.lastDecideResult.baseDc,
      );
    }

    // 2. hpZero → floor + save ladder (iteration 2: survive-at-1 once per day).
    if (hpZeroReached) {
      const currentDay = this.resolver.getCurrentDay?.() ?? 0;
      const savedDay = readCombatSave(context.sceneState ?? []);

      if (savedDay === null || savedDay !== currentDay) {
        // ── Desperate-choice beat (first lethal blow today) ──
        // Floor player to 1 HP, author the combat_save edge, keep the combat edge at the
        // band-depleted enemyHp (same round — player hasn't survived yet in a way that
        // advances the fight). Return forced options: bail bloodied / last stand.
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
          playerBonus, enemyBonus, state.lastDecideResult.baseDc, { floorSave: true },
        );

        // ANSI-D: carry the fight's accumulated round log forward off the PREVIOUS
        // pendingDecision (tolerant read — `?? []` covers both a fresh fight and any
        // in-flight state saved before this field existed).
        // B#19: also set combatStatus so the player sees the enemy/player HP bars and
        // the last round's damage — without this, the desperate-choice screen shows
        // only "last stand or bail" with no combat context.
        // The floor absorbs the lethal blow: the player survives at exactly 1 HP.
        // Showing `char.health + roundResult.playerHpDelta` (which is ≤0) would display
        // 0 HP — misleading when the floor guarantees survival. Pass HP=1, delta=0 so
        // the status frame reflects the truth, not the would-be-lethal math.
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
        return this.resolveCombat(
          cs, roundResult, playerHpDelta, newEnemyHp, 'failure',
          state, char, items, newDc, newDecisions, chosenOption,
          playerBonus, enemyBonus, state.lastDecideResult.baseDc,
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
        state, char, items, newDc, newDecisions, chosenOption,
        playerBonus, enemyBonus, state.lastDecideResult.baseDc,
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

    // decide-scene-narration: hand the just-resolved round's mechanical truth to DECIDE so its
    // narration can acknowledge the approach the player took and stay faithful to the dice.
    // Deliberately `combatRoundSummary`, not `rollOutcome` — that field switches the phase to
    // RESOLVE_ROLL, which this call is not.
    const updatedContext = {
      ...context,
      sceneState: updatedSceneState,
      combatRoundSummary: {
        band: roundResult.band,
        playerHpDelta: roundResult.playerHpDelta,
        enemyHpDelta: roundResult.enemyHpDelta,
        chosenOption: {
          label: chosenOption.label,
          ...(chosenOption.stat ? { stat: chosenOption.stat } : {}),
        },
      },
    };
    // T4: NOT gated — combat truth is engine-owned (the contested roll + band already decided
    // this round), so there is no authored decision content here for the coherence critic to check.
    const { result: decideResult, callId: combatDecideCallId } = await this.llm.decide({
      actionType: state.actionType,
      flags: state.flags,
      context: updatedContext,
    });

    const nextDecision = toActionDecision(decideResult, state.required);

    // Mechanical-diversity check (decide-scene-narration spec): a combat round needs a genuine
    // trade-off — at least two options differing on stat or dcModifier. Telemetry only (no
    // retry), in the `validateSingleOption` console.warn style: icons over a non-choice is this
    // spec's quiet failure mode, so make it measurable.
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

    // Strip any same-labelled decide option first, BEFORE the emptiness backstop below — a
    // wayward LLM could author a real 'Flee the fight' despite BASE Rule 3, and counting it as a
    // "real" option would let the backstop skip while the flee-dedup then strips it anyway,
    // leaving a silent flee-only screen. The engine's guaranteed-null flee is appended after the
    // backstop instead, so it always wins step()'s label lookup.
    nextDecision.options = nextDecision.options.filter(o => o.label !== COMBAT_FLEE_LABEL);

    // Combat empty-decision backstop (decide-scene-narration spec, belt-and-braces): the fresh
    // continue-decide returned zero real (non-flee) options — never present a flee-only screen
    // mid-fight. Injected BEFORE the guaranteed flee append below, so even the degraded path is a
    // real choice, not a screen with no decision in miniature.
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

    // Engaged combat always offers a voluntary flee (dcModifier: null), caught by step()'s bail
    // path — which leaves the in_combat edge persisted, so the enemy is remembered (plan decision 4).
    // ensureBail can't add this — it returns early for required actions, which combat always is.
    nextDecision.options = [
      ...nextDecision.options,
      { label: COMBAT_FLEE_LABEL, dcModifier: null },
    ];
    // Engine-composed status frame (decide-scene-narration spec, B#5/B#6): banded enemy
    // condition (never exact enemy HP) plus the player's own exact, clamped HP.
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
      playerBonus, enemyBonus, state.lastDecideResult.baseDc,
      emptyDecisionFallback ? { emptyDecisionFallback: true } : {},
    );
    // ANSI-D: carry the fight's accumulated round log forward off the PREVIOUS pendingDecision
    // (tolerant read — `?? []` covers both a fresh fight and any in-flight state saved before
    // this field existed).
    nextDecision.combatRounds = [...(state.pendingDecision.combatRounds ?? []), continueBeat];

    const nextState: PipelineInternalActionState = {
      ...state,
      decisions: newDecisions,
      accumulatedDc: newDc,
      pendingDecision: nextDecision,
      distilledType: decideResult.distilledType || state.distilledType,
      lastDecideResult: decideResult,
      combatAnchor: heldAnchor,
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
   * Terminal combat beat: verdict is pre-determined (no resolveRoll). RESOLVE-MUTATE still
   * runs for ancillary loot; the engine-authored combat mutations (set_relation + modify_health)
   * are injected into the outcome alongside the LLM-authored ones, then finalize + RESOLVE-NARRATE.
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
  ): Promise<{ resolved: true; state: PipelineInternalActionState; outcome: ActionOutcome }> {
    const context = buildPipelineContext(this.resolver, char, state.rawInput, recordToPrev(newDecisions), items);

    const d20Roll = roundResult.playerD20;
    // playerBonus is the same abilityCheckBonus the caller already computed to feed
    // resolveCombatRound — reused here (not re-derived) for both the outcome's rollBonus and
    // the terminal combatBeat's playerBonus.
    const rollBonus = playerBonus;
    const decisionForHandoff = state.lastDecideResult;
    const chosenOptionForHandoff = chosenOption as LlmDecisionOption;

    // RESOLVE-MUTATE for ancillary loot only (the LLM never authors enemyHp/core damage).
    const { result: combatMutate, callId: combatMutateCallId } = await this.llm.resolveMutate({
      actionType: state.actionType,
      decision: decisionForHandoff,
      chosenOption: chosenOptionForHandoff,
      verdict,
      d20Roll,
      context,
    });
    const proposedMutations = combatMutate.mutations;
    const combatResolveCallIds: number[] = combatMutateCallId !== 0 ? [combatMutateCallId] : [];

    // D6 travel-coherence gate.
    const gatedMutations = applyTravelCoherenceGate(
      proposedMutations as WorldMutation[],
      decisionForHandoff.sceneLocation,
      char.location,
    );

    // Inject engine-authored combat mutations: the final combat edge + player HP delta.
    const finalRound = cs.round + 1;
    // Use the state-held anchor (decision 4) — for npc fights, cs.anchor carries the
    // id-as-name that would fail re-resolution; the held anchor is the originally authored one.
    const finalCsAnchor = state.combatAnchor ?? (cs.anchor as { node: 'npc' | 'location'; name: string });
    const finalEdge = combatRoundUpdate({ ...cs, enemyHp: cs.enemyHp, anchor: finalCsAnchor }, 0, finalRound);
    // Overwrite enemyHp to the computed final value (clamped at 0 for win). `type: 'set_relation'`
    // is required — combatRoundUpdate returns a bare AuthoredRelation (no op `type`), so without it
    // validateMutations drops the edge as an unknown type and the terminal in_combat write is lost
    // (a defeated enemy's edge would linger at positive HP → the next fight resumes the dead foe).
    // The CONTINUE/floor paths add it the same way.
    const clampedFinalEdge = { ...finalEdge, type: 'set_relation', props: { ...finalEdge.props, enemyHp: Math.max(0, finalEnemyHp) } };
    const engineMutations: WorldMutation[] = [
      clampedFinalEdge as unknown as WorldMutation,
      ...(playerHpDelta !== 0
        ? [{ type: 'modify_health' as const, amount: playerHpDelta }]
        : []),
    ];
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
    const { mutations: finalMutations } = this.finalize(mutationsWithCombat, mutationCtx);

    // RESOLVE-NARRATE.
    const { result: combatNarrate, callId: combatNarrateCallId } = await this.llm.resolveNarrate({
      actionType: state.actionType,
      decision: decisionForHandoff,
      chosenOption: chosenOptionForHandoff,
      verdict,
      d20Roll,
      finalMutations: finalMutations as unknown[],
      context,
    });
    const rawOutcomeText = combatNarrate.outcomeText;
    if (combatNarrateCallId !== 0) combatResolveCallIds.push(combatNarrateCallId);

    // Faithfulness prose critic (D7): may only patch outcomeText. `finalMutations` is already
    // finalized above and never handed back for modification — see critiqueNarration's contract.
    const { outcomeText, criticCallIds } = await this.critiqueNarration(
      rawOutcomeText, verdict, decisionForHandoff, finalMutations as unknown[], context, state.actionType,
    );

    const mutations = [...finalMutations];
    if (state.wage && state.wage > 0) {
      mutations.push({ type: 'modify_wealth', amount: state.wage });
    }

    // Terminal beat (T5): built here, after `mutations` is fully assembled (incl. the wage
    // append), so `ops` matches exactly what the outcome reports.
    // Clamp to the actual applied change — a lethal nominal delta (e.g. -5 from 3 HP) can't
    // drop the player below 0, so the beat log must record -3, not the raw band nominal.
    const appliedPlayerHpDelta = Math.max(playerHpDelta, -char.health);
    const combatBeat = this.buildCombatBeat(
      cs,
      roundResult,
      Math.max(0, finalEnemyHp),
      appliedPlayerHpDelta,
      mutations.map(m => m.type),
      playerBonus,
      enemyBonus,
      dc,
    );
    // ANSI-D: close out the fight's round log — prior rounds off the last pendingDecision
    // (tolerant read) plus this terminal beat, surfaced on the outcome for the terminal
    // presentation layer.
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

    // Structured, typed handoff (Task 2 acceptance criterion) — the actual `PipelineDecideResult`
    // the last `decide()` call returned, carried forward on `state.lastDecideResult`. `decision`
    // is a fresh session per the pipeline contract, so this is what RESOLVE-MUTATE is told was
    // decided, not a shared object.
    const decisionForHandoff = state.lastDecideResult;
    const chosenOptionForHandoff = chosenOption as LlmDecisionOption;

    const { result: mutateResult, callId: resolveMutateCallId } = await this.llm.resolveMutate({
      actionType: state.actionType,
      decision: decisionForHandoff,
      chosenOption: chosenOptionForHandoff,
      verdict,
      d20Roll,
      context,
    });
    const proposedMutations = mutateResult.mutations;
    const resolveCallIds: number[] = resolveMutateCallId !== 0 ? [resolveMutateCallId] : [];

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

    const { result: narrateResult, callId: resolveNarrateCallId } = await this.llm.resolveNarrate({
      actionType: state.actionType,
      decision: decisionForHandoff,
      chosenOption: chosenOptionForHandoff,
      verdict,
      d20Roll,
      finalMutations: finalMutations as unknown[],
      context,
    });
    const rawOutcomeText = narrateResult.outcomeText;
    if (resolveNarrateCallId !== 0) resolveCallIds.push(resolveNarrateCallId);

    // Faithfulness prose critic (D7): may only patch outcomeText. `finalMutations` is already
    // finalized above and never handed back for modification — see critiqueNarration's contract.
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
   * The classify-fallback-total-failure path: heuristic missed AND the LLM fallback call
   * rejected. Typed, not string-sentinel (risk table: don't overload `distilledType` with
   * `'__divine__'` the way `FallbackLlmGateway.ts` does) — `isDivineIntervention: true` on the
   * outcome is the only signal. Never lets the rejection escape `start()`.
   */
  /**
   * D7 two-critic-split resolution (settled by the lead): a SINGLE `CriticGateway.critique`
   * interface (the critic-v1 prompt, branching on `beat`) is invoked at two pipeline sites — a
   * gated coherence critic over DECIDE (major → one bounded re-decide, below) and a faithfulness
   * prose critic over RESOLVE-NARRATE (patches `outcome_text` only, see `critiqueNarration`). Not
   * two prompts/interfaces: the D5b split already structurally prevents the prose critic from
   * altering mutations (the machine applies only `patch.outcomeText`; the finalized mutation array
   * is never handed to the critic for modification), so a separate "prose-only" interface would
   * add versioning + wiring for zero behavioural gain.
   *
   * No critic injected → unconditional no-op (`{ result: decideResult, criticCallIds: [] }`), so
   * every caller that doesn't wire one in (all existing tests + the sim) is byte-identical to
   * pre-T4 behaviour.
   */
  private async critiqueDecide(
    decideResult: PipelineDecideResult,
    actionType: ActionType,
    flags: RoutingFlags,
    context: LlmContext,
  ): Promise<{ result: PipelineDecideResult; criticCallIds: number[] }> {
    if (!this.critic) return { result: decideResult, criticCallIds: [] };

    // §3 v12 QA: removed the `required` gate — the decision critic now fires on
    // every decide beat, catching single-option and other LLM quality issues that
    // would otherwise pass through unchecked (e.g. add_item on a travel action).
    // RA-4c: the anomaly-based gating this TODO asked for now exists (`critic-gate.ts`), opt-in
    // via `criticGateMode`. A clean beat under 'anomaly' skips the critic call entirely — no
    // verdict, no criticCallIds, byte-identical to the beat never having a critic at all.
    if (
      this.criticGateMode === 'anomaly' &&
      !isAnomalousDecide({ baseDc: decideResult.baseDc, decisionLength: decideResult.decision.length, actionType })
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

    // Major: ONE bounded re-decide with the critic's issues as guidance. NOT re-critiqued —
    // a correction is not itself subject to correction (mirrors CritiquedLlmGateway's ladder).
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
   * §2 v12 QA: deterministic single-option validator. After the critic pass, if the final
   * decision has exactly one option, trigger ONE bounded re-decide with guidance to produce
   * real choices or return []. The re-decide output is NOT re-critiqued (mirrors the critic's
   * own re-decide ladder — a correction is not itself subject to correction).
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

    // Combat beats are linear per round — single-option "Press the attack" is expected
    // and the combat sub-mode handler owns the entire round flow. Skip the validator.
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
   * Faithfulness prose critic over RESOLVE-NARRATE. Returns ONLY a (possibly patched) string —
   * it never receives or returns mutations, so the caller's `finalMutations` array is untouched
   * by construction: the prose critic structurally cannot alter a finalized mutation.
   *
   * No critic injected → unconditional no-op, matching `critiqueDecide`.
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

    // RA-4c: gated the same way as `critiqueDecide`, keyed off the decide result this narration
    // resolves against — a narrate beat's coherence risk traces back to how risky its authoring
    // decide beat looked, and that's the only anomaly signal available at this beat.
    if (
      this.criticGateMode === 'anomaly' &&
      !isAnomalousDecide({ baseDc: decideResult.baseDc, decisionLength: decideResult.decision.length, actionType })
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
      // Dice + mutations are already finalized; a structural defect can't be safely re-narrated,
      // so keep the original text (mirrors legacy machine.ts's resolveWithRoll critic hook).
      console.warn('[critic] major defect on resolution beat — keeping original text:', v.issues.join('; '));
    }

    return { outcomeText, criticCallIds };
  }

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

/** DECIDE authors options only (no `prompt` — settled decision), so the beat's prompt is always
 *  the generic CTA, never derived from LLM prose. decide-scene-narration amendment: DECIDE now
 *  also authors `narration` on CONTINUE beats (scene-framing prose, not outcome-authoring) —
 *  passed through here unchanged; absent on NEW_ACTION, so the first beat stays lean. */
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

/** Enemy HP fraction -> a 5-pip fill count + wound word (decide-scene-narration spec). Banded
 *  only — never the exact HP number — so hidden exact HP keeps tension while still reading as
 *  progress. Returns the fill count (not glyphs); the presentation layer renders the pips. */
export function enemyConditionBand(hpFraction: number): { filled: number; woundWord: string } {
  const filled = Math.max(0, Math.min(5, Math.round(hpFraction * 5)));
  const woundWord =
    hpFraction >= 0.8 ? 'Healthy'
    : hpFraction >= 0.4 ? 'Bloodied'
    : hpFraction >= 0.15 ? 'Battered'
    : 'Critical';
  return { filled, woundWord };
}

/** Engine-composed combat-status DATA for a continue-screen (B#5/B#6, ANSI-C): the engine keeps
 *  the banding maths only — enemy stays BANDED (never exact HP — hidden exact HP keeps tension);
 *  the player is EXACT, it's their own information, clamped to >=0 so a lethal round never
 *  displays negative HP mid-resolution (0/dead is resolved by the terminal outcome, not this
 *  continue screen). Frame assembly (glyphs, AnsiRenderer) moves to the presentation layer
 *  (`buildDecisionMessage`) so `src/render/` is never imported engine-side. */
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

/** Adapts a DECIDE-beat result into the single `LlmDecision` shape the critic-v1 prompt expects
 *  (it reads a `decision`/`prompt`/`mutations`/`outcome_text`-shaped object regardless of beat). */
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

/** Adapts a finalized RESOLVE-NARRATE beat (verdict-shaped, `done: true`) into the same
 *  `LlmDecision` shape — `mutations`/`outcomeText` carried through for the critic's context only,
 *  never fed back into the machine's own mutation handling. */
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
