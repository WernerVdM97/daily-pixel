# The Warden's Oak

> *A year is a long time to carry an ember. But it's longer still to carry one alone.*

---

You are eight travelers who have never met. You live ordinary lives in ordinary villages — until the smoke rises from Stonebridge, a star falls in the east, and every well in the kingdom runs dry on the same morning. Something is wrong. Something is waking.

Each day, the world advances. You get three rolls. You travel, rest, scout, fight, talk, flee. Some days you forget — and your character sits by the fire at the Warden's Oak, waiting. Some weeks you disappear entirely, and the world moves on without you, cruelly, indifferently.

After a few weeks, paths cross. A fellowship forms — not because destiny demands it, but because you all saw the same smoke, heard the same rumor, and a warden who never speaks finally looked east.

Twelve months later, in December, whatever has been waking will arrive. Whether the fellowship is still standing — that depends on three rolls a day, once a week at minimum, for an entire year.

This is a game about memory. About the spaces between. About a tree at a crossroads and the names carved into its bark, some so old the bark has swallowed them halfway.

---

## Thematic DNA

| Tag | Weight | Meaning |
|-----|--------|---------|
| **frieren** | anchor | Time is the central tension. Bonds form and fray across real calendar months. The December reset gives everything weight — knowing it ends makes the daily ritual matter. |
| **pixelart** | visual | The game is rendered in ASCII art. Low-res deliberate, not low-effort. Every scene, character, and item is text you can scroll on a phone screen. |
| **dnd** | mechanical | Three daily rolls. Rest and recovery. Party composition matters. The dice are visible and the stakes are real. |
| **lotr** | structural | Fellowship of many. Splitting paths. A greater unknown threat that looms without being fought directly. The December convergence. |
| **castlevania** | tonal | Gothic fantasy. The threat should feel like Dracula's castle on the horizon — distant, impossible, slowly approaching. Pixel monsters. |
| **animé** | emotional | Friendship-as-mechanic. Dramatic narrative framing. Characters have feelings and the game names them. "Lina seems distant today." |
| **maplestory** | nostalgic | The social grind as ritual. A central hub where players idle. Rare drops as bragging rights. The game *feels like* Henesys at 2am in 2006. |

---

## Game Mechanics

### The Daily Roll (Core Loop)

Each real day = 1 in-game day. The player receives **3 rolls**.

A roll is a d20 check against a target number, modified by:
- Character stats (strength, agility, wits, bond)
- Environmental conditions (rain, night, cursed ground)
- Equipment and injuries
- Proximity to other fellowship members (convergence bonus)

Roll categories:
1. **Travel** — move toward a destination, discover locations, navigate hazards
2. **Rest / Recover** — heal stamina, repair gear, prepare. Required periodically (SIM element).
3. **Act** — scout, fight, talk to NPCs, investigate, trade, craft

Players choose how to spend their 3 rolls each day, within what's possible at their current location.

### Weekly Rhythm

| Period | Behavior |
|--------|----------|
| **Monday–Thursday** | Standard 3 daily rolls. Minor quests. Minor rewards. |
| **Friday** | Standard rolls + weekly quest becomes available. |
| **Saturday–Sunday** | **Bonus rolls** (4–5 instead of 3). Larger battles. Major quest progression. Weekend events. |

### The Weekly Floor

**Players must play at least once per calendar week.** Missing a full week triggers the penalty track:

1. **Week 1 missed:** Character auto-sims in "resting" mode at last safe location. Minor stat decay. Notification to other fellowship members: *"Bram hasn't been seen in days."*
2. **Week 2 missed:** Character becomes "lost." World events happen *to* them — injury, ambush, capture. Fellowship receives a distress signal or rumor.
3. **Week 3 missed:** Death. Character dies off-screen. Name carved into the Warden's Oak. Fellowship notified. Player may start a new character who joins sooner (convergence catch-up mechanic).

### Auto-Simulation

When a player misses their daily roll (but is still within the weekly window):

- Character defaults to "resting" at last safe location
- The AI generates a brief passive update: *"Bram tends the fire at the Oak. He sleeps poorly."*
- No stat gains. No quest progress. No risk.
- Other players can see them at shared locations — they become NPC-like set dressing

### Rest & Recovery (SIM Element)

Characters have **stamina**. It decays with travel, combat, and failed rolls. It recovers with:
- Successful Rest rolls
- Time spent at safe locations (Oak, inns, allied camps)
- Rare items (healing herbs, blessed water)

Running on low stamina penalizes all subsequent rolls (-1 per point below threshold). The game *forces* downtime — you cannot sprint for months. This is the Frieren pacing: the spaces between matter.

### Convergence

**Week 0–2:** All characters start in separate villages, living ordinary lives. The world is introduced. Small personal quests. The crack in the world appears.

**Week 2–3:** Paths begin crossing. Characters who performed well (successful Travel rolls, completed quests) converge faster. Those who struggled arrive later.

**Week 3+:** Fellowship formed. Party play begins. Shared quests. The graph DB now tracks *inter-character* edges: trust, rivalry, debt, friendship.

**New/replacement characters** (after death) join the fellowship directly — no solo start.

