import Database from 'better-sqlite3';
import { PipelineActionStateMachine, type PipelineInternalActionState } from '../engine/action/PipelineActionStateMachine.js';
import { applyMutations, type MutationContext } from '../engine/action/mutations.js';
import { resolveAuthoredRelation } from '../engine/action/relation-wiring.js';
import type { PipelineContextResolver } from '../engine/action/pipeline-context.js';
import type {
  ActionKind,
  ActionOutcome,
  ActionStartResult,
  ActionState,
  ActionStepResult,
  CharacterData,
  ItemData,
} from '../engine/WorldEngine.js';
import { createGeographyFinalize } from '../engine/geography-finalize.js';
import { runMigrations, seedWorld, SEEDED_LOCATIONS, SEEDED_EDGES } from '../db/migrate.js';
import { LocationRepository } from '../db/repositories/location.js';
import { LocationEdgeRepository } from '../db/repositories/locationEdge.js';
import { RelationRepository } from '../db/repositories/relation.js';
import type { PipelineLlmGateway } from '../llm/pipeline/types.js';
import { makeRollD20 } from './roll-source.js';
import type { CharacterSeed, RollSource } from './types.js';

// Fresh-character default, duplicated from WorldEngineImpl.ts's private DAILY_ROLL_ALLOWANCE
// (createCharacter, WorldEngineImpl.ts:76,409) — `CharacterSeed` has no rollsRemaining field
// (a real character's is always the day-one default, never scenario-authored), and this
// in-memory adapter has no DB row to read the constant off of. Same duplication rationale as
// engine-factory.ts's own mulberry32 copy: isolated, not meant to track engine internals.
const DAILY_ROLL_ALLOWANCE = 3;

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

  // Stage 2 T5b — private geography-capable world. `:memory:` with the FULL migration chain
  // applied (incl. the relations migration T1 registers last) and the seed world layered on, so
  // this adapter can reachability-gate movement (`createGeographyFinalize`) the same way the
  // live path does, not just persist scene-state relations. Deliberately NOT exposed on
  // `PipelineSimEngineHandle` (engine-factory.ts) — the handle shape and its
  // `'db' in handle === false` assertion (tests/sim/pipeline-sim.test.ts) stay unchanged.
  private readonly db: Database.Database;
  private readonly locationRepo: LocationRepository;
  private readonly edgeRepo: LocationEdgeRepository;
  private readonly relationRepo: RelationRepository;
  private readonly resolver: PipelineContextResolver;

  constructor(
    rollSource: RollSource,
    llm: PipelineLlmGateway,
    seed: CharacterSeed,
    private readonly discordUserId = 'sim:pipeline',
  ) {
    this.db = new Database(':memory:');
    this.db.pragma('foreign_keys = ON');
    runMigrations(this.db);
    seedWorld(this.db, SEEDED_LOCATIONS, SEEDED_EDGES);
    this.locationRepo = new LocationRepository(this.db);
    this.edgeRepo = new LocationEdgeRepository(this.db);
    this.relationRepo = new RelationRepository(this.db);

    // Same no-op shape as PipelineActionStateMachine's own default resolver for the parts this
    // adapter still has no backing for (NPC/PC), plus the two live hooks this pass wires: the
    // scene-state read-back (D1 "graph → markdown at ~0 tokens") and known-locations from the
    // seeded world (so the injected `createGeographyFinalize` below has a real set to validate
    // `move_to`/`set_location` reachability against).
    this.resolver = {
      getNearbyNpcs: () => [],
      getNearbyPcs: () => [],
      getRecentActions: () => [],
      getKnownLocations: () => this.locationRepo.findAll().map((l) => l.name),
      isLocationSafe: () => true,
      getLocalGeography: () => ({ region: null, neighbours: [], frontiers: [] }),
      getSceneRelations: (node) => this.relationRepo.forNode(node.type, node.ref),
    };

    this.machine = new PipelineActionStateMachine(
      llm,
      makeRollD20(rollSource),
      this.resolver,
      createGeographyFinalize({ locationRepo: this.locationRepo, edgeRepo: this.edgeRepo }),
    );
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

  /** Stage 2 T5c sim-metrics hook — total relation rows persisted at this point in the scenario
   *  (`relationRepo.count()`). Pipeline-only: the legacy sim path has no relation repo, so
   *  `runPipelineScenario` (driver.ts) is the only caller. */
  getPersistedRelationCount(): number {
    return this.relationRepo.count();
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
      // Geography (Stage 2 T5b) already ran inside the machine's injected finalize, ahead of
      // this call — outcome.mutations are the post-geography survivors, so applyMutations here
      // just applies them to in-memory char state; no `knownLocations` needed a second time.
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

    this.persistRelations(applied.relationsToSet, applied.relationsToUpdate);
  }

  /**
   * Stage 2 T3 persist point — `applied.relationsToSet/relationsToUpdate` carry endpoints AS
   * AUTHORED (decision 4; `mutations.ts`'s pure applier never does DB lookups). Resolve each via
   * the pure `relation-wiring.ts` helper against this adapter's own no-npc-store resolver, then
   * write through the private repo. An unresolvable edge is already warned by the helper —
   * silently skipped here, never a throw (mirrors `applyGeography`'s drop-with-warn).
   */
  private persistRelations(
    relationsToSet: ReturnType<typeof applyMutations>['relationsToSet'],
    relationsToUpdate: ReturnType<typeof applyMutations>['relationsToUpdate'],
  ): void {
    const nearbyNpcs = this.resolver.getNearbyNpcs(this.char.location);

    for (const relation of relationsToSet) {
      const key = resolveAuthoredRelation(relation, { id: this.char.id }, nearbyNpcs);
      if (!key) continue;
      this.relationRepo.set({ ...key, props: relation.props });
    }

    for (const relation of relationsToUpdate) {
      const key = resolveAuthoredRelation(relation, { id: this.char.id }, nearbyNpcs);
      if (!key) continue;
      const updated = this.relationRepo.updateProps(key, relation.props);
      if (!updated) {
        console.warn(
          `[PipelineSimEngine] dropping update_relation — no existing edge for ${key.fromType}:${key.fromRef} -> ${key.toType}:${key.toRef} (${key.relType})`,
        );
      }
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
