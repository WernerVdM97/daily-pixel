---
title: "Pipeline stages and their wire contracts"
status: decided
domain: engine
phase: poc
tags:
  - engine
  - pipeline
  - llm
  - prompts
  - observability
related:
  - "[[action-engine-framework]]"
  - "[[resolve-difficulty-signal]]"
  - "[[agent-player-personas]]"
  - "[[combat-system-v12]]"
  - "[[threat-encounter-system]]"
  - "[[layer-boundaries-and-json-seam]]"
---
_The wire detail of `src/llm/pipeline/`: what each of the four stages is handed, what it may author, how its reply is parsed, how a stage fault is told apart from an engine fault, and where its row lands in `llm_calls`. Read this before changing a stage._

---

# Pipeline stages and their contracts

`[[action-engine-framework]]` draws the spine and the zone split; `[[resolve-difficulty-signal]]` covers the one field RESOLVE gained; `[[agent-player-personas]]` covers reading a run's audit. This doc is the layer they all assume: the contract each stage honours, in `src/llm/pipeline/`.

## 1. The stage graph

`PipelineActionStateMachine` (`src/engine/action/`) is the only caller. Four of the boxes below are LLM stages; two are not.

```
raw input
  │
  ▼ CLASSIFY        heuristicClassify (classifier.ts, pure regex, no call)
  │                   └─ miss → gateway.classify (LLM fallback; must come back a hit)
  ▼ DECIDE          per beat; template = decide[actionType] × phase (NEW_ACTION | CONTINUE)
  │                   ↳ critic (optional, gated) and the single-option validator may each re-decide once
  ▼ DICE            engine only: rollD20 + resolveRoll when flags.needs_roll, else verdict 'success' with d20 0
  ▼ RESOLVE-MUTATE  proposed mutations only
  ▼ FINALIZE        engine only: the machine's travel-coherence gate, then the injected geography → collapse → validate
  ▼ RESOLVE-NARRATE outcome_text, written against the FINAL mutations
  ▼ persist
```

The four names in `PipelineStage` (`stamping.ts`) are the LLM stages: `classify · decide · resolve-mutate · resolve-narrate`. DICE and FINALIZE are engine code with no gateway method and no `llm_calls` row of their own, so nothing in this doc constrains them. The DICE box draws the generic path only: a `required` combat action short-circuits it into `handleCombatStep`, two d20 draws a round with an HP-derived verdict, so read `[[combat-system-v12]]` for what combat actually does.

CLASSIFY is heuristic-first by design: a wide pattern table routes most input at zero cost (`heuristicClassify`), and the LLM is the fallback for a miss, never the first move. The table misses rather than guesses on anything ambiguous, negated or idiomatic, and the fallback is the last stage that can route at all (it has no fallback beneath it).

### What crosses each boundary

| Boundary | Carries | Does not carry |
| --- | --- | --- |
| into DECIDE | `actionType`, `flags`, the full `LlmContext` | any verdict, d20, or mutation |
| into DICE / verdict | the chosen option's `stat` and `dcModifier` (engine accumulates the DC) | anything the model authored about the outcome |
| into RESOLVE-MUTATE | `actionType`, the decide result, the chosen option, verdict, d20, `finalDc` or `foeDanger`, `LlmContext` | the options the player did not pick |
| into FINALIZE | proposed `mutations` | — |
| into RESOLVE-NARRATE | all of the above plus the **final** mutations | the proposed ones, and any permission to add to them |

The honest answer to "what does DECIDE get that RESOLVE does not": DECIDE gets the beat's shape. It sees `PHASE:` (`NEW_ACTION` on the first beat, `CONTINUE` after), the decision counter that paces toward `MAX_DECISIONS_PER_ACTION`, `### So far this beat` (each decision and the choice taken, oldest first), the just-resolved round on a combat CONTINUE, and its own `## Reviewer note` on a re-decide. RESOLVE gets the outcome's facts instead: `TASK:`, `VERDICT:`, `D20:`, its difficulty token, and the single chosen option.

