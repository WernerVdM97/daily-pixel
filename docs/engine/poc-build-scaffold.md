---
title: POC Build — Scaffold
status: decided
domain: engine
phase: poc
tags:
- poc
- build-plan
related:
- '[[poc-build-poa]]'
- '[[poc-tech-stack]]'
- '[[poc-spec-reconciliation]]'
---

# POC Build — Scaffold

> *Part of [[poc-build-poa]]. Foundation layer: project init, database, character creation, and all deterministic commands. Everything else depends on this.*

---

## 1. Project Init

Monolith TypeScript project. No build step — `tsx` runs directly.

**Dependencies:** `discord.js`, `typescript`, `tsx`, `better-sqlite3`, `js-yaml`.

**Config:**
- `tsconfig.json` — strict mode, target ES2022
- `.env` — `DISCORD_TOKEN`, `DEEPSEEK_API_KEY` (gitignored)

**Bot registration:** Discord Developer Portal — bot scope, `applications.commands` scope. Bot must respond to `/ping` → "pong" as a smoke test.

**Startup sequence** (`src/index.ts`):
1. Load + validate all YAML files from `assets/char-creation/`
2. Load + validate all `.ascii` files from `assets/scenes/`
3. Load + validate all prompt templates from `assets/prompts/` (fail-fast if a required prompt is missing — see [[poc-build-probabilistic]])
4. Initialize SQLite, run schema migrations
5. Register slash commands with Discord
6. Login client, set status

---

## 2. Database

SQLite via `better-sqlite3` — sync API, file-based, zero ops. Nine tables.

### `users`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `discord_user_id` | TEXT UNIQUE NOT NULL | Discord snowflake |
| `created_at` | TEXT | ISO timestamp |

### `player_characters`

One per user for POC. Split from `users` so the Discord identity and in-world entity are separate concerns.

| Column              | Type                            | Notes                                                           |
| ------------------- | ------------------------------- | --------------------------------------------------------------- |
| `id`                | INTEGER PK                      |                                                                 |
| `user_id`           | INTEGER UNIQUE FK → users       | One character per user for POC                                  |
| `name`              | TEXT NOT NULL                   | Character name                                                  |
| `class`             | TEXT NOT NULL                   | FK-ish to `classes.yml`                                         |
| `upbringing`        | TEXT NOT NULL                   | From `backgrounds.yml`                                          |
| `race`              | TEXT NOT NULL                   | From `races.yml`                                                |
| `alignment`         | TEXT NOT NULL                   | e.g. "lawful good"                                              |
| `day_job`           | TEXT NOT NULL                   | From `day-jobs.yml`                                             |
| `stats`             | TEXT (JSON) NOT NULL            | `{physical, wisdom, intelligence, charisma}` — base + modifiers |
| `health`            | INTEGER DEFAULT 10              | Current HP                                                      |
| `max_health`        | INTEGER DEFAULT 10              | Max HP                                                          |
| `stamina`           | INTEGER DEFAULT 10              |                                                                 |
| `rolls_remaining`   | INTEGER DEFAULT 2               | Reset by the daily tick (admin `/sleep` or cron), not player rest |
| `location`          | TEXT DEFAULT "The Warden's Oak" |                                                                 |
| `wealth`            | INTEGER DEFAULT 0               | Copper                                                          |
| `last_action_state` | TEXT (JSON, NULLABLE)           | Full action snapshot for `/hi` resumption. NULL when idle.      |
| `created_at`        | TEXT NOT NULL                   | ISO timestamp                                                   |

### `actions`

Inserted only at action completion. Mid-action state lives in `player_characters.last_action_state` for resumption.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `character_id` | INTEGER FK → player_characters | |
| `raw_input` | TEXT NOT NULL | What the player typed, e.g. `"go hunt a wolf"` |
| `type` | TEXT NOT NULL | LLM-distilled single word, e.g. `"hunt"` |
| `decisions_json` | TEXT (JSON) NOT NULL | LLM prompts + options + player choices — see example below |
| `final_dc` | INTEGER NOT NULL | Accumulated DC at roll time |
| `player_rolled` | INTEGER NULLABLE | d20 result. NULL if skipped or timed out. |
| `outcome` | TEXT NOT NULL | `success`, `failure`, `skipped`, `timed_out` |
| `created_at` | TEXT NOT NULL | ISO timestamp |

