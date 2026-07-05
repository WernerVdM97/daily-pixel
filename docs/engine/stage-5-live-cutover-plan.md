---
title: "Stage 5 — Live cutover: sim-calibrate, then hard-flip v11 → v12 with a DB wipe (build plan)"
status: exploring
domain: engine
phase: poc
tags: [llm, pipeline, thread-d, cutover, stage-5, prod]
related: ["[[prompt-separation-of-concerns]]", "[[prompt-v12-pipeline]]", "[[stage-0a-sim-harness-plan]]", "[[stage-1-thread-d-backbone-plan]]", "[[stage-2-scene-state-spine-plan]]", "[[stage-3-combat-spine-plan]]", "[[v12-prompt-set-versioning]]", "[[action-engine-framework]]"]
---
_Handoff-ready build plan for the v12 graduation gate, POC-style: calibrate the sim-proven `PipelineActionStateMachine` for balance, build the production pipeline path, prove the real model against the v12 templates with a smoke run, then hard-flip from v11 to v12 in one commit accompanied by a fresh DB wipe. No feature flag, no canary, no gradual rollout: a POC with a small tester audience and no precious data buys a clean swap. Launches scale-neutral (Thread B follows). Every code anchor and open decision inlined so a lesser agent can execute it task by task._

---

## Why this shape

Stages 1 through 4 all obey one fence: prove the pipeline in the sim, never touch the live loop ([[stage-1-thread-d-backbone-plan]] §Scope fence). Production still runs a single ~5,600-token v11 call through the legacy `ActionStateMachine` (`WorldEngineImpl.ts:257,359`) and stamps `PROMPT_VERSION = 'v11'` everywhere (`prompt-builder.ts:6`, `WorldEngineImpl.ts:568-569,1747`, `DeepseekLlmGateway.ts:161-162`). This is the missing gate that takes v12 live.

The chosen strategy is deliberately un-ceremonious: this is a POC with a fresh-wipeable database, so we skip flags, canaries, and shadow traffic. Two calibration gates de-risk it instead of a gradual rollout:

- **The sim harness gates *balance*** (deterministic, scripted LLM): win/death/reward curves, round counts, floor/cap behaviour.
- **A real-model smoke run gates *LLM behaviour*** (real DeepSeek + real v12 templates on a throwaway DB): prompt quality, classify accuracy on free text, coherence, and the latency tail.

The sim alone is not enough because it never sends the real templates to the model. Both gates clear before the destructive step. The flip and the DB wipe land together: a fresh schema means no `prompt_version` migration and no characters caught mid-action across the machine swap.

## Gating prerequisites (must be true before this stage starts)

- [x] **Stage 1 backbone built** — `PipelineActionStateMachine` runs the full chain in the sim with the D5b inversion and per-stage stamping seams (`src/engine/action/PipelineActionStateMachine.ts`, `src/llm/pipeline/*`).
- [x] **Stage 3 combat sim-proven** — win/floor/cap resolve through the pipeline with per-round logging and metrics (T5 shipped, `c228790`).
- [x] **Stage 2 scene-state wired in CODE, not just migrated** — *Verified 2026-07-05: **sim-only**. `RelationRepository` is instantiated only in `PipelineSimEngine` (`:92`); prod (`WorldEngineImpl`) has no relation repo, no `getSceneRelations` read-back on its `contextResolver`, and `applyResolution` (`:500`) never persists `applied.relationsToSet/relationsToUpdate`. NOT subsumed by T6 — relations are not structurally inside `PipelineActionStateMachine` (persistence + read closure live in the sim host). Reassuring: no legacy path touches relations, so the applied-but-empty tables cannot break v11 — this is dormant groundwork, not a live hazard. Now **owned**: the terminal-outcome host wiring → **Task 0** (do first, non-destructive) — **landed** (`83b9673`, review follow-ups `273a260`); the multi-beat combat persist loop is folded into **Task 6** (it needs the live pipeline step contract).*
- [>] **Stage 4 world-scaling — NOT in scope.** Launch scale-neutral (seam at 1, [[stage-3-combat-spine-plan]] D7); Thread B is a later stage on live data.

## Settled decisions (this round)

