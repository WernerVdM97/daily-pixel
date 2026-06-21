---
title: Goodnight, Absence Penalty, and Rest Features
status: shipped
domain: archived
phase: poc
tags: [sleep, journal, navigation, penalties, safety]
superseded_by: "implemented in code"
related:
  - "[[poc-build-action-ux]]"
  - "[[poc-discord-ux]]"
---
---

> **As a player,** I want rest to feel meaningful, unsafe areas to carry risk, and my journal to hold narrative weight so the world feels alive even when I'm not actively driving an action.

> Status tracking: `[x]` done · `[/]` partial · `[ ]` not started

---

## Proposed changes

### 1. `/sleep` Good Night Message `[ ]`

Replace the bare text response with a **Components V2** good-night embed with:

- A **warm narrative** about bedding down at the Oak or wherever the character is
- **Action button** — starts `/action` (opens day-job menu or resumes mid-action)
- **Feedback button** — opens the feedback flow

### 2. Three-Day Absence Penalty `[ ]`

On world tick, if a character hasn't interacted (`last_played_at` >= 3 days ago):

- They lose **3 health** (floored at 0)
- A warning is **logged** and should be surfaced when they next `/hi`

Storage:

- Add `last_played_at TEXT` column to `player_characters`
- Update it on: `/action`, `/hi`, `/look`, `/sleep`
- (In future: `/backpack`, `/stats`, `/journal`)

### 3. Feedback & Bug Report Buttons on Action Outcomes `[ ]`

Append **Feedback** and **Bug Report** buttons to the public outcome follow-up message.

- Clicking opens a **modal** to type the report
- Submitted text routes to `engine.submitFeedback()` / `engine.submitBug()`

### 4. Nav Button Cleanup `[ ]`

Remove `look`, `stats`, `backpack` from the global nav bar.

Keep: `hi`, `journal`, `action`, `sleep`

### 5. Journal Narrative `[ ]`

Save the LLM's `outcomeText` as a narrative snippet for each action.

- Add `narrative TEXT` column to `actions` table (migration)
- Populate it during `applyResolution()` from `outcome.outcomeText`
- Show narrative entries in `/journal` as quoted story beats under "Recent Actions"

### 6. Location Safety Emojis `[ ]`

Prefix location names with a safety emoji:

- Safe: 🛡️ → `🛡️ The Warden's Oak`
- Unsafe: ⚠️ → `⚠️ The Dark Pines`

Render this in `/hi`, `/look`, and `/journal`.

### 7. Unsafe Sleep Repercussions `[ ]`

If a player uses `/sleep` while at an **unsafe** location (not the Oak):

- They **lose 1 health** from a rough night
- They still wake at the Oak (pulled there at dawn)
- Flavour text reflects the rough night

### 8. Feedback Enhancement: Screen Context + Sentiment Emojis `[ ]`

When the feedback button is pressed:

- Save which **screen/command** the player was on when they hit feedback (e.g. `/action` outcome, `/hi`, `/look`, goodnight message)
- Present a row of **emoji sentiment buttons** for quick feeling: 😊 good, ☹️ bad, 😄 happy, 💔 broken, etc.
- The screen context + sentiment choice get stored alongside the free-text feedback

---

## Implementation Plan

### Phase 1: Schema + Track last_played_at `[x]`

- [x] Migration: `ALTER TABLE player_characters ADD COLUMN last_played_at TEXT`
- [x] Migration: `ALTER TABLE actions ADD COLUMN narrative TEXT`
- [x] Update `WorldEngine` calls to stamp `last_played_at`

### Phase 2: Tick Penalty `[x]`

- [x] In `tick()`, check `last_played_at` for 3+ days, apply -3 health

### Phase 3: Nav + Location Emoji `[ ]`

- [ ] Remove look/stats/backpack from `NAV_BUTTONS`
- [ ] Prepend safety emoji to location names in `hi`, `look`, `journal`

### Phase 4: Journal Narrative `[ ]`

- [ ] Stamp `outcome.outcomeText` as `narrative` on action rows
- [ ] Render narrative in `/journal`

### Phase 5: Good Night Embed `[x]`

- [x] `/sleep` adds Action + Feedback buttons to the good night message
- [x] Unsafe sleep penalty: -1 HP if bedding down outside a safe area
- [x] Feedback button opens a modal, routes to engine.submitFeedback()
- [x] Action button navigates to the day-job /action screen

### Phase 6: Outcome Buttons `[x]`

- [x] Append feedback/bug buttons to action outcome follow-ups
- [x] Handle modal submissions

### Phase 7: Feedback Enhancement `[ ]`

- [ ] Capture screen context when feedback button is pressed
- [ ] Present emoji sentiment buttons
- [ ] Store context + sentiment with feedback

---

### Extra — soul count + alone indicator `[x]`

- [x] Good night reports how many souls did not make it home (`countSoulsInUnsafe()`)
- [x] `/look` shows "_Silence. You are alone here._" when no entities

---

### Checkpoints

1. Schema + migration tests pass → `[x]`
2. Tick tests pass (absence penalty) → `[x]`
3. Nav, location emoji render correctly → `[x]`
4. Journal shows narrative → `[x]`
5. Sleep command produces embed with working buttons → `[x]`
6. Outcome message has working feedback/bug buttons → `[x]`
7. Feedback captures screen + sentiment → `[ ]`
