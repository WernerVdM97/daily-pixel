---
title: Example Scenes — MVP
status: spark
domain: spark
phase: mvp
tags:
- discord
- ascii
- mvp
related:
- '[[mvp-core-loop]]'
- '[[poc-example-scenes]]'
- '[[mvp-progression]]'
---

# Example Scenes — MVP

> *What the player sees once co-op, quests, and richer NPC interactions are in play. Builds on the action flow from the POC.*

---

## `/hi` — Morning, Mid-Campaign (Day 47)

```
══════════════════════════════
      DAY 47 · RAIN
══════════════════════════════

  [oak.ascii]

  You wake to rain on the tent. The
  fire is dead. The Oak's branches
  barely hold back the weather.

  ⚔️ Kaelen — Warrior
  Day-job: Town Guard (10c)
  Stamina: 6/10
  Rolls today: 1/3

  Your fellowship (2/8 at the Oak):
    🏹 Lina       [camped with you]
    📜 Elara      [arrived last night]

  Others reported:
    🛡️ Bram       [Stonebridge, 2 days east]
    🗡️ Vesper     [unknown — last seen Day 41]

  [Day-job]  [Travel]  [Rest]  [Hunt]
  [Scout]    [Talk to Lina]  [Talk to Elara]
══════════════════════════════
```

---

## `/action scout` — Co-op Bonus (Two Players at Oak)

Player Kaelen chooses [Scout]. Lina is at the same location → convergence bonus.

**Decision 1:**

```
══════════════════════════════
      DAY 47 · SCOUT
══════════════════════════════

  ⚔️ Kaelen climbs the Oak's highest
  branch. 🏹 Lina keeps watch below.

  +2 convergence bonus (co-op)

  From the canopy, you see two things:
  smoke rising from Stonebridge — not
  hearth-smoke, siege-smoke — and a
  thin trail winding east into the
  mist.

  [Watch the smoke]  [Follow the trail]  [Skip]
══════════════════════════════
```

Player picks [Watch the smoke].

**Decision 2:**

```
══════════════════════════════
      DAY 47 · SCOUT
══════════════════════════════

  The smoke is thick, black. Something
  big is burning. Lina counts three
  separate plumes.

  "That's not a campfire," she says.
  "That's a town."

  DC so far: 10

  [Estimate distance (-1 DC)]
  [Identify the source (+2 DC)]
  [Skip]
══════════════════════════════
```

Player picks [Identify the source]. DC now 14. Roll:

```
══════════════════════════════
      DAY 47 · SCOUT
══════════════════════════════

  Scout DC 14.

  🎲 19 ✓

  Stonebridge. The eastern gate is
  ablaze. Figures — too many to count
  — move in the fields beyond. Not
  farmers. Soldiers.

  → QUEST OPENED: "Stonebridge Burning"
     Reach Bram in Stonebridge before
     the siege closes the road. 3 days.
     Shared with: 🏹 Lina

  → Lina's map updated with smoke plume
     positions.

  Rolls remaining: 0/3
══════════════════════════════
```

---

## `/action talk` — NPC Interaction, Night at the Oak

```
══════════════════════════════
     THE WARDEN'S OAK · NIGHT
══════════════════════════════

  [campfire.ascii]

  Firelight. The warden — silent as
  always — tends the flames. You are
  the only one awake.

  The warden sets down a worn cup
  beside you. Inside: not water.
  A single ember, glowing faintly.

  You look up. The warden meets your
  eyes for the first time. Then looks
  east. Toward the smoke.

  Talk DC 16.

  [Roll d20]  [Skip]
══════════════════════════════
```

Player rolls. Success:

```
══════════════════════════════
     THE WARDEN'S OAK · NIGHT
══════════════════════════════

  🎲 17 vs DC 16 ✓

  "Some fires start before the
  kindling is laid," says the warden.
  "Bram is not in Stonebridge. He
  never was."

  → BOND: Warden trust +2
     New marker on map: ??? (east)

  → Lina stirs in her sleep. She heard
    something. Tomorrow, she'll ask.

  Rolls remaining: 0/3
══════════════════════════════
```

---

## `/action travel` — Convergence, Two Players Meet

```
══════════════════════════════
      DAY 47 · TRAVEL
══════════════════════════════

  [road.ascii]

  ⚔️ Kaelen sets out east toward
  Stonebridge. Rain hammers the road.

  🏹 Lina is already on the road ahead
  — you spot her cloak through the mist.
  Travel together?

  [Join Lina (+2 convergence)]
  [Travel alone]
  [Skip (stay at Oak)]
══════════════════════════════
```

Player picks [Join Lina]:

```
══════════════════════════════
      DAY 47 · TRAVEL
══════════════════════════════

  +2 convergence bonus

  Travel DC 12.

  🎲 14 vs DC 12 ✓

  You catch up to Lina at the old
  waystone. She's soaked but smiling.

  "Kaelen. I was starting to think
  I'd be walking into Stonebridge
  alone."

  → LOCATION: Old Waystone
     Halfway to Stonebridge.
     +1 bond with Lina.

  Rolls remaining: 0/3
══════════════════════════════
```
