---
title: Discord UX — MVP+
status: spark
domain: spark
phase: mvp
tags:
- discord
- mvp
related:
- '[[poc-discord-ux]]'
- '[[mvp-core-loop]]'
---

# Discord UX — MVP/MVP+

> *Interaction patterns deferred from the POC. Reactions, free text, select menus, multi-player batch strategy.*

---

## Reactions (MVP)

For quick binary signals without buttons:

```
🔼 North    🔽 South    ◀ West    ▶ East    (map movement)
👍 Accept quest    👎 Decline quest
```

- Lightweight — good for map nav, consent, binary choices.
- Never use reactions for text input — they carry no context.
- Reactions persist on the message until the next tick clears them.

---

## Free Text (MVP+)

```
"go east"              → parsed to action: travel, direction: east
"talk to the warden"   → parsed to action: talk, target: npc_warden
```

- Natural language input for players who prefer typing.
- Requires an LLM pass to parse intent → action enum + params.
- Slash commands + buttons cover 90% of interactions; free text is the 10% delight layer.

---

## Select Menus (MVP)

For lists that exceed 5 options or grow dynamically:

```
Choose your destination:
  ▸ The Warden's Oak
    Stonebridge
    Raven's Hollow
    Eastwood Mill
```

- Use when known locations / NPCs / quests list grows beyond a button row.
- One menu per message. Player picks, bot resolves.

---

## Batch Message Strategy (MVP)

Once multiple players and daily cron ticks are in play:

| Message | Content |
|---|---|
| **DM** (morning) | Day header, environment, roll count, available actions (buttons). |
| **DM** (after rolls) | Roll results, ASCII scene, relationship changes. |

Public channel messages only for:
- Fellowship-wide events (someone died, new quest opened, weekend event).
- The weekly summary (one message in `#the-oak` each Sunday).

**Never:**
- Send a message per roll (notification spam).
- Send updates for passive auto-sim events.
- Send "Bram rested at the Oak" every day.

---

## Scene Rendering Triggers (MVP)

Scenes are rendered:
1. After all daily rolls are used (the "daily recap card").
2. On demand (`/look`).
3. On significant events (quest completion, NPC interaction, death).

---

## Action Layer (MVP)

The concept from the POC extends naturally to MVP. All input — slash commands, free text, buttons, reactions — resolves through the same action resolver:

```
DISCORD INPUT                    GAME ACTION
─────────────                    ────────────
/action travel east    ──→        action: travel, direction: east
"go east"              ──→        action: travel, direction: east
🔼 reaction on map      ──→        action: travel, direction: north
Button [Travel East]   ──→        action: travel, direction: east
```

Adding a new input method never changes game logic — just adds another route to the same resolver.
