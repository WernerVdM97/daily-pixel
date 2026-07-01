---
title: Mutation Vocabulary Refinement — Verb Cleanup, NPC Lifecycle & Action-Category Map
status: shipped
domain: engine
phase: poc
tags:
  - llm
  - mutations
  - engine
  - prompt
  - npc
  - taxonomy
related:
  - "[[prompt-v9-markdown-and-critic]]"
  - "[[prompt-seperation-of-concerns]]"
  - "[[roll-economy-timeouts-and-world-growth]]"
  - "[[per-player-map-exploration]]"
---

## What this is

A focused cleanup-plus-small-expansion of the **mutation vocabulary** — the keywords the LLM emits in a decision's `mutations[]` array that cause persistent DB/state writes. The current set works but has drifted: four naming conventions, one keyword doing two jobs, and a class of world entity (NPCs) that can only ever be born, never changed. This spark tidies the vocabulary into one principled scheme, gives NPCs a lifecycle, and introduces a soft `category → expected-mutations` map so the prompt's per-action recipes live in one place and deviations become a tuning signal.

This is a `0.2.x` candidate. It bumps the decision prompt (a new **`decision-v11.md`** + `PROMPT_VERSION`), so historical action rows stay attributable to the v8/v9 vocabulary that produced them.

- [>] **Sequencing settled by reality: v9 shipped standalone** (`PROMPT_VERSION='v9'`, `decision-v9.md` + the critic are live). So this cleanup is a **separate, later bump**, not folded into v9.
- [>] **Numbering — RESOLVED (decided 2026-06-27).** Three prompt changes queue after v9: the *decided* [[per-player-map-exploration]] prompt bump ships first as **`decision-v10`** (KNOWN LOCATIONS → local exits); **this** vocabulary cleanup is the second single-file `0.2.x` bump, **`decision-v11`**; and the `0.3.0` pipeline *set* in [[prompt-seperation-of-concerns]] becomes **`v12`**. This cleanup builds on the map model — its `move_to`/`reveal_location` defer to the graph (see §3) — so it sequences *after* the map bump.

## The current vocabulary (v8/v9 baseline)

**v9 shipped without touching the vocabulary** — `decision-v9.md` still lists these exact nine types (`src/engine/action/mutations.ts:33`) and still carries the hand-written recipe prose (now `decision-v9.md` §4, the old v8 §4a). The live baseline this forks from is therefore **v9**; old action rows stay attributable across **both v8 and v9**.

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
- [?] **No alignment between the action and its mutations.** `distilled_type` is a free-form, player-facing string (`src/llm/LlmGateway.ts:41`); nothing connects "this is a combat action" to "these mutations make sense." The per-action recipes exist only as prose in the prompt (now `decision-v9.md` §4, the old v8 §4a) with no single source of truth and no telemetry on deviation.

---

## Decisions

### 1. One naming convention

> **Rule:** `modify_*` = a delta on one of the character's clamped numbers · `add_/update_/remove_*` = CRUD on a world entity or collection · `move_to` = relocate the character.

This collapses four conventions into one learnable scheme. The `modify_` vs `add/update/remove_` split is intentional — a clamped scalar delta and a row CRUD are genuinely different operation shapes — but within each axis the verbs are now uniform across nouns.

