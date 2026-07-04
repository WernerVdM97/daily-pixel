---
title: "Stage 1 — Thread D backbone: build plan"
status: decided
domain: engine
phase: poc
tags: [llm, pipeline, thread-d, stage-1, sim]
related: ["[[prompt-separation-of-concerns]]", "[[prompt-v12-pipeline]]", "[[v12-prompt-set-versioning]]", "[[stage-0a-sim-harness-plan]]", "[[action-engine-framework]]", "[[prompt-v12-scene-state]]"]
---
_Handoff-ready build plan for Stage 1 of the v12 critical path: decompose the single mega-LLM-call into a classify → decide → (dice) → resolve pipeline, built as a **parallel `PipelineActionStateMachine` exercised through the Stage 0a sim harness** so the live v11 path is untouched until the pipeline is proven. Includes the D5b mutation-finalization inversion. Every architecture decision, code anchor, and risk is inlined so a lesser agent can execute it task by task._

---

## Why this shape

Today one `decide()` contract is called 2–3 times per beat (open decision → optional CONTINUE beat → narrate-as-resolve), carrying the entire ~5,600-token rulebook every time (`machine.ts:87,244,315`). Thread D ([[prompt-v12-pipeline]]) splits it into focused, per-type stages. Stage 1 is the backbone; it is the most invasive change in the effort, so per the parent spec ([[prompt-separation-of-concerns]] Stage 1) we **prototype off the live loop first**.

## Settled decisions (ratified — do not re-litigate)

1. **Prototype strategy: a parallel machine driven by the sim harness.** Build a new `PipelineActionStateMachine` beside the legacy `ActionStateMachine`. The sim `engine-factory` can construct either; the sim `driver` runs the same scenarios through both and compares `TurnTrace` metrics. The prod `WorldEngineImpl` keeps using the legacy machine — **the live v11 path is untouched by this stage.** This is what Stage 0a was built to enable.
2. **Include the D5b inversion.** Resolve authors `outcome_text` against **final** mutations: the engine's deterministic finalize (geography → collapse → validate) runs *before* resolve narrates. Fixes the critic-v1 defect class (text written against pre-adjustment mutations). Contained entirely in the parallel machine, so the risk stays off the live path.
3. **Classify = heuristic-first, wide regex/ngram matcher, LLM fallback.** A broad regex/ngram table maps short inputs → `ActionType` + routing flags with zero LLM cost; an LLM classify call fires only on a miss (ambiguous free text). The LLM-fallback path is a **seam** in the prototype (the sim scripts it); a real fallback impl is not required for Stage 1's exit.
4. **Classify fires once per action** (at `NEW_ACTION`), not per beat. The `ActionType` is pinned for the action; a CONTINUE beat has already been routed.
5. **`ActionType` replaces `category`** as the machine routing key (category is telemetry-only today, `WorldEngineImpl.ts:127-139`). **`distilledType` is demoted** to a free-text narrative/display label (still authored at decide/resolve for flavour + the `actions.type` column + Discord rendering), decoupled from routing. It is **not** removed — three consumers read it (display `action.ts:230,376,620`; DB `WorldEngineImpl.ts:589`; the divine-intervention sentinel).

## Pipeline contract (what the parallel machine runs)

```
raw input
   │
   ▼  (once per action, NEW_ACTION only)
[CLASSIFY]  heuristic regex/ngram → ActionType + flags {unsafe_location, needs_roll, target_present}
   │          miss → LLM classify fallback (seam; scripted in sim)
   ▼  (per beat — replaces NEW_ACTION + CONTINUE)
[DECIDE]    ActionType selects a v12 template (loadPromptSet(...).decide[type]);
   │          authors OPTIONS ONLY (per-option stat/dc). NO mutations, NO outcome_text.
   ▼
[DICE]      roll-first, unchanged (dc.ts resolveRoll; rollD20 injectable)
   │
   ▼  (replaces RESOLVE_ROLL — the INVERSION lives here)
[RESOLVE-MUTATE]   fresh session, structured handoff {decisions, verdict, world} → PROPOSED mutations
   │
   ▼
[ENGINE FINALIZE]  deterministic: geography → collapse → validate → FINAL mutations  (pure, no persist)
   │
   ▼
[RESOLVE-NARRATE]  fresh session, {FINAL mutations, verdict, world} → outcome_text
   │
   ▼
persist (actions row + llm_calls, per-stage stamped)
```

Key inversion point: today narration + mutation authoring happen in one call *before* the engine's transforms (`machine.ts:315` → `WorldEngineImpl.applyResolution:470`). Stage 1 splits mutation-authoring from text-authoring and slots the engine's finalize *between* them, so `outcome_text` is authored against the mutations that actually landed. The finalize logic must be extracted from `applyResolution` into a **pure function** (finalize-only, no DB write) the pipeline machine can call.

## Sim-harness integration (the proving ground)

