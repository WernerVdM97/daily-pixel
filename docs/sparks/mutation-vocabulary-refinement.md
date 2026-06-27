---
title: Mutation Vocabulary Refinement — Verb Cleanup, NPC Lifecycle & Action-Category Map
status: spark
domain: spark
phase: poc
tags: [llm, mutations, engine, prompt, npc, taxonomy]
related:
  - "[[prompt-v9-markdown-and-critic]]"
  - "[[prompt-v10-scaling-and-pipeline]]"
  - "[[roll-economy-timeouts-and-world-growth]]"
---
---

start here

---

## What this is

A focused cleanup-plus-small-expansion of the **mutation vocabulary** — the keywords the LLM emits in a decision's `mutations[]` array that cause persistent DB/state writes. The current set works but has drifted: four naming conventions, one keyword doing two jobs, and a class of world entity (NPCs) that can only ever be born, never changed. This spark tidies the vocabulary into one principled scheme, gives NPCs a lifecycle, and introduces a soft `category → expected-mutations` map so the prompt's per-action recipes live in one place and deviations become a tuning signal.

This is a `0.2.x` candidate. It bumps the decision prompt (a new `decision-v<N>.md` + `PROMPT_VERSION`), so historical action rows stay attributable to the v8 vocabulary that produced them.

- [>] **Sequencing against [[prompt-v9-markdown-and-critic]] is now settled by reality: v9 shipped standalone** (`PROMPT_VERSION='v9'`, `decision-v9.md` + the critic are live). So this cleanup is a **separate, later bump**, not folded into v9. **Open naming collision** (resolve before implementing): the next decision prompt is `v10`, but [[prompt-v10-scaling-and-pipeline]] also claims the name "v10" for its 0.3.0 prompt *set*. Either this ships as `decision-v10` and the pipeline set becomes `v11`+, or this folds into the v10 set — pick one so two different things aren't both called v10.

## The current vocabulary (v8 baseline)

Nine mutation types in four families, with four different verb conventions:

| Family | Keyword(s) | Shape | Verb style |
|---|---|---|---|
| Scalar deltas | `modify_stamina` · `modify_health` · `modify_max_stamina` · `modify_wealth` · `modify_rolls_remaining` | `{ amount }` | `modify_` |
| Inventory | `add_item` · `remove_item` | `{ name, emoji, stat, modifier, quantity }` | `add_/remove_` |
| World actor | `spawn_npc` | `{ name, class?, race?, description? }` | `spawn_` |
| Movement/world | `set_location` | `{ name }` | `set_` |

What is genuinely good and stays untouched:

- [p] The **scalar family is clean** — uniform `{amount}`, every one bounds-checked (`src/engine/action/mutations.ts:86`), and the failure-filter (`src/engine/action/machine.ts:379`) treats them generically (keep negatives, drop positives on a failed roll).
- [p] **Lazy location creation** — a `set_location` to an unknown name auto-creates a provisional location row + async cartographer enrichment (`src/engine/WorldEngineImpl.ts:557`). Elegant; preserved.

The problems this spark fixes:

- [!] **Verb soup.** `modify_` vs `add_/remove_` vs `spawn_` vs `set_` — four conventions for "change the world." More chances for the LLM to emit a near-miss (`update_location`, `create_npc`) that gets silently dropped.
- [!] **`set_location` is overloaded** — it both *moves the character* and *creates a place*. Two concerns, one keyword. Today you cannot put a place on the map without walking a character into it.
- [!] **`spawn_npc` is write-once.** NPCs are born inert: they can never die, move, or have their description evolve. The social world only ever grows, never changes.
- [?] **No alignment between the action and its mutations.** `distilled_type` is a free-form, player-facing string (`src/llm/LlmGateway.ts:31`); nothing connects "this is a combat action" to "these mutations make sense." The per-action recipes exist only as prose in the prompt (`decision-v8.md` §4a) with no single source of truth and no telemetry on deviation.

---

## Decisions

### 1. One naming convention

> **Rule:** `modify_*` = a delta on one of the character's clamped numbers · `add_/update_/remove_*` = CRUD on a world entity or collection · `move_to` = relocate the character.

This collapses four conventions into one learnable scheme. The `modify_` vs `add/update/remove_` split is intentional — a clamped scalar delta and a row CRUD are genuinely different operation shapes — but within each axis the verbs are now uniform across nouns.

Rename table (changes in **bold**):

