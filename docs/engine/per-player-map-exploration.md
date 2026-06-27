---
title: Map & Exploration — Shared Hub-and-Spoke Geography, Deterministic Travel & Fog-of-War /map
status: decided
domain: engine
phase: poc
tags: [map, exploration, locations, travel, geography, graph, hub-and-spoke, ui, fog-of-war, stamina, cartographer]
related:
  - "[[world-setting]]"
  - "[[daily-work-teleport]]"
  - "[[roll-economy-timeouts-and-world-growth]]"
  - "[[prompt-v12-scaling-and-pipeline]]"
  - "[[mvp-llm-prompt-architecture]]"
  - "[[mutation-vocabulary-refinement]]"
  - "[[mvp-data-model]]"
  - "[[mvp+world-state-projection]]"
---
---

start here

---

## What this is

A reworking that pulls the world-setting's original ambition — *"the graph DB stores all location nodes and their connections… the Oak always reachable within 1–2 travel rolls"* ([[world-setting]]) — **forward into the POC**. The first cut of this spark was deliberately timid: a per-player **Discovery Tree** whose shape was *visit-order history*, not geography. Two players who both reached Wolf Hollow — one via the Pines, one via the Fen — saw two different "maps" of the same world, and the tree could never tease an unexplored road because there was no adjacency to tease from. It was a breadcrumb log wearing a map's clothes.

This rework makes the world **one shared, coherent place** that **governs movement** (full Tier 2), while staying **monospace-text friendly** for Discord. The spine:

- [I] A **shared hub-and-spoke graph** rooted at the Oak — real connections, identical for everyone, fog-of-war masked per player.
- [I] **Deterministic, engine-owned routing** — the engine validates movement against the graph (a `set_location` must be reachable). Engine-*charged* travel stamina (`Σ difficulty`) is the intended end-state but is **deferred to fast-travel** (§9); the POC build wires routing/validation only, and travel stamina stays LLM-authored for now.
- [I] **A frontier that pulls outward** — pre-seeded "unexplored exits" (direction + teaser) are the invitation; crossing one mints the place on the far side, shared thereafter.
- [I] **`/map`** renders your discovered subgraph (paginated, region/hub drill-in); **`/journal`** becomes a true chronicle of recent actions and where you did them.

**Scope stance — Path 2 (decided with Werner).** Build the **deterministic, engine-owned foundation now** (`0.2.x`): the geography data model, routing, stamina, edge-validated `set_location`, the local-exits prompt, `/map`, `/journal`. **Defer the LLM-pipeline elegance to `0.3.0`/v12** ([[prompt-v12-scaling-and-pipeline]] Thread D): the classify→decide→resolve split and the dedicated *resolve* LLM slot *on top of* an engine that is already geographic. None of the foundation is throwaway — v12 plugs its `travel` per-type template into these same tables. This is forward-compatible with v12, not rivalrous.

## The gap (why rework)

- [!] **The old tree wasn't a place.** Structure came from each player's `discovered_from` parent — private, visit-order-dependent, incoherent across players. Geography must be *shared truth*, not a personal log.
- [!] **No frontier, so nothing pulled you anywhere.** Pure "only what you've visited" fog-of-war can't show "a road runs north, uncharted" — there was no adjacency to hang it on. Exploration had no goal.
- [!] **No regions, so the world read as a list, not a land.** Scattered nodes, no grouping, no sense of "the home Vale vs. the Ashen Reach."
- [c] **`set_location` still teleports anywhere.** Per [[roll-economy-timeouts-and-world-growth]] D3 the resolution path omits `knownLocations`, so the unknown-location guard is inactive and movement is unconstrained. Tier 2 closes this in the engine.
- [p] **What's reused.** Lazy location creation + the **async cartographer** enrichment call (D3) already exists — we *grow its job*, not add a new agent. `locations.name` is `UNIQUE`; the whole schema keys locations by **name** (`player_characters.location`, `npcs.location` are TEXT). The roll-first split (`machine.resolveWithRoll`) and `applied_mutations` provenance are intact.

