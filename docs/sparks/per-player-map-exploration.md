---
title: Per-Player Map & Exploration — Discovery Tree, /map View, Visited-Set Tracking
status: spark
domain: spark
phase: mvp
tags: [map, exploration, locations, ui, per-player, fog-of-war, discovery]
related:
  - "[[world-setting]]"
  - "[[mvp+world-state-projection]]"
  - "[[daily-work-teleport]]"
  - "[[roll-economy-timeouts-and-world-growth]]"
  - "[[mutation-vocabulary-refinement]]"
---
---

start here

---

## What this is

A player-facing **map view** backed by the missing primitive it depends on: **per-player location tracking**. Today the world knows exactly one thing about a player's whereabouts — their single *current* location string — and `KNOWN LOCATIONS` (in both the LLM prompt and `/journal`) is the entire world, identical for everyone. There is no record of where a given player has *been*. This spark adds a per-player visited set, renders it as a **Discovery Tree** under a new `/map` command, and corrects `/journal`'s global leak.

Proposed as a near-term `0.2.x` increment. It is **presentation + a new table**; it deliberately does **not** build an adjacency graph and does **not** change what the LLM sees.

## The gap (current state)

- [!] **No per-player exploration state.** `player_characters.location` (`src/db/schema.sql:25`) is a single current-location string. There is no visited/discovered set, no history, no fog-of-war.
- [!] **`KNOWN LOCATIONS` is global.** Built from `locationRepo.findAll()` (`src/llm/prompt-builder.ts:74`, `src/engine/WorldEngineImpl.ts:389`) — every player's prompt sees every place.
- [!] **`/journal` leaks the whole world.** `getJournal` returns all locations world-wide (`src/engine/WorldEngineImpl.ts:896`) regardless of who is asking — a per-player feature showing global data.
- [c] **No adjacency.** Locations are a flat list (`src/db/schema.sql:104`): `name`, `description`, `tags`, `is_safe`, `enrichment_pending`. No edges, coordinates, or regions. `set_location` teleports to any known place instantly; distance/connectivity was explicitly deferred to MVP in [[roll-economy-timeouts-and-world-growth]] (D3).
- [p] **What works and is reused.** Lazy location creation + async cartographer enrichment (`WorldEngineImpl.ts:557`); NPCs already carry a `location` (`schema.sql:60`); `getNearbyEntities` (`WorldEngineImpl.ts:840`) lists who's at a place.

---

## Decisions

### 1. The primitive — a per-player visited set

A new table records, per character, every place they've set foot and where they first came from:

```sql
CREATE TABLE IF NOT EXISTS character_locations (
  character_id      INTEGER NOT NULL REFERENCES player_characters(id),
  location_name     TEXT    NOT NULL,           -- matches locations.name
  discovered_from   TEXT,                        -- the location they stood in on first arrival; NULL for the root (the Oak)
  first_visited_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  last_visited_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (character_id, location_name)
);
```

- [x] `discovered_from` is written **once**, on first arrival — making the per-player graph a **tree** (one parent per node, root = the Oak, no cycles).
- [x] It is **per-player** by nature: you and I may both reach Wolf Hollow, but from different parents.
- [I] `last_visited_at` is cheap to maintain and lets the view sort/age places ("last seen 3 days ago") later; not required for v1 render.

### 2. The view — a Discovery Tree under `/map`

A new `/map` command renders the character's visited set as a hub-and-spoke tree rooted at the Oak, with the current position marked:

```
🗺️  Kael's Map — 7 places charted

The Warden's Oak  ◀ you are here
├─ The Dark Pines      — met Nikolai
│   └─ Wolf Hollow
├─ Riverside Inn
└─ Black Fen
    └─ The Sunken Road
```

- [x] **Pure fog of war.** Only places the player has visited appear. Undiscovered places are simply absent.
- [x] **Soft progress line** — "N places charted." A **count only**: the world grows lazily, so there is no fixed total to show a fraction against, and we never leak places the player hasn't found.
- [-] We **cannot** tease specific undiscovered neighbours ("a path leads north to ???") — that requires adjacency we don't have. Don't fake it.
- [I] Annotate a node with NPCs met there (from `npcRepo.findByLocation`, scoped to NPCs this character has encountered) and a `🔥`/`🌲` safe-vs-wild glyph from `is_safe`.
- [c] Discord message length + mobile width cap the tree; deep/wide trees must clip gracefully (collapse or paginate). Define the clip rule at build time.

