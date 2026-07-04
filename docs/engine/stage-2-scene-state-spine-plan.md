---
title: "Stage 2 — Scene-state spine + travel gate: build plan"
status: decided
domain: engine
phase: poc
tags: [llm, pipeline, scene-state, graph, thread-d, stage-2]
related: ["[[prompt-separation-of-concerns]]", "[[prompt-v12-scene-state]]", "[[prompt-v12-pipeline]]", "[[stage-1-thread-d-backbone-plan]]", "[[action-engine-framework]]", "[[mutation-vocabulary-refinement]]"]
---
_Handoff-ready build plan for Stage 2 of the v12 critical path: pin the typed, graph-shaped scene-state spine (D1), add edge-shaped typed mutations with no LLM SQL (D2), and close the deterministic travel/location coherence gap (D6) — all on the parallel `PipelineActionStateMachine`, leaving the live v11 path untouched. Executed in two passes: **Pass 1 (this orchestration) = the foundation (T1 storage + T2 mutation vocabulary), then a human checkpoint**; Pass 2 = the spine wiring + travel gate. Every anchor, type contract, and settled decision is inlined so a lesser agent can execute task by task._

---

## Why this shape

Stage 1 split the mega-call into classify → decide → (dice) → resolve on a parallel machine. Its real prize (per [[prompt-v12-pipeline]] D1) is that the pipeline can carry a **scene-state object across beats** instead of reconstructing "where are we" from `RECENT ACTIONS` prose every beat — the deterministic spine that lets combat track wounds, a puzzle keep one answer, an NPC hold a grudge. Stage 2 pins that structure (the still-unchecked gating prerequisite in [[prompt-separation-of-concerns]] — "pin the typed scene-state structure before Thread C", because `combatState` is its first writer in Stage 3), makes it graph-shaped and persistent in SQLite, and uses it to close the travel-coherence hole (D6).

## Settled decisions (ratified — do not re-litigate)

1. **Pipeline-only. The live v11 path stays frozen.** Everything here lands on `PipelineActionStateMachine` / the pipeline contracts / new additive infra (a new table, a new repo, new pure mutation handling). No change to `machine.ts`, the live `PROMPT_VERSION`, or the prod `startAction`/`applyResolution` *behaviour* for existing ops. The teleport fix reaches players when the pipeline is later promoted, not in this stage. (Confirmed with the human.) **Nuance (Pass-1 review):** because `mutations.ts`/`WorldEngineImpl.ts` are shared modules, the live validator now *accepts* `set_relation`/`update_relation` tokens instead of dropping them as unknown — but they land inertly in the dangling `AppliedState` fields, are never persisted or read on the live path, and the frozen `PROMPT_VERSION` never emits them. "Pipeline-only" for the vocabulary is therefore **by convention** (the live prompt never asks for these ops), not a structurally separate code path.
2. **Two-pass execution with a checkpoint.** Pass 1 = T1 (storage) + T2 (mutation vocabulary) — purely additive, touches nothing that runs today, fully unit-testable in isolation. **Human review, then** Pass 2 = T3 (spine wiring) + T4 (`scene_location` + travel gate) + T5 (real geography finalize into the pipeline + LLM-never-SQL proof). This doc specs all five so Pass 2 is anchored; only T1–T2 execute now.
3. **Scene-state is graph-shaped, persisted as a typed `relations` table in SQLite this round** (per D2). Real graph backend defers to MVP ([[mvp-data-model]]) — do not reach for one.
4. **Node identity is polymorphic `(type, ref)`, following existing conventions — not a new FK scheme.** `type ∈ 'pc' | 'npc' | 'location'`. `pc` ref = `character_id`; `npc` ref = the resolved npc **id**; `location` ref = location **name** (matches `location_edges`). **Resolution ownership:** the pure `mutations.ts` applier does NOT do DB lookups — exactly as `update_npc`/`remove_npc` carry a pre-resolved `npcId` supplied upstream by the gateway (`mutations.ts:32-34`), the endpoint npc-name→id resolution for relations happens **upstream at the T3 wiring layer**, not in Pass 1's pure applier. The schema-wide name→FK normalisation is **explicitly deferred to MVP** (`TODO.md`, [[per-player-map-exploration]] §6) — do not open it here.
5. **The LLM never emits SQL.** Mutations are edge-shaped typed deltas; the engine validates against a whitelist, resolves endpoints, clamps numeric props, and writes the query itself (D2). This is a hard invariant with a test in T5.
6. **Op-name reconciliation.** The design doc ([[prompt-v12-scene-state]] D2) writes `{ op, from, to, type, props }`. The codebase `WorldMutation` already uses `type` for the **op name** (`WorldEngine.ts:79`). So in code the op name is `type: 'set_relation' | 'update_relation'` and the *relationship* kind is carried as **`relType`** (doc's `type` → code's `relType`; doc's `op` → code's `type`). Document this at the type definition so the mapping to the design doc is unambiguous.