| v8 | New | Note |
|---|---|---|
| `modify_stamina` · `modify_health` · `modify_max_stamina` · `modify_wealth` · `modify_rolls_remaining` | *unchanged* | The clean core — keep it |
| `add_item` · `remove_item` | *unchanged* | Conventional |
| `spawn_npc` | **`add_npc`** | Aligns NPC creation with `add_item` |
| — | **`update_npc`** | New — see §2 |
| — | **`remove_npc`** | New — death/departure |
| `set_location` | **`move_to`** | "Relocate the character." Unknown name still lazily creates the place |
| — | **`reveal_location`** | New — a place exists / is learned of, **without** moving there |

- [p] Old v8 action-row JSON keeps its vocabulary and stays attributable to `decision-v8` — those rows are audit data, never re-applied, so the validator only ever sees fresh v-next output. The rename is clean.

### 2. NPC lifecycle (free fields now, disposition deferred)

The `npcs` table already carries `description` and `location` (set at creation). So the lifecycle additions that need **no schema change** ship now:

- [I] **`update_npc { name, description?, location? }`** — an NPC's prose and whereabouts can evolve ("now scarred from the duel," "moved to the docks").
- [I] **`remove_npc { name }`** — death or departure.
- [<] **`disposition` / relationship tracking is explicitly deferred.** A `disposition` column is worthless unless it is also fed *back into* `LlmContext` when that NPC reappears — otherwise it is dead, write-only state. That is schema migration + context plumbing + prompt changes, which belongs with the 0.3.0 relationship/social work, not this cleanup.

- [!] **NPC identity resolution.** `add_npc` addresses NPCs by `name`; `update_npc`/`remove_npc` must resolve a name back to an existing row. Resolve case-insensitively, scoped by the acting character's current location to disambiguate; on no-match, **warn + drop** (soft, consistent with §5). Define this precisely at implementation time.
  - [c] **Live duplicate risk (the Warden case).** NPCs are **seeded** in `seedNpcs` (`src/db/migrate.ts:116`), which already plants *two* hooded mystery figures by design — **The Warden** (at the Oak; its description leans on the deep hood) and a distinct **"A Hooded Figure"** (a Wanderer at the Weary Lantern Inn). The only dedup today is a partial unique index `ON npcs(name) WHERE created_by_action_id IS NULL` (`schema.sql:147`) — it protects **seeded** names only. LLM `spawn_npc` rows carry a non-null `created_by_action_id`, so they're exempt: a play-time `spawn_npc "The Warden"` (or yet another "hooded figure") inserts a duplicate alongside the canon (`npc.ts:26`, `WorldEngineImpl.ts:595` insert unconditionally), and the lore GM-note (the title-passed-across-centuries framing, [[prompt-v9-markdown-and-critic]]) can't bind them. This is the motivating bug for resolution-on-create: an `add_npc` whose name matches an existing NPC at the location — seeded **or** spawned — should reuse/`update_npc` that row, not mint a duplicate. Exact-name reuse is solid; alias/fuzzy matching for canonical figures (Warden ≈ hooded figure) is the harder, deferrable part — at minimum stop the literal duplicate, and consider extending the unique index to cover spawned rows.

### 3. `set_location` split → `move_to` + `reveal_location`