---

## 1. The data model — a shared, tiered, edge-connected world

### Node tiers

A new **`node_tier`** column on `locations` (named to avoid the existing retry-`tier` on the action/LLM path):

- [I] `0` — **The Warden's Oak**, the singular super-hub / tree root. *"Central to the game"* (Werner).
- [I] `1` — **district hubs**: the Town, the Eastern Town, the Caves, the Deep Woods. The only tier that is **capped + mostly hand-seeded**; new tier-1 hubs are minted *only* by crossing the three seeded exploration spokes.
- [I] `2` — **leaf locations**: the Forge, the Library, Town Square, specific glades/caverns. Where lazy growth happens.

### Edges — a new shared `location_edges` table

```sql
CREATE TABLE IF NOT EXISTS location_edges (
  from_location        TEXT    NOT NULL,           -- locations.name
  to_location          TEXT,                        -- NULL = unexplored frontier exit (dangling)
  direction            TEXT    NOT NULL,            -- canonical cardinal: N/S/E/W/NE/...
  flavour              TEXT,                         -- "downriver", "into the dark" (nullable prose hint)
  teaser               TEXT,                         -- frontier vibe shown before crossing
  difficulty           INTEGER NOT NULL DEFAULT 1,  -- terrain band: 1 road · 2 trail/wild · 3 harsh/ridge
  distance             INTEGER NOT NULL DEFAULT 1,  -- DORMANT placeholder; reserved for the time mechanic (see §7)
  created_by_action_id INTEGER,                      -- provenance; NULL for hand-seeded edges
  PRIMARY KEY (from_location, direction)
);
```

- [I] **Shared, not per-player.** The world is one coherent place; everyone agrees A connects to B.
- [I] **Direction is cardinal + optional flavour.** The canonical cardinal keeps the render and the LLM consistent; the prose `flavour` keeps it from feeling like a chessboard.
- [!] **`difficulty` is the geography biting.** It is the **edge weight in the stamina formula** (§2) — terrain, not hop-count, is what costs you. It is a property of the *edge*, not of `manner` (a ridge is hard whether you walk or ride). **Three bands** (`1/2/3`) — they map 1:1 to the `/map` effort glyphs (§5).
- [I] **A frontier exit is a row with `to_location IS NULL`** (direction + teaser, no node yet). Crossing it binds the destination and seeds *its* onward frontier (§3).
- [<] **`distance` is a dormant placeholder** (default `1`, unused now). It only becomes a mechanic alongside time-tracking — see §7.

### Region & emoji on `locations`

- [I] **`region TEXT`** — a flat label ("The Vale", "The Ashen Reach"), cartographer-assigned. Pure grouping that makes the map read as a *land*.
- [I] **`emoji TEXT`** — deduced by the cartographer from name + description + tags (seed/home locations hand-assigned); fallback `📍`. Drives the first glyph on every `/map` line.
- [I] **`created_by_action_id INTEGER`** on `locations` too — provenance for which action spawned a place (`NULL` for hand-seeded). The action row already carries `character_id` + `prompt_version`, so action-id alone traces *who/when/which-prompt*.

### Per-player discovery — `character_locations` (fog-of-war mask)

```sql
CREATE TABLE IF NOT EXISTS character_locations (
  character_id     INTEGER NOT NULL REFERENCES player_characters(id),
  location_name    TEXT    NOT NULL,                 -- matches locations.name
  first_visited_at TEXT    NOT NULL DEFAULT (datetime('now')),
  last_visited_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (character_id, location_name)
);
```

- [!] **It's a mask over a shared graph, not a private tree.** The old `discovered_from` parent is gone — the real parent lives on the shared `location_edges`. Two players' `/map`s now agree about *where things are*; they differ only in *how much each has uncovered*.
- [I] **`last_visited_at` drives the render's recency ordering** (§5 clip rule) and lets the view age places later — not just bookkeeping.
- [I] Every new player is **seeded with the entire home cluster** as already-discovered (§3) — nobody "discovers" their own workplace.

