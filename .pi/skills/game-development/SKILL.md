---
name: game-development
description: Game development orchestrator for The Warden's Oak (async, turn-based, text/ASCII Discord RPG). Core principles + routing to sub-skills. Use when building or changing game systems, the tick loop, actions, or when unsure which game-* sub-skill applies.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Game Development

> **Orchestrator skill** that provides core principles and routes to specialized sub-skills.

---

## When to Use This Skill

You are working on **The Warden's Oak** — an async, turn-based, text/ASCII Discord RPG — or a similar tick-based, server-authoritative game. This skill teaches the core PRINCIPLES for this style of game and directs you to the right sub-skill based on context.

---

## Sub-Skill Routing

This project is fixed: one async, turn-based, text/ASCII Discord RPG. There is no platform or dimension to choose — routing is by specialty only. Each sub-skill is a sibling top-level skill (flattened so Claude Code auto-discovers them), invoke by its bare name.

| If you need... | Use Sub-Skill |
|----------------|---------------|
| GDD, balancing, player psychology, progression, reward design | `game-design` |
| Co-op architecture, server authority, sync model | `multiplayer` |
| Static visual style, palette, ASCII scene composition, asset organization | `game-art-static` |
| Animation / dynamic & video rendering (future MP4 path) | `game-art-dynamic` |
| Sound design, music, adaptive audio (future video) | `game-audio` |

---

## Core Principles

### 1. The Tick Loop

This game has no real-time frame loop. The loop is the **daily (cron) tick**:

```
INPUT  → Collect the day's player actions (rolls, commands)
UPDATE → Advance the sim deterministically (rolls, economy, NPC routines)
RENDER → Re-render only the entities the tick touched → deliver to Discord
```

**Tick Rule:**
- Logic: one deterministic tick per in-game day (cron-driven), plus a weekly pass
- Rendering: regenerate only the nodes the tick touched (dirty-flag), never the whole world
- Replayable: same inputs → same state (no wall-clock randomness in the sim)

---

### 2. Pattern Selection

| Pattern | Use When | Example (this game) |
|---------|----------|---------------------|
| **State Machine** | 3-5 discrete states | PC: Active→Resting→Lost→Dead; NPC daypart: Dawn→Morn→…→Night |
| **Observer/Events** | Cross-system communication | Roll result → quest update → vault re-render |
| **Command** | Undo, replay, audit | Each action as a command; append to the per-entity event log |
| **Behavior Tree** | Complex AI decisions | NPC goal/agenda choices |

**Decision Rule:** Start with State Machine. (The source's **Object Pooling** and **ECS** don't apply here — there are no hot spawn/destroy loops, and 8 players + ~10 key NPCs never need entity-component scale.)

---

### 3. Action Abstraction

Abstract player input into game ACTIONS, not raw Discord syntax:

```
"travel" → /travel, "go east", a button, a reaction
"rest"   → /rest, "make camp"
"act"    → /scout, /fight, /talk, /trade …
```

**Why:** One action layer means slash-commands, free text, and reactions all resolve the same way — and the roll engine never parses Discord strings.

---

### 4. Token Budget (the binding constraint)

There is no frame budget. The scarce resource is **LLM tokens**. Every AI call must justify its cost.

| Tier | Examples | Cost |
|------|----------|------|
| **Cheap (no LLM)** | Roll resolution, stat/stamina math, graph queries, economy tick, NPC routines, template + procedural rendering | 0 tokens |
| **Expensive (LLM)** | NPC weekly sentiment (~200 tok/NPC), quest generation, death & climax set-pieces | Paid once, then cached |

Steady state ≈ **2K tokens/week** (the weekly sentiment pass), independent of world size.

**Optimization Priority:**
1. Template/deterministic first (the LLM never sees a number)
2. Cache prose as state (generate once, re-render free)
3. Feed only the 2-hop subgraph, never the whole world
4. Render only touched nodes (dirty-flag)
5. Append-only logs (never re-summarize history)

---

### 5. NPC AI Selection by Complexity

| AI Type | Complexity | Use When |
|---------|------------|----------|
| **FSM** | Simple | NPC dayparts, PC status states |
| **Behavior Tree** | Medium | Modular, designer-friendly goal/agenda decisions |
| **GOAP** | High | Emergent planning (likely overkill here) |
| **Utility AI** | High | Scoring decisions — flaws/ideals weight choices (`proud` resists charity) |

**Rule:** Daily NPC ticks run **deterministically (no LLM)**. The LLM only writes the weekly sentiment *prose* — it never decides NPC actions.

---

### 6. Graph Locality

There is no spatial collision. The equivalent concern is **which slice of the graph you touch**:

| Scope | Use For |
|-------|---------|
| **Node + 1 hop** | Render one entity's vault file (its direct edges) |
| **2-hop subgraph** | LLM context for a scene; "who/what is nearby" |
| **Location bucket** | Everyone/everything `at_location` X (the Oak, a town) |

**Rule:** Never traverse the whole kingdom. Locality keeps render *and* token cost flat as the world grows.

---

## Anti-Patterns

| Don't | Do |
|-------|-----|
| Re-render the whole vault each tick | Render only touched nodes (dirty flags) |
| Regenerate prose every tick | Cache LLM prose as state; re-render reads it free |
| Pay an LLM to phrase data | Template all data; the LLM never sees a number |
| Optimize by guesswork | Profile token cost first |
| Mix Discord parsing with game logic | Abstract to an action layer |

---

## Routing Examples

### Example 1: "Design the daily roll + co-op incentives"
→ `game-design` (core loop, reward schedules) → `multiplayer` (co-op, server authority)

### Example 2: "Build the ASCII scene/card for a roll result"
→ `game-art-static` (palette, scene composition)

### Example 3: "Add NPC weekly sentiment + behaviour"
→ `game-design` (player/NPC psychology) + Core Principle 4 (token budget) + Principle 5 (AI selection)

### Example 4: "Add sound to the MP4 render (future)"
→ `game-art-dynamic` (animation/frames) → `game-audio`

---

> **Remember:** Great games come from iteration, not perfection. Prototype fast, then polish.
