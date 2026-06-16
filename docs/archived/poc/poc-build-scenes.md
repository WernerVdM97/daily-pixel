---
title: POC Build — ASCII Scenes
status: shipped
domain: archived
superseded_by: "implemented in code"
phase: poc
tags:
- poc
- build-plan
- ascii
related:
- '[[poc-build-poa]]'
- '[[poc-build-scaffold]]'
- '[[poc-build-probabilistic]]'
- '[[poc-spec-reconciliation]]'
---

# POC Build — ASCII Scenes

> *Part of [[poc-build-poa]]. Fragment catalog, tag-based deterministic matching, and integration into `/hi`, `/look`, and `/action`.*

---

## 1. Fragment Catalog

21 scenes across four categories. `.ascii` files in `assets/scenes/` carry YAML frontmatter with tags. Art created later — the spec defines the catalog only.

### Settlement

| # | Scene name | Filename | Tags |
|---|---|---|---|
| 1 | The Warden's Oak (interior) | `oak.ascii` | `oak, interior, fire, sanctuary, warden` |
| 2 | Town Square | `town-square.ascii` | `town, square, buildings, cobblestone, market` |
| 3 | Tavern Interior | `tavern.ascii` | `tavern, interior, fire, crowd, drink` |
| 4 | Village Shopfront | `shopfront.ascii` | `shop, village, market, goods, trade` |
| 5 | Shrine / Temple | `shrine.ascii` | `shrine, temple, holy, stone, quiet` |

### Wilderness

| # | Scene name | Filename | Tags |
|---|---|---|---|
| 6 | Open Road | `road.ascii` | `road, travel, open, path, horizon` |
| 7 | Campfire / Rest Site | `campfire.ascii` | `campfire, rest, night, fire, safe` |
| 8 | Dense Forest | `forest-dense.ascii` | `forest, trees, wilderness, dark, canopy` |
| 9 | Forest Edge | `forest-edge.ascii` | `forest, edge, trees, field, boundary` |
| 10 | River / Stream | `river.ascii` | `river, water, stream, crossing, bank` |
| 11 | Swamp / Bog | `swamp.ascii` | `swamp, bog, wet, mist, marsh` |
| 12 | Mountain Pass | `mountain-pass.ascii` | `mountain, pass, rocky, high, narrow` |

### Structures

| # | Scene name | Filename | Tags |
|---|---|---|---|
| 13 | Cave Entrance | `cave-entrance.ascii` | `cave, entrance, dark, rock, opening` |
| 14 | Cave Interior | `cave-interior.ascii` | `cave, interior, dark, underground, stone` |
| 15 | Ancient Ruins | `ruins.ascii` | `ruins, ancient, stone, broken, old` |
| 16 | Watchtower | `watchtower.ascii` | `tower, watch, high, stone, lookout` |
| 17 | Bridge / Crossing | `bridge.ascii` | `bridge, crossing, river, stone, arch` |

### Edges

| # | Scene name | Filename | Tags |
|---|---|---|---|
| 18 | Farmland / Fields | `farmland.ascii` | `farm, field, crops, open, rural` |
| 19 | Coastline / Lake Shore | `coast.ascii` | `coast, water, shore, lake, horizon` |
| 20 | The Eastern Smoke | `eastern-smoke.ascii` | `smoke, east, threat, ash, danger` |
| 21 | Unknown Territory | `unknown.ascii` | `unknown, generic, wilderness, mist` |

### File format

```
---
tags: [forest, trees, wilderness, dark, canopy]
---
   /\
  /  \
 / /\ \
/ /  \ \
  ||||
```

Tags: comma-separated, lowercase, no spaces within a tag.

---

## 2. Loading & Validation

At startup, after YAML validation (scaffold spec), the bot loads all `.ascii` files from `assets/scenes/`.

### Load

1. Read all files from directory
2. Parse frontmatter → extract tags
3. Extract body → the ASCII art
4. Store in `Map<sceneName, { tags: string[], art: string }>`

### Validation — fail-fast

| Check | Fail if |
|---|---|
| File count | < 1 file in directory |
| Frontmatter | Missing or unparseable |
| Tags | Empty array or any tag contains spaces |
| Width — hard cap | Any line exceeds 30 characters (matches the mobile no-scroll must-pass, §5) |
| Height | Any file exceeds 32 lines (Discord message budget) |

Failures log filename + specific error, then exit. Bot never comes online with a scene that breaks rendering.

---

## 3. Tag Matching

Deterministic. No LLM. Runs once per location switch, result cached.

### Algorithm

1. Split `locations.tags` by comma → array
2. For each loaded scene, count overlapping tags with location
3. Pick scene with highest overlap score
4. Ties → first in load order (alphabetical filename)
5. Zero matches → `unknown.ascii` fallback

### Cache

Resolved scene cached in memory per location. Re-resolved only when `player_characters.location` changes.

### Examples

| Location tags | Best match | Overlap |
|---|---|---|
| `"forest, dark, eastern"` | `forest-dense.ascii` | 2 |
| `"town, market, trade"` | `shopfront.ascii` | 2 |
| `"cave, dark, underground, wet"` | `cave-interior.ascii` | 3 |
| `"desert, sand, hot"` | `unknown.ascii` | 0 |

---

## 4. Integration

### `/hi` — Message 1

Always shows `oak.ascii`. Hardcoded — the Oak is the game's anchor, not location-dependent.

### `/look`

1. Read `player_characters.location`
2. Query `locations.tags` WHERE `name = current_location`
3. `resolveScene(locationTags)` → ASCII art
4. If location not in DB → `unknown.ascii`
5. Render: code block (scene) + location description below

### `/action` — Decision Messages

1. On first LLM response, resolve scene from current location
2. Prepend same scene to every decision message in the action loop
3. Scene re-resolved on next action if location changed via mutations

### Message template

```
╔══════════════════════════╗
║  [scene ascii art]       ║
╚══════════════════════════╝

{decision prompt / description}

[button] [button] [button]
```

Scene in a Discord code block, above text and buttons. Consistent across `/hi`, `/look`, and `/action`.

---

## 5. Mobile Testing

All 21 scenes tested on phone Discord client before ship.

| Check | Threshold |
|---|---|
| Horizontal scroll at 30 chars | Must-pass — no scroll |
| Code block renders correctly | Must-pass — some fonts break ASCII |
| Light + dark theme | Must-pass — both readable |
| Full `/action` flow with scene | Must-pass — scene persists through decision edits |

---

## S2 Handover

- [x] **Shipped:** Scene subsystem — `SceneLoader` (load + validate all `.ascii` files, fail-fast on missing/width>30/malformed, real 21 scenes all pass at ≤26 width), `TagResolver` (deterministic overlap-score matching, tie→first, zero→`unknown.ascii`).
- [!] **Frozen:** `SceneLoader` (public API: `loadAll() → Map<string, SceneFile>`, validates body width ≤30), `TagResolver` (`resolve(locationTags[]) → sceneName`), `SceneLookupFn` type (`(tags: string[]) => { sceneName, ascii }` — injected into `/look` for decoupling).
- [x] **Tests:** `tests/scenes/scene-loader.test.ts` (8), `tests/scenes/tag-resolver.test.ts` (8). Run full suite: `cd ~/projects/daily-pixel && npx vitest run`.
- [>] **Next (S4):** Action polish — two-tier LLM fallback, template fallback for `outcome_text` (logged), error mapper, idle messages, outcome rendering. See `docs/engine/poc-build-poa.md` §5 for S4 scope.
