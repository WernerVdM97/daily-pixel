---
title: Core Loop — Rolls, Weekly Rhythm, Co-op
status: spark
domain: spark
tags:
- game-design
related:
- '[[mvp-progression]]'
- '[[world-setting]]'
- '[[mvp+npc-economy]]'
phase: mvp
---

## Game Mechanics

### The Daily Roll (Core Loop)

Each real day = 1 in-game day. The player receives **2 rolls** on weekdays — more on weekends (see Weekly Rhythm below).

A roll is a d20 check against a target number, modified by:
- Character stats (strength, agility, wits, bond)
- Environmental conditions (rain, night, cursed ground)
- Equipment and injuries
- Proximity to other fellowship members (convergence bonus)

Roll categories:
1. **Travel** — move toward a destination, discover locations, navigate hazards
2. **Rest / Recover** — heal stamina, repair gear, prepare. Required periodically (SIM element).
3. **Act** — scout, fight, talk to NPCs, investigate, trade, craft

Players choose how to spend their rolls each day, within what's possible at their current location.

### Weekly Rhythm

| Period | Behavior |
|--------|----------|
| **Monday–Thursday** | **2 daily rolls.** Minor quests. Minor rewards. |
| **Friday** | **3 rolls** + weekly quest becomes available. |
| **Saturday** | **4 rolls.** Larger battles. Major quest progression. Weekend events. |
| **Sunday** | **3 rolls.** Major quest progression. Weekend events. |

### The Weekly Floor

**Players must play at least once per calendar week.** Missing a full week triggers the penalty track:

1. **Week 1 missed:** Character auto-sims in "resting" mode at last safe location. Minor stat decay. Notification to other fellowship members: *"Bram hasn't been seen in days."*
2. **Week 2 missed:** Character becomes "lost." World events happen *to* them — injury, ambush, capture. Fellowship receives a distress signal or rumor.
3. **Week 3 missed:** Death. Character dies off-screen. Name carved into the Warden's Oak. Fellowship notified. Player may start a new character who joins sooner (convergence catch-up mechanic).

### Social Incentives & Co-op Play

> *The game is not designed for daily players. It's designed to make you want your friends to log in.*

**No one is expected to play every day.** The game respects that players have lives. The weekly floor (at least once per week) is the real bar. But when a player *does* show up, the game should make other players *feel it* — and want to come back.

**Co-op bonuses — rewards that flow to others:**

| Action | Bonus | Why it incentives others |
|--------|-------|--------------------------|
| **Travel together** (2+ PCs in same party) | +2 convergence bonus to all rolls. Shared discovery XP. | "Kaelen is heading to Stonebridge — if I log in tonight, we travel together and both get the bonus." |
| **Camp together** (shared rest at same location) | Bonus stamina recovery. A shared campfire scene is generated — visible to all party members. | "Lina's at the Oak. If I rest there too, we both recover faster and get a campfire moment." |
| **Co-op quest completion** | All participating PCs get full quest rewards (no splitting). Bonus bond points between participants. | "Bram and I could take down those wolves together — he gets the reward too, even if I do the heavy lifting." |
| **Gift an item** (PC → PC) | The giver earns bond points. The receiver gets the item. Both get a shared memory logged to their character. | "Elara left me a healing herb at the Oak. I should log in and thank her — or return the favor." |
| **Shared scouting** (one PC scouts, another is nearby) | The non-scouting PC also receives the scouting intel. Discovered locations are shared. | "I scouted the eastern ridge. If Kaelen logs in tomorrow, he'll see it on his map too." |
| **Missed-week rescue** | A PC who rescues a "lost" comrade (Week 2 penalty) earns a rare bond trait. The rescued player returns with gratitude — and a stat boon the rescuer helped unlock. | "Bram's been missing for two weeks. If I find him, we both get something unique." |

**Design principles:**
- **No penalties for playing solo.** A lone player can do anything — just slower, harder, with more risk.
- **Bonuses are additive, never zero-sum.** Co-op doesn't split rewards; it *creates* extra rewards that wouldn't exist otherwise.
- **Shared context creates FOMO that feels like warmth, not pressure.** A campfire scene you missed is still visible later — it becomes a memory, not a punishment.
- **The weekly rhythm is the cadence.** Bonuses are calibrated so that a player who logs in once on Saturday (with 4 rolls) can meaningfully contribute to the party's progress for the entire week.

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

## Rolls

- 2 rolls on weekdays, 3 on Friday, 4 on Saturday, 3 on Sunday.
- Each roll increments in seriousness or step size (unless story resumes from the previous day)
- At least one roll is a multi step choice with decisions affecting final DC
