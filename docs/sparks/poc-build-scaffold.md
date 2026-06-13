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

**Checklist:**

- [ ] Project init
- [ ] Bot registration
- [ ] Database
- [ ] Character creation
- [ ] Deterministic commands

---

## Project init

- [ ] `npm init`, install `discord.js`, `typescript`, `tsx`, `better-sqlite3`
- [ ] `.env` file with `DISCORD_TOKEN` and `DEEPSEEK_API_KEY`
- [ ] `tsconfig.json` — strict mode, target ES2022
- [ ] `src/index.ts` — entry point, Discord client login

## Bot registration

- [ ] Register bot with Discord Developer Portal
- [ ] Bot comes online, responds to `/ping` → "pong"
- [ ] Set up DeepSeek API client (fetch wrapper, env var for key)

## Database

- [ ] Initialize SQLite database file
- [ ] `players` table: `id`, `discord_user_id`, `name`, `class`, `stamina`, `rolls_remaining`, `location`, `last_action_state`
- [ ] `actions` table: `id`, `player_id`, `type`, `decisions_json`, `outcome`, `created_at`
- [ ] `items` table: `id`, `player_id`, `name`, `emoji`, `quantity`
- [ ] Load character creation YAML files from `assets/char-creation/` at startup
- [ ] Validate YAML schema on load (fail fast on bad data)
- [ ] One active character per user — enforce in DB constraint

## Character creation — `/join`

See [[poc-onboarding]] for full design.

- [ ] 6-step wizard flow, edited in place (one message)
- [ ] Step 1: Name — free text input modal
- [ ] Step 2: Class — 4 buttons, loaded from `classes.yml`
- [ ] Step 3: Upbringing — buttons, loaded from `backgrounds.yml`
- [ ] Step 4: Race — buttons, loaded from `races.yml`
- [ ] Step 5: Build — height + weight select menus
- [ ] Step 6: Alignment — 9 buttons (3×3 grid)
- [ ] Step 7: Day-job — buttons loaded from `day-jobs.yml`. Show stat dependency and base income.
- [ ] Step 8: Starting item set — buttons, loaded from `item-sets.yml`
- [ ] Summary page: all choices + cumulative modifiers + day-job + items
- [ ] Confirm: save to `players` table, `/hi` now works
- [ ] Abort: discard everything, no character created
- [ ] Re-join guard: error if user already has active character

## Deterministic commands

### `/hi` — Opening scene

- [ ] Message 1: oak.ascii + atmosphere + [Begin] button (no decisions yet)
- [ ] Message 2: warden narrative + character stats + day-job hooks as buttons
- [ ] Day-job hooks loaded from `day-jobs.yml` — contextual to the player's job
- [ ] Weekday: present 3 job-specific hooks + [Something else…] for free actions
- [ ] Weekend: present open-ended adventure hooks instead (travel, scout, hunt, talk)
- [ ] Resumption: if player has a mid-action state, [Begin] resumes from last decision
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

- [ ] Same layout as `/join` summary screen — reuse the template
- [ ] Display: name, class emoji, upbringing, race, alignment, all 4 stats, day-job, location, stamina, wealth, rolls remaining
- [ ] Plain text, no ASCII art

### `/help`

- [ ] List all commands with one-line descriptions
- [ ] Action types and what they do

### `/feedback`

- [ ] Accept free-text feedback, append to `feedback` table in SQLite
- [ ] Confirmation message: "Thanks. The warden listens."