---

## 2. Travel mechanics — deterministic, engine-owned

- [I] **Named-destination routing is the primary travel verb.** You say *where* you want to go; the engine computes the least-cost path over the shared graph (Dijkstra on `difficulty` weights — trivial at this node count) and moves the character. **One action, one roll** regardless of hops (a roll is the price of a resolved world-changing action, not per-hop — consistent with [[roll-economy-timeouts-and-world-growth]] D1).
- [<] **Stamina = `Σ(edge difficulty)` is the intended model — DEFERRED, not wired in the POC build.** Oak→Town→Blacksmith *would* be `1 + 1 = 2`; an Oak→Town→ridge-shrine trip `1 + 3 = 4`. The engine computes the route cost but does **not** charge it yet — travel stamina stays LLM-authored (the travel recipe's `modify_stamina`), and `difficulty` is shown on `/map`/`/look` as terrain-demand flavour only. Automatic engine-charged travel cost (the "engine owns the cheatable truth" thesis) lands with **fast-travel** (§9), where routing-to-any-visited makes a deterministic cost essential.
- [I] **Frontier crossing is the exploration verb** — one hop down a dangling exit, minting the destination via the cartographer. This is the *only* way tier-1 hubs and new ground are born.
- [!] **`set_location` validation moves into the engine.** A resolved `set_location` must be either (a) a node reachable on the shared graph from the current location, or (b) the bound destination of a frontier exit being crossed. Anything else is rejected/retried — closing the D3 "accept unknown location" hole. **This is built** (it's the reachability use of the route, independent of the deferred stamina charge).
- [<] **Stamina exhaustion refusing the trip** — declining a route that costs more than the player has — ships with the deferred travel-stamina charge (fast-travel, §9), since there's no engine-charged cost to compare against until then.
- [-] **Fast-travel-to-any-visited is out of scope** — deferred as its own action/command (§9). For now *all* travel routes from the current position, so distance always costs honestly.

---

## 3. Seed topology — the home Vale + three spokes

- [I] **The home cluster is pre-discovered for everyone.** Every new player starts already knowing the whole town around the Oak — Town Square, the Forge, the Library, the Weary Lantern Inn, the Shrine, the Forest Edge (the daily-work destinations of [[daily-work-teleport]]) — all interconnected as short spokes off the Oak, region `"The Vale"`. This is shared common ground.
- [I] **The Oak is the hub.** Town locations are tier-2 short spokes off it; the geography is essentially a **shared tree** — which is *why the original tree render survives*, now over real shared geography.
- [I] **Three named frontier exits radiate from the home cluster** toward **the caves**, **the eastern town**, and **the deep woods**. Unlike deeper teasers these three are *named* — local lore everyone's heard of, even if uncharted. Places minted *beyond* them stay **unnamed until first crossing** (we never commit a name nobody's seen).
- [!] **First-crosser mints; shared thereafter.** Because a frontier exit lives on the shared node, the first player to cross it creates the destination and binds `to_location`; everyone who crosses the same exit afterwards arrives at the **same** charted place. One mechanism delivers both coherence *and* frontier.

---

## 4. LLM roles & prompt changes (kept lean — Path 2)

| Role | Owns | Status |
|---|---|---|
| **Cartographer** (async, exists from D3) | new-place metadata from **constrained menus**: `region` (reuse-or-new), `parent_hub` (pick from enumerated hubs), `node_tier`, each edge's `direction` + `difficulty`, `emoji`, and **1–3 onward frontier teasers** | extend it |
| **Decision LLM** (exists) | narrate, offer travel **only along the current node's exits**, author non-travel mutations | constrain it |
| **Resolve LLM** | mutations + outcome text from a structured verdict | **deferred → v12 Thread D** |
| **Engine** (deterministic) | `set_location` edge-validation, graph routing, roll economy, spoke cap (travel **stamina math** deferred → fast-travel, §9) | now |

- [I] **Decision prompt swaps global `KNOWN LOCATIONS` for a local "here + exits" block** — current node (name, region, safe/wild), discovered neighbours (legal move targets), and frontier exits (direction + teaser). This is the change the old spark explicitly *avoided*; Tier 2 needs it because movement is now geographic.
- [I] **Dedup moves to the cartographer.** The global list existed for anti-dupe name reuse (D3); since the decision LLM no longer sees it, the **cartographer** inherits dedup — handed the known names (especially same-region siblings) and told to reuse rather than coin a near-dupe. `name UNIQUE` + normalized-match remains the hard backstop.
- [!] **Structure is code-enforced, not LLM-trusted.** The two things an LLM does *badly* are pinned in code: (a) the **parent-hub classification** is a pick from an enumerated list, defaulting to the current hub if unsure — never free-form "infer the hierarchy"; (b) the **spoke cap is 5** — a tier-1 hub past 5 tier-2 leaves stops accepting children; further intent reuses the nearest existing leaf or routes to a frontier exit. The prompt *encourages* reuse; the engine *enforces* the ceiling.
- [>] **`manner` (walk/run/ride) is not modelled in the foundation at all** — introduced and owned by v12's Stage-1 classifier, when time-tracking gives it a payoff (§7). The `/map` effort glyph is *terrain demand*, not a manner choice, so it stands alone now.

---

## 5. The `/map` render — fog-of-war over shared geography

Your discovered subgraph, rendered as an indented hub-and-spoke tree, grouped by **region**, with **frontier exits** as the hook.

- [I] **Per-line emoji order: `[location] [safe/unsafe] [effort] Name`.**
  - **location emoji** from the new `locations.emoji` column.
  - **safe/unsafe toggle** — `🛡️` safe · `⚠️` wild (from `is_safe`).
  - **effort** — from the *incoming edge's `difficulty`*, 1:1: `🚶` road (1) · `🏃` trail/wild (2) · `🧗` harsh/ridge (3); omitted on the home root. This is the land's *demand*, distinct from the player's *manner* choice (which the foundation doesn't model).