What RESOLVE never gets: the beat chronology, `PHASE:`, DECIDE's `narration`, or DECIDE's session. It is a fresh session over a re-read `LlmContext` plus a typed handoff, so the framing line the player saw is **reconstructed** from `distilledType` (`reconstructDecisionPrompt`, kept in lockstep with `toActionDecision`'s CTA wording) or supplied verbatim as `decisionPrompt` when the beat was hand-authored (a fatal-blow interstitial has prose no reconstruction can produce).

## 2. The message contract

System prompts come from the prompt set at `assets/prompts/decision-prompts/<PROMPT_SET_VERSION>/`. Read them there; this doc names the slot, not the prose. `loadPromptSet` (`src/llm/prompt-builder.ts`) composes decide as `BASE.md` + `phases/<PHASE>.md` + `<category>.md`, and resolve as `resolve/BASE.md` + `<category>/<verdict>.md`.

| Stage | System prompt | User message | Sent, in order |
| --- | --- | --- | --- |
| classify | `classify.md` | `buildClassifyUserMessage` | the raw input as a whitespace-collapsed blockquote, then `Location: <name>` when the context has one |
| decide | `decide[actionType]` (phase-variant) | `buildUserMessage` (unchanged from v9) | `PHASE:`, the decision counter on CONTINUE, the scene body, `### So far this beat`, the combat round on a CONTINUE, `## Reviewer note` on a re-decide |
| resolve-mutate | `resolve[actionType][verdict]` | `buildResolveUserMessage(input, 'RESOLVE-MUTATE')` | `TASK:`, `VERDICT:`, `D20:`, `### Action type`, `### What was decided`, the scene body |
| resolve-narrate | same template as resolve-mutate | `buildResolveUserMessage(input, 'RESOLVE-NARRATE')` | all of the above, then `### Final mutations` as a fenced JSON block |

`buildUserMessage`, the DECIDE builder, can also emit a third phase, `RESOLVE_ROLL`, with a `ROLL RESULT:` block claiming the outcome. The pipeline never reaches it: on this path a verdict belongs to DICE and RESOLVE, and the block survives for the legacy single-call gateway. Do not assume a prompt that keys off `RESOLVE_ROLL` is reachable from a stage.

The scene body is one shared builder (`buildSceneBody`): `## You` and the ability-checks table, `### Inventory`, `## Scene` with the safety tag, `### Present` with ephemeral `[N#]` NPC handles, the Warden GM note when present, `### Story so far`, `### Exits from here`, and `## What you're attempting` (the player's input, blockquoted and fenced as in-world speech). Sharing it is what keeps the decide and resolve prose layouts from drifting apart.

`### What was decided` is the only place the resolve stages learn what happened: the framing line, the chosen label, its stat (option-level, falling back to the action's), `favoured` when set, the path's difficulty token (`final dc` on a DC-checked attempt, `foe danger` on a fight), and `fatal blow` when the resolution was one.

What a stage is forbidden to do, and why the boundary is drawn there:

- **No SQL, no schema.** A stage emits typed ops; geography, collapsing and validation are FINALIZE's, and persistence is the engine's. The LLM proposes, the engine disposes.
- **No cross-stage state.** Every call is a fresh session. The handoff is a typed payload, never prose a later stage re-parses and never the previous call's reasoning.
- **No mutation it did not declare.** DECIDE authors options (plus optional `sceneLocation`, `combatEnemy`, `narration`), RESOLVE-MUTATE authors proposed mutations, RESOLVE-NARRATE authors `outcome_text`. `PipelineDecideResult` has no `mutations`/`outcomeText` field at all, so the split is enforced by the type, not by the prompt.
- **No verdict.** DICE owns it; RESOLVE is told it and must not re-judge.

## 3. Parsing and validation

`parse_ok` in the row means "the body was JSON", not "the stage's parser accepted it": it is set between `JSON.parse` and the stage parser, so a well-formed body the parser rejects records `parse_ok = 1` **with** `error` set. Read the two columns together, never `parse_ok` alone.

`validation_warnings` is always `[]` from this gateway. The pipeline has no warnings channel: a field a stage parser cannot use is dropped silently (or the whole parse fails), there is nothing to report. Warnings-bearing rows come from the agent gateways, not from here.

What each parser requires, and what it does when a field is missing:

| Stage | Required | Defaults when absent |
| --- | --- | --- |
| classify | `actionType` (or `action_type`) must be a member of `ACTION_CATEGORIES` — otherwise the parse throws and the call fails as `validation` | each flag coerced with `Boolean`, so a missing flag is `false` |
| decide | nothing | `distilledType` → `''`; `stat` → `physical`; `baseDc` → 10; `required` → `false`; `decision` → `[]`; per option `label` → `''`, `dcModifier` → 0 (an explicit `null` survives as `null`), `stat` omitted so the action's applies; `sceneLocation`/`combatEnemy`/`narration` copied only when present and valid |
| resolve-mutate | nothing | `mutations` → `[]`; `[N#]` handles resolved to `npcId`, an unknown handle becoming `0` plus a warn line |
| resolve-narrate | nothing | `outcome_text`/`outcomeText` → `''`, and nothing rejects an empty narration |

Only an absent field defaults. A present but non-numeric `baseDc` or `dcModifier` goes through `Number(...)` and gives `NaN`, which is then carried through the DC accumulation into the resolve message (`final dc: NaN`) and into `resolveRoll`. Read the column as absence only.

So the never-guess rule is the **router's**, not the wire's. Only classify fails hard, and only on its routing key: a wrong `ActionType` misroutes the whole action, while a missing `stat` is a default the engine already understands. `decision: []` is a legitimate signal, not a parse failure: the machine reads it as "resolve this outright now" (later beats treat an all-`null` option set the same way), and at NEW_ACTION a combat action synthesises a first option instead of auto-resolving. If you want another field to be mandatory, this table is the thing to change: add the check to that stage's parse in `ProdPipelineGateway.ts`, and the field joins `actionType` as a `validation` failure.

## 4. Errors and the fail-open surface

`PipelineStageError` carries two extra facts: the stage label and a failure kind.

| Kind | Raised when |
| --- | --- |
| `transport` | non-2xx from OpenRouter, or the request never completed (DNS, socket) |
| `timeout` | the request was aborted, almost always `chat-transport`'s own timeout |
| `empty` | 2xx with no usable body (null, empty, whitespace-only); the message carries `finishReason`, the one signal that separates a truncated completion from a genuinely empty one |
| `parse` | content came back but was not JSON |
| `validation` | valid JSON the stage's own parser rejected |

Two call sites catch them and resolve the turn, both failing **open**:

- **`PipelineActionStateMachine.start()`, beat 1.** A classify rejection resolves to the typed divine-intervention outcome (the roll was never spent). DECIDE and the first-beat auto-resolve gate on `isLlmStageFailure` and rethrow anything else. The classify catch is a bare `catch` and predates the predicate, so a non-LLM fault on that one call also resolves as divine intervention; the two later catches are gated.
- **`WorldEngineImpl.stepActionPipeline`, beat 2+.** A failure past the first beat cannot re-serve the decision (the roll is spent), so a gated `isLlmStageFailure` resolves as `timed_out` with the stamina cost and roll refund of a timeout. Anything else rethrows.

Two further catches are the fail-open surface's loose edge. The bounded re-decides in `PipelineActionStateMachine.critiqueDecide` and `validateSingleOption` are bare `catch`es: each prints one `console.warn` and keeps the previous decision. The turn carries on with the original single option, or the critic-rejected one, and never reaches `stepActionPipeline`'s `isLlmStageFailure` branch, so there is no `timed_out`, no roll refund and no stamina cost. A stage fault on those two paths leaves no trace but the warn.

The type exists because a bare `catch` at either resolving site would dress a DB error, a bad mutation or a plain programming mistake in the in-voice "the world stutters" card, hiding it from every log and every QA run. Discriminating on the error's type keeps the fail-open surface exactly as wide as the LLM boundary. `isLlmStageFailure` also accepts an `AbortError` (by name or abort wording in the message) as belt-and-braces for a non-pipeline LLM path that forgets to wrap.

Mind the two vocabularies when chasing one failure: the error's `stage` is the gateway method (`resolveMutate`, `resolveNarrate`), while `call_kind` and `PipelineStage` are kebab (`resolve-mutate`, `resolve-narrate`). Logs grep one, rows the other.

One divine intervention is not a stage error and is worth knowing about when reading a run: `applyTravelCoherenceGate` (`src/engine/action/travel-gate.ts`) reports a `scene_location` that names no location the graph knows and that no same-beat `cross_frontier` mints, and the machine resolves the beat through the same refunded outcome rather than injecting travel to it. The model authored a name nothing can place, so the beat's mutations are dropped whole rather than landing against a scene the engine refused. The guard checks the declared name, not the destination finalize settles on: crossing an exit that was already bound arrives at the earlier-bound place, and the authored name is ignored there.

## 5. Stamping and observability

`stampForPipelineStage` derives every stamp through the prompt set's own `stampFor`, so a row and the template it came from cannot drift apart. `callKindForPipelineStage` derives the label the audit groups by. `<version>` below is `PROMPT_SET_VERSION`, the same constant `loadPromptSet` reads.

| Stage | `prompt_version` | `call_kind` |
| --- | --- | --- |
| classify | `<version>/classify` | `pipeline-classify` |
| decide | `<version>/decide/<actionType>` | `pipeline-decide` |
| resolve-mutate | `<version>/resolve/<actionType>/<verdict>` | `pipeline-resolve-mutate` |
| resolve-narrate | the same resolve stamp | `pipeline-resolve-narrate` |

Two observations fall out of that table. The two resolve stages share **one** template: the D5b split is at stage level (two calls with FINALIZE between them), not at prompt level, and giving them different prose would be a `PromptSet` shape change rather than something to route around here. And `decide` and the resolve stages have no default template, so the stamp functions throw rather than guess a category when called without an `actionType` and, for the resolve stages, without a `verdict` (that throw names both).

One row per attempt, written in a `finally`, so a failed stage still leaves its row (`error` set, `parse_ok` as § 3 describes). `tier` is always 0: this gateway has no internal retry and is not wrapped by `FallbackLlmGateway`, whose single-method shape structurally cannot wrap four stages. Resilience lives in the machine's fail-open surface instead. A beat can carry more than one `pipeline-decide` row, because a critic-driven or validator-driven re-decide goes through the same `decide` method; critic rows are `call_kind: critic`, not pipeline stages.

The queries that read those rows, per-stage parse failures and warnings, `tier=1` rate, critic severity by beat, live in `[[agent-player-personas]]` § Mining the LLM audit, over a run's `<AGENT_OUT>.llm-calls.json`. Those four kebab labels are the `call_kind` values they group by.

## 6. The scripted gateway

`PipelineScriptedGateway` + `PipelineSimEngine` (`src/sim/`) is the deterministic stand-in: same `PipelineLlmGateway` interface, same `PipelineActionStateMachine`, scripted answers instead of a model. It is what makes `npm run sim`, the scenario replay and the dual-engine comparison comparable run to run.

What it reproduces: the whole machine, the stage sequence, the handoff shapes, the single-option validator's bounded re-decide, FINALIZE (a geography-aware one, over the seeded world) and persistence into an in-memory DB, and the engine's own dice. Rolls come from a `RollSource` (`fixed`, `sequence`, `seeded` via mulberry32), never `Math.random`, so a scenario replays byte for byte. It constructs the machine with no critic, so the critique passes are no-ops here: a critic-driven re-decide is a live-run and test-only path.

What it cannot: anything about the model. A script returns already-typed objects, so no JSON body, no parse layer and no validation path is exercised, and the message builders never run, so a prompt that is wrong about the message the engine sends cannot fail here. Latency and token cost are absent (scripted calls are near-instant, so `stageCalls` latency is plumbing, not a reading). A `callId` is always 0, so no `llm_calls` rows and no `action_id` threading.

One deliberate asymmetry: a script bug throws. The legacy `ScriptedLlmGateway` must never throw, because `FallbackLlmGateway` would retry and then swap in a canned decision, silently skewing a curve; nothing decorates the pipeline gateway that way, so a bad script fails the run loudly. `classify` is optional in a script because the heuristic table runs first, and a miss with no scripted classify reaches the machine's typed divine-intervention outcome rather than a fabricated hit.

---

_Where the four citing docs shorten to a link: `[[action-engine-framework]]` for the spine, `[[resolve-difficulty-signal]]` for RESOLVE's difficulty field, `[[agent-player-personas]]` for the audit queries, `[[threat-encounter-system]]` for its slice of `types.ts`. The prompt prose itself lives in `assets/prompts/decision-prompts/<PROMPT_SET_VERSION>/` and is versioned there, never here._