### 3. Fix `/journal`'s global leak

- [x] Scope `/journal`'s location section to the **per-player visited set** (the same source `/map` uses), so it stops showing every player the entire world. `/map` is the rich spatial view; `/journal` keeps its "story so far" framing (NPCs met, recent actions) but its places become *yours*.

### 4. Write paths — what records a visit

Every way a character's location changes must upsert into `character_locations` (insert on first visit with `discovered_from` = prior location; else bump `last_visited_at`):

- [ ] **Engine movement** — where `set_location`/`move_to` is applied (`WorldEngineImpl.ts:433`). The prior `row.location` is the `discovered_from`.
- [ ] **Daily-work teleport** — handled in the Discord layer outside the engine (`src/index.ts`, per [[daily-work-teleport]]); it bypasses `startAction`, so it must record the visit too (`discovered_from` = the Oak).
- [ ] **Onboarding** — `/join` seeds the root row: the Oak, `discovered_from = NULL`.

### 5. Migration — backfill from action history (best-effort)

A one-time migration reconstructs existing players' trees by scraping `actions`:

- [x] `actions.applied_mutations` (TEXT JSON, added in `src/db/migrations/202606171200_action_applied_mutations.ts`) records `set_location` destinations; rows are ordered by `created_at`.
- [x] Per character, walk actions oldest-first carrying a "current location" cursor seeded at the Oak. On each `set_location`, upsert the destination with `discovered_from` = the cursor, then advance the cursor.
- [x] Always insert the character's **present** `player_characters.location` (in case the scrape missed it) and the Oak root.
- [!] **Best-effort, not exact.** Rows predating `applied_mutations`, or movement that happened via teleport (not in mutations), yield an approximate tree — some places may parent to the Oak by default. Acceptable: the tree self-corrects going forward as new visits are recorded. State this limitation in the migration's comment.

---

## Implementation touch-points

- [ ] `src/db/schema.sql` + a new `src/db/migrations/<ts>_character_locations.ts` (create table + backfill scrape).
- [ ] `src/db/repositories/` — a `characterLocation` repo: `recordVisit(characterId, name, from)`, `findByCharacter(characterId)`.
- [ ] `src/engine/WorldEngineImpl.ts` — call `recordVisit` on location change in `applyResolution`; scope `getJournal` to the per-player set; expose a `getDiscoveredLocations(characterId)` for the view.
- [ ] `src/index.ts` — record the visit on the daily-work teleport path.
- [ ] `src/discord/commands/map.ts` (new) — build + render the tree; register the command. Tree-render + clip helper (unit-testable, pure).
- [ ] `src/discord/commands/journal.ts` (or wherever `/journal` renders) — switch its location section to the per-player set.
- [ ] Tests — visited-set upsert (first vs repeat), tree builder (root, branching, clip), migration scrape over a fixture action log, `/journal` per-player scoping.

## Scope boundaries

- [-] **No adjacency graph / edges / regions / travel cost.** Stays deferred (D3). The tree's structure comes from per-player `discovered_from`, not a world graph.
- [-] **No change to the LLM's `KNOWN LOCATIONS`.** It stays global on purpose (anti-dupe name reuse). The map is a presentation layer over a per-player table — this sidesteps the per-player-vs-name-reuse tension entirely.
- [-] **No fabricated spatial coordinates / rendered world map.** A coordinate map would imply a structure that doesn't exist and would churn as the world grows.
- [<] **`reveal_location`** (from [[mutation-vocabulary-refinement]]) would let a place be *known* without being *visited* — a natural future "rumoured, uncharted" leaf on the tree. Out of scope here; noted as the clean interaction point if that spark lands.

## Open questions

- [?] **Tree clip rule** — when the tree exceeds Discord/mobile limits, collapse deepest branches, paginate, or summarise ("+4 more places")? Pick at build time.
- [?] **Node annotations** — how much to show per node (NPCs met, safe/wild glyph, last-visited age) before it gets noisy on mobile.
- [?] **Backfill `discovered_from` fidelity** — accept the Oak-default approximation for un-scrapeable history, or attempt a richer reconstruction from `llm_request` prose (fragile)? Recommend the simple approximation.

---

footer