- [I] **Named frontier exits surface as goals** under a "roads not yet walked" section, so a brand-new player sees the eastern town / caves / deep woods as destinations from day one. Deeper teasers sit inline under their parent node as `↳ <dir> <teaser> ???`.
- [I] **Progress line is a count, never a fraction** — "N charted · M roads into the unknown." The world has no fixed total, and we never leak unfound places.
- [!] **Pagination + region/hub drill-in is first-class.** Default `/map` shows the Vale + your current region + uncharted roads; `/map <region|hub>` drills in. Clip rule: render breadth-first by region; **within a node, siblings render most-recently-visited first (`last_visited_at`)** and the tail past the cap collapses into `└─ … +K more (/map <hub>)`; paginate by region if the whole thing still overflows Discord's ~2000-char cap. Deterministic, testable, **no silent truncation**.

```
🗺️ Kael's Map — 9 charted · 3 roads into the unknown
The Vale · /map reach → the Ashen Reach

── THE VALE (home) ──────────────
🌳🛡️ The Warden's Oak   ◀ you are here
├─ 🏛️🛡️🚶 Town Square
│   ├─ 🔥🛡️🚶 The Town Forge
│   └─ 🍺🛡️🚶 The Weary Lantern Inn
├─ 📚🛡️🚶 The Warden's Library
├─ ⛪🛡️🚶 The Shrine of the First Flame
└─ 🌲⚠️🏃 The Forest Edge
      ↳ N  a deer trail deeper in…   ???

── ROADS NOT YET WALKED ─────────
🧭 E  the road to the eastern town   ???
🧭 ↓  caves breathe cold air below   ???
```

