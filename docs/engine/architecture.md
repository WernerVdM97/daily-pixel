---
title: Technical Architecture (High Level)
status: exploring
domain: engine
tags: [architecture, graph-db, llm, tokens, ascii, sqlite]
related:
  - "[[world-state-projection]]"
  - "[[ascii-render-pipeline]]"
  - "[[hazard-map]]"
---

## Technical Architecture (High Level)

```
┌─────────────────────────────────────────────────────┐
│                     DISCORD                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐              │
│  │ Player1 │  │ Player2 │  │ Player8 │  ...         │
│  └────┬────┘  └────┬────┘  └────┬────┘              │
│       │            │            │                   │
│       ▼            ▼            ▼                   │
│  ┌─────────────────────────────────────┐            │
│  │         DISCORD BOT (TypeScript)    │            │
│  │  - Command router                   │            │
│  │  - ASCII art renderer               │            │
│  │  - Daily roll engine                │            │
│  │  - Weekly scheduler (cron)          │            │
│  │  - Auto-sim engine (PC + NPC)       │            │
│  │  - Daily economy tick               │            │
│  │  - NPC routine simulation           │            │
│  └─────────────┬───────────────────────┘            │
│                │                                    │
│       ┌────────▼────────┐                           │
│       │   GRAPH DB      │                           │
│       │ (SQLite +custom │                           │
│       │  edge model)    │                           │
│       │                 │                           │
│       │ Nodes: PC       │                           │
│       │  Location, NPC, │                           │
│       │  Item, Quest    │                           │
│       │                 │                           │
│       │ Edges: trust,   │                           │
│       │  rivalry, owns, │                           │
│       │  at_location,   │                           │
│       │  knows_of,      │                           │
│       │  on_quest, etc. │                           │
│       └────────┬────────┘                           │
│                │                                    │
│       ┌────────▼────────┐                           │
│       │   LLM GATEWAY   │                           │
│       │                 │                           │
│       │ - Narrative gen │                           │
│       │ - NPC dialogue  │                           │
│       │ - Quest creation│                           │
│       │ - World events  │                           │
│       │                 │                           │
│       │ Token-optimized:│                           │
│       │  cache + lazy   │                           │
│       │  evaluation     │                           │
│       └─────────────────┘                           │
└─────────────────────────────────────────────────────┘
```

### Token Optimization Strategy

The binding constraint. Every AI call must justify its cost.

**Cheap (no LLM):**
- Roll resolution (deterministic d20 + modifiers)
- Stamina and stat calculations
- Graph DB queries and edge updates
- Location descriptions (template + graph data)
- ASCII art scene rendering (templates + procedural)
- Auto-sim passive updates for PCs (template: `"[Name] rests at [Location]. [Condition]."`)
- NPC daily routine ticks (job, income, spending — all deterministic)
- Town economy daily tick (supply/demand, prosperity drift)
- Weekly scheduler triggers

**Expensive (LLM, use sparingly):**
- NPC dialogue and character moments (cache responses per NPC+context)
- NPC weekly sentiment updates (~200 tokens per key NPC per week; ~2K/week for 10 NPCs)
- Quest generation (generate once, reuse)
- Major world events (weekends only, max 1–2 per weekend)
- Death narrations (one-time, per character death)
- December climax scenes (budget accumulated across the year)

**Lazy evaluation rules:**
- NPCs are not "alive" until a player interacts with them
- Locations are described procedurally until visited, then cached
- Quest text is generated on first access, serialized, and reused
- NPC dialogue is cached by (NPC, player_state_hash) to avoid repeats
- The graph DB serves as context injection — the LLM receives only the relevant subgraph, not the whole world

### Graph DB Schema (Conceptual)

```
Node types:
  Character { id, name, class, stats, status, player_id }
  Location  { id, name, type, description_cache, coordinates,
              prosperity, supply_map, demand_map, tax_rate, population }
  NPC       { id, name, role, location_id, workplace_id, home_id,
              daily_income, wealth, stamina_npc, sentiment,
              goals, flaws, ideals, dialogue_cache_keys }
  Item      { id, name, type, owner_id, location_id, price }
  Quest     { id, name, status, generated_text, reward }

Edge types:
  trusts(Char→Char, value)        knows_of(Char→NPC, detail)
  rivals(Char→Char, reason)        at_location(Char|NPC|Item→Location)
  owns(Char→Item)                  on_quest(Char→Quest, progress)
  bonded_to(Char→Location, reason) mentioned_in(NPC→Quest)
  works_at(NPC→Location)           lives_at(NPC→Location)
  bonded_npc(NPC→NPC, type, value)   trades_with(Location→Location, goods)
  owes_debt(NPC→NPC, amount)       supplies(Location→Location, resource)
```

The LLM receives only the subgraph reachable within 2 hops of the current context. A player at the Oak sees: Oak → warden, nearby characters, recent quests, known locations within travel range. Not the entire kingdom.

> **World state projection.** This same graph is mirrored into a browsable, Obsidian-style markdown vault — one file per entity, `[[wikilinks]]` as edges — rendered deterministically each tick at ~0 LLM tokens, so the whole world's state is viewable at a glance. See [world-state-projection.md](world-state-projection.md) for the render model, the data-vs-prose split, the D&D character-driver tiers, and an example template.

### ASCII Art Engine

Renders scenes, characters, and items as pixelated ASCII art. Design principles:

- Fixed-width blocks that fit mobile Discord (max ~30 chars wide)
- Palette of 4–6 characters for shading: ` ` `.` `,` `-` `=` `@`
- Emojis reserved for rare punctuation (quest markers, death markers, rare item sparkle)
- Location scenes are templated + procedural (weather, time-of-day variants)
- Characters have simple class-based sprites (2–3 lines each)
- Combat scenes use simple spatial layouts
