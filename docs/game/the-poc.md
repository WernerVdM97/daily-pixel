---
title: The POC — One-Week Proof of Concept
status: exploring
domain: game
phase: poc
tags:
- poc
- scope
- build-plan
related:
- '[[mvp-architecture]]'
- '[[mvp-core-loop]]'
- '[[poc-discord-ux]]'
- '[[hazard-map]]'
- '[[pitch-and-pillars]]'
---

# The POC — One-Week Proof of Concept

> *Prove the simplest possible version of the game works end-to-end. Ship it to some friends. Everything else waits.*

---

## What This Is

A one-week build that answers exactly one question: **"Do people enjoy a daily Discord RPG where their decisions shape the dice?"**

Not "is the NPC economy balanced?" Not "does the moral drift system feel right?" Not "is the December climax satisfying?" Just: does the core ritual — wake up, open Discord, take an action, make a choice, roll the dice, see the outcome — spark joy?

If yes → Phase 3 (MVP). If no → we learned something and didn't waste a year.

---

## What Ships

### The Bot (TypeScript + Discord.js)

One process. No cron. Actions split into two paths: probabilistic (LLM + dice + roll consumption) and deterministic (instant, free, no roll consumed).

| Feature                 | Implementation                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Slash commands**      | `/hi` (opening scene), `/action <type>`, `/look`, `/journal`, `/help`<br>`/backpack` (deterministic), `/stats` (deterministic), `/feedback`, `/bug`                                                                                                                                                                                                                            |
| **Action types**        | ex `hunt`, `travel`, `rest`, `scout`, `talk`, `attack`<br>fixed list for POC, free-form for MVP<br>Actions should be based off of set character abilities.                                                                                                                                                                                   |
| **Roll economy**        | 2 daily rolls. Each `/action` consumes 1.<br>Unused rolls lost at midnight.                                                                                                                                                                                                                                                                  |
| **Decision generation** | LLM (DeepSeek V4 Flash) generates 1-2 decision branches per action.<br>TBD tokens per call.<br>Decisions can spawn new nodes in DB (new NPC interaction, new item found, new town discovered)                                                                                                                                                |
| **DC adjustment**       | Each player choice nudges the DC up or down.<br>AI rolls for environment/NPC.<br>Base DC varies by action type.                                                                                                                                                                                                                              |
| **Confirm or skip**     | After decisions, player sees final DC.<br>Button to roll d20 or skip if it the action optional <br>(for exmaple, initiating combat is optional, but not a reaction to getting attacked not).                                                                                                                                                 |
| **Consequence**         | Skipping incurs no penalty for optional rolls.<br>Not confirmind a required roll times out and auto fails.<br>Succeed -> you (or others) get rewarded,<br>Fail -> you (or others) get penalised.<br>Either way, your actions could have consequences that ripple through the simulated world.<br>(steal from the town, NPCs starve to death) |
| **Outcome**             | Template text based on success/failure for narration.<br>AI computes SQL and updates relationships in graph DB<br>Longer term outcomes are not narrated immeadiately but come up again later or the following (or multiple) day(s).                                                                                                          |
| **ASCII art**           | Pre-rendered fragment library.<br>Hardcoded scenes composed by templates in assets.                                                                                                                                                                                                                                                          |
| **State**               | All server side in DB.<br>`rolls_remaining`, `stamina`, current location.<br>Character class, level.<br>NPC wealth.                                                                                                                                                                                                                          |
| **Discord output**      | Opening scene, then<br><br>One message per action: <br>new scene + decision prompt → <br>decision options → <br>roll (or skip) → <br>outcome                                                                                                                                                                                                 |

### Action Flow

The player's first command is `/hi`, which triggers the opening scene. 
A player can only trigger this command once a day and is presented with the same cached version if repeated.
From there, every `/action` flows through the same pattern.
Calling `/hi` after an action, just resumes the last state of the action (unless it has timed out, in which case the failed outcome is displayed).

#### Opening Scene — `/hi`

Always opens with pure atmosphere, then presents contextual day-job hooks after the player clicks [Begin].

```
/hi
  │
  ▼
┌──────────────────────────────────────┐
│  MESSAGE 1 — The Oak (atmosphere)    │
│                                      │
│  [oak.ascii]                         │
│                                      │
│  The fire has been burning since     │
│  before you arrived. The warden —    │
│  silent, hooded — tends the flames.  │
│  They don't look up. Not yet.        │
│                                      │
│  [Begin]                             │
└──────────────────┬───────────────────┘
                   │ Player clicks
                   ▼
┌──────────────────────────────────────┐
│  MESSAGE 2 — Warden + Day-job hooks  │
│                                      │
│  The warden sets down a cup. Inside: │
│  not water. A single ember.          │
│                                      │
│  "You're the last."                 │
│  "The others went east."            │
│                                      │
│  ⚔️ Kaelen — Town Guard (10c)       │
│  Rolls: 2/2 · Stamina: 9/10          │
│                                      │
│  [Patrol the walls] [Check east gate]│
│  [Train at barracks] [Something…]    │
└──────────────────────────────────────┘
```

**Message 1 is pure atmosphere.** The player arrives, takes in the Oak, then chooses to begin. No decisions yet — just presence.