1. **Hard flip, no flag or canary.** The pipeline machine directly replaces the legacy one in `WorldEngineImpl` construction (`WorldEngineImpl.ts:359`). The unchanged `start`/`step`/`resume` call sites drive it (the machine was built to mirror that surface). Reversibility is one thing only: the legacy machine stays **in-tree but uninvoked** between the swap (T6) and the smoke-run pass, so a catastrophe is a one-commit revert; T7 deletes it once the smoke clears.
2. **DB wipe accompanies the flip.** Fresh migrate on the new schema. No historical `prompt_version` migration (the concern evaporates), no in-flight v11 actions to reconcile. Acceptable because this is a POC with no data worth keeping.
3. **Two calibration gates, then flip.** Sim balance calibration (T1) and a real-model smoke run (Checkpoint) both clear before the destructive T7.
4. **Scale-neutral launch.** Combat behaves exactly as sim-proven; the `scale` seam stays at 1. Thread B tuning is a later stage.
5. **Per-stage stamps only.** The pipeline stamps `v12/<stage>` via `stampFor` + the `LlmCallRecorder` callKinds (already built); `actions.prompt_version` carries `v12`. The wipe moots any back-fill question.

## Open questions (resolve during the build — do not silently pick)

- [x] **Does the Fallback decorator wrap each stage or the orchestrator?** ~~Decide per-stage vs once-around-the-chain in T2.~~ **Resolved (T2): neither.** `FallbackLlmGateway` implements the single-method legacy `LlmGateway` and returns a whole-decision divine-intervention on tier-2 — it structurally cannot wrap the pipeline's four distinct stage shapes, and wrapping the chain once has no slot in the D5b split. So the prod pipeline gateway is not wrapped at all; resilience is **structural, owned by `PipelineActionStateMachine`** (a `classify` throw → typed divine-intervention in `start()`; `decide`/`resolve*` throws propagate by design). The gateway mirrors `DeepseekLlmGateway`'s single-attempt transport and throws loudly. `FallbackLlmGateway` stays on the v11 path only (deleted in T7). Documented in the `ProdPipelineGateway.ts` header. How `WorldEngineImpl` handles a propagated pipeline throw is T6's concern.
- [x] **Where does the critic sit?** ~~confirm two-critic-split vs single-relocated before building.~~ **Resolved (T4): single interface, two sites.** A single `CriticGateway.critique` (the critic-v1 prompt, branching on `beat`) is invoked at two in-machine sites in `PipelineActionStateMachine` — a gated coherence critic over DECIDE (gate on `required`; major → one bounded re-decide, not re-critiqued) and a faithfulness prose critic over RESOLVE-NARRATE (patches `outcome_text` only). NOT two prompts/interfaces: the D5b split already structurally prevents the prose critic from touching mutations (the machine applies only `patch.outcomeText`; the finalized mutation array is never handed to the critic), so a separate prose-only interface buys nothing. The critic is an optional ctor param (absent → strict no-op). **Prod pass-through of `config.critic` to the pipeline machine is T6** (WorldEngineImpl still builds the legacy machine until the swap). Documented in `PipelineActionStateMachine.ts` (`critiqueDecide` header).

## Cutover contract (the post-flip live path)

```
WorldEngineImpl.startAction / stepAction / resume
   │
   ▼  (v11 legacy machine deleted in T7)
PipelineActionStateMachine
   │  prod PipelineLlmGateway (DeepSeek-backed) + loadPromptSet('v12')
   [CLASSIFY] heuristic → hit | miss → LLM classify fallback (T3)
   [DECIDE]   options only  ── coherence critic gate (T4)
   [DICE]     resolveRoll (unchanged)
   [RESOLVE-MUTATE] → proposed mutations
   [FINALIZE] finalizeMutations() (pure, already extracted — WorldEngineImpl.ts:664)
   [RESOLVE-NARRATE] outcome_text vs FINAL mutations ── prose critic patch (T4)
   │
   ▼ persist: actions row (prompt_version='v12') + per-stage llm_calls stamps
```

`finalizeMutations` already exists as a pure function shared by both paths (`WorldEngineImpl.ts:664` → `geography-finalize.ts`), so the D5b inversion needs no new extraction; the prod gateway just routes resolve-narrate against the finalized set.

## Task breakdown

