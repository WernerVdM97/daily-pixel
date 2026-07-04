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

1. **Pipeline-only. The live v11 path stays frozen.** Everything here lands on `PipelineActionStateMachine` / the pipeline contracts / new additive infra (a new table, a new repo, new pure mutation handling). No change to `machine.ts`, the live `PROMPT_VERSION`, or the prod `startAction`/`applyResolution` *behaviour* for existing ops. The teleport fix reaches players when the pipeline is later promoted, not in this stage. (Confirmed with the human.)
2. **Two-pass execution with a checkpoint.** Pass 1 = T1 (storage) + T2 (mutation vocabulary) — purely additive, touches nothing that runs today, fully unit-testable in isolation. **Human review, then** Pass 2 = T3 (spine wiring) + T4 (`scene_location` + travel gate) + T5 (real geography finalize into the pipeline + LLM-never-SQL proof). This doc specs all five so Pass 2 is anchored; only T1–T2 execute now.
3. **Scene-state is graph-shaped, persisted as a typed `relations` table in SQLite this round** (per D2). Real graph backend defers to MVP ([[mvp-data-model]]) — do not reach for one.
4. **Node identity is polymorphic `(type, ref)`, following existing conventions — not a new FK scheme.** `type ∈ 'pc' | 'npc' | 'location'`. `pc` ref = `character_id`; `npc` ref = the resolved npc **id** (the applier resolves the LLM-supplied name → id exactly as `update_npc` does today, `mutations.ts:219/328`); `location` ref = location **name** (matches `location_edges`). The schema-wide name→FK normalisation is **explicitly deferred to MVP** (`TODO.md`, [[per-player-map-exploration]] §6) — do not open it here.
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
**Validation** (`validateOne`): op recognised; `from`/`to` are well-formed `Endpoint`s; `relType` is a non-empty snake_case string in a **seed whitelist constant** (`in_combat`, `trust`, `disposition`, `knows_secret`, `fears`, `owes_debt`, `puzzle` — extensible; writers add theirs); `props` is a flat record of scalars with every number inside a global clamp (`RELATION_NUM_CLAMP`, e.g. ±9999) — per-`relType` prop schemas are out of scope (T2 scope fence). Endpoint name resolution (npc name→id) happens at **apply**, not validate; an unresolvable npc name is a dropped op with a warn at apply (mirrors `applyGeography`'s drop-with-warn, `WorldEngineImpl.ts:868`), never a throw.
**Collapse:** both ops pass through `collapseStackedDeltas` untouched (not in the collapsible set — `mutations.ts:71`).
**Drift guard:** the grounding found `MUTATION_TYPES` (`mutations.ts:41`) and the TS union (`WorldEngine.ts:80`) are two independent sources of truth. Add a drift guard mirroring the `ActionCategory` drift-proofing pattern (commit `62b102b`): prefer a single-source refactor if low-risk, else a test asserting `MUTATION_TYPES` exactly equals the union's members.
**Acceptance:**
- [ ] `validateMutations` accepts a well-formed `set_relation`/`update_relation` and rejects: unknown `relType`, malformed `Endpoint`, non-scalar/over-clamp `props`.
- [ ] `applyMutations` places a valid `set_relation` into `AppliedState.relationsToSet` and `update_relation` into `relationsToUpdate`, with the npc endpoint resolved to an id (unresolvable → dropped + warn).
- [ ] Drift guard present and green; `summariseMutation` and the category map handle both ops.
**Verification:** `npm test -- tests/engine/mutations.test.ts` (extend) green; full suite + `npm run typecheck` clean; **no `applyResolution`/pipeline behaviour change for existing ops** (assert against existing tests).
**Files:** `src/engine/WorldEngine.ts` (union), `src/engine/action/mutations.ts` (set + validate + apply + AppliedState fields), `src/engine/WorldEngineImpl.ts` (`summariseMutation` `:154`, `CATEGORY_MUTATION_MAP` `:116`), tests. **Scope:** L. **Deps:** T1 (for the `Endpoint`/`RelationRow` types; no runtime call yet).

### Checkpoint — after T1 + T2 (Pass 1 exit)
- [ ] Full suite green; typecheck clean; the additions run nowhere yet (storage + pure vocabulary only) — **the live path and every existing test are unchanged.**
- [ ] Human review before Pass 2 wires the spine into the pipeline.

### Task 3 — Scene-state spine wiring (D1) · **Pass 2**
**Description.** Wire `AppliedState.relationsToSet/Update` through to the `RelationRepository` in the pipeline's finalize/persist path; carry scene-state across beats (read `forNode` into the resolve `mutationCtx`); seed the subgraph→markdown context-assembly path ([[prompt-v12-scene-state]] D1 "graph → markdown at ~0 tokens"). **Exit:** a scripted pipeline scenario writes an edge on beat 1 and reads it back on beat 2 (enemy HP / disposition / clue persists across beats). **Files:** `PipelineActionStateMachine.ts` (`resolve` `:245`, `mutationCtx` `:288`), pipeline context assembly, sim. **Deps:** T1, T2.

### Task 4 — `scene_location` field + deterministic travel-coherence gate (D6) · **Pass 2**
**Description.** Add the `scene_location` field to the pipeline decision contract; the deterministic gate reads structured fields only (per D6: `normalize(scene_location) !== normalize(character.location) && !mutations.some(set_location)` → structural incoherence) and **injects the missing `set_location`** (no LLM re-authoring). Pipeline-only. **Exit:** the forge→forest teleport (narrated-divergence, no `set_location`) is fixed deterministically in the pipeline machine. **Files:** pipeline contracts (`src/llm/pipeline/types.ts`), the gate in `PipelineActionStateMachine`, tests. **Deps:** T3.

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

_Execution note: build task-by-task via delegated subagents per the orchestrated-delegation loop (executor builds → lead verifies + commits → fresh reviewer critiques → lead triages → fixer applies accepted findings → commit). **Pass 1 = T1 → T2 → checkpoint**; Pass 2 (T3–T5) after human review. Open questions carried forward: per-`relType` prop schemas (defined by Stage 3 combat + the conversation templates); subgraph→markdown context-assembly detail (T3); whether the `scene_location` gate later graduates to the live path._