- [-] **NPC node annotations are dropped for now** — a later polish.
- [<] **Cross-links** (rare non-tree edges between two spokes) render as a `↔ also reaches X` note; rare enough in hub-and-spoke that they won't dominate.

---

## 6. `/journal` — a chronicle, not a location list

- [!] **`/journal` drops the visited-locations list entirely.** That's `/map`'s job now — no scoping gymnastics, no global leak, no duplication. **`/map` owns space; `/journal` owns time.**
- [I] **Add `actions.location_name TEXT`**, stamped at **action start** (the place you were standing when you acted). One deterministic write on the existing action-creation path; doubles as data-mining provenance.
- [I] **Snapshot, not FK — deliberate.** `actions` is an audit table (note its `app_version`/`prompt_version` snapshot columns) and the whole schema keys locations by **name**. A stored `location_name` preserves what you did, where, *as it was called then* — an FK would silently rewrite history on a rename/merge. (Normalising all location refs to FK ids is logged as future tech-debt in root `TODO.md` — a holistic refactor, not a lone divergence here.)
- [I] **`/journal` becomes a true chronicle** — recent actions, each tagged with the location it happened in (join to `locations` for the emoji at render time):

```
📖 Kael's Journal

🌳 The Warden's Oak   · set out east on the old road
🐺 Wolf Hollow        · drove off a starving wolf  ✓
🪨 The Sunken Road     · searched the broken shrine  ✗
```

- [I] Travel is the one case where start-location ≠ end-location; recording the **origin** reads naturally ("from the Oak, set out east") and the narrative text carries the destination.

---

## 7. Deferred to `0.3.0`+ (documented, not built) — the time/manner triad

- [<] **`distance` + `manner` + time become a real mechanic together.** Once in-game time is tracked, introduce `time = Σ(distance) ÷ manner_speed`; *then* `manner` becomes a genuine **stamina↔time trade** — run = arrive sooner, pay more stamina (and on `difficulty`≥wild edges, more risk); ride = sooner *and* cheaper, but needs a mount.
- [!] **They are inseparable and gated on time-tracking.** Shipping `manner` cost now (running drains more stamina) with no time payoff makes running a dominated choice nobody picks. So `distance` ships as a dormant column, `manner` is left to v12's classifier entirely, and the trade lands when time does.

---

## 8. Implementation touch-points