- [I] **Considered — full CRUD (`create_/update_/delete_`) for everything; rejected.** (a) `modify_*` is a *bounded delta* on a singleton field, not a row op — dressing it as `update_stamina` invites the LLM to emit an absolute "set to 5" instead of "+5/−5" and erases the delta-vs-CRUD distinction this scheme is built on. (b) `add_/remove_item` is already shipped, reads as game fiction (you *add* to a pack, you don't *create a row*), and `remove_npc` (death/departure) is likely a **soft** state change, not a hard `DELETE` — `delete_npc` would mislead toward erasing audit/provenance rows. The vocabulary is an LLM-facing *intent* layer over the engine's real CRUD, so it optimises for the model + the fiction, not DB-API symmetry. The genuinely valuable part of CRUD — one uniform verb-triad per entity — is **already adopted** as `add/update/remove`; swapping to the literal `create/delete` tokens is churn on clean keywords for no adherence gain.

Rename table (changes in **bold**):

| v8 | New | Note |
|---|---|---|
| `modify_stamina` · `modify_health` · `modify_max_stamina` · `modify_wealth` · `modify_rolls_remaining` | *unchanged* | The clean core — keep it |
| `add_item` · `remove_item` | *unchanged* | Conventional |
| `spawn_npc` | **`add_npc`** | Aligns NPC creation with `add_item` |
| — | **`update_npc`** | New — see §2 |
| — | **`remove_npc`** | New — death/departure |
| `set_location` | **`move_to`** | "Relocate the character" to a **known, reachable** node. (v11 rename; until then `set_location` carries this.) |
| — | **`cross_frontier`** | New — the **exploration verb**: cross a dangling frontier exit `{ direction, name }`, minting + binding the place on the far side. Ships in **v10** with the map (the map is inert without it). See §3. |
| — | **`reveal_location`** | New — a place exists / is learned of, **without** moving there |

- [>] **Update 2026-06-27 — frontier crossing is its own verb (`cross_frontier`), not folded into `move_to`.** Building [[per-player-map-exploration]] surfaced that a `move_to {name}` cannot express *which* frontier a new name binds to: a frontier exit is identified by **direction** (e.g. "NE from The East Road") and is unnamed until crossed, so a node with >1 frontier is ambiguous. Overloading `move_to` to mean both "go to a known node" and "mint new ground" re-creates the exact `set_location` overload this spark set out to kill. Resolution: **`cross_frontier { direction, name }`** — the LLM names the place it's walking into (narrative-facing naming stays with the decision LLM, per the map spec §3) and states the `direction`; the engine binds that exact exit (`bindFrontier`), mints the destination, and fires the cartographer for the *rest* of the geometry (region/tier/emoji/onward teasers). `move_to` is then cleanly "known reachable node only." Because the map (`v10`) cannot function without a crossing mechanism, `cross_frontier` ships **with the map in v10**; the `set_location → move_to` rename + `reveal_location` + the NPC verbs remain the `v11` cleanup.

- [p] Old v8 action-row JSON keeps its vocabulary and stays attributable to `decision-v8` — those rows are audit data, never re-applied, so the validator only ever sees fresh v-next output. The rename is clean.

### 2. NPC lifecycle (free fields now, disposition deferred)

The `npcs` table already carries `description` and `location` (set at creation), so the **NPC lifecycle core needs no schema change** and ships now. (This spark is *not* migration-free overall: §3 adds `locations.created_by_action_id`, and §2's duplicate fix may widen the `npcs` unique index — both additive and guarded.) The additions:

- [I] **`update_npc { name, description?, location? }`** — an NPC's prose and whereabouts can evolve ("now scarred from the duel," "moved to the docks").
- [I] **`remove_npc { name }`** — death or departure.
- [<] **`disposition` / relationship tracking is explicitly deferred.** A `disposition` column is worthless unless it is also fed *back into* `LlmContext` when that NPC reappears — otherwise it is dead, write-only state. That is schema migration + context plumbing + prompt changes, which belongs with the 0.3.0 relationship/social work, not this cleanup.

- [!] **NPC identity resolution — see §2a.** Raw names are too weak a key (they false-merge *and* false-split), so resolution is **handle-based**, `add_npc` is **create-only**, and duplicate *detection* is deterministic while *resolution* defers to v12. Full treatment in §2a.
  - [c] **Live duplicate risk (the Warden case).** *(Update 2026-06-27: the redundant seeded **"A Hooded Figure"** Wanderer was removed from `seedNpcs` (`src/db/migrate.ts`) — only **The Warden** now leans on the hood, killing the seed-vs-seed alias clash. Existing DBs keep their row until cleaned; the general duplication below is unaffected.)* The only dedup today is a partial unique index `ON npcs(name) WHERE created_by_action_id IS NULL` (`schema.sql:147`) — it protects **seeded** names only. LLM `spawn_npc` rows carry a non-null `created_by_action_id`, so they're exempt: a play-time `spawn_npc "The Warden"` (or any existing name) inserts a duplicate alongside the canon (`npc.ts:26`, `WorldEngineImpl.ts:595` insert unconditionally), and the lore GM-note (the title-passed-across-centuries framing, [[prompt-v9-markdown-and-critic]]) can't bind them. This is the motivating bug for resolution-on-create: an `add_npc` whose name matches an existing NPC at the location — seeded **or** spawned — should reuse/`update_npc` that row, not mint a duplicate. Exact-name reuse is solid; alias/fuzzy matching for canonical figures (Warden ≈ hooded figure) is the harder, deferrable part — at minimum stop the literal duplicate, and consider extending the unique index to cover spawned rows.

### 2a. NPC identity & resolution — handle-based (the v12 stepping stone)

A name is a weak key: it false-**merges** (two `Bandit`s, two `Grey Wolf`s are different NPCs) *and* false-**splits** (Warden ≈ "the hooded figure"). So resolution must not lean on raw names, and `add_npc` must never silently merge.

- [!] **`add_npc` is create-only — never auto-converted to a match.** Silently folding an `add` into an existing row risks a false-merge that erases a genuinely new NPC. Add always creates; "refer to an existing NPC" is a *different* operation (by handle, below) — so there is nothing to auto-merge.
- [I] **Reference existing NPCs by an engine-assigned handle, not by re-naming them.** The decision context already lists present/known NPCs (the `### Present` block); surface each with a short stable handle (the existing `npcs.id`, rendered e.g. `[N2]`). `update_npc`/`remove_npc` take that **handle**, not a free-text name → resolution is a deterministic id lookup, no fuzzy guessing. This is the load-bearing move and needs **no schema change** (reuses `npcs.id`); the context-plumbing is light (the Present list already exists).
- [p] **This is the v12 stepping stone.** Handles are exactly v12's graph **node ids** (D2): mutations become typed deltas referencing a node id, the LLM never emits SQL, the engine validates + writes. Building the handle contract in single-call v11 means v12's `set_relation`/`update_relation` edge-deltas already have stable endpoints — the v11 contract upgrades into the pipeline's graph contract with no re-design.
- [I] **Collision *detection* is deterministic and cheap (do it now); *resolution* defers.** An `add_npc` whose name matches a present NPC at the same location is almost certainly an accident — the validator flags it as a `_warning` + telemetry (the §5 soft stance) and surfaces it (drop the dup or keep both flagged-for-review). **Detection ≠ silent merge.** No LLM is needed to *notice* a collision.
- [c] **The critic is the wrong tool for resolution.** The v9 critic judges beat *coherence*, not entity identity. It *could* flag "you introduced an NPC who's already here" as one more incoherence check, but the deterministic name+location check above already covers detection — don't spend an LLM judgment on what a string compare catches.
- [<] **A dedicated entity-resolution LLM stage → v12.** A classify-phase resolver maps a free NPC *mention* → an existing node id (handling aliases the engine can't), with the engine still validating the id against the whitelist. Affordable in the pipeline (D5); premature as a bespoke call in single-shot v11; natural as a v12 stage operating on the handles this spark introduces.
- [I] **Richer identity — DECIDED: add `home_location`, defer `tags`.**
  - `home_location TEXT` (**add now**) — the NPC's canonical home, distinct from the mutable current `location` (the Caravan Master *travels*; the Warden *belongs* at the Oak). Directly supports the `update_npc {location}` lifecycle this spark introduces — "moved" without losing "where they're from" — plus later return/respawn. One cheap nullable column; additive guarded migration.
  - `tags TEXT` — **deferred.** Pure richness the handle mechanism doesn't need; let it ride in with v12's graph identity rather than grow this cleanup.
  - [p] Neither is load-bearing for resolution (handles do that); `home_location` earns its place by pairing with the NPC lifecycle, not by aiding identity matching.
- [I] **Handle format — DECIDED: ephemeral per-prompt tags (`[N1]…[Nk]`).** The engine assigns them to present/known NPCs per call and maps them back to rows itself — most LLM-friendly, no DB ids leaked into prompts, cleanly superseded by v12's stable graph node ids. (Rejected: raw `npcs.id` leaks internals; slugs collide like names.)

### 3. `set_location` split → `move_to` + `reveal_location`

- [!] **Coordinate with the *decided* [[per-player-map-exploration]] — it changes the substrate `move_to` sits on.** That rework makes movement **engine-validated against a shared hub-and-spoke graph**: a resolved `move_to`/`set_location` must target a graph-reachable node or a **frontier exit being crossed**, which **closes the "move to any unknown name → lazy-create" hole** this section assumes (`per-player-map-exploration` §2). The verb *rename* is unaffected; the lazy-create *semantics* defer to the map model. Whichever ships first dictates `move_to`'s behaviour.
- [I] **`move_to { location }`** — relocates the character to a **known, reachable** node (verb rename of `set_location`, v11). Lazy-create-on-unknown-name applied **only pre-map-rework**; once [[per-player-map-exploration]] lands, `move_to` is graph-validated and **no longer mints** — minting new ground is `cross_frontier`'s job (above), not `move_to`'s. An illegal `move_to` (unreachable, non-frontier) is rejected.
- [I] **`reveal_location { name, is_safe?, description? }`** — introduces/describes a place on the map **without** moving the character there ("you spot a watchtower on the ridge"). Resolves the v8 overload: knowing a place exists is now distinct from being there.
- [I] Both `move_to` (on a novel name) and `reveal_location` may optionally carry `is_safe`/`description` so a freshly-discovered place isn't always defaulted unsafe + async-guessed.
- [>] **Location provenance — `created_by_action_id` on `locations` — is now OWNED by the *decided* [[per-player-map-exploration]]** (its geography migration adds it alongside `node_tier`/`region`/`emoji`); this spark **cedes** the column there rather than re-proposing it. The rationale below stands as *why* it matters. `npcs` already records which action spawned it (`schema.sql:71` + `idx_npcs_created_by_action`), but `locations` has no such column — a lazily-created place (D3, [[roll-economy-timeouts-and-world-growth]]) loses the action that birthed it. Add a nullable `created_by_action_id INTEGER REFERENCES actions(id)` to `locations` and stamp it when `move_to`/`reveal_location` creates a new row (NULL for the seeded starter map, exactly like seeded NPCs). Pure provenance/data-mining symmetry — it makes "which actions grew the world, and what prompted each new place" queryable, and pairs with the per-player `discovered_from` tree in [[per-player-map-exploration]] (that's *who reached it*; this is *what created it*). Additive guarded migration; no behaviour change.

### 4. A closed `category` enum keys the map (keep `distilled_type` as flavour)

A dictionary cannot be keyed on a free string the LLM invents (`"hunt"` vs `"hunting"` vs `"stalk the boar"` would all miss). So:

- [I] Add a **closed `category` enum** to the decision schema, *alongside* the existing free `distilled_type`. Each field does one job: `category` = machine key (map + telemetry + failure-filter), `distilled_type` = the player-facing flavour label already shown in broadcasts.

The category set, derived from `decision-v9.md` §4 (the old v8 §4a) and rounded out for a normal session, each with a distinct mutation signature:

| `category` | Covers | Signature mutations |
|---|---|---|
| `combat` | fights, encounters | stamina− · health− · loot (`add_item`) · `update_npc`(hostile)/`remove_npc`(slain) |
| `travel` | moving, exploring | **`move_to`** (known node) · **`cross_frontier`** (explore new ground) · stamina− · `add_npc`(met on road) · found item |
| `social` | talk, persuade, barter, intimidate | wealth± · `add_npc`(contact) · `update_npc` · gift/trade items |
| `skill` | train, practice, craft, perform | stamina− · max_stamina+ · rolls+ |
| `search` | scavenge, forage, loot, investigate | `add_item` · stamina− |
| `rest` | recover, sleep, heal | **health+ · stamina+ · rolls+** |
| `other` | catch-all — never blocks a weird action | anything |

- [!] `rest` is the one category whose *expected reward is positive* health/stamina — so its row lists what's expected **on success**. The existing failure-filter (`applyOutcomeToMutations`, `src/engine/action/machine.ts:455`) keys on the **sign** of each delta, *not* on category: it already drops all positive health/stamina/rolls on a failed roll, so a **failed rest already doesn't heal today** with zero category-awareness. The map therefore needs **no** coupling to the filter — do not add category logic to a filter the sign already handles correctly.
- [p] `other` is a deliberate escape hatch so a novel action is never wedged by the enum.

### 5. Soft enforcement — warn + telemetry, always apply

The `category → expected-mutations` map lives in code as the **single source of truth**, and:

- [I] It is **injected into the prompt**, replacing the hand-written recipe prose (v9 §4) so the two cannot drift.
- [I] At runtime, a mutation outside its category's expected set is **flagged "unexpected," logged for data-mining, but still applied**.
- [-] **Not** hard-dropped. D&D is emergent — a `social` turn can erupt into a stabbing, and the LLM then legitimately needs `modify_health`. Hard-dropping would break emergent scenes and largely duplicates the failure-filter.
- [p] Payoff: prompt + filter generated from one definition (no drift) **and** a balancing signal ("the LLM keeps emitting `modify_wealth` on `combat`") without constraining play.

### 5a. Per-category deterministic guards (generalises §5) — added 2026-06-30; scoped 2026-06-30

§5's "unexpected mutation" flag is the **first instance of a broader pattern**: each `category` carries its own set of **deterministic guards** over the resolved decision, because what counts as a malformed result differs by action type. This is the home for the validation ideas surfaced by the dev-DB review in [[polish-v0.2.7]] — folding them here rather than scattering one-off checks.

- [!] **Why it must key off `category`, not a single action type.** An action's type **legitimately evolves across decision steps** — observed in the dev DB: action #24 "Study the key" distilled step 1 → `investigate`/`search`, step 2 → `social` (asked the Warden, then examined). That flip-flop is **correct**, not a bug — a turn can start as a search and become a conversation. So a guard is evaluated against the **step's own `category`** (and the resolution's), never a flattened whole-action label. `distilled_type` stays free-text flavour (§4); the closed `category` enum is the guard key.

The contract every guard shares:

- [I] **Keyed by `category`** — `rest` guards differ from `combat` guards (a `rest` that ends with the player *worse off*, a `combat` with zero stamina/health movement, a `search` that yields nothing yet charges full cost). Plus a small **universal** bucket for shape checks that aren't category-specific (e.g. a decision beat reaching the player with ≤1 real option).
- [!] **Always logs to the DB when tripped** — a structured guard-violation capture (extends the existing `validation_warnings` column / telemetry), so **every break is mineable whether or not we act on it**. This half is non-negotiable: detection is always recorded.
- [I] **Optionally acts** — per guard, one configurable action: **clamp** (rewrite the mutation — e.g. collapse stacked same-axis `modify_stamina` deltas and cap per-turn drain), **flag** (log only, ship as-is — today's §5 default), **bail** (resolve as a refundable no-op back to the player), or **retry** (re-request the decision). Defaulting a new guard to *log-only* lets us turn on enforcement once the telemetry says it's safe.

Evidence already in hand (dev DB — [[polish-v0.2.7]]):

- [c] **Stacked scalar deltas** — action #24 applied `modify_stamina −1` **and** `−2` in one resolution (−3 total) on a *failed* turn. A clamp guard (collapse same-axis deltas, cap per-turn cost) is the lowest-risk first enforcement; this is what the player felt as "3 stamina to look at a key."
- [c] **Degenerate decision shape** — a beat reaching the player with a single real option (the [[polish-v0.2.7]] Bug #2). A universal shape guard → retry-then-bail.

Additional evidence (prod snapshot — warden-2026-06-30):

- [c] **Rule 4b: SUCCESS beats with no reward (the only unresolved validation warning)** — `validation_warnings` in the prod snapshot shows `"resolving turn with only negative stamina/health mutations — SUCCESS must include a reward (prompt rule 4b)"` fired **17 times** across v8, v9, and v10, making it the **sole remaining warning type in v0.2.6** (all 5 warnings in that version trace to this pattern). It fires across combat, social, prayer, and exploration turns regardless of complexity. Guard: on a `success` resolution where every `modify_*` delta is ≤0 and no `add_item` / positive-delta `modify_*` is present → **flag + retry once**, then apply as-is. Exempt: `rest` (its expected mutations on *success* are already `health+ · stamina+` per the category map, so a negative-only rest turn is the *failed-rest* case already handled by the failure-filter; `other` is flag-only, never blocking the catch-all). 17 confirmed misfires across three prompt versions is the clearest per-category tuning signal in the current dataset.
- [c] **Mutations on a DECISION beat (pre-roll side effects)** — the v9 critic flagged this as `major` in 2 of its 3 total major findings (prod calls #392 and #459, 2026-06-28). Both are DECISION beats (`done=false`) carrying a non-empty `mutations[]` array, meaning the world is side-effected before the player makes any choice or dice are thrown. Both also had empty `decision[]` arrays — zero options — so both defects co-occurred: the player could make no choice *and* the world had already changed beneath them. Structural guard (category-agnostic, universal bucket): a beat with `done=false` and non-empty `mutations[]` → **flag + retry once**. The shape guard shipped in `0.2.7` covers ≤1 real option; this is the complementary pre-roll side-effect check. Both are symptoms of the same CONTINUE-phase beat-type confusion.
- [c] **NPC hallucination confirmed in prod — §2a field evidence** — critic major call #440 (2026-06-28) found NPC "Otto" referenced in the outcome text but absent from context (active NPCs: The Warden, Foreman Ivor). The resolve stage invented a name from training data with no handle to validate against; the final mutations also carried an extra −2 stamina not in the authored set. This is the false-split case §2a was designed to prevent: without handle-keyed references, the resolve stage freelances NPC names. The critic's structured `issues[]` confirmed this is a real, fielded defect, not a theoretical one. Cross-reference §2a — the handle contract is load-bearing.

- [>] **Sequencing and scope (scoped 2026-06-30).** The guard *framework* (enum + unexpected-mutation telemetry + stacked-delta clamp) rides the **v11** bump. Of the three specific guards: the **stacked-delta clamp** (guard 1) ships now; the **pre-roll side-effect guard** (guard 2 — DECISION beat with mutations) is implemented as **log-only** in v11 (no retry), with the retry deferred to v12 once telemetry confirms frequency; the **Rule 4b success-no-reward guard** (guard 3) remains **flag-only** (the warning already fires in `validateDecision`) — retry deferred for the same reason. Both deferred retries will re-home naturally under this framework when they ship.

### 6. Forward note → 0.3.0 two-pass prompt (ties to [[prompt-seperation-of-concerns]], the **v12** set)

- [>] Today's soft map is a **stepping stone**. In the larger prompt refactor (v12 thread D — *classify → decide → resolve pipeline*), move to a **two-pass flow**: derive the `category` first, then **dynamically inject only that category's mutation sub-vocabulary** into the second prompt. A smaller, focused mutation menu per call should sharpen adherence and shrink the prompt. The soft map built here becomes the data source that two-pass flow reads from.
- [>] **One classification vocabulary — RESOLVED.** The `category` enum added here (`combat · travel · social · skill · search · rest · other`) **is the seed of v12's Stage-1 classifier `type`**, and [[prompt-seperation-of-concerns]] now standardises on this exact set throughout (its earlier 5-value `fight · travel · trade · talk · other` sketch is retired). v11 ships first, so this enum is canonical; v12 inherits it (and may extend), never forks a parallel taxonomy.

---

## Implementation touch-points

**Handle resolution approach (decided 2026-06-30):** `update_npc`/`remove_npc` handles are resolved to `npcId: number` inside `DeepseekLlmGateway` at parse time (using `ctx.nearbyNpcs` with id), so the engine sees resolved ids — it never handles raw `[N1]` tokens. `nearbyNpcs` gains an `id` field throughout the chain.

**`reveal_location` approach (decided 2026-06-30):** `{ name, is_safe?, description?, direction? }` — authors a frontier exit (`to_location=NULL`) at the character's current location. `direction` is optional; if omitted, the engine auto-assigns from the first unused cardinal/ordinal at that node. Does NOT create a location row upfront (the destination row is minted when `cross_frontier` binds it, as normal). Does NOT move the character.

**Guard scope (decided 2026-06-30):** stacked-delta clamp ships now; pre-roll side-effect and Rule 4b guards are **log-only** in v11 (retries deferred to v12 — see §5a).

| Task | Status | File(s) |
|---|---|---|
| T1 · Types — extend `WorldMutation`, `LlmDecision`, `LlmContext`, `WorldContextResolver` | [x] | `WorldEngine.ts`, `LlmGateway.ts`, `machine.ts` |
| T2 · DB migration — `npcs.home_location TEXT` | [x] | `src/db/migrations/202606300001_npc_home_location.ts` |
| T3 · `mutations.ts` — rename + new types + stacked-delta guard | [x] | `src/engine/action/mutations.ts` |
| T4 · `prompt-builder.ts` — NPC handles + category map injection | [x] | `src/llm/prompt-builder.ts` |
| T5 · `DeepseekLlmGateway.ts` — parse category + resolve handles + pre-roll guard (log) | [x] | `src/llm/DeepseekLlmGateway.ts` |
| T6 · `WorldEngineImpl.ts` — resolver id + apply new mutations + collision detection + `reveal_location` frontier | [x] | `src/engine/WorldEngineImpl.ts` |
| T7 · `machine.ts` — failure-filter rename + stacked-delta integration | [x] | `src/engine/action/machine.ts` |
| T8 · `decision-v11.md` + `PROMPT_VERSION` bump | [x] | `assets/prompts/decision-v11.md`, `src/llm/prompt-builder.ts` |
| T9 · Tests — mutations, handles, guards, collision, reveal_location, category | [x] | `tests/` |

## Resolved questions

- [>] **Prompt-version numbering — RESOLVED:** ships as `decision-v11` (after the map doc's `decision-v10`); the pipeline set is `v12` (see the resolved note under "What this is").
- [>] **NPC identity resolution — DECIDED (§2a):** handle-based references via **ephemeral per-prompt `[N1]` tags**, `add_npc` create-only (never auto-merged), deterministic name+location collision *detection* → warn + telemetry, **add `home_location`** (defer `tags`); fuzzy/alias resolution and any dedicated resolver LLM stage deferred to v12 (the handle contract is the stepping stone).
- [>] **`reveal_location` reachability — ANSWERED by the *decided* [[per-player-map-exploration]].** Under the shared hub-and-spoke graph a revealed-but-unvisited place **is a frontier exit** — a `location_edges` row with `to_location IS NULL` (direction + teaser), known to a player who has no `character_locations` (fog-of-war) entry for it. It is therefore **not a reachable node**: crossing the exit is what *mints and binds* the destination. So "revealed" is structurally distinct from "visited" (teaser vs charted node) and from "reachable" (you must cross to arrive). → **Implementation (decided 2026-06-30):** `reveal_location` authors a frontier exit (`location_edges` row, `to_location IS NULL`) at the character's current location. `direction` is optional in the mutation; if absent, the engine auto-assigns from unused cardinals. No location row is pre-created — the row is minted at `cross_frontier` time as normal.

## Out of scope

- [-] NPC disposition / relationships / reputation — deferred to 0.3.0 social work (§2).
- [-] Status effects / conditions with durations (poisoned, blessed, exhausted) — a separate, larger expansion; not part of this cleanup.
- [-] Quest/story flags, location state changes (cleared/burned), knowledge/journal — noted as future expressiveness, not this spark.
- [-] Any change to the scalar `modify_*` family — it is the clean core.
