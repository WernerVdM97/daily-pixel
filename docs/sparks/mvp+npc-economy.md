---
title: NPC Simulation & Town Economy
status: spark
domain: spark
tags:
- social
- simulation
related:
- '[[mvp+world-state-projection]]'
- '[[mvp-social-model]]'
- '[[mvp-core-loop]]'
phase: mvp+
---

## NPC Simulation & Town Economy

> *The blacksmith doesn't wait for a hero to walk in. He wakes at dawn, lights his forge, and earns his bread — whether you're watching or not.*

Every in-game day, the world ticks forward for its inhabitants. NPCs have lives: jobs, homes, routines, income, expenses, and changing sentiments. This simulation is **deterministic under the hood** — no LLM calls for daily ticks — with weekly LLM sentiment updates for key characters.

### NPC Daily Loop

Each in-game day, every key NPC runs through a fixed simulation tick:

```
DAWN  → Wake. Check home/family state.
MORN  → Travel to workplace. Begin job.
NOON  → Meal break. Socialize with nearby NPCs.
AFTN  → Continue job. Fulfill orders. Earn income.
EVEN  → Leave work. Optional: tavern, market, temple, home.
NIGHT → Sleep. Recover.
```

**What gets tracked per NPC:**
| Attribute | Description |
|-----------|-------------|
| `role` | Blacksmith, farmer, innkeeper, guard, merchant, priest, herbalist, etc. |
| `workplace_id` | Location node where they work |
| `home_id` | Location node where they sleep |
| `daily_income` | Base coins earned per work day (modified by skill, demand, events) |
| `wealth` | Accumulated savings. Affects what they can buy, upgrade, or commission |
| `stamina_npc` | Like player stamina — decays with work, recovers with rest. Affects output quality |
| `sentiment` | Mood vector: `{hope, fear, trust_in_fellowship, local_tension}` — updated weekly via LLM |
| `bonds` | Edges to other NPCs: family, friendship, rivalry, debt, romance |
| `goals` | What they're working toward: "save for a new anvil," "find missing brother," "court the baker" |
| `flaws` | D&D-style personality flaw: greedy, cowardly, naive, proud, etc. Affects decision weights |
| `ideals` | D&D-style driving belief: "community first," "knowledge is power," "wealth is security" |

> **Canonical model — see [[mvp-character-drivers]] and [[mvp-social-model]].** The list above is a summary. How each of these drivers is actually typed — which are enums, which are edges, which are cached prose — and the precise distinction between `sentiment`, `bonds`, and `relationships`, is defined there. Treat those files as the source of truth; this table is illustrative.

### Weekly LLM Sentiment Update

Once per in-game week (or real-world weekend), key NPCs within 2 hops of active players receive a **lightweight LLM pass**:

**Input (token-minimal):**
- NPC's current state snapshot (role, wealth delta this week, any significant events)
- World event overlay (threat proximity, weather, local rumors)
- Player interaction log (did any PC talk to them? trade? threaten?)

**Output:**
- Updated `sentiment` vector
- Potentially revised `goals`, `flaws`, or `ideals` (if something happened that would change a person)
- A 1–2 sentence "state of mind" summary for the weekly digest

**Token budget:** ~200 tokens per NPC per week. At ~10 key NPCs, that's ~2K tokens/week — a rounding error against the main quest LLM budget.

### Town Economy

Each settlement runs a **light economic simulation** — enough to make the world feel responsive, not enough to become an MMO crafting spreadsheet.

**Economic attributes per settlement:**
| Attribute | Description |
|-----------|-------------|
| `prosperity` | 0–100. Drives shop quality, NPC wealth growth, available quests |
| `supply` | Map of `{resource: quantity}`. Grain, iron, lumber, herbs, etc. Produced by NPC jobs |
| `demand` | Map of `{resource: quantity}`. Consumed by NPCs and upkeep. Drives trade between towns |
| `tax_rate` | Percentage skimmed by local lord/reeve. Affects NPC disposable income |
| `population` | Count of generic residents (statistical) + key NPCs (simulated) |

**Daily economic tick (deterministic):**
1. NPCs produce resources based on their role (farmer → grain, blacksmith → tools)
2. NPCs consume resources (food, basic goods)
3. Surplus goes to town `supply` pool; deficit draws from it
4. Trade between nearby settlements resolves shortages (automatic, abstracted)
5. `prosperity` drifts: +1 if supply > demand, -1 if deficit persists for 3+ days
6. NPC income modified by prosperity: +10% in thriving towns, -20% in struggling ones

**What players see:**
- Shop prices fluctuate slightly day to day (template: *"Bread is dear today — the miller's wheel broke."*)
- NPCs comment on their fortunes (*"Business has been good since the road reopened."*)
- Quest hooks emerge from economic pressure (*"If someone could clear the wolves from the north pasture, the whole village would eat better this winter."*)
- A struggling town visibly deteriorates: fewer lanterns lit, boarded windows, thinner NPC dialogue

**What players do NOT see:**
- Spreadsheets. Raw numbers. The simulation is felt through narrative, not displayed as a dashboard.

### Example: A Week in the Life of Garrick the Blacksmith

```
DAY 1 (Mon)  → Wakes at forge. Repairs 3 farming tools. Earns 15c. 
                Eats at inn. Talks to Mera the herbalist — 
                she mentions strange lights in the east wood.
DAY 2 (Tue)  → Standard workday. Earns 15c. 
                Player Kaelen visits! Sells a reinforced shield for 45c.
                Wealth now 230c. Goal "save for new anvil" is 70% complete.
DAY 3 (Wed)  → Rain. Forge work slows. Earns only 8c.
                Drinks at tavern. Rumor: Stonebridge smoke visible from ridge.
DAY 4 (Thu)  → Standard workday. Earns 15c.
                Sentiment: hope -3 (the smoke from Stonebridge unsettles him).
DAY 5 (Fri)  → Market day! Sells surplus tools. Earns 25c.
                Wealth hits 250c. Goal COMPLETE: commissions new anvil from 
                traveling merchant. Town prosperity +1.
DAY 6 (Sat)  → Installs new anvil. Forge quality upgraded. 
                Future daily_income increases from 15c to 20c.
                Sentiment: hope +5. Shares ale with neighbors to celebrate.
DAY 7 (Sun)  → Rest day. Visits temple. Prays for Stonebridge.
                
WEEKLY LLM UPDATE:
  INPUT:  Garrick (blacksmith), wealth 280c ↑, new anvil installed, 
          Stonebridge smoke visible, player Kaelen visited once
  OUTPUT: sentiment {hope: 6→8, fear: 3→5, trust_in_fellowship: 2→4}
          goals: "forge a masterwork blade for the fellowship" (new)
          summary: "Garrick is proud of his new anvil but the smoke 
          from Stonebridge keeps him up at night. He's decided to 
          put his best steel toward helping the travelers."
```

### Integration with the Rest of the Game

- **Resting at an inn?** The innkeeper's prosperity affects room quality and price. A thriving inn might have warm baths and good gossip; a struggling one has thin walls and watered ale.
- **Shopping?** What's in stock depends on what NPCs have produced. A blacksmith who had a bad week might not have that sword you wanted.
- **Quest generation?** Economic pressure generates natural quests. Failing crops → clear the field of monsters. Trade route blocked → escort the merchant.
- **Convergence?** Wealthy towns attract more travelers. Players naturally converge toward prosperous settlements, which become organic hubs.
- **The December climax?** If towns are struggling economically all year, the final battle is harder — fewer supplies, weaker allies, thinner defenses. A prosperous kingdom puts up a better fight.