### The December Climax

The threat that has been building all year reaches its apex in December. The fellowship must be positioned, equipped, and bonded enough to face it.

**Outcomes:**
- **Victory:** The threat is defeated. The year ends. Characters are remembered. A new generation may be born (sequel hook).
- **Partial victory:** The threat is delayed, not destroyed. Bitter cost. Some characters lost.
- **Defeat:** The world falls. The Warden's Oak burns. The names on its bark are all that remain.

After December: **character wipe**. New campaign possible with new characters, same world — a generation later. The old characters are legends, names on the Oak.

---

## World & Setting

### The Warden's Oak

The central hub. An ancient tree at a crossroads where three old roads meet. Its branches shelter travelers from rain. Names are carved into its trunk — some fresh, some swallowed by bark.

A **warden** tends it: an NPC who never leaves, never fights, never gives quests. They offer fire, stew, and silence.

**Game functions of the Oak:**
- Safe resting location (stamina recovery)
- Where auto-simmed characters idle (visible to active players)
- Memorial wall (dead characters' names appear)
- Where fellowship members notice each other's state ("Kaelen's sword is cracked")
- Cryptic warden dialogue that deepens over the year
- The most-trafficked node in the graph DB

**The warden's secret:** They are not one person. The warden has been many people across centuries. The current warden is the *last*. When they die, the Oak dies. This is never stated directly — only implied through fragments and year-long observation.

### The Threat

The greater unknown evil. It should:
- Have a name, but not one spoken aloud in Month 1
- Manifest through environmental changes (wells dry, stars fall, borders close)
- Send lieutenants and heralds before it arrives personally (Castlevania structure)
- Be defeatable — but only through year-long preparation and fellowship bonds

### The World Map

A region roughly the size of a small kingdom. Key locations emerge through play, not pre-authored:
- **Starting villages** (8, one per player)
- **The Warden's Oak** (crossroads, always reachable within 1–2 travel rolls)
- **Stonebridge** (early quest hub, first sign of the threat)
- **Unmapped locations** emerge from scouting rolls and the AI

The graph DB stores all location nodes and their connections.

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
│  │  - Auto-sim engine                  │            │
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
- Auto-sim passive updates (template: `"[Name] rests at [Location]. [Condition]."`)
- Weekly scheduler triggers

**Expensive (LLM, use sparingly):**
- NPC dialogue and character moments (cache responses per NPC+context)
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
  Location  { id, name, type, description_cache, coordinates }
  NPC       { id, name, role, location_id, dialogue_cache_keys }
  Item      { id, name, type, owner_id, location_id }
  Quest     { id, name, status, generated_text, reward }

Edge types:
  trusts(Char→Char, value)        knows_of(Char→NPC, detail)
  rivals(Char→Char, reason)        at_location(Char|NPC|Item→Location)
  owns(Char→Item)                  on_quest(Char→Quest, progress)
  bonded_to(Char→Location, reason) mentioned_in(NPC→Quest)
```

The LLM receives only the subgraph reachable within 2 hops of the current context. A player at the Oak sees: Oak → warden, nearby characters, recent quests, known locations within travel range. Not the entire kingdom.

### ASCII Art Engine

Renders scenes, characters, and items as pixelated ASCII art. Design principles:

- Fixed-width blocks that fit mobile Discord (max ~30 chars wide)
- Palette of 4–6 characters for shading: ` ` `.` `,` `-` `=` `@`
- Emojis reserved for rare punctuation (quest markers, death markers, rare item sparkle)
- Location scenes are templated + procedural (weather, time-of-day variants)
- Characters have simple class-based sprites (2–3 lines each)
- Combat scenes use simple spatial layouts

---

## Hazard Map

### No-Gos

| Item | Why |
|------|-----|
| **Real-time combat** | Discord latency + mobile = terrible UX. All combat is roll-resolution, not twitch. |
| **Voice chat integration** | Scope creep. Text-only. |
| **Persistent inventory menus** | Discord buttons have limits. Keep interactions to text commands and simple reactions. |
| **Multi-party simultaneous events** | Token budget killer. One scene at a time, queued. |
| **Procedural world generation mid-year** | The world must feel *built*, not generated. Pre-seed locations, let the AI reveal them. |
| **Player-driven economy / crafting system** | This is a narrative game, not an MMO. Keep items meaningful and rare. |

### Rabbit Holes

| Hole | Risk | Mitigation |
|------|------|------------|
| **"Let's make the AI smarter"** | Endless prompt engineering. Token budget blows up. | Ship with dumb-but-charming AI. Improve only if engagement survives Month 1. |
| **"One more NPC system"** | Faction reputation, romance arcs, betrayal mechanics — each is a subsystem. | Start with 1 NPC depth mechanic (trust). Add only if the first one lands. |
| **"The ASCII engine should animate"** | Frame-by-frame animation in Discord text is possible but dev-heavy. | Static scenes first. "Animation" is scene-to-scene transition. |
| **"Let's support 20+ players"** | Graph DB and token budget don't scale linearly. | Hard cap at 8. If the POC works, the sequel campaign can be designed for scale. |
| **"Balancing classes and stats"** | D&D-style class balance is an infinite timesink. | 3–4 broad archetypes (Warrior, Ranger, Sage, Rogue). No subclasses. Stats are simple. |
| **"The graph DB should be Neo4j/ArangoDB"** | Operational overhead for a POC with 8 players. | SQLite with a custom edge table. Migrate to a real graph DB only if it survives Month 3. |

### Known Risks

| Risk | Likelihood | Impact | Response |
|------|-----------|--------|----------|
| Player drop-off after 2 weeks | High | Fellowship feels thin, narrative loses momentum | Auto-sim keeps absent characters in the world. Death at 3 weeks is the hard reset — the story "eats" the dropout. |
| LLM API costs exceed budget | Medium | Game pauses or degrades | Lazy evaluation + caching is the primary defense. Fallback: template-only mode (no LLM) for weekdays, LLM only on weekends. |
| Discord rate limits on mobile | Low | Messages delayed or dropped | Batch daily-roll results into 1–2 messages max. No rapid-fire updates. |
| 1 year is too long | Medium | Engagement cliff around Month 4–6 | Mid-year event (June/July) as a mini-climax. The threat sends a herald. A character may die unavoidably. Raise the stakes. |

---

## Examples

### Daily Roll — Day 47, Early Convergence

```
══════════════════════════════════════
            DAY 47 · RAIN
══════════════════════════════════════

    .-===-.    ,-.      You wake to rain on
   (  .-.  )  (   )     the tent. The fire is
    `-...-´    `-´      dead. The Oak is two
                         hours east.

Your fellowship (2/8 gathered):
  ⚔️ Kaelen       [with you]
  🏹 Lina         [with you]

Others reported:
  🛡️ Bram         [Stonebridge, 3 days away]
  📜 Elara        [unknown — last seen Day 41]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ROLL 1/3: Travel
  🎲 14 + 2 (rained before) = 16 ✓
  You reach the Oak by noon. The warden
  has left bread. Lina notices a fresh
  name carved low on the trunk:
  > ELARA WAS HERE

ROLL 2/3: Rest
  🎲 4 — failure
  The bread is stale. You eat it anyway.
  -1 stamina. Lina suggests hunting
  tomorrow.

ROLL 3/3: Scout (bonus — at Oak)
  🎲 19 ✓
  From the Oak's highest branch, Kaelen
  spots smoke rising from Stonebridge.
  Not hearth-smoke. Siege-smoke.

  → NEW QUEST: "Stonebridge Burning"
     Reach Bram before the 3-day window
     closes. Weekday — minor reward.

══════════════════════════════════════
NEXT ROLLS: tomorrow, Day 48.
Bram auto-sims in 2 days if unplayed.
══════════════════════════════════════
```

### NPC Interaction — The Warden at Night

```
══════════════════════════════════════
         THE WARDEN'S OAK · NIGHT
══════════════════════════════════════

              ,@@@@@@,
         ,,,,.@@@@@@@@,,,,        Firelight.
       ,@@@@@@@@@@@@@@@@@@,
      @@@@@@@@@@@@@@@@@@@@@@      The warden — silent as always —
     @@@@@@@@@@@@@,,,@@@@@@@@      tends the flames. You are the
      @@@@         @@@@@@@@@@      only one awake.
        @@@       @@@@@@@@@
         @@       ,@            The warden sets down a worn cup
                        @@       beside you. Inside: not water.
               /\       @@
              /  \   @@           A single ember, glowing faintly.
    _        /    \  @@
   |.|      /  /\  \              You look up. The warden meets
   `-´     /  /  \  \             your eyes for the first time.
          /        ` \            Then looks east. Toward the smoke.
         ´-...____...-`

"Some fires start before the kindling
is laid," says the Warden. "Bram is
not in Stonebridge. He never was."

  → RELATIONSHIP: Warden → trust +2
     New marker on map: ??? (east of Oak)

  → "Who is Bram, then?"  [ask]
  → "Where is the real Bram?"  [ask]
  → Say nothing. Drink the ember.  [act]
```

---

## Player Lifecycle

```
Week 0   ○ Ordinary life. Personal quest. The crack appears.
Week 1   ○ Solo travel begins. First roll choices matter.
Week 2   ○ Convergence window opens. Paths cross.
Week 3   ○ Fellowship formed. Party play. Shared threat.
Month 2  ○ Deepening bonds. Location map filling. Threat sends signs.
Month 6  ○ Mid-year event. A herald arrives. Stakes escalate.
Month 11 ○ Final preparation. Fellowship must be positioned.
December ○ Climax. Victory, partial, or defeat.
January  ○ Wipe. Names on the Oak. Next generation?
```

## Rolls

- 2 rolls on week days, 3 on friday 4 saturday 3 sunday.
- Each roll increments in seriousness or step size (unless story resumes from the previous day)
- At least one roll is a multi step choice with decisions affecting final DC

---

*This document is a design intent, not a specification. It is the output of an interview-me + creative exploration session. Hand off to `spec-driven-development` for formal requirements or `planning-and-task-breakdown` for implementation ordering.*