- [ ] `src/db/schema.sql` + one additive, guarded `src/db/migrations/<ts>_geography.ts`: `node_tier`/`region`/`emoji`/`created_by_action_id` on `locations`; new `location_edges`; new `character_locations`; `location_name` on `actions`.
- [ ] **Backfill in three confidence tiers** (same migration):
  - [I] **Home cluster — exact, hand-authored** (deterministic, no LLM): set `node_tier`/`region`/`emoji` on the fixed seed locations, wire their edges to the Oak, seed the three named frontier exits.
  - [I] **Off-map D3 locations — best-effort:** `node_tier = 2`, `emoji = 📍`, edges **scraped from `actions.applied_mutations`** (walk each character's `set_location` history oldest-first, union all transitions into the *shared* graph; direction `unknown`, `difficulty = 1`); parent the unattachable to the nearest wild hub else the Oak; then set `enrichment_pending = 1` so the **existing cartographer path** fills `region`/`emoji`/proper tier on next visit (reuse D3, no migration-time LLM pass).
  - [I] **Per-player discovery:** seed every character with the full home cluster + their present `player_characters.location` + the scraped visited set.
  - [!] **Honest caveat (state it in the migration comment):** the home spine is exact; off-map edges/regions are approximate and **self-correct going forward** as real visits record real direction/difficulty.
- [ ] `src/db/repositories/` — a `locationEdge` repo (`neighbours(name)`, `frontierExits(name)`, `recordEdge`, `bindFrontier`) and a `characterLocation` repo (`recordVisit`, `findByCharacter`); extend `locationRepo` for the new columns.
- [ ] `src/engine/WorldEngineImpl.ts` — graph routing + stamina (`Σ difficulty`), `set_location` edge-validation, frontier-crossing mint, spoke-cap enforcement, `recordVisit` on location change, stamp `actions.location_name`, expose `getDiscoveredGraph(characterId)` for the view.
- [ ] `src/llm/prompt-builder.ts` — swap global `KNOWN LOCATIONS` for the local "here + exits" block; bump `PROMPT_VERSION` to **`decision-v10`** (the first of the two `0.2.x` bumps; per `AGENTS.md`: new `decision-v10.md` + mirror to `current_source.md`). The vocabulary cleanup ([[mutation-vocabulary-refinement]]) is the second bump, `decision-v11`.
- [ ] **Cartographer prompt/schema** — extend its structured output with `region`/`parent_hub`/`node_tier`/`emoji`/edge `direction`+`difficulty`/frontier teasers, all constrained; the engine validates + writes the geometry.
- [ ] `src/index.ts` — record the visit (`recordVisit`) on the daily-work teleport path; it targets a home-cluster node already wired by the seed, so no new edge is minted — already a non-engine path per [[daily-work-teleport]].
- [ ] `src/discord/commands/map.ts` (new) — build + render the paginated, region/hub-drill-in tree; pure, unit-testable tree-render + clip helper.
- [ ] `src/discord/commands/journal.ts` — drop the location list; render recent actions + `location_name` + emoji.
- [ ] Tests — routing + stamina (`Σ difficulty`, exhaustion refusal), `set_location` validation (reachable / frontier / rejected), frontier mint + shared-rebind, tree-render + clip (recency order), migration backfill over a fixture action log, `/journal` chronicle.

## 9. Scope boundaries

- [-] **No full travel-cost economy beyond `Σ difficulty`.** Pathfinding is Dijkstra over the small node set; no fuel/provisions model.
- [>] **Pipeline split (classify→decide→resolve) + the resolve LLM** → [[prompt-v12-scaling-and-pipeline]] Thread D. The geography slots under v12's future `travel` template.
- [>] **Travel-risk DC** (a real mishap roll on harsh edges, feeding off `difficulty`) → v12 Thread B ("danger is geographic").
- [<] **`manner`/`distance`/time trade** → §7, gated on time-tracking; owned by v12.
- [<] **A 4th "gated/blocked" difficulty band** — an edge impassable without a required item (a key, climbing gear, a guide). Cool, but MVP territory, and **links cleanly to an items refactor** — defer until items can gate traversal.
- [<] **Fast-travel-to-any-visited + engine-charged travel stamina** → its own action/command later. The POC ships routing/reachability only; the route's `Σ(edge difficulty)` **cost is computed but not charged**. Automatic engine-owned travel stamina (and the "too far in your state" exhaustion refusal) rides in with fast-travel, where routing to any visited node — not just an adjacent hop — makes a deterministic, non-LLM cost essential (and closes the "phrase travel to dodge the stamina hit" hole). Until then travel stamina is LLM-authored via `modify_stamina`, and `difficulty` is purely the immersive terrain-demand glyph on `/map`/`/look`.
- [<] **`reveal_location`** ([[mutation-vocabulary-refinement]]) — a *rumoured, uncharted* leaf known without being visited, plus the rumour/treasure carrot → v12 Thread B. Clean interaction point: a frontier exit whose teaser is authored by a rumour rather than seeded.
- [-] **NPC `/map` annotations**, cross-link-heavy rendering, and the `actions`→FK location normalisation (root `TODO.md`) — all later.

## Open questions

- [I] None blocking — the build-time calls are settled: **spoke cap = 5**, **3 difficulty bands**, **clip orders by most-recently-visited**, **`manner` deferred to v12**. Revisit the spoke cap and band thresholds on prod data once the map ships.

---

footer