- The engine takes `llm` as a plain constructor field (`WorldEngineImpl.ts:227`); the sim `engine-factory.ts:69-98` already swaps in a `ScriptedLlmGateway` + seeded `rollD20`. Add a knob to `buildSimEngine` / `SimEngineHandle` (`engine-factory.ts:48-57`) selecting **legacy vs pipeline** machine.
- `ScriptedLlmGateway` is single-method (`decide` only, `ScriptedLlmGateway.ts:11-22`). The pipeline needs 3 distinct scripted stage shapes. Extend the sim `DecisionScript`/gateway to disambiguate stage (classify / decide / resolve-mutate / resolve-narrate) — a `PipelineScriptedGateway` with per-stage callbacks, or a stage tag on the existing script.
- **A scripted stage must never throw** — a throwing gateway trips the FallbackLlmGateway → divine-intervention trap the sim already documented (`stage-0a-sim-harness-plan.md:47`). Return valid stage outputs.
- The sim `driver.runTurn` (`driver.ts:67-113`) calls `engine.startAction`/`stepAction` and is machine-agnostic — so if the pipeline machine satisfies the same `startAction`/`stepAction` surface, the driver needs no per-turn changes; only engine construction selects the machine.

## Task breakdown

### Task 1 — Pipeline types + heuristic classifier
**Description.** Define the pipeline's stage contracts (a `PipelineLlmGateway`-shaped interface with `classify` / `decide` / `resolveMutate` / `resolveNarrate`, or an orchestrator + a small stage-tagged gateway) and implement the heuristic classifier: a **wide regex/ngram table** mapping short inputs → `ActionType` + `{unsafe_location, needs_roll, target_present}`, with a typed "miss → needs LLM fallback" result. The LLM fallback itself is a stub/seam (returns a not-implemented marker or a scriptable hook), not a real call in this task.
**Acceptance:**
- [ ] A broad set of short n-gram inputs classifies to the correct `ActionType` (rest, obvious travel/combat/social/skill/search verbs); ambiguous input returns a `miss` signal, never a wrong guess.
- [ ] `ActionType` is the canonical `ActionCategory` union (`LlmGateway.ts:52`) — no new enum.
**Verification:** `npx vitest run <classifier test>` green; typecheck clean.
**Files:** `src/llm/pipeline/{types.ts,classifier.ts}` (new), `tests/llm/pipeline/classifier.test.ts`. **Scope:** M. **Deps:** none.

### Task 2 — `PipelineActionStateMachine` (decide emits options only)
**Description.** New class mirroring `ActionStateMachine`'s public surface (`start`/`step`/`resume`) so the engine/sim call it identically, but internally: classify-once → decide (options only) → dice → resolve. Reuse `WorldContextResolver`/`buildContext`. Decide must NOT author mutations or `outcome_text`. Resolve-mutate produces proposed mutations from a structured, typed handoff (not prose). Do NOT touch the legacy `machine.ts`. Use a **typed** representation for the divine-intervention fallback — do not overload `distilledType` with the `'__divine__'` string.
**Acceptance:**
- [ ] `start`/`step`/`resume` signatures match the legacy machine so a caller can be pointed at either.
- [ ] Decide output carries options + per-option stat/dc only; asserted empty of mutations/outcome_text.
- [ ] The handoff into resolve is a typed object, not a re-parsed string.
**Verification:** unit tests drive a scripted action to resolution through the new machine; typecheck + full suite green.
**Files:** `src/engine/action/PipelineActionStateMachine.ts` (new), `tests/engine/pipeline-machine.test.ts`. **Scope:** L. **Deps:** T1.

### Task 3 — The mutation-finalization inversion
**Description.** Extract the deterministic finalize (geography `applyGeography:794` → `collapseStackedDeltas:505` → `validateMutations`) from `WorldEngineImpl.applyResolution` into a **pure function** (no DB write) returning `final_mutations`. The pipeline machine calls: resolve-mutate → finalize → resolve-narrate(final_mutations). Legacy `applyResolution` keeps working unchanged (it may call the extracted pure fn internally, but its behaviour must be identical — verify against existing tests).
**Acceptance:**
- [ ] A pure `finalizeMutations(proposed, ctx)` exists and is covered by tests; `applyResolution` still passes all its existing tests unchanged.
- [ ] In the pipeline machine, `outcome_text` is authored against `final_mutations` (prove with a scenario where finalize drops/rewrites a mutation and the text reflects the final set).
**Verification:** existing engine tests green (behaviour-preserving extraction); new inversion test green.
**Files:** `src/engine/WorldEngineImpl.ts` (extract), `src/engine/action/PipelineActionStateMachine.ts`, tests. **Scope:** L. **Deps:** T2.

