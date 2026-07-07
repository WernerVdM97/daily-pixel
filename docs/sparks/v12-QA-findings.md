---
title: "v12 QA — prod data review (2026-07-05)"
status: spark
domain: spark
tags: [v12, pipeline, llm, prompt-refactor, qa, bug]
phase: poc
related:
  - "[[polish-v0.2.8]]"
  - "[[v12-pipeline-plan]]"
---

Raw findings from ~20 minutes of playtesting v12 on prod (`app_version 0.2.8`, `prompt_version v12`), queried from `data/warden.db`.

---

## 1. 2-beat decide cycle exceeds timeout budget

### Mechanics

The v12 pipeline splits each action into up to 5 LLM calls:

```
CLASSIFY (heuristic, 0ms) → DECIDE beat 1 (NEW_ACTION) → DECIDE beat 2 (CONTINUE)
                          → RESOLVE-MUTATE → RESOLVE-NARRATE → CRITIC
```

`MAX_DECISIONS_PER_ACTION = 2` forces two sequential decide calls before any dice are rolled. Each decide call uses DeepSeek thinking mode and takes 4-13 seconds. Successful actions average 35-40 seconds wall-clock.

The per-call timeout is 15 seconds (`deepseek-transport.ts`, `AbortController`). When beat 2 takes >15s, the entire step() throws, the character's `last_action_state` survives (was persisted), and the player is re-served the same decision. They pick again → same CONTINUE decide → same timeout.

### Observed: 6 decide timeouts, all on CONTINUE

All 6 timed-out calls show `PHASE: CONTINUE` / `This is decision 2 of 2 — the final beat.` in their captured raw prompts.

For action 3 ("seek fight"), the player clicked the same option 5 times, each deciding call timed out at exactly ~15005ms. Total: 75 seconds before the bot gave them the bail message.

### Proposed fixes

- [ ] **Bump per-call timeout to 60s.** Single constant change in `deepseek-transport.ts`. Acceptable latency for POC — coherency and decision quality are far higher priorities.
- [ ] **Wire pipeline-stage call IDs into `llmCallIds`.** `stamping.ts` exists but was never connected to `LlmCallRecorder`. Currently only critic calls get `action_id` set; pipeline-decide, pipeline-resolve-mutate, and pipeline-resolve-narrate all have `action_id: null`. This is a known, documented gap (`PipelineInternalActionState.llmCallIds` comment: "nothing wires it into an actual LlmCallRecorder call yet — no live gateway/persistence exists for the pipeline machine in Stage 1").
- [ ] **Catch timeout in `stepActionPipeline`, resolve as `timed_out` outcome instead of re-throwing.** Currently the error propagates uncaught, the player gets the same decision re-presented, and they can burn 5+ attempts on the same stuck beat.
- [ ] **Background-log DeepSeek reasoning on timeout.** When the 60s abort fires, the stream is already dead — but we could fire a second non-blocking `fetch` with a longer timeout (or no timeout) purely for audit, catching the `reasoning_content` we miss from the aborted call. This is speculative — DeepSeek may not support concurrent calls on the same context. (Investigate.)

[!] Rejected: raising `MAX_DECISIONS_PER_ACTION` from 2 to 3. The CONTINUE beat is the one timing out — more beats just gives it more chances to fail. Raise the timeout first, capture the data, then decide.

---

## 2. Decision quality: single-option outputs + auto-resolve regression

### Observed: single-option decisions

Call 24 (DECIDE beat 2 for the interact action) returned a single option:

```json
{ "decision": [{ "label": "The Warden pauses...", "stat": "wisdom", "dcModifier": -2 }] }
```

Player feedback confirms it:

```
15:14:22 — "Wtf is this . I didn't even get an option!"
15:16:21 — "Wtf no choices"
15:20:36 — "Why did I get a single choice in the second decision ??"
```

The BASE.md prompt explicitly demands 2-4 options and runs a PRE-FLIGHT CHECK: "every option has a stat and is a real, active choice." The LLM is violating its own instructions.