- [I] **`move_to { location }`** — relocates the character. Unknown name → keep the existing lazy-create + async-enrich behaviour.
- [I] **`reveal_location { name, is_safe?, description? }`** — introduces/describes a place on the map **without** moving the character there ("you spot a watchtower on the ridge"). Resolves the v8 overload: knowing a place exists is now distinct from being there.
- [I] Both `move_to` (on a novel name) and `reveal_location` may optionally carry `is_safe`/`description` so a freshly-discovered place isn't always defaulted unsafe + async-guessed.
- [<] **Stamp location provenance — `created_by_action_id` on `locations`, mirroring `npcs`.** `npcs` already records which action spawned it (`schema.sql:71` + `idx_npcs_created_by_action`), but `locations` has no such column — a lazily-created place (D3, [[roll-economy-timeouts-and-world-growth]]) loses the action that birthed it. Add a nullable `created_by_action_id INTEGER REFERENCES actions(id)` to `locations` and stamp it when `move_to`/`reveal_location` creates a new row (NULL for the seeded starter map, exactly like seeded NPCs). Pure provenance/data-mining symmetry — it makes "which actions grew the world, and what prompted each new place" queryable, and pairs with the per-player `discovered_from` tree in [[per-player-map-exploration]] (that's *who reached it*; this is *what created it*). Additive guarded migration; no behaviour change.

### 4. A closed `category` enum keys the map (keep `distilled_type` as flavour)

A dictionary cannot be keyed on a free string the LLM invents (`"hunt"` vs `"hunting"` vs `"stalk the boar"` would all miss). So:

- [I] Add a **closed `category` enum** to the decision schema, *alongside* the existing free `distilled_type`. Each field does one job: `category` = machine key (map + telemetry + failure-filter), `distilled_type` = the player-facing flavour label already shown in broadcasts.

The category set, derived from `decision-v8.md` §4a and rounded out for a normal session, each with a distinct mutation signature:

| `category` | Covers | Signature mutations |
|---|---|---|
| `combat` | fights, encounters | stamina− · health− · loot (`add_item`) · `update_npc`(hostile)/`remove_npc`(slain) |
| `travel` | moving, exploring | **`move_to`** · stamina− · `add_npc`(met on road) · found item |
| `social` | talk, persuade, barter, intimidate | wealth± · `add_npc`(contact) · `update_npc` · gift/trade items |
| `skill` | train, practice, craft, perform | stamina− · max_stamina+ · rolls+ |
| `search` | scavenge, forage, loot, investigate | `add_item` · stamina− |
| `rest` | recover, sleep, heal | **health+ · stamina+ · rolls+** |
| `other` | catch-all — never blocks a weird action | anything |

- [!] `rest` is the one category whose *expected reward is positive* health/stamina, which interacts directly with the failure-filter — a **failed** rest must still not heal. The map and the failure-filter must be defined against the same `category` and kept in agreement.
- [p] `other` is a deliberate escape hatch so a novel action is never wedged by the enum.

### 5. Soft enforcement — warn + telemetry, always apply

The `category → expected-mutations` map lives in code as the **single source of truth**, and:

- [I] It is **injected into the prompt**, replacing the hand-written §4a recipe prose so the two cannot drift.
- [I] At runtime, a mutation outside its category's expected set is **flagged "unexpected," logged for data-mining, but still applied**.
- [-] **Not** hard-dropped. D&D is emergent — a `social` turn can erupt into a stabbing, and the LLM then legitimately needs `modify_health`. Hard-dropping would break emergent scenes and largely duplicates the failure-filter.
- [p] Payoff: prompt + filter generated from one definition (no drift) **and** a balancing signal ("the LLM keeps emitting `modify_wealth` on `combat`") without constraining play.

### 6. Forward note → 0.3.0 two-pass prompt (ties to [[prompt-v10-scaling-and-pipeline]])

- [>] Today's soft map is a **stepping stone**. In the larger prompt refactor (prompt-v10 thread D — *classify → decide → resolve pipeline*), move to a **two-pass flow**: derive the `category` first, then **dynamically inject only that category's mutation sub-vocabulary** into the second prompt. A smaller, focused mutation menu per call should sharpen adherence and shrink the prompt. The soft map built here becomes the data source that two-pass flow reads from.

---

## Implementation touch-points

- [ ] `assets/prompts/decision-prompts/decision-v<N>.md` (new) + `current_source.md` mirror + `PROMPT_VERSION` bump in `src/llm/prompt-builder.ts`. New vocabulary, the `category` field, and the §4a recipes generated from the map.
- [ ] `src/llm/LlmGateway.ts` — add `category` to `LlmDecision`; `src/llm/DeepseekLlmGateway.ts` — parse/validate it.
- [ ] `src/engine/action/mutations.ts` — rename keywords in `MUTATION_TYPES` + validators; add `add_npc`/`update_npc`/`remove_npc`, `move_to`, `reveal_location`.
- [ ] `src/engine/action/machine.ts` — keep the failure-filter switch aligned with the renamed keywords and the `rest` category.
- [ ] `src/engine/WorldEngineImpl.ts` — apply NPC update/remove and `reveal_location` (place-without-move); the category→map definition + the "unexpected mutation" telemetry log.
- [ ] Tests — `tests/engine/action-mutations.test.ts` and friends: renamed-keyword validation, NPC update/remove + name resolution, `reveal_location`, category-deviation warning path.

## Open questions

- [?] **Prompt-version number + collision with the v10 set** — v9 already shipped, so this is a later standalone bump; settle whether it takes `decision-v10` (pushing [[prompt-v10-scaling-and-pipeline]]'s prompt set to `v11`+) or folds into that set, so "v10" names exactly one thing.
- [?] **NPC name-resolution precision** — exact rule for resolving `update_npc`/`remove_npc` by name within a location, and behaviour on ambiguity (multiple matches) vs no-match.
- [?] **`reveal_location` reachability** — does a revealed-but-unvisited place behave any differently from a visited one in known-locations context, or is it identical minus the character's presence?

## Out of scope

- [-] NPC disposition / relationships / reputation — deferred to 0.3.0 social work (§2).
- [-] Status effects / conditions with durations (poisoned, blessed, exhausted) — a separate, larger expansion; not part of this cleanup.
- [-] Quest/story flags, location state changes (cleared/burned), knowledge/journal — noted as future expressiveness, not this spark.
- [-] Any change to the scalar `modify_*` family — it is the clean core.

---

footer