### Task 0 — Prod scene-state host wiring (the gating prerequisite)
**Description.** Close the sim-only gap so the scene-state spine is live the moment T6 installs `PipelineActionStateMachine`, not dead. Give `WorldEngineImpl` the host `PipelineSimEngine` already has (`:92,:99-108,:263-314`), all behind the still-legacy machine so it is inert until T6: (a) instantiate one `RelationRepository` in the constructor (mirror `locationRepo`/`edgeRepo`, `:285-286`); (b) widen the local `contextResolver` (`:310`) to a `PipelineContextResolver` and add `getSceneRelations(node) => relationRepo.forNode(node.type, node.ref)` and `getCurrentDay() => this.currentDayNumber()` — optional hooks the pipeline context builder (`pipeline-context.ts:75`) consumes and the legacy machine ignores; (c) in `applyResolution`, after `applyMutations` (`:500`), persist `applied.relationsToSet/relationsToUpdate` inside the existing `db.transaction`. De-duplicate rather than triplicate: extract the sim's inline persist-resolve loop (`PipelineSimEngine.persistRelations`, `:323-345`) into a shared `persistAuthoredRelations(...)` in `relation-wiring.ts` (which already owns `resolveAuthoredRelation`, imported by both hosts) and call it from BOTH — behaviour-preserving for the sim. To feed the helper's `nearbyNpcs`, extract the resolver's `getNearbyNpcs` body (`:311-317`) into a private `nearbyNpcsAt(location)` used by both the resolver and the persist call.
**Acceptance:**
- [x] `WorldEngineImpl` constructs exactly one `RelationRepository`; its `contextResolver` is a `PipelineContextResolver` exposing `getSceneRelations` + `getCurrentDay` backed by that repo / `currentDayNumber()`.
- [x] `applyResolution` persists authored relations via the shared helper, inside the existing `db.transaction`; an unresolvable endpoint drops-with-warn (never throws), mirroring the sim (`:329-343`).
- [x] `persistAuthoredRelations` is unit-tested against an in-memory `RelationRepository`: `set`, `updateProps`, and the unresolved-endpoint drop. The sim calls the same helper with identical behaviour (sim suite green).
- [x] Zero behaviour change on the live v11 path — the legacy machine emits no relation mutations, so persistence is a no-op and no existing engine test changes.
**Verification:** `npm run typecheck` clean; `npm test` green (engine + sim); the helper test proves round-trip persistence + the drop-with-warn path.
**Files:** `src/engine/WorldEngineImpl.ts`, `src/engine/action/relation-wiring.ts` (new export), `src/sim/PipelineSimEngine.ts` (call the shared helper), `tests/**` (helper unit test). **Scope:** M. **Deps:** prerequisites (verified). **Must land before T6.** **Landed** (`83b9673`; review follow-ups incl. the pre-move location fix `273a260`).

### Task 1 — Sim calibration (the balance gate)
**Description.** Run the existing combat scenarios through the sim and tune to acceptable curves, scale-neutral. Adjust the band table / enemy-HP derive in `combat-dc.ts` (and add scenarios if a case is unproven) until win/death/reward rates and round counts read sensibly. Capture the chosen constants + the curves in a short calibration record so the flip is defensible. No prod code changes here.
**Acceptance:**
- [x] Win/death/reward + rounds-per-fight curves recorded for the tuned constants across the win / floor / cap scenarios.
- [x] Any band/`enemyMaxHp` change lands via `combat-dc.ts` with the sim rerun green.
**Verification:** `npm run sim` produces the curves; combat sim tests green.
**Files:** `src/engine/action/combat-dc.ts`, sim scenarios, a calibration note (docs or committed sim output). **Scope:** M. **Deps:** prerequisites. Can run alongside T2–T4. **Landed** — reproducible seeded harness `src/sim/calibrate-combat.ts` (`npm run calibrate`, 9-config physical×baseDc grid, N=300 seeded fights each) + calibration record [[T1-combat-calibration]]. **Verdict: accepted as the scale-neutral launch baseline, no constant changes** (curves monotonic + directionally correct; baseline warrior vs standard foe ~90.7% win / ~4 rounds; underdog death rates are knockouts-not-permadeath + floor-save-mitigated + location-gated, recorded as post-launch watch-items). `combat-dc.ts` untouched.

