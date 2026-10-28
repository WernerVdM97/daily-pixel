---
title: OpenRouter keys and cache observability
status: exploring
domain: engine
phase: poc
tags: [llm, cost, openrouter, observability, agents]
related:
  - "[[poc-build-deploy]]"
  - "[[dark-factory]]"
  - "[[dark-factory-requirements]]"
---
_How OpenRouter spend gets attributed per actor (four actors, four keys since the factory was split off in #160, and the `--api-key` precedence trap that makes an environment variable useless for this), and why the host pin cannot currently be verified, plus the five `llm_calls` columns and the migration that fix it._

---

Two loose ends were left by the move onto OpenRouter (PR #157). Both are about the same thing: nobody can currently say **who is spending** or **whether the pin is working**. This doc settles the first and specifies the second, because the second is only meaningful once the first is true. A shared key means a cache regression and a spend spike arrive together, with no way to tell them apart.

## Part 1: a key is the unit of attribution

Four actors reach the same OpenRouter account, and each holds its own key since the factory was split off (#160). A shared key means a cache regression and a spend spike arrive together, with no way to tell them apart.

| Actor | Key | Where it comes from | Separated? |
| ----- | --- | ------------------- | ---------- |
| Interactive `pi` | the shared key | `~/.pi/agent/auth.json`, provider `openrouter` | n/a, that _is_ the shared key |
| The Dark Factory, every loop and every stage child | `FACTORY_OPENROUTER_API_KEY` | process environment, else the repo `.env` (never sourced); `--api-key` at both spawn sites, and a shadow agent dir for everything spawned under them | yes (#160) |
| The bot | `OPENROUTER_API_KEY` | process env; `EnvironmentFile=/home/bot/app/.env` in prod | yes (PR #157) |
| The agent-player | `AGENT_OPENROUTER_API_KEY` | the shell that sources the repo `.env` | yes (PR #157) |

The factory was the omission, and it is the largest spender: a tick can fire several loops and spawn several children, and until #160 none of it was separable from your own interactive sessions.

**Per-key accounting already exists**, which is what makes splitting worthwhile rather than cosmetic. `GET https://openrouter.ai/api/v1/key` with a key returns its own `usage`, `usage_daily`, `usage_weekly`, `usage_monthly`, `limit` and `limit_remaining`. Reading the shared key on 2026-09-14 reported **$10.27 all-time and $3.38 this week** with no attribution beneath it, while every factory loop reaches the same endpoint under the same identity as you. Those figures are a snapshot, not a budget: they date the split rather than describe it.

`limit` is `null` (no cap) on the shared key and `expires_at` is `null` (nothing forces rotation). Both are available per key, and the split is already using the first of them: **the factory key carries a `$5` cap that resets daily** (`limit: 5`, `limit_reset: daily`, `limit_remaining: 5`, unused so far), which is the runaway case handled rather than discussed. The ceiling is loose against the observed burn, since the shared key's $3.38 covers a week of the factory plus your own sessions, so $5 a day is roughly ten times that and should not bind in normal operation; the daily reset is what makes it safe, because the outage clears itself rather than waiting for a human to raise a limit. The failure itself is worth stating plainly, because it is not a smaller bill but an outage: an exhausted key fails every call, and because the key is passed as `--api-key` there is deliberately no fallback to the shared credential, so the factory stops rather than spending somewhere else. A capped key converts spend into failure, which is the right trade for an unattended loop and the wrong one for anything a player is waiting on.

**The cap is only safe because something reads it.** `scripts/factory-run-due.sh` asks the same `GET /api/v1/key` for `limit_remaining` before it fires, and skips the tick when the answer is zero or negative, so an exhausted key is one log line saying why rather than a 401 per call for the rest of the day (#160). Nothing is mirrored into `.env`: the field is read live, so raising the cap on the dashboard takes effect on the next tick with nothing to re-provision, lowering it mid-window recomputes what is left, and removing it reports `null` and stands the guard down. The polarity matters as much as the check: only a definite answer skips — a spent budget, or an HTTP 401/403, which says the key itself is wrong and, with `--api-key` passed, every call today would be refused — while a timeout, a 5xx, an unparseable body or a missing field fires the tick anyway, because a guard that cannot read the budget must not become a new way to stop the factory.

### The trap: `auth.json` outranks the environment

pi resolves credentials in this order, and it is not the order most people assume:

```
1. --api-key flag
2. auth.json entry        ← wins over the environment
3. environment variable
4. custom provider keys in models.json
```

So adding `FACTORY_OPENROUTER_API_KEY` to `.env` and exporting it would **not** change the factory's behaviour. It would keep using the shared `auth.json` key while looking correctly configured, which is the worst version of the bug. Verified both halves rather than inferred from the doc:

```bash
$ OPENROUTER_API_KEY=sk-or-v1-BOGUS pi -p --model openrouter/deepseek/deepseek-v4.1-flash "reply ok"
ok                                            # auth.json beat the env var

$ pi -p --api-key sk-or-v1-BOGUS --model openrouter/deepseek/deepseek-v4.1-flash "reply ok"
401: {"message":"User not found."}            # the flag beat auth.json
```

The lever is therefore `--api-key`, at the two places the factory spawns `pi`. Both are built in #160, the branch stacked directly above this one, so what follows is the record of what landed there rather than a plan for it:

| Site | What it is | What changed |
| ---- | ---------- | ------------ |
| `scripts/factory-run-due.sh`, the `"$PI_BIN" -p … "$ACTION"` line | a schedule fire | `--model openrouter/deepseek/deepseek-v4.1-flash` pinned before `--api-key "$PI_KEY"`, both before `"$ACTION"` — a fire with no `--model` resolves the model from settings and installs `--api-key` against _that_ provider |
| `scripts/factory-jobs.ts`, `defaultSpawnStage` | the ledger's per-stage wrapper | `--api-key` in the args array, read off the injected `env` so it stays testable |

Both are one line, and both pass the flag only when the key is non-empty: `--api-key ""` is not "no key", it is a broken key, and it would turn the pin's hard-failure behaviour into a factory that cannot reach a model at all. Absent the flag, pi falls back to the shared `auth.json` credential, which is the deliberate degradation the launcher then warns about on the tick it happens.

A third path looked like it needed nothing: the agent children are spawned by pi from inside the wrapper process, so the assumption was that they inherit whatever credential the parent resolved, which is why the fix was two lines rather than one per agent definition. **They do not inherit it, and that assumption hid the factory's largest spend.** A child is pi's own session, built by pi-subagents on a `ModelRuntime` of its own, and that runtime reads `auth.json` from the agent dir (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`); the parent's `--api-key` is a runtime override on the *parent's* runtime and reaches nothing else, so every child of every loop and every stage billed the shared key while the wrapper's own calls looked correctly attributed. Probed both ways rather than reasoned about: with a bogus key in a shadow agent dir and the real key on the wrapper, the wrapper answered and its child came back `401 User not found`; with two distinct valid keys, the wrapper's spend landed on one and the child's on the other.

Both spawn sites therefore hand the process tree a **shadow agent dir** — `$HOME/.pi/factory-agent`, `FACTORY_AGENT_DIR` to move it — whose `auth.json` carries the factory key while every other entry is a symlink to the real agent dir, so models, the DeepSeek host pin, `settings.json`, the session root and the npm package install are exactly what a plain run resolves. The wrapper keeps its `--api-key`, which covers its own calls; the shadow covers everything under it. It is rebuilt on every stage and every fire, so a rotated key reaches the next one; only OpenRouter is re-keyed, so a provider this factory does not use keeps its credential; and it is skipped with a log line when there is no key or the shadow cannot be built, which is the same deliberate degradation as the missing key itself. `scripts/factory-run-due.sh` asks `scripts/factory-jobs.ts agent-dir` for the path instead of re-deriving the convention in shell, so there is one implementation and one `auth.json` writer.

### Where the factory key is stored

The launcher does **not** source the repo `.env`. It `sed`s `FACTORY_ENABLED` out of it by name (`scripts/factory-run-due.sh:70`), which is deliberate: the file carries a Discord token and, historically, plaintext material, and sourcing it into a systemd-run script buys nothing. So the key needed a home.

**Decided, and built in #160: another named `.env` value, `FACTORY_OPENROUTER_API_KEY`.** The other two candidates were a systemd drop-in and a separate `EnvironmentFile`; `.env` won because it puts every factory knob in the one file a reader already looks in, and the named `sed` read is the mechanism already proven there for `FACTORY_ENABLED`. The process environment is still checked first, so a drop-in remains available to anyone who wants the credential out of the repo tree entirely, and nothing has to change to switch.

The convention is mirrored in both languages rather than shared: `factory_key()` in `scripts/factory-run-due.sh` for the schedule fire, `factoryApiKey()` in `scripts/factory-jobs.ts` for the ledger's stage wrappers. Both take the process environment first, then the last matching line in `.env`, and both strip optional quoting, surrounding whitespace and a trailing comment. Duplicating a parsing convention across a shell script and a TypeScript one is the same bargain the launcher already makes with its own switch sources. The variable is listed in `.env.example` with the reason it exists, which is the convention #157 set for the bot's and the player's keys. The cap is not in that file: it lives on the key in the dashboard, and the launcher reads it from there rather than holding a copy that could drift.

## Part 2: the pin is unverifiable, and the response already says so

PR #157 pins every call to the DeepSeek host because a host switch means a cold prompt cache on a prefix that is re-read on every call, and the review pass on that PR sharpened it further: DeepSeek is the one endpoint of the model's 17 that OpenRouter flags `supports_implicit_caching`, so a fallback host would not merely be cold at the switch, it would never cache the prefix at all. That reasoning is only worth anything if the cache stays warm, and **nothing currently measures it**.

`llm_calls` records `prompt_tokens`, `completion_tokens`, `total_tokens`, `latency_ms`, `finish_reason` and `reasoning_chars`, the last of those a gauge of how long the model's thinking was rather than an input to any price. It does not record cached tokens, cost, or which host served the call, so a pin that silently stopped holding would look exactly like a pin that works, at a higher bill.

The evidence is already in the response body we receive and throw away:

```
id       : gen-1789404528-ALrfi7MXdFypkeyyMLmX
provider : DeepSeek
model    : deepseek/deepseek-v4.1-flash
usage    : prompt_tokens_details.cached_tokens : 0
           completion_tokens_details.reasoning_tokens : 47
           cost : 0.00004275
```

**`provider` is the field that matters.** The dotVault side solves the same problem in `bin/cachestat` by backfilling an id-to-host map from `GET /api/v1/generation?id=…`, because a pi session log keeps only the response id. That machinery is not needed here: the host is in the body, so per-call attribution is a field copy rather than a lookup against an index that expires. Two consequences follow, and they are the reason to do this at all:

- Any row where `provider != "DeepSeek"` is a **pin failure**, visible directly instead of inferred from a price.
- `cached_tokens / prompt_tokens` is the hit rate that prices the pin, per call kind. That is the number that decides whether the pin ever becomes unnecessary.

### The trap: an output cap above what the pinned host serves

A pin can be dropped before it is ever consulted. OpenRouter removes every endpoint whose served `max_completion_tokens` is below the `max_completion_tokens` the request asks for, and it does that in the first routing filter, ahead of `order` and `allow_fallbacks`. So a strict pin whose named hosts all serve less than the request asks for ends up with an empty candidate set, and the whole failure is one line in a few seconds:

```text
404: {"message":"No endpoints found for <model>. Every candidate endpoint was removed during routing: ... ; Filter by Fallback removed ...","code":404,"metadata":{"routing_funnel":[...],"failed_routing_step":"Filter by Fallback"}}
```

The signature to grep for is `404 No endpoints found … Filter by Fallback`. Nothing in the repo changed between the tick that worked and the tick that did not, no call timed out, and no request ever reached a host, so a pin walk that meets this has nothing to blame but the number under the pin.

**The asked-for figure is not something this repo sets.** It is the model's resolved `maxTokens`, and it comes from pi's cached OpenRouter model list rather than from the model registry bundled with the CLI. The two can disagree by a large factor, so the same override sits comfortably under the cap on one machine and above it on the next, decided by which list was last refreshed. That is what makes it a trap rather than a bug: the pin did not drift, the number under it moved.

**`allow_fallbacks: true` is not the remedy**, and the rule is worth stating as a rule rather than an incident: a fallback is a routing decision, so relaxing the pin to get past a filter can only route to an endpoint the pin exists to avoid. For the DeepSeek pin that is a host that does not cache the prefix at all, which turns a loud 404 into a quiet full-price re-read on every call; for a pin held for data-handling or price reasons it defeats the pin outright. The cap and the pin are independent levers, and only the cap puts the filtered endpoint back.

Two checks, both cheap, and they answer different questions:

- **Which cap won.** `pi --list-models` prints the resolved figure per model in its `max-out` column. That is the number the request asks for, and every host a pin can name must serve at least it. A model whose figure came from the cached list rather than the bundled registry is where the surprise lives, because a refresh can move it without a line of this repo changing.
- **What routing did.** A failed run keeps OpenRouter's own routing funnel in `.pi/subagents/schedules/<loop>/history.json`, inside `runs[].error`: the 404 body carries `metadata.routing_funnel`, one `{step, endpoint_count}` entry per filter, and `metadata.failed_routing_step`. Read it top to bottom: endpoints leaving at the context or cap step were dropped for serving too little, and endpoints leaving at the fallback step are the pin refusing whatever was left. Both in the same funnel is this trap's signature, where the cap emptied the pin and `allow_fallbacks: false` finished it.

The failure does reach `llm_calls`: a filtered request records a row with `http_status` 404 and an `error` naming the removed endpoints, and with no `provider` at all, because nothing served it. That is why `provider != 'DeepSeek'` is not the check that catches this one, and why the error text is worth reading before the host is blamed.

### The migration

Record first, report second. The columns are cheap and every day without them is a day of cache evidence that cannot be reconstructed; the report can be built from stored columns at any point afterwards.

Five columns on `llm_calls`:

| Column | Type | Why |
| ------ | ---- | --- |
| `response_id` | TEXT | The `gen-…` id, so a suspicious call can be pulled up in the OpenRouter dashboard by hand |
| `provider` | TEXT | The serving host. `DeepSeek` is the pin holding; anything else is a regression, per call |
| `cached_tokens` | INTEGER | Numerator of the hit rate; `prompt_tokens` is already recorded, so the rate is derivable |
| `cost_usd` | REAL | The provider's own figure, which is what a routing decision should be priced on |
| `reasoning_tokens` | INTEGER | What the reasoning opt-in costs, per call. The review pass on #157 exists because silence was buying a chain-of-thought on stages that never asked for one, so this is the column that prices that decision rather than leaving it in `completion_tokens` as a lump. It complements rather than duplicates `reasoning_chars`, which measures the length of the thinking rather than what that thinking is billed at |

Files it touches, following the house pattern for a schema change:

- `src/db/schema.sql`, the canonical shape a fresh DB gets. Not optional: a migration alone leaves every newly created database behind.
- `src/db/migrations/YYYYMMDDHHMM_llm_call_cache.ts`, registered in `src/db/migrations/index.ts` with an `id` matching the filename stem, guarded for idempotency (existing prod DBs predate the runner).
- `src/llm/LlmCallRecorder.ts`, for the five fields on `LlmCallRecord`, optional so a caller that cannot know them still records a row.
- `src/db/repositories/llm-call.ts`, the insert's column list and parameter bindings.
- `src/db/repositories/types.ts`, whose `LlmCallRow` mirrors `schema.sql`, so the five fields land in the row type a reader looks at first.
- `src/llm/chat-transport.ts`, to widen `ChatResponse` so the envelope carries `responseId`, `provider`, `cachedTokens`, `costUsd` and `reasoningTokens`. A widening rather than logic: the transport stays policy-free, and deciding what to do about a non-DeepSeek host belongs to the caller.
- The four callers that assemble a record: `ProdLlmGateway`, `ProdPipelineGateway`, `ProdAgentPlayerGateway`, `ProdPlaytestCriticGateway`.
- `src/agent/llmCostSummary.ts`, for the print half, since the existing report is the natural home for the hit rate. The split is already the house shape (`summarizeLlmCosts(db)` reads, `formatLlmCostSummary(summary)` renders), so the new figures stay unit-testable against hand-inserted rows.
- Tests, because this is a build spec with acceptance criteria rather than a claim: `tests/agent/llmCostSummary.test.ts` for the hit rate and the serving host against hand-inserted rows, and a case alongside `tests/db/migrate.test.ts` for the migration's idempotency and for the five columns a freshly created database gets from `schema.sql`.

`llm_calls` is unpruned, so its row count is the cost centre and five columns of `INTEGER`/`REAL`/`TEXT` do not move it. **All five are `NULL` on every row written before the migration**, which is the honest representation of "not recorded then" and needs the same treatment `actionableCriticLegacyCount` already gets: report the legacy rows separately rather than folding `NULL` into a zero hit rate or a zero cost.

### What this deliberately does not do

- **No generations-endpoint backfill.** That pattern exists because pi's logs keep only an id. Here the answer is in the response; adding a second, expiring source of truth for the same fact would be a way to disagree with ourselves.
- **No change to failure behaviour.** `allow_fallbacks` stays `false`, so a pin failure stays a hard error the caller handles, and it does not become the workaround for the cap trap above. These columns are how the failure gets noticed, not how it gets routed around.
- **No per-key limits on the bot or the playtest key yet.** The factory's own key is capped at `$5` a day; the other two are uncapped. A cap is a spend ceiling that reads as an outage when it is reached, so where to put one is a per-actor decision rather than a blanket policy.

## Acceptance

- [ ] One live bot call and one `agent:play` call each write `provider = 'DeepSeek'`, a `response_id` starting `gen-`, and non-null `cached_tokens`, `cost_usd` and `reasoning_tokens`.
- [ ] A `decide` call carries `reasoning_tokens > 0` and a `classify` call carries `0`, which is the check that the explicit `{enabled: false}` from the #157 review pass is reaching the wire on the stages that never opted in.
- [ ] **A second call sharing a prefix reports `cached_tokens > 0`.** This is the actual proof the pin is doing its job, and it is the one number no surface here shows today.
- [ ] `formatLlmCostSummary` prints hit rate and serving host per call kind, with pre-migration rows counted separately rather than as misses.
- [ ] Deliberately breaking the pin makes `provider != 'DeepSeek'` appear on the next call, so the check fails loudly rather than quietly paying full price. `order: ["morph"]` is not how to break it: with `allow_fallbacks: false`, a host that cannot serve the slug is a routing failure rather than a different provider. The executable form is to point `DEFAULT_LLM_MODEL` at `deepseek/deepseek-v4-flash`, which no DeepSeek endpoint serves, and drop the route's `order` with `allow_fallbacks: true`, so the next call is a real non-DeepSeek row and the check has something to fail on.

## Open questions

- [x] Home for the factory key: another named `.env` value, `FACTORY_OPENROUTER_API_KEY`, with the process environment still winning when it is set. Decided and built in #160, the branch above this one: the convention is mirrored as `factory_key()` in the shell launcher and `factoryApiKey()` in the job ledger, and the variable is listed in `.env.example`.
- [?] Does the bot's **local dev** run want a fifth key, or is it acceptable for a dev machine to spend on the production key? Today both would read `OPENROUTER_API_KEY` from the same `.env` pattern.
- [x] `limit` per key: the factory key carries a `$5` daily cap, and the launcher reads its `limit_remaining` before firing (#160), so its failure mode is a skipped tick with a line naming the cap rather than an unbounded bill. Caps on the bot and the playtest key are still open, and the bot's is the interesting one, because there a limit means mock-mode gameplay rather than a stopped loop.
- [!] Is `cost_usd` worth a `REAL` at all when `cached_tokens` and `prompt_tokens` already let us price any rate table we like? It is the provider's own number, which is an argument for recording it, and a provider number that can disagree with our arithmetic is an argument against. Settle this before the migration lands or the column arrives and a second migration has to remove it; the lean here is to keep it, since our own arithmetic disagreeing with the provider is exactly the kind of thing worth a row.
- [?] What status does an exhausted key actually return? The probe above is a 401 because that key is not one OpenRouter knows, and a key past its limit is a different failure. Confirm the code before anything keys on it, which is the reason the launcher guard reads `limit_remaining` instead.
- [<] Board item for this spec, so it competes for a milestone rather than living only here.

---

_Related: [[dark-factory-requirements]] holds the model-tier decisions and the reversal of the direct-provider rule; `docs/engine/poc-build-deploy.md` covers where the bot's `.env` lives in production._
