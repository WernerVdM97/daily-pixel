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
  "A flash of light. The Warden's hand on your shoulder. " +
  'You wake beneath the Oak, your action lost to forces beyond mortal ken.';

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
    const { result: decideResult, criticCallIds } = await this.critiqueDecide(rawDecideResult, actionType, flags, context);
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
      ...([...gatewayCallIds, ...criticCallIds].length > 0
        ? { llmCallIds: [...gatewayCallIds, ...criticCallIds] }
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
    const { result: decideResult, criticCallIds } = await this.critiqueDecide(
      rawDecideResult, state.actionType, state.flags, context,
    );
    const beatCallIds = [stepDecideCallId, ...criticCallIds].filter(id => id !== 0);
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
   */
  private buildCombatBeat(
    cs: CombatState,
    roundResult: CombatRoundOutcome,
    enemyHpAfter: number,
    ops: string[],
    opts: { floorSave?: boolean } = {},
  ): CombatBeatLog {
    const materialMutationFired =
      roundResult.enemyHpDelta !== 0 || roundResult.playerHpDelta !== 0 || ops.some(o => o !== 'set_relation');
    return {
      round: cs.round,
      band: roundResult.band,
      enemyHpBefore: cs.enemyHp,
      enemyHpAfter,
      playerHpDelta: roundResult.playerHpDelta,
      materialMutationFired,
      ops,
      marker: 'combat_round',
      ...(opts.floorSave ? { floorSave: true } : {}),
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
        if (enemy.anchor === 'npc') {
          const nearbyNpcs = this.resolver.getNearbyNpcs(char.location) as NearbyNpc[];
          const resolved = resolveRelationEndpoint({ node: 'npc', name: enemy.name }, { id: char.id }, nearbyNpcs);
          if (resolved && resolved.type === 'npc') {
            anchor = { node: 'npc', name: resolved.ref };
          } else {
            // NPC resolution failed — default to location-anchored minion (decision 4 fallback).
            anchor = { node: 'location', name: char.location };
          }
        } else {
          anchor = { node: 'location', name: char.location };
        }

        const enemyMaxHp = deriveEnemyMaxHp(state.lastDecideResult.baseDc);
        cs = {
          enemyName: enemy.name,
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

        const nextDecision: ActionDecision = {
          prompt: 'The blow would be lethal — you feel death\'s cold touch. Make your stand or flee before it\'s too late.',
          options: [
            { label: 'Bail bloodied', dcModifier: null },
            { label: 'Last stand', dcModifier: 0 },
          ],
        };

        const nextState: PipelineInternalActionState = {
          ...state,
          decisions: newDecisions,
          accumulatedDc: newDc,
          desperateChoice: true,
          pendingDecision: nextDecision,
          combatAnchor: heldAnchor,
        };

        const floorMutations: WorldMutation[] = [
          { type: 'modify_health' as const, amount: floorPlayerHpDelta },
          { ...combatEdge, type: 'set_relation' } as unknown as WorldMutation,
          { ...saveRelation, type: 'set_relation' } as unknown as WorldMutation,
        ];
        return {
          resolved: false,
          state: nextState,
          nextDecision,
          mutations: floorMutations,
          combatBeat: this.buildCombatBeat(
            cs, roundResult, newEnemyHp, floorMutations.map(m => m.type), { floorSave: true },
          ),
        };
      } else {
        // ── Second lethal blow today → HP-zero, resolve failure ──
        return this.resolveCombat(
          cs, roundResult, playerHpDelta, newEnemyHp, 'failure',
          state, char, items, newDc, newDecisions, chosenOption,
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

    const updatedContext = { ...context, sceneState: updatedSceneState };
    // T4: NOT gated — combat truth is engine-owned (the contested roll + band already decided
    // this round), so there is no authored decision content here for the coherence critic to check.
    const { result: decideResult, callId: combatDecideCallId } = await this.llm.decide({
      actionType: state.actionType,
      flags: state.flags,
      context: updatedContext,
    });

    const nextDecision = toActionDecision(decideResult, state.required);
    // Engaged combat always offers a voluntary flee (dcModifier: null), caught by step()'s bail
    // path — which leaves the in_combat edge persisted, so the enemy is remembered (plan decision 4).
    // Filter any same-labelled decide option first so the engine's guaranteed-null flee wins step()'s
    // label lookup (a wayward LLM could author a real 'Flee the fight' despite BASE Rule 3).
    // ensureBail can't add this — it returns early for required actions, which combat always is.
    nextDecision.options = [
      ...nextDecision.options.filter(o => o.label !== COMBAT_FLEE_LABEL),
      { label: COMBAT_FLEE_LABEL, dcModifier: null },
    ];
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

    const continueMutations: WorldMutation[] = [
      { ...combatEdge, type: 'set_relation' } as unknown as WorldMutation,
      ...(playerHpDelta < 0
        ? [{ type: 'modify_health' as const, amount: playerHpDelta }]
        : []),
    ];
    return {
      resolved: false,
      state: nextState,
      nextDecision,
      mutations: continueMutations,
      combatBeat: this.buildCombatBeat(cs, roundResult, newEnemyHp, continueMutations.map(m => m.type)),
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
  ): Promise<{ resolved: true; state: PipelineInternalActionState; outcome: ActionOutcome }> {
    const context = buildPipelineContext(this.resolver, char, state.rawInput, recordToPrev(newDecisions), items);

    const d20Roll = roundResult.playerD20;
    const rollBonus = abilityCheckBonus(char.stats, items, state.rollStat);
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
      rawOutcomeText, verdict, decisionForHandoff, finalMutations as unknown[], context,
    );

    const mutations = [...finalMutations];
    if (state.wage && state.wage > 0) {
      mutations.push({ type: 'modify_wealth', amount: state.wage });
    }

    // Terminal beat (T5): built here, after `mutations` is fully assembled (incl. the wage
    // append), so `ops` matches exactly what the outcome reports.
    const combatBeat = this.buildCombatBeat(
      cs,
      roundResult,
      Math.max(0, finalEnemyHp),
      mutations.map(m => m.type),
    );

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
      rawOutcomeText, verdict, decisionForHandoff, finalMutations as unknown[], context,
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

    // Gate: the pipeline has no `_warnings` channel like the legacy deterministic validator, so
    // `required` (a high-stakes/reactive beat) is the whole gate here — mirrors
    // CritiquedLlmGateway's "required OR warnings" ladder with warnings unavailable. Clean,
    // low-stakes beats skip the critic entirely.
    if (!decideResult.required) return { result: decideResult, criticCallIds: [] };

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
  ): Promise<{ outcomeText: string; criticCallIds: number[] }> {
    if (!this.critic) return { outcomeText, criticCallIds: [] };

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
