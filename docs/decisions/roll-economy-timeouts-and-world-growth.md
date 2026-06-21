---
title: 'Roll Economy, Timeouts & World Growth (POC)'
status: decided
domain: engine
phase: poc
tags:
- poc
- decision
- engine
- llm
- rolls
- locations
related:
- '[[prod-data-review-v0.2.3]]'
- '[[polish-pass-v0.2.4]]'
- '[[goodnight-and-rest-features]]'
- '[[daily-work-teleport]]'
- '[[mvp-data-model]]'
---

Resolves the three open design calls raised by [[prod-data-review-v0.2.3]] — **D1** (§C1 auto-resolve eats a roll), **D2** (§C2 timeout handling), **D3** (§G3 world can't grow new locations) — so that doc becomes implementable. One record because all three live in the same action-resolution path and land in the same `decision-v8.md` prompt bump.

Decided with Werner, 2026-06-21. The prod evidence (8 players, 67 actions, 216 LLM calls) is in [[prod-data-review-v0.2.3]]; this record is the *what we're doing about it*.

---

## Context

The action loop debits **1 of 3 daily rolls** in `WorldEngineImpl.startAction` (`:565`) the moment an action starts, before any dice or choice. Three failure modes fall out of that, all live on v0.2.3:

- **Auto-resolve** (`machine.ts:79-111`): when the LLM returns no rollable option, the action resolves `done` / `playerRolled:null` — but the roll is already spent. 28% of v0.2.3 actions; top complaint volume.
- **Timeout** (`isStateStale`, `WorldEngineImpl.ts:173-205`): a stale action writes `timed_out`, applies no mutations (intended travel lost), **does not refund**, renders a grey ghost card.
- **Off-map travel** (`set_location`): the decision prompt never sends the location list (`prompt-builder.ts:42` sends only the *current* location), so the LLM invents place names. The resolution-path mutation context (`WorldEngineImpl.ts:414-422`) omits `knownLocations`, so the unknown-location guard in `mutations.ts:77` is **inactive** — unknown `set_location` is *accepted*, leaving the player at an unrenderable spot the day-work gating then refuses.

Shared design principle adopted across all three: **a roll is the price of a resolved action that changes the world or offers a real choice — not the price of starting one.**

---

## D1 · Roll economy for auto-resolve

**Decision.** Charge the roll when the resolved action **changes the world** (≥1 state-changing mutation — location/health/stamina/wealth/items/rolls — or the player actually rolled). When it resolves as a **no-op** (a `done` with no rollable choice and no world-changing mutation, e.g. "The moment passes."), **refund the roll — but only the first no-op per character per day.** Subsequent no-ops that day cost the roll.

- [p] Removes the "wasted turn" sting that drives the loudest complaints, without making the roll economy free.
- [p] The once-per-day freebie is an anti-farming guard: a player can't spam no-op prompts to fish for free attempts.
- [c] Adds per-day bookkeeping (one column) and a "what counts as a no-op" rule the engine must apply consistently.
- [?] Resolved: travel/rest auto-resolves **do** change the world (location/stamina), so they legitimately cost a roll — they are *not* no-ops.

**Also (prompt side, v8):** tighten the prompt so a paragraph of substantive player intent must yield **≥1 rollable decision** unless it is genuinely pure travel/rest. Reject empty-decision / no-mutation / no-outcome responses at the gateway (`DeepseekLlmGateway.ts:264` currently only *warns*) and retry instead of surfacing a dead turn. This shrinks how often the no-op path is hit at all; the refund handles the residue.

**Acceptance.** A no-op action: first per day → roll count unchanged (refunded), footer/telemetry reflect no spend; second+ per day → roll spent. A world-changing auto-resolve (travel/rest) → roll spent every time. Covered by engine tests against `MockLlmGateway` no-op vs mutation-bearing responses.

---

## D2 · Timeout handling

**Decision.** On a stale/`timed_out` action: **refund the roll for the first timeout per character per day**; later timeouts that day keep the roll spent (the freebie is a courtesy, not an exploit surface). Always render an explicit, in-voice message that (a) names it as a **server-side timeout** (not a player failure), and (b) states plainly whether the roll was refunded. Apply no mutations; the intended travel does **not** occur — the player re-issues if they still want it.

- [p] Makes the player whole for our slowness on the common case, and the message stops the "ghost card, did I travel?" confusion (C2).
- [c] A timeout usually fires *mid-decision*, so there is no committed mutation to re-apply — "resume the travel" is undefined. Cleanly cancelling is the honest behaviour. (Re-applying intended travel was **rejected** for this reason.)
- [?] Resolved: D1's no-op freebie and D2's timeout freebie are **separate** per-day allowances — different failure modes (the player's dud prompt vs our server slowness); a timeout must not burn the no-op grace.

**Acceptance.** First timeout/day → roll refunded, message names server timeout + refund; second+ timeout/day → roll stays spent, message names server timeout + says the roll was used; no `set_location`/mutations applied in either case; no grey bare card.

---

## D3 · World growth — lazy location creation

**Decision.** Let the world grow from play. When a resolved `set_location` names a place **not** matched (case/trim-normalized) to any existing location:

1. **Inject the known-location list into the decision prompt (v8)** so the LLM reuses real names and only invents when the story genuinely goes off-map. v8 rule:
   > You are given `KNOWN LOCATIONS`. To move the player, prefer an **exact** name from that list. Introduce a **new** location name **only** when the narrative genuinely takes them beyond the known map (real exploration/construction) — never as a synonym for a place that already exists.
2. **Synchronously write a provisional stub** row: the given name, `is_safe = 0` (off-map wilds are unsafe until charted), a placeholder description, and an `enrichment_pending` flag. The player is *immediately* at a valid, renderable location — the stranding bug dies regardless of LLM timing. Scene art rides the existing `locations.tags` system.
3. **Fire an async "cartographer" LLM call** (off the player's critical path) with the existing-locations list + the action's narrative context. It fills `is_safe` + a proper description and clears the flag. Enrichment only overwrites a row while still provisional (idempotent; the flag also prevents double-firing).

**Dedup:** list-injection (LLM reuses names) + normalized-name reuse on write (exact/case/trim match → reuse the existing row, never create) + the DB `locations.name UNIQUE` constraint. The cartographer **only enriches; it never merges or deletes** a location a player may be standing on.

- [p] The world grows where players push it — on-theme, and answers the real prod demand (the "temple"/"new town" the narrative kept inventing).
- [p] Sync stub + async enrich keeps latency off the player (Q1 already flags ~13 s avg beats); the player never waits on world-building.
- [c] +1 LLM call per *genuinely new* location (not per action — bounded). A new place is transiently `is_safe = 0` + placeholder until enrichment lands (seconds); if a player rests there in that window they take the unsafe-rest penalty. Accepted as negligible (rest is end-of-day).
- [c] Rare **semantic** near-dupes ("The Temple" vs "Temple of the First Flame") can produce two rows. Accepted for POC.
- [?] Will the LLM ever create new locations? **Only because v8 explicitly licenses it** (rule above). Without that rule the create path is dead — so the rule is load-bearing, not optional.

**Rejected / deferred to MVP:** semantic-dupe merging (relocating a player + dropping a stub underfoot — too many edge cases); distance/travel-cost modelling for new locations; a curated alias table. These belong to [[mvp-data-model]] / the graph-DB world-state work.

**Acceptance.** A resolved `set_location` to a novel name → a `locations` row exists immediately (player renders, `/hi` and day-work gating work) → within seconds the row has an LLM `is_safe` + description and `enrichment_pending` cleared. A `set_location` matching an existing name (any casing) → reuses that row, no new row. The decision prompt context includes the location list.

---

## Cross-cutting consequences

- [I] **`decision-v8.md` bump owns:** the D1 "substantive intent → ≥1 rollable decision" rule; the D3 `KNOWN LOCATIONS` injection + creation rule; **plus** the cosmetic fixes relocated from [[polish-pass-v0.2.4]] — P1 ("expendale"→"expendable"), P2 (inventory-reference wording), and the E3 `done`-flag contract call (re-document or strip the engine's reliance). All land in the **one** new version. Per `AGENTS.md`: add `decision-v8.md`, bump `PROMPT_VERSION`, copy to `current_source.md` byte-identical.
- [I] **DB migration (new columns on `player_characters`):** `last_noop_refund_day` and `last_timeout_refund_day` (INTEGER game-day, same pattern as `last_rested_day`); plus `enrichment_pending` on `locations` (INTEGER 0|1). Migration framework is additive/guarded (see [[bug-analysis-v0.2.2]]).
- [I] **Gateway:** a new async "cartographer" path (its own focused prompt + a small structured schema: `{ matchesExisting?: string, is_safe?: 0|1, description?: string }`), separate from the decision gateway. Reuses the existing transport (clean at 216/216 calls).
- [I] **Touches `WorldEngineImpl.ts`** in `startAction`/`isStateStale` and the mutation-context builder (`:414`) — *not* `countSoulsInUnsafe`, which stays owned by [[polish-pass-v0.2.4]] §E1. With D3 live, unknown locations stop existing, so §E1's guard becomes belt-and-braces (still wanted).
- [c] **Scope honesty:** D3 is the most ambitious POC item — a second LLM agent and emergent world state. Justified by prod demand, but it is the first toe into MVP-shaped world-growth; the rejections above keep it from sliding fully into MVP.
