---
title: Graph Data Model — Schema Reference
status: spark
domain: spark
tags:
- data-model
related:
- '[[mvp-architecture]]'
- '[[mvp+world-state-projection]]'
- '[[mvp-social-model]]'
- '[[mvp-character-drivers]]'
- '[[mvp+moral-drift]]'
phase: mvp
---
 
# Graph Data Model

> *The graph is the single source of truth. Every byte in the vault traces back to a node or edge.*

SQLite with a custom edge table. No full graph DB — the scale (8 players, ~10 key NPCs, ~30 locations) doesn't need one, and the POC avoids operational overhead. Migrate only if the game survives Month 3.

---

## Node Types

### Character (PC)

```yaml
id:         char_<uuid>
type:       character
name:       string
player_id:  discord_user_id | null  # null = NPC
class:      warrior | ranger | sage | rogue
stats:
  strength:  int 1-20
  agility:   int 1-20
  wits:      int 1-20
  bond:      int 1-20
status:     active | resting | lost | dead
stamina:    int 0-10
moral_vector: {hope: -10..10, fear: -10..10, trust: -10..10, corruption: 0..10}
alignment_label: string  # derived from moral_vector, see [[mvp+moral-drift]]
portrait_asset: path
```

### Location

```yaml
id:              loc_<uuid>
type:            location
name:            string
kind:            crossroads | village | town | city | wilderness | ruin | dungeon
coordinates:     {x: int, y: int}
description_cache: string  # LLM prose, generated on first visit
prosperity:      int 0-100
supply_map:      {resource: quantity}
demand_map:      {resource: quantity}
tax_rate:        float 0-1
population:      int
```

### NPC

```yaml
id:                  npc_<uuid>
type:                npc
name:                string
role:                blacksmith | herbalist | warden | innkeeper | merchant | guard | …
status:              alive | dead | missing
daily_income:        int
wealth:              int
stamina_npc:         int 0-10
sentiment:           {hope, fear, trust_in_fellowship, local_tension}
ideals:              [string]  # e.g. "community first"
flaws:               [string]  # e.g. "proud"
goals:               [{text, status: active | complete | abandoned, added_day}]
dialogue_cache_keys: [string]  # hash keys for cached LLM dialogue
summary:             string    # LLM prose, rewritten weekly
portrait_asset:      path
```

### Item

```yaml
id:    item_<uuid>
type:  item
name:  string
kind:  weapon | armor | consumable | key | misc
stats: {…}          # type-dependent
price: int
lore:  string       # LLM prose, generated once
```

### Quest

```yaml
id:              quest_<uuid>
type:            quest
name:            string
status:          open | active | complete | failed
generated_text:  string  # LLM prose, generated once on open
reward:          string
```

---

## Edge Types

| Edge | From → To | Semantics |
|---|---|---|
| `trusts` | Character → Character | Directed trust score (int -10..10). Core social mechanic. |
| `rivals` | Character → Character | Rivalry reason (string). Antagonistic but not necessarily hostile. |
| `at_location` | Character \| NPC \| Item → Location | Where the entity currently is. Single-valued per entity. |
| `owns` | Character → Item | Inventory. |
| `on_quest` | Character → Quest | Participation + progress (string \| int). |
| `bonded_to` | Character → Location | Emotional attachment (string reason). Why this place matters. |
| `knows_of` | Character → NPC | Awareness (string detail). Unlocks NPC interaction. |
| `works_at` | NPC → Location | Workplace. |
| `lives_at` | NPC → Location | Home. |
| `bonded_npc` | NPC → NPC | Relationship (type: string, value: int -10..10). |
| `mentioned_in` | NPC → Quest | NPC is part of quest narrative. |
| `trades_with` | Location → Location | Trade route (goods: [string]). |
| `owes_debt` | NPC → NPC | Debt obligation (amount: int). |
| `supplies` | Location → Location | Resource flow (resource: string). |

---

## The Data / Prose Split

Data is deterministic, prose is cached LLM output. The graph stores both — rendering reads, never generates.

| | What it is | Who writes it | Token cost |
|---|---|---|---|
| **Data** | `wealth: 280`, `location: [[The Winery]]`, `hope: 8` | Deterministic sim | 0 — templated |
| **Prose** | "Garrick is proud of his new anvil but the smoke keeps him up at night." | LLM, on an event | Paid once, cached forever |

**Prose-bearing fields (LLM-authored, cached):**
- `Location.description_cache` — generated on first visit
- `NPC.summary` — rewritten weekly (~200 tok/NPC)
- `NPC.dialogue_cache_keys` — per-context dialogue snippets
- `Quest.generated_text` — generated on quest open
- `Item.lore` — generated on item creation
- Death narrations and climax scenes — one-shot, stored in the event log (not a node field)

---

## Per-Entity Frontmatter Schema (Vault Projection)

`render()` writes these fields into each entity's markdown file frontmatter. See [[mvp+world-state-projection]] for the full render model.

### Character (PC)

```yaml
id, name, class, status, stamina, player_id
stats: {strength, agility, wits, bond}
moral_vector: {hope, fear, trust, corruption}
alignment: derived_label
location, bonded_to, owns[]   # edge → [[wikilink]]
quests[]                       # edge → [[wikilink]]
```

### NPC

```yaml
id, name, role, status, wealth, daily_income, stamina_npc
sentiment: {hope, fear, trust_in_fellowship, local_tension}
ideals, flaws, tags
location, workplace, home      # edge → [[wikilink]]
bonds[]                        # bonded_npc edge → [[wikilink]]
```

### Location

```yaml
id, name, kind, coordinates, prosperity, population, tax_rate
supply_map, demand_map
adjacent[]                     # trades_with/supplies edges → [[wikilink]]
```

### Item

```yaml
id, name, kind, stats, price
owner, location                # owns/at_location edge → [[wikilink]]
```

### Quest

```yaml
id, name, status, reward
participants[]                 # on_quest edge → [[wikilink]]
```

---

## Query Patterns

### "Who is at the Oak right now?"

```
MATCH (loc:Location {name: "The Warden's Oak"})
EDGES at_location(→ loc)
RETURN nodes
```

### "What does Kaelen know about this area?" (2-hop subgraph for LLM context)

```
START node:Character {name: "Kaelen"}
TRAVERSE 1 hop: bonded_to, at_location, on_quest, knows_of, owns
TRAVERSE 2 hops: from those nodes, follow all edges
RETURN subgraph
```

### "All NPCs Garrick has a relationship with"

```
START node:NPC {name: "Garrick"}
EDGES bonded_npc(→), trusts(→), rivals(→), owes_debt(→)
RETURN target nodes + edge values
```

---

## Direction of Truth

- **Graph DB is the source of truth.** Write here.
- **Vault markdown is a projection.** Read-only, regenerated each tick.
- **Never parse markdown back into state** during normal operation. (Frontmatter is ingestible as a cold recovery path, but that's a migration tool, not the live loop.)