### Task 1b — Pipeline scenario coverage for social / skill / other
**Description.** Close the sim coverage gap before anything goes live: `combat` and `rest` are well-exercised through `PipelineActionStateMachine`/`PipelineSimEngine`, `travel`/`search` only lightly, but **`social`, `skill`, and `other` have zero pipeline-level scenarios** — their decide/resolve templates and machine routing have never been driven end-to-end, even against the scripted gateway. Add one scripted-gateway scenario per missing type (mirror the combat scenarios' shape) asserting the full chain completes: classify routes the type, decide emits options only, resolve produces mutations + `outcome_text`, and the per-stage stamp seams carry the right stage names.
**Acceptance:**
- [x] `social`, `skill`, and `other` each have at least one sim scenario driving the full chain through the pipeline machine.
- [x] `travel` and `search` each have at least one full-chain assertion (upgrade the light touches).
**Verification:** sim suite green with the new scenarios; `npm run typecheck` clean.
**Files:** `src/sim/scenarios/*`, `tests/sim/*`. **Scope:** M. **Deps:** prerequisites only (the scripted gateway suffices — no T2). Can run alongside T1–T4. **Landed** — 5 full-chain per-ActionType scenarios added to `tests/sim/pipeline-sim.test.ts` (social/skill/search/travel + the `other` miss→scripted-classify path); each asserts `actionType` propagation through decide/resolveMutate/resolveNarrate and the per-stage `stageCalls` names. Suite 1159 green.

### Task 2 — Production `PipelineLlmGateway` (DeepSeek-backed)
**Description.** Implement the four stage methods of `PipelineLlmGateway` (`src/llm/pipeline/types.ts:113`) against the real model: `classify` (LLM-fallback shape), `decide` (options only), `resolveMutate`, `resolveNarrate`. Load per-stage templates via `loadPromptSet('v12')` (`prompt-builder.ts:90`) and stamp each call via `stampFor` (`prompt-builder.ts:144`) using the pipeline callKinds on `LlmCallRecorder` (`LlmCallRecorder.ts:14-15`). Reuse `DeepseekLlmGateway`'s transport/retry, do not fork it. Excludes classify-fallback heuristic (T3) and the critic stack (T4).
**Acceptance:**
- [x] Each stage issues one real model call with the correct v12 template and stamps `v12/<stage>`.
- [x] `decide` asserted free of mutations/`outcome_text`; `resolveMutate` returns proposed mutations only; `resolveNarrate` receives the finalized set.
- [x] Resolves the Fallback-wraps-stage-vs-orchestrator question (documented in the gateway header).
**Verification:** unit tests with a mocked transport assert per-stage prompts + stamps; suite + typecheck green.
**Files:** `src/llm/ProdPipelineGateway.ts` (new), `src/llm/DeepseekLlmGateway.ts` (shared transport), tests. **Scope:** L. **Deps:** prerequisites. **Landed** — `ProdPipelineLlmGateway` (`src/llm/pipeline/ProdPipelineGateway.ts`) implements all four stages against a shared `callDeepseek` transport (`src/llm/deepseek-transport.ts`, extracted from `DeepseekLlmGateway`'s 4 inline call sites, byte-identical v11 behaviour) + `pipeline-messages.ts`/`pipeline-parse.ts`. Per-stage stamps/callKinds via the existing `stampForPipelineStage`; decide reuses `buildUserMessage`, resolve uses a shared `buildSceneBody` (extracted, output unchanged). Q1 resolved (above). Suite 1188 green. Adversarial review clean (one dual-key `dcModifier` fix applied).

### Task 3 — Real LLM classify-fallback + classify prompt authoring
**Description.** Turn the seam at `classifier.ts:141` into a real call: on a heuristic miss, the machine calls `gateway.classify` (built in T2) and pins the returned `ActionType` + flags. Keep the total-failure path (miss AND LLM failure) routing to the typed divine-intervention fallback (`PipelineActionStateMachine.ts:801`), never a wrong guess. **This task also owns replacing the classify stub with a real prompt:** `assets/prompts/decision-prompts/v12/classify.md` is still the documented 3-line Stage-0b stub ([[v12-prompt-set-versioning]]), and the loader test only asserts non-emptiness — no other task authors it and nothing currently stops the stub reaching the smoke run. Author it via the `prompt-versioning` skill: tiny-output contract (the seven-value `ActionType` + routing flags, no narrative, no options), inheriting the SECURITY RULE and v9 markdown framing.
**Acceptance:**
- [x] A heuristic-miss input resolves to a real classified `ActionType`; a forced classify failure falls to the typed fallback.
- [x] The heuristic hit path is unchanged (zero added latency on the common case).
- [x] `classify.md` is a real prompt (ActionType + routing-flags contract), not the stub; a content test asserts more than non-emptiness (e.g. it names all seven `ActionType` values and carries the SECURITY RULE).
**Verification:** tests for miss→call→hit and miss→failure→fallback; the classify content test green; suite green.
**Files:** `src/engine/action/PipelineActionStateMachine.ts`, `src/llm/pipeline/classifier.ts`, `assets/prompts/decision-prompts/v12/classify.md`, tests. **Scope:** M. **Deps:** T2. **Skill:** `prompt-versioning`. **Landed** — the prod classify seam was already live from T2 (`start()` calls the injected `gateway.classify` on a heuristic miss → typed divine-intervention on throw); T3 authored the real `classify.md` (standalone tiny-output router: seven-value `actionType` + nested `flags`, honour-intent + negation/idiom disambiguation, SECURITY RULE, no BASE prepend — matches `ProdPipelineLlmGateway.classify`'s parser), a content test (`prompt-set-loader.test.ts`: names all seven types + flags + SECURITY RULE, not the stub), and closed the miss→classify-**success**→pinned-type coverage gap (`pipeline-machine.test.ts`). `notImplementedClassifyFallback` kept as a valid no-real-gateway default guard. Suite 1190 green. **Routing accuracy on real free-text is gated by the Checkpoint smoke run** (not statically testable).

### Task 4 — Critic re-placement (D7)
**Description.** Move the critic off the single decide call into the pipeline as stage(s): a gated coherence critic over decide, and a faithfulness prose critic over resolve-narrate that patches prose only (never re-authors mutations — the engine owns the numbers). The legacy dual-injection (`WorldEngineImpl.ts:~363`) is removed with the legacy machine in T7.
**Acceptance:**
- [x] The prose critic can only alter `outcome_text`; a test proves it cannot change a finalized mutation.
- [x] A coherence-gate rejection triggers a bounded re-decide, not an unbounded loop.
- [x] Resolves the two-critic-split-vs-single question (documented).
**Verification:** tests for patch-prose-only and the re-decide bound; suite green.
**Files:** `src/engine/action/PipelineActionStateMachine.ts`, critic gateway wiring, tests. **Scope:** L. **Deps:** T2. **Landed** — critic moved into `PipelineActionStateMachine` as an optional 5th ctor param (`critic?: CriticGateway`, absent → strict no-op, so the sim + all existing tests are byte-identical). Two private helpers: `critiqueDecide` (coherence gate over start()+step()-continue decide, `required`-gated, major → one bounded re-decide not re-critiqued) and `critiqueNarration` (over resolve()+resolveCombat() narrate, returns only a string — mutations structurally untouchable). Combat-continue decide left ungated (engine-owned truth). Q2 resolved (above). 6 new tests incl. the byte-identical-mutations-across-a-minor-patch proof. Suite 1196 green. **Prod pass-through of `config.critic` → pipeline machine is T6.**

### Task 5 — Carry-forward audit + template hardening
**Description.** Walk the six v8–v11 rules ([[prompt-separation-of-concerns]] §Carry-forward: refunds, KNOWN LOCATIONS reuse, no-dead-turns, the SECURITY RULE, markdown framing, per-option ability checks) against the v12 templates as `loadPromptSet` assembles them for the live context, not the sim stubs. Fix gaps through the `prompt-versioning` skill (this is the one task that edits `assets/prompts/decision-prompts/v12/**`). Easiest place to silently regress a hard-won rule.
**Acceptance:**
- [x] A checklist test (or documented audit) shows each of the six rules present in its owning v12 template.
- [x] Template edits follow the prompt-versioning procedure (still `v12`, no `*_VERSION` bump).
**Verification:** the carry-forward test green; a sample live-shaped prompt inspected per rule.
**Files:** `assets/prompts/decision-prompts/v12/**`, `tests/llm/*`. **Scope:** M. **Deps:** T2. **Skill:** `prompt-versioning`. **Landed** — audit ran the six rules against the **assembled** `loadPromptSet('v12')` strings (all seven categories, both phases/verdicts), not the raw stubs, so BASE-prepend inheritance is exercised. Result: **five of six already present in their owning template, zero gaps → no template edit needed** (the rewrite dropped nothing). Owners: KNOWN-LOCATIONS-reuse (`move_to` vs `cross_frontier`) → `resolve/BASE.md`; no-dead-turns + per-option ability-check → `decide/BASE.md`; SECURITY RULE + markdown framing → `decide/BASE.md` + `resolve/BASE.md` + `classify.md`. The sixth — **refunds (no-op/timeout free roll) is ENGINE-owned, never a prompt rule** (DB `last_noop_refund_day`/`last_timeout_refund_day`, verified absent from every v11/v12 prompt); it survives the prompt rewrite trivially, but **T6 must preserve the refund calls when it swaps to the pipeline path**. Deliverable is the locking checklist test (`tests/llm/prompt-set-loader.test.ts`, 6 `it`s — five assert the owning assembled template, one locks the engine refund columns), anchored on rule-specific language so a silent drop breaks CI. No `*_SET_VERSION` bump (v12 is pre-publication — prod still runs v11). Suite 1202 green. Adversarial review clean (one accepted finding applied: rule-6 anchor strengthened off the bare `` `stat` `` field name onto the per-option enforcement bullet).

### Task 6 — Hard swap (legacy kept in-tree, uninvoked)
**Description.** Make `WorldEngineImpl` construct `PipelineActionStateMachine` with the T2 gateway (`WorldEngineImpl.ts:359`); the unchanged call sites drive it. Route per-stage stamps to the real `llm_calls`/`actions` writes (`actions.prompt_version='v12'`). Leave the legacy `ActionStateMachine` and `PROMPT_VERSION` present but no longer invoked — this is the single revert lever until the smoke run clears. **Also wire the multi-beat half of the scene-state spine deferred from Task 0:** prod has no non-terminal mutation apply path today (the legacy machine never returns non-terminal `mutations`), but the pipeline machine's combat rounds do — so `stepAction`'s non-terminal branch (`:997+`) must apply `result.mutations` and persist relations across beats (mirror `PipelineSimEngine.stepAction`, `:195-221`), reusing the Task 0 `persistAuthoredRelations` helper. **This task also owns the two prod-wiring caveats flagged in [[T3-followup-combat-bail-spec]]** (explicitly left for "whoever promotes the pipeline off the sim"): round N's edge must persist before round N+1 starts (ordering — falls out of the per-beat persist above, but must be asserted), and `step()` must be serialised per action so concurrent Discord interactions cannot interleave one action's combat state.
**Acceptance:**
- [ ] A live-shaped action runs the full chain and persists `prompt_version='v12'` + per-stage stamps.
- [ ] The legacy machine still compiles and its tests still pass (it is dead-but-present, not deleted).
- [ ] Non-terminal combat beats apply their mutations and persist relations across beats (the multi-beat half of the scene-state spine, deferred from Task 0), with round N persisted before round N+1 begins.
- [ ] `step()` is serialised per action — a test proves two concurrent steps on one action cannot interleave its combat state (the [[T3-followup-combat-bail-spec]] caveat).
**Verification:** an engine test runs one action through the pipeline against a seed; suite + typecheck green.
**Files:** `src/engine/WorldEngineImpl.ts`, tests. **Scope:** M. **Deps:** T2, T3, T4, T5.

### Checkpoint — real-model smoke run (the LLM gate)
Run a scripted character through the **real DeepSeek + v12 templates** on a throwaway/staging DB (fresh migrate, discard after). Not the sim's scripted gateway — the real model.
- [ ] The script exercises **all seven `ActionType`s** (incl. `social`/`skill`/`other`, which only meet the real templates here — T1b covers them scripted, this is their first real-model contact), not just combat/travel.
- [ ] Classify routes real free-text inputs correctly; no wrong-guess mis-routes.
- [ ] Decide emits options only; resolve authors coherent prose against the final mutations; no schema/parse failures.
- [ ] Latency tail per action is acceptable vs the v11 single call.
- [ ] Human go/no-go before the destructive T7. Any prompt/latency fix loops back to T5/T2.

### Task 7 — Delete v11, wipe, release
**Description.** Once the smoke clears: delete the legacy `ActionStateMachine` (`machine.ts`) and its critic dual-injection; remove `PROMPT_VERSION` (`prompt-builder.ts:6`) and its three stamp sites (`WorldEngineImpl.ts:568-569,1747`, `DeepseekLlmGateway.ts:161-162`), the `decision-<PROMPT_VERSION>.md` load path + the `current_source.md` byte-identical test (`tests/llm/prompt-builder.test.ts:211-218`). Keep `decision-v11.md` on disk for history, off the load path. Wipe + fresh-migrate the DB. Update `CHANGELOG.md` `[Unreleased]` and cut `0.3.0` per the `releasing` skill.
**Acceptance:**
- [ ] `PROMPT_VERSION` and the legacy machine are gone; grep is clean outside history; full suite green without them.
- [ ] DB wiped and re-migrated on the new schema; a live action confirmed end-to-end on `v12`.
- [ ] Changelog updated; `0.3.0` release notes name the cutover + the wipe.
**Verification:** full suite green with no legacy path; typecheck clean; one live action on `v12`.
**Files:** `src/engine/action/machine.ts` (delete), `src/engine/WorldEngineImpl.ts`, `src/llm/prompt-builder.ts`, `src/llm/DeepseekLlmGateway.ts`, tests, `CHANGELOG.md`, `VERSION`, migrations. **Scope:** L. **Deps:** Checkpoint pass + T1.

## Scope fence

**In scope:** sim balance calibration, pipeline scenario coverage for the untested types (T1b), the prod pipeline gateway, real classify-fallback incl. authoring the real classify prompt, critic re-placement, the carry-forward audit, a real-model smoke run, the hard swap + v11 deletion + DB wipe + `0.3.0`. **Explicitly OUT of scope (do NOT do):**
- Feature flag, canary, shadow, or any gradual/percentage rollout — the flip is a single commit.
- Thread B world-scaling — launch scale-neutral (seam at 1); Thread B is a later stage.
- D3/D4 (free-text conversation/puzzle shapes, security stack beyond the existing SECURITY RULE).
- Rebalancing beyond T1's scale-neutral calibration — further tuning is post-launch on live data.
- Any historical `llm_calls`/`actions` migration — the wipe moots it.

## Risks

| Risk | Mitigation |
|------|-----------|
| Scene-state (Stage 2) not wired in code → pipeline writes edges nothing reads (wipe doesn't fix code) | Verified sim-only (2026-07-05); now owned by **Task 0** (terminal host wiring, do first) + **Task 6** (multi-beat loop). Both land before the smoke run. |
| Real templates never hit the model until prod | The smoke-run Checkpoint on real DeepSeek is the explicit LLM gate before deletion. |
| Compounding latency (D multiplies calls per beat) | Smoke run measures the tail; heuristic classify keeps the common case single-hop; round cap bounds combat. |
| Fallback/critic stack composes over one gateway, not four | Resolved in T2/T4 with the decision documented. |
| A carry-forward rule silently dropped in v12 templates | T5 is a dedicated audit gate; edits go through `prompt-versioning`. |
| `classify.md` ships as the Stage-0b stub (the loader test only asserts non-emptiness) | T3 explicitly owns authoring it; a content test + the smoke run's all-seven-types script gate it. |
| `social`/`skill`/`other` reach prod having never run the pipeline end-to-end | T1b adds scripted full-chain scenarios; the smoke run gives them real-model contact. |
| Hard flip has no gradual safety net | Legacy stays in-tree and uninvoked until the smoke clears (one-commit revert); wipe means no half-migrated state. |
| Prose critic re-authoring engine numbers | T4 acceptance proves patch-prose-only. |

## Verification (stage exit)

- Every live action runs the full v12 chain: classify routes → decide options only → dice → resolve-mutate → engine finalize → resolve-narrate against the final mutations, each row stamped `v12/<stage>` and `actions.prompt_version='v12'`.
- `PROMPT_VERSION` and the legacy `ActionStateMachine` are gone; the suite is green without them.
- The six carry-forward rules are verified present; the sim calibration curves are recorded; the real-model smoke run passed.
- DB wiped and re-migrated; `0.3.0` cut with release notes naming the cutover. `npm run typecheck` clean; `npm test` green.

---

_Execution note: build task-by-task via delegated subagents (T0 prereq first — landed; then T1/T1b calibration + coverage alongside T2 → T3/T4 → T5 → T6, then the smoke-run Checkpoint, then T7), verifying + committing after each per the orchestrated-delegation loop. This is the graduation gate for [[prompt-separation-of-concerns]]; Thread B (Stage 4 world-scaling) and D3/D4 follow it on the now-live pipeline._