### Task 4 — Sim-harness dual-machine integration + metric compare
**Description.** Add a machine-selector knob to `buildSimEngine`/`SimEngineHandle`; extend the sim gateway to script the pipeline's 3 stages deterministically (`PipelineScriptedGateway` or a stage-tagged `DecisionScript`); let the driver run a scenario through both machines and emit a comparison (per-turn `TurnTrace` diff / the existing metrics side by side). Scripted stages never throw.
**Acceptance:**
- [ ] `npm run sim` can run a scenario through the pipeline machine and produces a `SimResult`.
- [ ] A comparison mode reports legacy vs pipeline metrics for the same scenario + seed.
**Verification:** sim runs end-to-end on both example scenarios; new sim tests green.
**Files:** `src/sim/{engine-factory.ts,driver.ts,ScriptedLlmGateway.ts,types.ts}`, `tests/sim/*`. **Scope:** L. **Deps:** T2 (T3 for faithful resolve).

### Task 5 — Per-stage prompt-version stamping + latency measurement
**Description.** Wire `stampFor` (`prompt-builder.ts:84`) into the pipeline's `llm_calls` records so each stage stamps `v12/classify`, `v12/<type>` (decide), `v12/resolve`; extend `LlmCallRecorder`/`callKind` to carry the stage (today `callKind:'decision'` is a single literal, `DeepseekLlmGateway.ts:163`). Measure the pipeline's latency tail via the sim metrics (the exit criterion "the latency tail is measured").
**Acceptance:**
- [ ] Each pipeline stage's llm_calls row is stamped with its `v12/<stage>` version; `actions.prompt_version` carries the set (`v12`).
- [ ] A latency/stage-count metric is emitted by the sim for a pipeline run.
**Verification:** a test asserts the stamps; sim metric output shows per-stage counts.
**Files:** `src/llm/{LlmCallRecorder.ts,pipeline/*}`, `src/sim/metrics.ts`, tests. **Scope:** M. **Deps:** T2.

### Checkpoint — after T2 and after T3
- [ ] Full suite green; the **legacy path and all its tests are unchanged** (the parallel machine adds, never edits, live behaviour).
- [ ] Review with a human before wiring anything toward the live loop.

## Scope fence

**In scope:** the parallel pipeline machine, the heuristic classifier (+ fallback seam), the D5b inversion (via a pure finalize fn), sim dual-machine integration + metric compare, per-stage stamping, latency measurement. **Explicitly OUT of scope (do NOT do):**
- Touching the live `PROMPT_VERSION`/`machine.ts`/prod `startAction` path.
- Authoring real template *content* for the v12 stubs (Stage 1 uses scripted/stub prompts; prose authoring is later).
- Promoting `CATEGORY_MUTATION_MAP` from warn-only to enforced (a separate decision — `WorldEngineImpl.ts:116-124`).
- Per-type interaction shapes D3 (free-text conversation/puzzle), the D4 security stack, scene-state D1/D2 — those are Stage 2+.
- A real LLM classify-fallback implementation (seam only).

## Risks (from the exploration map)

| Risk | Mitigation |
|------|-----------|
| Twice-called `decide()` is baked into test fixtures (`decision-pipeline.test.ts:14-16`) | New machine has its own tests; legacy fixtures stay with the legacy machine — don't share `MockLlmGateway` single-decision fixtures. |
| Divine-intervention `'__divine__'` string sentinel overloads `distilledType` (~6 sites) | Pipeline machine uses a **typed** fallback flag, not the routing field. |
| `applyResolution` finalize is entangled with persistence | T3 extracts a **pure** finalize fn; assert `applyResolution` behaviour-preserving against existing tests. |
| Fallback/critic decorator stack composes over 1 gateway, not 3 | Decide per-stage: does `FallbackLlmGateway` wrap each stage or the orchestrator? Coherence/prose critic likely becomes a stage that only resolve's output reaches — replaces today's dual-injection (`WorldEngineImpl.ts:366-375`). Resolve in the spec; keep the critic OUT of the critical path if it complicates T2 (add in T5 or later). |
| Scripted stage that throws → divine-intervention trap | Scripted stages always return valid stage output. |
| Mixed `prompt_version` values already in prod | Per-stage stamps are additive TEXT; no migration (per [[v12-prompt-set-versioning]]). |

## Verification (stage exit)

- An action runs the full chain in the pipeline machine: classify routes → decide emits options only → dice → resolve authors mutations, engine finalizes, resolve authors `outcome_text` against **final** mutations.
- Every pipeline `llm_calls` row is stamped with its exact `v12/<stage>`.
- The sim harness runs scenarios through the pipeline machine and reports its metrics + latency tail beside the legacy machine's.
- The live v11 path and every existing test are unchanged. `npm run typecheck` clean; `npm test` green.

---

_Execution note: build task-by-task via delegated subagents (T1 → T2 → T3, checkpoint, then T4/T5), verifying + committing after each per the orchestrated-delegation loop. Open questions carried to Stage 2+: critic placement as a 4th DMA; enforced `allowedMutations`; `distilledType` full retirement; real LLM classify fallback._
