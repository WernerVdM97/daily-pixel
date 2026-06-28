---
title: Example Scenes — POC
status: shipped
domain: archived
phase: poc
superseded_by: "implemented in code"
tags:
- discord
- ascii
- poc
related:
- '[[the-poc]]'
- '[[archived/poc/poc-build-scaffold|poc-build-scaffold]]'
- '[[archived/poc/poc-build-probabilistic|poc-build-probabilistic]]'
---

# Example Scenes — POC

> *What the player sees. Every message carries a leading emoji to signal the message type at a glance.*

---

## `/join` — Character Creation Wizard

```
══════════════════════════════
      ✍️ WHO ARE YOU?
══════════════════════════════

  Name: ____________

  [Submit]
══════════════════════════════
```

Name submitted. Next step — class pick:

```
══════════════════════════════
      ⚔️ CHOOSE YOUR CLASS
══════════════════════════════

  Warrior    ⚔️  Blade and shield.
             Physical +3  Wisdom -1

  Ranger     🏹  Bow and beast.
             Physical +1  Wisdom +2  Charisma -1

  Wizard     🧙‍♂️  Arcane and ancient.
             Physical -2  Intelligence +3

  Bard       🎵  Song and story.
             Physical -1  Intelligence +1  Charisma +2

  Priest     ✝️  Faith and flame.
             Wisdom +2  Charisma +1

  [Warrior]  [Ranger]  [Wizard]  [Bard]  [Priest]
══════════════════════════════
```

(Upbringing, Race, Build, Alignment, Day-job, Item Set — same pattern, each with a leading emoji.)

Final summary (same layout reused for `/stats` mid-game):

```
══════════════════════════════
      ✅ CHARACTER CREATED
══════════════════════════════

  Kaelen — Warrior ⚔️
  Soldier upbringing · Human · Tall · Normal
  Lawful Good

  PHYSICAL  +4   WISDOM  -1
  INT       -1   CHARISMA  0

  Day-job: Town Guard (10c/day)
  Patrol the walls. Break up tavern
  brawls.

  Items:
  ⚔️ Iron Sword  🛡️ Wooden Shield
  🍞 Travel Rations ×3

  [Confirm]  [Abort]
══════════════════════════════
```

---

## `/hi` — Opening Scene (Day 1, Weekday)

Always opens with atmosphere, then presents day-job hooks after [Begin].

**Message 1 🌳 — The Oak (scene + atmosphere):**

```
══════════════════════════════════════
        🌳 DAY 1 · THE OAK
══════════════════════════════════════

         ,@@@@@@,
    ,,,,.@@@@@@@@,,,,,
  ,@@@@@@@@@@@@@@@@@@,
 @@@@@@@@@@@@@@@@@@@@@@
 @@@@@,,,,,@@@@@@@@@@@@
  @@@@         @@@@@@@@
    @@             @@@
     @@
            /\
           /  \
          /    \
         /  /\  \
        /  /  \  \
       /        ` \
      ´-...____...-´

  The fire has been burning since
  before you arrived. The warden —
  silent, hooded — tends the flames.
  They don't look up. Not yet.

  [Begin]
══════════════════════════════════════
```

**Message 2 🔥 — Day-job hooks (Town Guard):**

```
══════════════════════════════════════
        🔥 DAY 1 · THE OAK
══════════════════════════════════════

  The warden sets down a worn cup
  beside you. Inside: not water.
  A single ember, glowing faintly.

  "You're the last," says the warden.
  "The others came through weeks ago.
  East, toward the smoke."

  They look at you. Then east.
  A long silence.

  ⚔️ Kaelen — Warrior
  Day-job: Town Guard (10c)
  Rolls: 2/2 · Stamina: 9/10

  [Patrol the walls]  [Check the east gate]
  [Train at barracks]  [Something else…]
══════════════════════════════════════
```

**The hooks are contextual to the day-job.** Town Guard gets patrol/east gate/barracks. A Scribe gets cataloging/letters/maps. A Hunter gets tracking/trapping/snares. The final button [Something else…] always opens free `/action` choices.

**On weekends** (Friday–Sunday), the hooks are open-ended adventure hooks instead of day-job tasks — travel, scout, hunt, talk. No guaranteed income, higher risk/reward.

**The [Begin] button is the gate.** Message 1 is pure atmosphere — the player arrives, takes in the scene, then chooses to begin. Message 2 is the decision point, rooted in who the character is.

---

## `/action hunt` — Probabilistic Action Flow

**Decision 1 🏹:**

```
══════════════════════════════════════
         🏹 DAY 1 · HUNT
══════════════════════════════════════

  [road.ascii]

  ⚔️ Kaelen sets out to hunt.

  You spot deer tracks heading east
  into the thicket, and larger prints
  — wolf — heading north toward the
  ridge.

  [Follow deer]  [Track wolf]  [Skip]
══════════════════════════════════════
```

Player picks [Follow deer]. Decision 2:

```
══════════════════════════════════════
        🤔 DAY 1 · HUNT
══════════════════════════════════════

  [road.ascii]

  The thicket is dense and dry. Move
  slow and quiet, or push through
  before the trail goes cold?

  DC so far: 12

  [Stalk (+2 DC)]  [Rush (-1 DC)]  [Skip]
══════════════════════════════════════
```

Player picks [Stalk]. Final — roll or skip:

```
══════════════════════════════════════
        🎲 DAY 1 · HUNT
══════════════════════════════════════

  [road.ascii]

  Hunt DC 14.

  [Roll d20]  [Skip]
══════════════════════════════════════
```

Player picks [Roll d20]. Outcome:

```
══════════════════════════════════════
        ✅ DAY 1 · HUNT
══════════════════════════════════════

  🎲 16 vs DC 14 ✓

  You emerge from the thicket with
  a young buck. Enough meat for the
  evening fire — and the warden nods
  in approval.

  +2 meat · +1 stamina

  Rolls remaining: 1/2
══════════════════════════════════════
```

*(If player had chosen [Skip]:)*

```
══════════════════════════════════════
        💨 DAY 1 · HUNT
══════════════════════════════════════

  You slip back into the brush.
  The hunt is lost.

  -1 stamina

  Rolls remaining: 1/2
══════════════════════════════════════
```

---

## `/stats` — Character Status

Same layout as the `/join` summary screen. Shows current state mid-game.

```
══════════════════════════════════════
      ⚔️ KAELEN · STATUS
══════════════════════════════════════

  ⚔️ Kaelen — Warrior
  Soldier upbringing · Human
  Lawful Good

  PHYS  +4   WIS  -1
  INT   -1   CHA   0

  Day-job: Town Guard (10c/day)
  Location: The Warden's Oak
  Stamina: 7/10
  Wealth: 34c

  Rolls today: 1/2
══════════════════════════════════════
```

---

## `/backpack` — Deterministic

```
══════════════════════════════════════
      🎒 BACKPACK · KAELEN
══════════════════════════════════════

  ⚔️  Iron Sword
  🛡️  Wooden Shield
  🍞  Travel Rations  ×3
  🥩  Venison          ×2

══════════════════════════════════════
```

---

## `/sleep` — Day Transition

```
══════════════════════════════════════
        🌙 DAY 1 ENDS
══════════════════════════════════════

  The fire burns low. The warden
  banks the coals. You sleep beneath
  the Oak.

  +2 stamina (safe location)

══════════════════════════════════════
        🌄 DAY 2 · THE OAK
══════════════════════════════════════

  The smoke is closer.

  Rolls today: 2/2
  Day-job: Town Guard (10c)

══════════════════════════════════════
```