Cause: the CONTINUE phase prompt tells the LLM "once the player commits to a clear, irreversible action, return an empty `decision` array" — but also "reserve decisions for genuine branches." The LLM appears to split the difference: it knows the player committed in beat 1, so it won't generate new branches, but it isn't confident enough to return `[]` (which triggers resolve). So it gives one no-stakes option as a hedge.

### Observed: auto-resolve removed from startAction

v11 allowed `start()` to return `resolved: true` — the LLM produced a complete decision (mutations + outcomeText) and the action resolved in one shot. For travel, the LLM would return `done: true` with a `move_to` mutation, the engine applied it, and the player saw a result with no intermediate decision screen.

v12 deliberately removed this path:

```typescript
// WorldEngineImpl.startActionPipeline():
// Pipeline DECIDE never authors mutations/outcome_text — the D5b split —
// so no auto-finish path exists here. DECIDE always returns `resolved: false`.
```

When DECIDE returns `decision: []` on beat 1 (e.g. for pure travel), `toActionDecision` turns it into a bail-only screen:

```
Travel — choose your approach: [Step back]
```

The player clicks the only option → bail path → stamina -1 + "You step back from the situation." Three consecutive travel attempts (actions 5-7) all ended this way.

### Proposed fixes

- [ ] **Deterministic single-option validator.** After `decide()` returns, if `decision.length === 1`, trigger one bounded re-decide with a note: "You returned a single option. The player needs real choices. Generate 2-4 distinct approaches or return [] if this should resolve outright." Surface the DeepSeek reasoning from the single-option call via `PipelineDecideResult._reasoning` so the validator can log what the LLM was thinking.
- [ ] **Restore auto-resolve on first-beat `decision: []`.** When DECIDE beat 1 returns an empty decision array, trigger the resolve pipeline immediately (RESOLVE-MUTATE → RESOLVE-NARRATE) inside `start()` instead of serving a bail-only screen. The LLM already decides what needs player choices vs. what resolves outright — the engine just needs to honour that signal.
- [ ] **Env var for unconditional prompt/reasoning logging.** `LLM_LOG_ALL_PROMPTS=1` removes the `errorMsg !== null || !parseOk` guard in `ProdPipelineGateway.runStage()`. Storage cost: prompts are 2-5KB each; fine for QA, turn off in steady state.

---

## 3. Critic gate: decision critic never fires

### Mechanics

There is ONE critic (`critic-v1.md`, `CRITIC_VERSION = 'v1'`, independent from the pipeline version). It implements a single `CriticGateway.critique()` interface, invoked at two pipeline sites:

(should we split out the decision and narration critic prompts? probably)

| Site | BEAT header | When | Fires on prod? |
|---|---|---|---|
| `critiqueDecide()` | `BEAT: decision` | After DECIDE | **No** — gated behind `required: true`, never reached |
| `critiqueNarration()` | `BEAT: resolution` | After RESOLVE-NARRATE | **Yes** — 3 calls, all `ok` |

The gate:

```typescript
// critiqueDecide():
if (!decideResult.required) return { result: decideResult, criticCallIds: [] };
```

`required: true` only gets set when the LLM detects an active threat the player can't walk away from. Zero actions in the 8-action test session were `required: true` — every action (interact, rest, travel, scavenge, hunt) was `required: false`. The decision critic is a dead code path.

This means the single-option defect from §2 passed through unchecked — the critic that could have caught "you gave the player no real choices" was never invoked.

### Proposed fix

(lets remove the guard entirely but leave a note and a todo to re-evalutate this after more testing data. perhaps we can have a better comparison for anomaly detection)

- [ ] **Remove the `required` gate on `critiqueDecide`.** Fire the decision critic on every decide beat. Cost: +1 LLM call per decide beat (critic is ~3-4s, ~1500-2000 tokens). With the 60s timeout from §1, this fits. Lighter alternative: gate on anomaly only (`decision.length < 2 && decision.length > 0` or `baseDc out of range`), but the simplest fix with most coverage is removing the guard entirely.


