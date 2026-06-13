---
title: POC Build — Scaffold
status: spark
domain: spark
phase: poc
tags:
- poc
- build-plan
related:
- '[[poc-build-plan]]'
---

# POC Build — Scaffold

> *Part of [[poc-build-plan]]. Project init, bot registration, DB setup, and deterministic commands.*

---

## Deterministic commands

### `/hi` — Opening scene

- [ ] Load `oak.ascii` fragment, compose opening scene message
- [ ] Narrative text: warden, ember, smoke, "you're the last"
- [ ] Display character name, class emoji, rolls remaining
- [ ] Single action button with goal, i.e. `/action <type> <descrtiption`
- [ ] Resumption: if player has a mid-action state, resume from last decision
- [ ] Timeout: if action state is stale, show failed outcome and reset
- [ ] Once per day: repeated `/hi` returns cached scene (no re-generation)

### `/look`

- [ ] Return current location scene (ASCII fragment + description)
- [ ] Cached — same scene until location changes

### `/backpack`

- [ ] Query items table for player
- [ ] Render as emoji grid in a code block
- [ ] Show quantities

### `/stats`

- [ ] Display character sheet: name, class, stamina, rolls remaining, location
- [ ] Plain text, no ASCII art

### `/help`

- [ ] List all commands with one-line descriptions
- [ ] Action types and what they do

### `/feedback`

- [ ] Accept free-text feedback, append to `feedback` table in SQLite
- [ ] Confirmation message: "Thanks. The warden listens."