**`decisions_json` example:**

```json
[
  {
    "prompt": "You spot deer tracks heading east into the thicket, and larger prints — wolf — north.",
    "options": [
      { "label": "Follow deer", "dc_modifier": 0 },
      { "label": "Track wolf", "dc_modifier": 2 },
      { "label": "Bail", "dc_modifier": null }
    ],
    "chosen": "Follow deer"
  },
  {
    "prompt": "The thicket is dense and dry. Move slow and quiet, or push through?",
    "options": [
      { "label": "Stalk", "dc_modifier": -1 },
      { "label": "Rush", "dc_modifier": 2 },
      { "label": "Bail", "dc_modifier": null }
    ],
    "chosen": "Stalk"
  }
]
```

### `items`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `character_id` | INTEGER FK → player_characters | |
| `name` | TEXT NOT NULL | |
| `emoji` | TEXT NOT NULL | Single emoji for backpack grid |
| `stat` | TEXT NOT NULL | Which stat this item modifies: `physical`, `wisdom`, `intelligence`, `charisma` |
| `modifier` | INTEGER NOT NULL | Added to d20 rolls where the stat applies. Can be negative. |
| `quantity` | INTEGER NOT NULL DEFAULT 1 | |

### `npcs`

Spawned by the LLM during probabilistic actions. Mirrors `player_characters` with fewer columns. At spawn only `name`, `class`, and `description` are populated (see [[poc-build-probabilistic]] §4); the rest are nullable. NPC daily movement keys on `class` ([[poc-build-world-tick]] §3).

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT NOT NULL | |
| `class` | TEXT | e.g. "Blacksmith", "Hunter" |
| `race` | TEXT | |
| `day_job` | TEXT | |
| `stats` | TEXT (JSON) | `{physical, wisdom, intelligence, charisma}` |
| `health` | INTEGER | Current HP |
| `stamina` | INTEGER | |
| `wealth` | INTEGER DEFAULT 0 |
| `location` | TEXT | |
| `description` | TEXT | LLM-generated flavor |
| `created_by_action_id` | INTEGER FK → actions NOT NULL | |

### `locations`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT UNIQUE NOT NULL | |
| `description` | TEXT | |
| `tags` | TEXT | Comma-separated, set by LLM when spawning. Used for deterministic scene matching. |
| `is_safe` | INTEGER NOT NULL DEFAULT 0 | Boolean. 1 = safe location for stamina/health recovery on tick. |

### `feedback`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `character_id` | INTEGER FK → player_characters | |
| `text` | TEXT NOT NULL | |
| `created_at` | TEXT NOT NULL | |

### `bug_reports`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `character_id` | INTEGER FK → player_characters | |
| `text` | TEXT NOT NULL | |
| `created_at` | TEXT NOT NULL | |

### `meta`

Single-row-per-key store for global world state. Holds the day counter (used by NPC-movement seeding and world scaling) and the cron cooldown. See [[poc-build-world-tick]].

| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | e.g. `day_number`, `last_cron_date`, `llm_fallback_count` |
| `value` | TEXT NOT NULL | Stringified value |

**Initial seed:** `"The Warden's Oak"` with tags `"oak, interior, fire, sanctuary"` and `is_safe = 1`. Scene resolved at render time via tag matching.

---

## 3. YAML Asset Loading & Validation

At startup, before the bot logs in: load all files from `assets/char-creation/` and validate schema.

**Fail-fast contract:** if any file is missing or invalid, log the error and exit. The bot never comes online with bad data. The join wizard is guaranteed valid options.

