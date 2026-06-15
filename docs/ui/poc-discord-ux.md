---
title: Discord UX — POC Constraints
status: exploring
domain: ui
phase: poc
tags:
- discord
- ui
related:
- '[[the-poc]]'
- '[[poc-example-scenes]]'
- '[[poc-build-scenes]]'
- '[[poc-build-probabilistic]]'
- '[[poc-build-world-tick]]'
- '[[poc-spec-reconciliation]]'
- '[[mvp-discord-ux]]'
---

# Discord UX — POC Constraints

> *The hard rules for Discord interaction in the POC. One message per action, mobile-first, buttons-only.*

---

## Mobile-First

The primary viewport is a **phone Discord client**. Everything must work at:

| Constraint | Limit |
|---|---|
| **Width** | Hard cap **30 chars** — phone portrait, no horizontal scroll (enforced at scene load, see [[poc-build-scenes]] §2). |
| **Height** | ~32 lines max per message (tested). Keep scenes + body + buttons within this. |
| **Message size** | One message per action (edit in place, don't spawn new messages) |
| **Buttons per row** | 5 max (Discord), prefer 3-4 for fat-finger safety |
| **Scrolling** | Minimal vertical scroll per message |
| **Emoji** | Use sparingly — render differently per platform |

**Rule:** Compose for the narrowest viewport. If it works on a phone, it works everywhere.

---

## Buttons Only

No reactions, no select menus. Free text is limited to two entry points — the `/action <description>` command argument and the `/join` name modal; **every branching interaction is buttons**, and game logic never parses button labels (each button carries its payload).

- Character creation: class pick, upbringing, race, build, alignment, day-job, item set
- Opening scene: day-job / adventure hooks that launch the `/action` flow
- Decision flow: LLM-generated options + [Roll d20] / [Skip]
- Confirmation: [Confirm] / [Start Over]

**Button rules:**
- Max 5 per message row (Discord hard limit)
- Buttons expire after the action concludes — no stale clicks
- Button press = one state advance, same as a slash command would do
- Each button carries its payload (dc_modifier, action_type, target) — the game logic never parses button labels

---

## One Message Per Action

The bot edits a single Discord message as the action flow advances. No new messages per step.

```
/hi → message 1 (opening scene + action buttons)
       ↓ player clicks [Hunt]
     → message 1 edited (decision 1 + buttons)
       ↓ player clicks [Follow deer]
     → message 1 edited (decision 2 or final roll/skip)
       ↓ player clicks [Roll d20]
     → message 1 edited (outcome)
```

If Discord rate-limits message edits, sending a follow-up message is acceptable — but the target is one evolving message.

### Message Emoji Signals

Every message carries a leading emoji in its header to signal the message type at a glance. The player should know what kind of message they're looking at before they read a word.

| Emoji | Message type | Example |
|---|---|---|
| 🌳 | Location scene | Arriving at the Oak |
| 🔥 | Narrative beat | Warden speaks, story moment |
| ⚔️ | Character / action prompt | Character sheet, action buttons |
| 🏹 | Action started | `/action hunt` begins |
| 🤔 | Decision point | LLM presents choices |
| 🎲 | Roll prompt | "Roll d20 or skip?" |
| ✅ | Success outcome | Roll succeeded |
| 💨 | Skipped / bailed | Action abandoned |
| 🎒 | Inventory | `/backpack` |
| 🌙 | Day ends | `/sleep` transition |
| 🌄 | New day begins | Day 2 header |
| ✍️ | Text input | `/join` name entry |
| ✝️ / 🧙‍♂️ / 🎵 | Class-specific | Matches the active class |

**Rule:** The emoji changes as the message state changes. A hunt action goes 🏹 → 🤔 → 🎲 → ✅ (or 💨). The player learns the rhythm.

### Threads

The bot's action message can be the thread parent. Player responses and follow-up decisions stay in the thread, keeping the channel clean. Thread auto-archives after the action concludes (or after 1 hour of inactivity).

```
#the-oak channel
  └─ 🧵 "Day 1 · Hunt" (bot message)
       ├─ Player clicks [Follow deer]
       ├─ Bot edits: decision 2
       ├─ Player clicks [Roll d20]
       └─ Bot edits: outcome
```

---

## Accessibility

- **Text is the primary medium.** ASCII art is decorative — all critical information is in plain text.
- **Symbols alongside color.** Status markers use symbols (✓ ✗) alongside any color formatting.
- **Emoji have text fallbacks.** Screen readers read emoji names — choose emoji that make sense when read aloud.
- **Commands are discoverable.** `/help` lists everything. First-time users have `/join` → `/hi` as a guided path.

---

## Command List (POC)

| Command | Type | Description |
|---|---|---|
| `/join` | Deterministic | Character creation wizard. One-time. |
| `/hi` | Deterministic | Opening scene. Atmosphere → [Begin] → day-job hooks (weekday) or adventure hooks (weekend). Once per day (cached). Resumes mid-action state. |
| `/action <description>` | Probabilistic | Free-text action; the LLM distills the type (hunt, travel, talk…). Consumes 1 roll. |
| `/look` | Deterministic | Current location scene + description. |
| `/journal` | Deterministic | Known locations, NPCs, recent actions. |
| `/backpack` | Deterministic | Emoji grid of items. |
| `/stats` | Deterministic | Character status. Same layout as `/join` summary screen. |
| `/sleep` | Deterministic | **Admin:** advance the day + reset rolls (also fires via nightly cron). **Non-admin:** make camp by the Oak (rest scene), no tick. See [[poc-build-world-tick]]. |
| `/help` | Deterministic | Command reference. |
| `/feedback` | Deterministic | Submit feedback. |
| `/bug` | Deterministic | Report a bug. |