**Message 2 is the decision point, rooted in who the character is.** The hooks are contextual to the player's day-job (loaded from `day-jobs.yml`). A Town Guard gets patrol/gate/barracks. A Hunter gets tracking/trapping/snares. A Scribe gets cataloging/letters/maps. The final button [Something else…] opens free `/action` choices.

**Weekdays** show job hooks. **Weekends** (Friday–Sunday) show open-ended adventure hooks instead — travel, scout, hunt, talk. No guaranteed income, higher risk/reward.

**Repeated `/hi`** on the same day returns the cached scene. **Mid-action resumption:** if the player disconnected mid-action, [Begin] resumes from the last decision. Timed-out actions show the failed outcome.

#### Action Flow

One message per action, evolving through states as the player interacts.

```
/action hunt
     │
     ▼
┌──────────────────────────────────────┐
│  MESSAGE 1 — Scene + Decision 1      │
│                                      │
│  [oak.ascii]                         │
│                                      │
│  ⚔️ Kaelen sets out to hunt.         │
│                                      │
│  You spot deer tracks heading east   │
│  into the thicket, and larger        │
│  prints — wolf — north.              │
│                                      │
│  [Follow deer] [Track wolf] [Bail]   │
└──────────────────┬───────────────────┘
                   │ Player picks
                   ▼
┌──────────────────────────────────────┐
│  MESSAGE 2 — Decision 2 (if needed)  │
│                                      │
│  The thicket is dense and dry.       │
│  Move slow and quiet, or push        │
│  through before the trail goes cold? │
│                                      │
│  [Stalk (+2)] [Rush (-1)]  [Bail]    │
└──────────────────┬───────────────────┘
                   │ Player picks
                   ▼
┌──────────────────────────────────────┐
│  MESSAGE 3 — Final: roll or bail     │
│                                      │
│  Hunt DC 14.                         │
│                                      │
│  [Roll d20]  [Bail (wisdom)]         │
└──────────┬───────────────┬───────────┘
           │               │
    [Roll] ▼               ▼ [Bail]
┌──────────────┐   ┌───────────────────┐
│  MESSAGE 4   │   │  MESSAGE 4        │
│              │   │                   │
│  🎲 16 vs 14 │   │  You slip back    │
│  ✓ success   │   │  into the brush.  │
│              │   │  The hunt is lost.│
│  You emerge  │   │  -1 stamina.      │
│  with a young│   │                   │
│  buck. +2    │   │                   │
│  meat.       │   │                   │
│              │   │                   │
│  Rolls: 1/2  │   │  Rolls: 1/2       │
└──────────────┘   └───────────────────┘
```

**Message lifecycle:** The bot edits a single Discord message as the flow advances. No new messages per step — one action, one message slot, four states. If Discord doesn't allow editing (rate limits), subsequent messages are fine, but the target is one evolving message.

### Two Action Types

| Type | Trigger | LLM? | Dice? | Consumes roll? | Example |
|---|---|---|---|---|---|
| **Probabilistic** | `/action <type>` | Yes — generates decisions | Yes — d20 vs DC | Yes (1 of 2/day) | `/action hunt`, `/action travel` |
| **Deterministic** | `/backpack`, `/stats`, `/look`, `/journal`, `/help`, `/feedback`, `/bug` | No | No | No | `/backpack` → emoji grid of items |

**Deterministic actions are instant.** The bot fetches data and renders it — no LLM call, no decision tree, no roll consumed. A player can check their backpack as many times as they want.

**Probabilistic actions are the game.** Each one is a mini narrative loop: LLM generates a situation, the player makes choices, the dice resolve the outcome. Consumes 1 of 2 daily rolls.

### ASCII Fragment Library

Pre-rendered scenes loaded from `assets/` as string constants:

| Fragment          | File              | Use                              |
| ----------------- | ----------------- | -------------------------------- |
| The Warden's Oak  | `oak.ascii`       | Default scene. `/look` shows it. |
| The Open Road     | `road.ascii`      | Travel actions.                  |
| Campfire at Dusk  | `campfire.ascii`  | Rest actions.                    |
| Village Shopfront | `shopfront.ascii` | Town / settlement arrival.       |
(and more TBD)

**Composition:** The bot picks a fragment based on action type and location. Characters are marked with class emojis only (⚔️ 🏹 📜 🗡️) — no sprite art in POC.

## Feedback

Lastly, each session should end with a reminder to submit feedback via `/feedback` and bugs via `/bug`.

---

### What's deliberately NOT in the POC

| Skipped                          | Why                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| Daily cron / auto-tick           | Manual `/action` is enough to test engagement <br>Manual `/sleep` is invoked for tick. |
| Multiple players / co-op         | One player at a time. Fellowship comes in MVP                                          |
| Reaction-based input             | Buttons only. Reactions add complexity without benefit.                                |
| Stamina system (deep)            | One `stamina` integer. Bail reduces it. Rest recovers it.                              |
| Weekly rhythm / death track      | Not needed to test the core question                                                   |
| `ascii-image-converter` pipeline | Deferred to MVP. Fragments are simpler and faster for POC.                             |
| PNG/MP4 rendering                | Deferred to MVP+. No visual-rich path until core loop is proven.                       |