| File              | Validates                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `classes.yml`     | Each entry: `name`, `description`, `modifiers` (4 keys: `physical`, `wisdom`, `intelligence`, `charisma`, all integers) |
| `backgrounds.yml` | `name`, `description`, optional `modifiers`                                                                             |
| `races.yml`       | `name`, `description`, optional `modifiers`                                                                             |
| `alignments.yml`  | `name`, `description` — exactly 9 entries for 3×3 grid                                                                  |
| `day-jobs.yml`    | `name`, `description`, `depends_on` (array of stat names), `base_income` (integer), `actions` (exactly 3 — the weekday `/hi` action-button labels)  |
| `item-sets.yml`   | `name`, `items` (array of `{name, emoji, stat, modifier, quantity}`), tied to classes                                   |

**Prompts:** `assets/prompts/*.md` (e.g. `decision.md`, `fallback.md`) load under the same fail-fast contract — plain text with `{…}` placeholders, not YAML. Exit if a required prompt file is missing. See [[poc-build-probabilistic]] §2.

---

## 4. Character Creation — `/join`

6-step wizard. One Discord message, edited in place as the player advances. State lives in the Discord interaction payload — no server-side wizard session needed until confirm.

### Step flow

| Step | Input | Source |
|---|---|---|
| 1. Name | Modal — free text, 2-30 chars | — |
| 2. Class | 5 buttons with stat preview | `classes.yml` |
| 3. Upbringing | Buttons with description snippets | `backgrounds.yml` |
| 4. Race | Buttons with description snippets | `races.yml` |
| 5. Alignment | 9 buttons in 3×3 grid | `alignments.yml` |
| 6. Day-job | Buttons showing stat dependency + income | `day-jobs.yml` |

### Summary & confirm

All choices listed with cumulative stat modifiers, day-job, and base income. Starting items auto-assigned by class from `item-sets.yml`.

Two buttons: **[Confirm]** → INSERT into `users` then `player_characters` (with `user_id` FK), or **[Start Over]** → discard.

### Guards

- `/join` when user already has a character → ephemeral error: "You already have a character."
- `/join` mid-wizard → resume from current step.
- Wizard times out after 10 minutes of inactivity → ephemeral "Timed out. Try `/join` again."
- Name validation: not empty, no Discord user/channel/role pings.

---

## 5. Deterministic Commands

All instant. No LLM call, no dice, no roll consumed.

### `/hi` — Opening Scene

Two messages, edited in place.

**Message 1 — Atmosphere:**
- `oak.ascii` fragment + flavor text
- One button: **[Begin]**
- Once per day: repeated `/hi` returns cached Message 1

**Message 2 — Decision:**
- Character stats header (class emoji, name, health, stamina, rolls)
- **Weekdays:** 3 job-specific action buttons from `day-jobs.yml` + **[Something else…]** for free actions
- **Weekends:** open-ended adventure hooks instead (travel, scout, hunt, talk)
- **Resumption:** if `last_action_state` is not NULL, **[Begin]** resumes the saved mid-action flow

### `/look`

Current location's ASCII fragment + description. Cached until `player_characters.location` changes. No buttons.

### `/backpack`

Query `items` WHERE `character_id`. Render as emoji grid in code block. Empty → "Your pack is empty."

### `/stats`

Full character sheet — same layout as join summary. Name, class emoji, upbringing, race, alignment, all 4 stats, day-job, location, health, stamina, wealth, rolls remaining.

### `/journal`

Deterministic. No LLM, no roll consumed.

- **Locations known:** list from `locations` table. Current location marked with `←`. Discovered via actions and exploration.
- **NPCs encountered:** list from `npcs` table — name, class, location. Sorted by most recently spawned.
- **Recent actions:** last 5 rows from `actions` — type + outcome.

Render as plain text, no ASCII art.

### `/help`

Command list with one-line descriptions. Action types explained. Roll economy explained.

### `/feedback`

Free-text → INSERT into `feedback`. Reply: "Thanks. The warden listens."

### `/bug`

Free-text → INSERT into `bug_reports`. Reply: "Bug noted. The warden will investigate."
