---
title: Edge Bearing Inversion & Region Reconciliation
status: decided
domain: engine
phase: poc
tags:
  - decision
  - engine
  - map
  - geography
related:
  - "[[per-player-map-exploration]]"
  - "[[polish-pass-follow]]"
---

# Edge Bearing Inversion & Region Reconciliation

> Edges are stored once (parent → child, one canonical direction). A node on the `to` side currently sees its neighbour in the wrong direction on `/look`. Separately, nodes whose cartographer enrichment is absent or predates the current region logic land in "Elsewhere" on `/map` regardless of where they sit on the graph. Both are render-level fixes with no migration.

---

## Context

**Bearing inversion.** `location_edges` stores one row per connection: `(from_location, direction, to_location)`. The `neighbours()` query unions both directions to return all adjacent nodes:

```sql
SELECT to_location AS name, direction …  WHERE from_location = @name  -- forward
UNION ALL
SELECT from_location AS name, direction … WHERE to_location = @name    -- reverse
```

The reverse arm returns the *stored* direction (the heading as seen from the `from` side), not the heading as seen from the queried node. Standing at Eastvale, a road that arrives from Old Watchtower via "NE" renders as "NE" — but from Eastvale the road leaves **SW**. `map-render.ts:renderNodeFocus()` already applies `oppositeDirection()` on the `to` side correctly (line 117); the bug is that `neighbours()` returns the raw stored direction, so `/look` and the decision-prompt context are inconsistent with `/map`.

**Region placement.** Nodes minted via `cross_frontier` get their `region` populated by the async cartographer (with a `fromRegion || HOME_REGION` fallback). Any node whose enrichment failed or predates the current cartographer region logic has `region = null`. The `/map` renderer groups by `n.region ?? "Elsewhere"`, so unenriched nodes land in a catch-all "Elsewhere" bucket regardless of where they actually sit in the BFS tree — a place clearly reachable via a charted path from The Vale still files under "Elsewhere."

---

## Options

### Bearing inversion

**A — Render-time inversion (chosen):** Add an `is_reverse` integer column to the `neighbours()` query, then apply `oppositeDirection()` in TypeScript before returning. No schema change, no migration. Consistent with the pattern already used in `map-render.ts`.

**B — Stored bidirectional:** Add a `reverse_direction` column to `location_edges`, or store two rows per connection. Requires a migration, complicates `recordEdge` / `bindFrontier`, and adds redundancy the graph doesn't need — edges already represent undirected connections.

### Region reconciliation

**A — BFS parent fallback in render (chosen):** `renderMap()` already builds a BFS tree (`buildTree()`). When grouping nodes by region, any node with `region = null` walks up `tree.parent` until it finds a non-null region, then uses that. No migration; handles past legacy rows and any future enrichment failures automatically.

**B — Cartographer fix only:** The cartographer already sets `region` with a `fromRegion || HOME_REGION` fallback, so future nodes are covered. But historical rows with `region = null` stay broken until manually backfilled — not self-healing.

**C — One-time migration backfill:** A guarded migration that sets `region` from the parent edge's node for null-region rows. Fixes history, but is a write migration on prod data that may have grown stale by the time it runs. Option A is strictly safer and covers Option C's case automatically.

---

## Decision

**Bearing inversion → Option A (render-time, TypeScript post-process).** The `neighbours()` method returns directions as seen from the *queried* node: forward edges keep their stored direction; reverse edges get `oppositeDirection()`. The `is_reverse` flag is internal to the repo, never exposed on `Neighbour`. This brings `/look` in line with `/map`'s `renderNodeFocus()`, which already inverts correctly.

**Region reconciliation → Option A (BFS parent fallback in `renderMap`).** The fallback climbs `tree.parent` until it finds a region or exhausts the chain, then falls back to `"Elsewhere"`. This is self-healing for legacy rows and enrichment failures alike — no migration, no prod data writes.

---

## Consequences

- `LocationEdgeRepository.neighbours()` inlines a local `opposite()` helper (8 compass pairs) rather than importing `oppositeDirection()` from `format.ts` — keeps the db layer free of discord-layer imports while avoiding any duplication risk from the tiny, fixed alphabet.
- `/look` paths and the decision-prompt context (`localGeography.neighbours`) will show correct compass headings after this change.
- `/map` node grouping is self-healing: a node with `region = null` silently inherits its nearest ancestor's region. The explicit "Elsewhere" bucket only appears for nodes that are genuinely disconnected from any enriched ancestor.
- No new columns, no migration, no data writes.
