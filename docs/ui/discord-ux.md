---
title: Discord UX — Command Flows & Interaction Patterns
status: exploring
domain: ui
tags: [discord, ux, commands, interactions, action-layer, mobile-first]
related:
  - "[[core-loop]]"
  - "[[example-scenes]]"
  - "[[architecture]]"
---

# Discord UX

> *The player types a command or taps a button. The game resolves an action. The screen shows one message. That's the loop.*

---

## The Action Layer

Player input never touches game logic directly. All input — slash commands, free text, button presses, reactions — resolves through an **action layer**:

```
DISCORD INPUT                    GAME ACTION
─────────────                    ────────────
/travel east          ──→        action: travel, direction: east
"go east"             ──→        action: travel, direction: east
🔼 reaction on map     ──→        action: travel, direction: north
Button [Travel East]  ──→        action: travel, direction: east

/rest                 ──→        action: rest
"make camp"           ──→        action: rest

/scout                ──→        action: act, subtype: scout
/talk @NPC            ──→        action: act, subtype: talk, target: npc_id
/fight                ──→        action: act, subtype: fight
```

**Why:** One action layer means the roll engine never parses Discord strings. Every input path resolves to the same action enum + parameters. Adding a button, reaction, or free-text parser never changes game logic — just adds another route to the same action resolver.

---

## Command Structure

### Core Commands

| Command | Params | Action | Cost |
|---|---|---|---|
| `/travel <direction \| location>` | direction or location name | Move toward destination. Triggers travel roll. | 1 roll |
| `/rest` | — | Recover stamina at current location. | 1 roll |
| `/act <type>` | scout, fight, talk, trade, craft, investigate | Context-dependent action at current location. | 1 roll |
| `/status` | — | Show your character sheet, stats, inventory. | 0 rolls |
| `/look` | — | Describe current location. Cached or fresh. | 0 rolls |

### Meta Commands

| Command | Purpose |
|---|---|
| `/map` | Show known world map (procedural, fog-of-war). |
| `/party` | Show fellowship status — who's where, who's active. |
| `/quests` | Active, completed, and available quests. |
| `/help` | Command reference and game rules. |

---

## The Daily Roll Flow

```
┌─────────────────────────────────────────┐
│  DAILY CRON FIRES (~00:00 UTC)          │
│  → Bot DMs each player:                 │
│    "Day 47. You have 2 rolls. Rain."    │
│    [Travel] [Rest] [Act]                │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  PLAYER RESPONDS (async, anytime)       │
│  → /travel east                         │
│  → Bot resolves roll, replies:          │
│    🎲 14 + 2 (rain) = 16 ✓              │
│    You reach the Oak by noon.           │
│    Roll 1/2 used.                       │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  PLAYER USES SECOND ROLL (or not)       │
│  → /rest                                │
│  → 🎲 4 — failure. -1 stamina.          │
│    All rolls used. See you tomorrow.    │
└─────────────────────────────────────────┘
```

- Rolls persist across the day. No time pressure.
- Unused rolls at midnight → auto-rest (if in the weekly window) or lost.
- Players can batch both rolls in one session.

---

## Interaction Patterns

### Buttons (Primary)

Used for common choices that don't need free-text input:

```
[Travel East] [Travel West] [Rest] [Scout]
[Talk to Warden] [Trade] [Fight]
"Yes, drink the ember."  "No, pour it out."
```

- Max 5 buttons per message row (Discord limit).
- Buttons expire after the daily tick (new day = new button set).
- Button press = one action resolution, same as `/command`.

### Reactions (Secondary, for quick signals)

```
🔼 North    🔽 South    ◀ West    ▶ East    (map movement)
👍 Accept quest    👎 Decline quest
```

- Reactions are lightweight — good for binary choices, map nav, consent.
- Never use reactions for text input — they carry no context.

### Free Text (Experimental, future)

```
"go east"           → parsed to action: travel, direction: east
"talk to the warden" → parsed to action: act, subtype: talk, target: npc_warden
```

- Nice-to-have, not POC. Free text parsing is fragile and adds token cost.
- Slash commands + buttons cover 90% of POC interactions.

### Select Menus (for lists)

```
Choose your destination:
  ▸ The Warden's Oak
    Stonebridge
    Raven's Hollow
    Eastwood Mill
```

- Use when choices > 5 or dynamic (e.g., known locations list grows).
- One menu per message. Player picks, bot resolves.

---

## Mobile-First Constraint

The primary viewport is a **phone Discord client**. Everything must work at:

| Constraint | Limit |
|---|---|
| **Width** | ~30 characters for ASCII art |
| **Message size** | 1–2 messages per interaction (batch where possible) |
| **Buttons per row** | 5 max (Discord), prefer 3–4 for fat-finger safety |
| **Scrolling** | Minimal vertical scroll per message — one scene, one message |
| **Emoji** | Use sparingly — render differently per platform |

**Design rule:** Compose for the narrowest viewport. If it works on a phone, it works everywhere.

---

## Batch Message Strategy

One daily tick = 1–2 Discord messages max. No rapid-fire updates.

| Message | Content |
|---|---|
| **Message 1** (DM) | Day header, environment, roll count, available actions (buttons). |
| **Message 2** (DM, after rolls used) | Roll results, ASCII scene, quest updates, relationship changes. |

Public channel messages only for:
- Fellowship-wide events (someone died, new quest opened, weekend event).
- The weekly summary (one message in `#the-oak` each Sunday).

**Never:**
- Send a message per roll (3 rolls = 3 messages = rate limit risk + notification spam).
- Send updates for passive auto-sim events.
- Send "Bram rested at the Oak" every day.

---

## Scene Rendering Trigger

Scenes are rendered:
1. After all daily rolls are used (the "daily recap card").
2. On demand (`/look`).
3. On significant events (quest completion, NPC interaction, death).

See [[example-scenes]] for the Day-47 daily-roll card and the Warden-at-night interaction as concrete rendered examples.

---

## Accessibility

- **Text is the primary medium.** ASCII art is decorative — all critical information is in plain text.
- **Color is never the sole signal.** Status markers use symbols (✓ ✗ ⚠️) alongside color.
- **Emoji have text fallbacks.** Screen readers read emoji names — choose emoji that make sense when read aloud.
- **Commands are discoverable.** `/help` lists everything. First-time users get a guided DM.