## Graph model (what the spine stores)

A `relations` row is a typed, directed edge between two nodes, uniquely identified by `(from, to, relType)`; `props` is a JSON bag of clamped scalars.

```
PC ──in_combat{enemyHp, posture, round}──▶ NPC        (Thread C — Stage 3's first writer)
PC ──trust{score}──▶ NPC                               (conversation — later)
PC ──knows_secret{}──▶ NPC | location                  (conversation/puzzle — later)
location ──self is_safe{...}                           (mutable safety — reads current, not static)
```

Pass 1 pins the **structure + vocabulary**; the concrete per-`relType` prop schemas (combat's `enemyHp`, conversation's `trust`) are defined by their writers in Stage 3+ — Pass 1 validates only the generic edge shape (see T2 scope fence).

## Task breakdown

### Task 1 — Relations storage (migration + repository) · **Pass 1**
**Description.** Add a new migration creating the typed `relations` table and a `RelationRepository` mirroring `locationEdge.ts`. Additive only — nothing reads/writes it yet (T3 wires it in).
**Schema** (`relations`): `id INTEGER PK AUTOINCREMENT`, `from_type TEXT NOT NULL CHECK(from_type IN ('pc','npc','location'))`, `from_ref TEXT NOT NULL`, `to_type TEXT NOT NULL CHECK(...)`, `to_ref TEXT NOT NULL`, `rel_type TEXT NOT NULL`, `props TEXT NOT NULL DEFAULT '{}'` (JSON object), `created_by_action_id INTEGER`, `updated_day INTEGER`, `UNIQUE(from_type, from_ref, to_type, to_ref, rel_type)`, plus `idx_relations_to (to_type, to_ref)` mirroring `idx_location_edges_to`.
**Repository** (`src/db/repositories/relation.ts`, mirror `locationEdge.ts`): `set(edge)` (upsert by the unique key — `INSERT … ON CONFLICT DO UPDATE SET props=…, updated_day=…`), `updateProps(key, propDeltas)` (merge onto an existing edge; returns whether a row existed), `find(key)`, `forNode(type, ref)` (all edges touching a node, both directions — the D1 subgraph read used by T3's context assembly), `remove(key)`. Row type `RelationRow` in `src/db/repositories/types.ts`.
**Acceptance:**
- [ ] Migration filename is `YYYYMMDDHHMM_scene_relations.ts` (use a 2026-07 stamp, e.g. `202607041000`), `id` matches the stem, `up()` is idempotent (`CREATE TABLE IF NOT EXISTS`), registered last in `src/db/migrations/index.ts`. New schema is **not** added to `schema.sql`/baseline.
- [ ] Repo round-trips: `set` then `find` returns the edge; a second `set` on the same key upserts props (no duplicate row); `updateProps` merges numeric deltas and returns `false` for a missing edge; `forNode` returns edges in both directions.
**Verification:** `npm test -- tests/db/relation.test.ts` green; `npm run typecheck` clean; a test applies the migration to a `:memory:` db and asserts the table + index exist.
**Files:** `src/db/migrations/<stamp>_scene_relations.ts` (new), `src/db/migrations/index.ts`, `src/db/repositories/relation.ts` (new), `src/db/repositories/types.ts`, `tests/db/relation.test.ts` (new). **Scope:** M. **Deps:** none.

### Task 2 — `set_relation` / `update_relation` mutation vocabulary · **Pass 1**
**Description.** Extend the typed mutation vocabulary with the two edge-shaped ops end-to-end through the **pure** `src/engine/action/mutations.ts` layer (validate → collapse → apply-to-`AppliedState`), plus the `WorldEngine.ts` union, the runtime `MUTATION_TYPES` set, `summariseMutation`, and the category map. **Persistence is NOT wired in this pass** — `applyMutations` collects the edges into new `AppliedState` fields (`relationsToSet` / `relationsToUpdate`); T3 consumes them via the repo. State this intentional dangling-output in code comments so review doesn't flag it as dead code.
**Op shape** (fits the open-bag `WorldMutation`; see decision 6): `{ type: 'set_relation', from: Endpoint, to: Endpoint, relType: string, props: Record<string, number|string|boolean> }` and the same with `type: 'update_relation'` (props carry deltas/sets). `Endpoint = { node: 'pc' } | { node: 'npc', name: string } | { node: 'location', name: string }`.
**Validation** (`validateOne`): op recognised; `from`/`to` are well-formed `Endpoint`s; `relType` is a non-empty snake_case string in a **seed whitelist constant** (`in_combat`, `trust`, `disposition`, `knows_secret`, `fears`, `owes_debt`, `puzzle` — extensible; writers add theirs); `props` is a flat record of scalars with every number inside a global clamp (`RELATION_NUM_CLAMP`, e.g. ±9999) — per-`relType` prop schemas are out of scope (T2 scope fence). Endpoint name resolution (npc name→id) is **NOT done by the pure applier** — mirroring `update_npc`/`remove_npc`, which receive a pre-resolved `npcId` from upstream (`mutations.ts:32-34`), the pure `applyMutations` collects endpoints **as authored** into `AppliedState`; the npc-name→id resolution and the drop-of-unresolvable (drop-with-warn, never a throw — mirrors `applyGeography` `WorldEngineImpl.ts:868`) are deferred to T3's engine wiring.
**Collapse:** both ops pass through `collapseStackedDeltas` untouched (not in the collapsible set — `mutations.ts:71`).
**Drift guard:** the grounding found `MUTATION_TYPES` (`mutations.ts:41`) and the TS union (`WorldEngine.ts:80`) are two independent sources of truth. Add a drift guard mirroring the `ActionCategory` drift-proofing pattern (commit `62b102b`): prefer a single-source refactor if low-risk, else a test asserting `MUTATION_TYPES` exactly equals the union's members.
**Acceptance:**
- [ ] `validateMutations` accepts a well-formed `set_relation`/`update_relation` and rejects: unknown `relType`, malformed `Endpoint`, non-scalar/over-clamp `props`.
- [ ] `applyMutations` places a valid `set_relation` into `AppliedState.relationsToSet` and `update_relation` into `relationsToUpdate`, carrying endpoints **as authored** (npc-name→id resolution + drop-of-unresolvable deferred to T3, per decision 4).
- [ ] Drift guard present and green; `summariseMutation` and the category map handle both ops.
**Verification:** `npm test -- tests/engine/mutations.test.ts` (extend) green; full suite + `npm run typecheck` clean; **no `applyResolution`/pipeline behaviour change for existing ops** (assert against existing tests).
**Files:** `src/engine/WorldEngine.ts` (union), `src/engine/action/mutations.ts` (set + validate + apply + AppliedState fields), `src/engine/WorldEngineImpl.ts` (`summariseMutation` `:154`, `CATEGORY_MUTATION_MAP` `:116`), tests. **Scope:** L. **Deps:** T1 (for the `Endpoint`/`RelationRow` types; no runtime call yet).

### Checkpoint — after T1 + T2 (Pass 1 exit)
- [ ] Full suite green; typecheck clean; the additions run nowhere yet (storage + pure vocabulary only) — **the live path and every existing test are unchanged.**
- [ ] Human review before Pass 2 wires the spine into the pipeline.

### Task 3 — Scene-state spine wiring (D1) · **Pass 2**
**Description.** Wire `AppliedState.relationsToSet/Update` through to the `RelationRepository` in the pipeline's finalize/persist path; carry scene-state across beats (read `forNode` into the resolve `mutationCtx`); seed the subgraph→markdown context-assembly path ([[prompt-v12-scene-state]] D1 "graph → markdown at ~0 tokens"). **Exit:** a scripted pipeline scenario writes an edge on beat 1 and reads it back on beat 2 (enemy HP / disposition / clue persists across beats). **Files:** `PipelineActionStateMachine.ts` (`resolve` `:245`, `mutationCtx` `:288`), pipeline context assembly, sim. **Deps:** T1, T2.

#### T3 — settled design (execution contract)
The grounding survey established the seams: the pipeline path is pure in-memory today (`PipelineSimEngine`, no DB, no repo instantiated anywhere — `engine-factory.ts` pipeline branch builds none), the machine's `finalize` seam (`PipelineActionStateMachine.ts:288-298`) and the empty default `resolver` (`:83-86`) are the wiring points, and `machine.ts` stays frozen (decision 1 — `WorldContextResolver` is declared there and must NOT be edited, mirroring the `pipeline-context.ts` duplication rationale).

**Storage seam (decision 3 — SQLite `relations` table is this round's backend).** `PipelineSimEngine` gains a **private** `:memory:` `better-sqlite3` DB with ONLY the relations migration applied (`migration.up(db)` from `src/db/migrations/202607041000_scene_relations.ts` — not the full baseline) and a **private** `RelationRepository`. The DB stays internal to the engine — it is NOT exposed on `PipelineSimEngineHandle`, so the existing `'db' in handle === false` / `'charRepo' in handle === false` assertions (`tests/sim/pipeline-sim.test.ts`) stay green by design.

**Endpoint resolution (the "T3 wiring layer" decision 4 defers to).** A small pure helper resolves an authored `RelationEndpoint` → a `RelationKey` node `(type, ref)`: `pc` → `('pc', String(char.id))`; `location` → `('location', name.trim())` (name-keyed, no lookup — matches `location_edges`); `npc` → resolve the authored name against `resolver.getNearbyNpcs(location)` by case-insensitive match → that npc's `id` as ref. Resolution order is npc-first then location (risk table); an **unresolvable** endpoint drops the whole edge **with a `console.warn`, never a throw** (mirrors `applyGeography`'s drop-with-warn, `WorldEngineImpl.ts:891`). This helper is unit-testable in isolation and is where decision 4's resolution lives.

**Persist point.** `PipelineSimEngine.applyOutcome` (`:177`) already calls the pure `applyMutations`; after it, read `applied.relationsToSet` / `applied.relationsToUpdate`, resolve endpoints via the helper, and call `repo.set(edge)` / `repo.updateProps(key, propDeltas)`. Relation ops pass through the machine's `resolve`→`finalize` untouched (they are not collapsible and `validateMutations` already accepts them) — persistence is a resolution-level concern handled by the persister, not the machine.

**Read-back (D1 "graph → markdown at ~0 tokens").** Define a pipeline-local resolver type (e.g. `PipelineContextResolver extends WorldContextResolver`) in a pipeline file — NOT in `machine.ts` — adding an optional `getSceneRelations?(node: { type: NodeType; ref: string }): RelationRow[]`. Retype `PipelineActionStateMachine.resolver` and `buildPipelineContext`'s param to it. `buildPipelineContext` calls `getSceneRelations({ type: 'pc', ref: String(char.id) })` and maps the rows into a new **optional** `LlmContext.sceneState` field (a STRUCTURED array of `{ from, to, relType, props }` — the markdown *rendering* is a v12-template concern and stays out of scope per the scope fence; T3 only lays the data channel). `PipelineSimEngine` injects a resolver whose `getSceneRelations` reads `repo.forNode(node.type, node.ref)`.

**Exit tests.** (a) A sim/integration scenario writes a `pc → location` edge (e.g. `knows_secret` / `disposition` — endpoints that need no npc store) on action 1's resolve and asserts action 2's `decide`/`resolveMutate` input `context.sceneState` carries the persisted edge (cross-turn read-back). (b) A focused unit test on the endpoint-resolution helper: a resolver with a scripted nearby npc resolves `npc` name → id; an empty resolver drops the edge with a warn (covers decision 4's npc path even though the sim scenario uses pc/location endpoints). **Do not** touch the live path; the `pipeline-sim.test.ts` handle-shape assertions must remain unchanged and green.

**T3 review triage — deferred (tracked, not fixed in T3).** Three review findings were accepted as real but deliberately deferred out of T3's slice: (1) **cross-bucket set/update ordering** — `applyMutations` splits `set_relation`/`update_relation` into two `AppliedState` arrays (T2's already-ratified shape), so a set + an update to the *same* edge authored in *one* resolve always persists set-then-update regardless of authored order. Pathological today (no writer emits both for one edge in one beat); **revisit when Stage 3 combat makes `update_relation` a heavy writer** — the fix belongs at the T2 collection layer, not T3. (2) **duplicate npc-name resolution** picks the first case-insensitive match silently — an MVP name→FK concern (already deferred), moot in the POC sim (empty npc store). (3) **the private `:memory:` relations DB is never closed** — no leak surface at today's per-test / one-engine-per-run usage; an uncalled `dispose()` would be dead code. Fixed in the T3 review-fix commit: `update_relation` on a missing edge now warns (was a silent no-op, breaking the "drop-with-warn, never silent" invariant), plus the stale `engine-factory.ts` "pure in-memory / no DB" comment.

### Task 4 — `scene_location` field + deterministic travel-coherence gate (D6) · **Pass 2**
**Description.** Add the `scene_location` field to the pipeline decision contract; the deterministic gate reads structured fields only (per D6: `normalize(scene_location) !== normalize(character.location) && !mutations.some(set_location)` → structural incoherence) and **injects the missing `set_location`** (no LLM re-authoring). Pipeline-only. **Exit:** the forge→forest teleport (narrated-divergence, no `set_location`) is fixed deterministically in the pipeline machine. **Files:** pipeline contracts (`src/llm/pipeline/types.ts`), the gate in `PipelineActionStateMachine`, tests. **Deps:** T3.

#### T4 — settled design (execution contract)
Grounded against [[prompt-v12-scene-state]] D6 (the authoritative spec — option **B2**, "declare location as data"): `scene_location` lives on the **decision contract**, the gate reads **structured fields only** (never NLP over prose), and the remedy is to **inject the missing `set_location`** deterministically — no LLM re-authoring, no re-decide. The bug it closes (D6, testing review action 16): a Blacksmith at The Town Forge typed "go to the woods and brawl"; the model authored a forest fight with no `set_location`, so the scene teleported while the engine kept the character at the Forge.

**Contract field.** Add `sceneLocation?: string` to `PipelineDecideResult` (`src/llm/pipeline/types.ts`) — doc's `scene_location` → code camelCase; document the mapping at the field. Optional: absent means "no scene declared," and the gate is a strict no-op (every existing scripted decide result stays valid unchanged). It is already threaded to resolve on `state.lastDecideResult` (`PipelineActionStateMachine.ts:44`, handed off as `decisionForHandoff`) — no new state plumbing.

**The gate (pure, unit-testable).** A small exported helper (e.g. `src/engine/action/travel-gate.ts`): `applyTravelCoherenceGate(mutations, sceneLocation, currentLocation): WorldMutation[]`. If `sceneLocation` is a non-empty string AND `normalize(sceneLocation) !== normalize(currentLocation)` AND no location-change mutation is present, append `{ type: 'set_location', name: sceneLocation }` and `console.warn` the deterministic injection (observability — mirrors the drop-with-warn telemetry style). Otherwise return the list unchanged. `normalize` = `.trim().toLowerCase()` (the casing convention already used in `mutations.ts`/`applyGeography`). **"No location-change mutation" means none of `set_location` / `move_to` / `cross_frontier`** — D6 writes `set_location`, but `move_to` is its alias and `cross_frontier` also relocates (`mutations.ts` treats all three as a relocate), so any of them already satisfies travel and must suppress the injection.

**Wiring.** In `PipelineActionStateMachine.resolve()`, run the gate on `proposedMutations` **between `resolveMutate` and `this.finalize(...)`** (~`:275-298`), using `state.lastDecideResult.sceneLocation` and `char.location`. The augmented list then flows through `finalize` — so once T5 wires real geography, an injected `set_location` to an unreachable `scene_location` is reachability-gated like any other move (correct D6 layering: **the gate injects intent; geography enforces feasibility** — the gate is the deterministic backstop, not a teleport grant).

**Exit tests.** (a) Pure-gate unit tests: incoherent (scene ≠ current, no travel mutation) → injects `set_location` to the scene; coherent same-location (incl. different casing) → no-op; already has `set_location` / `move_to` / `cross_frontier` → no-op; `sceneLocation` absent/empty → no-op. (b) A machine- or sim-level repro of the forge→forest teleport: a scripted `decide` returns `sceneLocation: 'the woods'`, `resolveMutate` returns a fight mutation with NO `set_location`, and the resolved `outcome.mutations` is asserted to contain the injected `set_location` to "the woods". **Scope fence:** pipeline-only; do not touch `machine.ts` / the live `PROMPT_VERSION` / `applyResolution`. No v12 template content (scripted `sceneLocation` in tests, per Stage 1). No live-path teleport patch.

### Task 5 — Real geography finalize into the pipeline + LLM-never-SQL proof · **Pass 2**
**Description.** Close the pipeline's identity-passthrough bypass the grounding found (`PipelineActionStateMachine.ts:92-95` default finalize; sim injects collapse+validate-only, no geography) by injecting the real `finalizeMutations` (geography→collapse→validate, `WorldEngineImpl.ts:675`) so pipeline `move_to`s are reachability-gated like the live path. Assert the LLM-never-SQL invariant. Extend sim metrics for a persistence-across-beats scenario. **Files:** `PipelineActionStateMachine.ts`, `src/sim/*`, tests. **Deps:** T3.

## Scope fence

**In scope:** the `relations` table + repo; the two edge-shaped mutation ops through the pure mutation layer; (Pass 2) spine wiring, the `scene_location` gate, and real geography finalize on the pipeline. **Explicitly OUT of scope (do NOT do):**
- Touching the live `machine.ts` / `PROMPT_VERSION` / prod `startAction` behaviour, or adding a live-path teleport patch (decision 1 — pipeline-only).
- Per-`relType` prop schemas / clamps (combat's `enemyHp` bounds, conversation's `trust` range) — those belong to their writers (Stage 3+). Pass 1 validates only the generic edge shape.
- Schema-wide location name→FK normalisation (deferred to MVP).
- A real graph backend (SQLite typed table this round).
- Authoring v12 template *content* for scene-state (scripted/stub in sim, per Stage 1).

## Risks

| Risk | Mitigation |
|------|-----------|
| Mutation union vs runtime `MUTATION_TYPES` drift (two sources of truth) | T2 drift guard (mirror the `ActionCategory` pattern, commit `62b102b`). |
| `AppliedState.relationsToSet/Update` dangling (produced in Pass 1, consumed in Pass 2) reads as dead code | Documented as intentional in code + this plan; T3 consumes it. Mirrors Stage 1 building the parallel machine before wiring. |
| Endpoint name resolution ambiguity (npc vs location same name) | Resolve npc-by-name first, then location; unresolvable → drop+warn, never a wrong write or throw. |
| Persisting relations in a shared applier could perturb the live path | Pass 1 does NOT persist (pure layer only); Pass 2 wires it into the **pipeline** finalize, not `applyResolution`. Assert existing-op behaviour unchanged. |
| LLM handed state-truth via SQL | Hard invariant: typed edge deltas only; T5 asserts no SQL string ever reaches persistence. |

## Verification (stage exit — after Pass 2)

- A pipeline action writes an edge (`set_relation`) on one beat and the next beat reads it back — enemy HP / NPC disposition / puzzle clue persists across beats.
- The forge→forest teleport (divergent `scene_location`, no `set_location`) is fixed deterministically in the pipeline machine; the engine injects the missing travel step.
- The LLM never emits SQL; every relation write goes through the typed op → validator → repo.
- The live v11 path and every existing test are unchanged. `npm run typecheck` clean; `npm test` green.

---

_Execution note: build task-by-task via delegated subagents per the orchestrated-delegation loop (executor builds → lead verifies + commits → fresh reviewer critiques → lead triages → fixer applies accepted findings → commit). **Pass 1 = T1 → T2 → checkpoint**; Pass 2 (T3–T5) after human review. Open questions carried forward: per-`relType` prop schemas (defined by Stage 3 combat + the conversation templates); subgraph→markdown context-assembly detail (T3); whether the `scene_location` gate later graduates to the live path; `summariseMutation`/`CATEGORY_MUTATION_MAP` handling of the two relation ops has no direct test (both unexported + inert in Pass 1 — traced correct in review; gets natural regression coverage once T3 feeds relation ops through `finalizeMutations`)._
