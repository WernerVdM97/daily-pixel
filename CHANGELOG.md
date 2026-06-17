# Changelog

All notable changes to The Warden's Oak are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]
### Added
- **Admin notification on tick failure** — `notifyAdmin()` called when the nightly cron tick or morning announcement fails, so silent errors like `DiscordAPIError 50001 (Missing Access)` are no longer invisible.
- **Hi button on morning announcement** — the daily welcome message now includes a 🌅 Hi button. Clicking it spawns an ephemeral `/hi` screen for the player, reusing the existing nav-button handler.
- **`setMeta()` on `WorldEngine` interface** — allows the morning announcement to write `last_announcement_date` for idempotency.
- **`last_announcement_date` idempotency guard** — prevents double-posting the morning message if the bot restarts.

### Changed
- **Tick decoupled from announcement** — the nightly world tick (DB reset at 3:30 UTC) and the morning announcement (7:30 UTC) are now separate `setTimeout` schedulers. The tick writes `last_tick_players_affected` and `last_tick_npc_movement_count` to meta; the announcement reads them 4 hours later.

### Fixed

### Chore
- **`biome.json`** — formatter config enforcing `indentStyle: space, indentWidth: 2` to prevent whitespace churn.

## [0.2.1] — 2026-06-16

### Added
- **Admin error DMs** — `notifyAdmin()` now routes all interaction catches, startup fatalities, `unhandledRejection`, and `uncaughtException` to the admin via DM instead of a silent `console.error`. The `uncaughtException` handler exits so systemd restarts; the DM is best-effort and self-guarding (no client / no admin / failed DM degrades to log).
- **Profanity filter** — `PROFANITY_FILTER` env var accepts comma-separated regex patterns (case-insensitive, unicode). Matching custom action text is blocked before reaching the engine with a generic rejection message. Full unit test coverage including unset/empty, multiple patterns, word boundaries, and unicode.
- **Double-click guard on `/join` wizard** — a per-user in-flight lock drops duplicate button clicks before any Discord API call, preventing duplicate character creation or stale interaction errors.
- **Startup admin DM** — on boot, the bot DMs `ADMIN_USER_ID` with the deployed version + git commit hash + subject line.
- **`SLEEP_ADMIN_TICK` env var** — controls whether admin `/sleep` advances the world. Defaults to `false` (admin rests at the Oak like everyone else). Set to `true` to restore the old test-mode tick behaviour.
- **`client.on('error')` and `client.on('shardError')` listeners** — prevent fatal crashes on Discord API errors; routed to `notifyAdmin()` instead.
- **`safeErrorReply()` helper** — picks `followUp` when the interaction has already been acknowledged, swallows any failure so a dead interaction never takes the process down.

### Changed
- **Error handling hardening** — all slash command and button catches route through `notifyAdmin()` + `safeErrorReply()` instead of bare `console.error` + `interaction.reply()`.
- **`scripts/clear-channel.sh` rewritten** — replaced fragile grep-based JSON field extraction with Python `json.load()`. No longer depends on Discord field ordering. Bot ID resolution and pagination also use Python now.
- **`scripts/deploy-check.sh` tracks `main`** — was watching the stale `POC` branch. Now auto-deploys from `main` on hourly timer.
- **`initDb()` auto-creates `data/` directory** — a fresh clone no longer crashes on first boot because `better-sqlite3` can't create parent directories.

### Fixed
- **Crash on "Interaction has already been acknowledged" (40060)** — the slash-command catch blindly called `interaction.reply()`, which throws 40060 on already-acked interactions; with no `client.on('error')` listener this crashed the bot. Now uses `safeErrorReply()` and routes the event to admin via the new client error listener.
- **`/join` buttons throwing "Unknown interaction" (10062)** — stale button clicks or double-clicks on expired wizard tokens no longer escape the handler. All join catches use `safeNotify()` (chooses `reply` vs `followUp` and swallows failures).
- **Crash on missing `data/` directory** — `initDb()` now `mkdir -p`s the SQLite parent dir before opening the database.
- **`clear-channel.sh` pagination truncation** — `head -1` on each page limited deletion to 1 message per batch. Now processes the full `messages` array.

### Chore
- Bumped to 0.2.1 — crash hardening & profanity filter

## [0.2.0] — 2026-06-16 — POC BETA

### Added
- **Components V2 infrastructure** — native Separator components, `buildComponentPayload()` for command output, shared `getNavButtons()` navigation bar across all commands
- **Per-option stat system** — each decision option can specify which ability the roll tests (`stat`); `computeRollBonus()` composes character ability + item modifiers
- **`modify_max_stamina` mutation** — LLM can raise/lower the stamina ceiling; current stamina clamps to new max
- **Passive-insight hints** — `10 + WIS` determines which DCs the character senses as achievable; options shown in green with 🟢 flag
- **Nearby entities in `/look`** — shows other player characters (highlighted) and NPCs at the current location with class-based emoji
- **`decision-v5` and `decision-v6` prompts** — evolved decision framework with SUCCESS reward rules, per-option stats, ability checks
- **LLM validation: Rule 4b** — blocks `done:true` with only negative stamina/health and no reward mutation
- **`scripts/clear-channel.sh`** — admin script to bulk-delete bot messages from a Discord channel via REST API

### Changed
- **Rolls are now ability checks** — d20 + character ability score + item bonuses vs DC (was d20 + item bonuses only)
- **Decision screen restyled** — quoted 🧭 Quest path trail, effective DC per option, passive-insight colouring, `base_dc` minimum raised 8 → 10
- **Join wizard data-driven** — all options loaded from `assets/char-creation/*.yml`; emoji + descriptions on buttons, progress ledger with strike-through, Start Over on every step
- **Backpack shows capacity** — `(used/10)` with ⬜ empty slots grid; items grouped by stat with total modifier
- **Outcome renderer overhaul** — critical highlights (🌟 nat 20 / 💥 nat 1), stat emoji prefix, bold roll calculus, emoji action-type labels (✅ SUCCESS, ❌ FAILURE, etc.)
- **Navigation buttons on public outcomes** — clicking spawns a fresh ephemeral screen per player
- **Join announcement simplified** — public "A new hero joins the Oak" embed shows title + Oak image only (no hero description)

### Fixed
- Item quantity no longer multiplies modifier in bonus calculation
- `formatCharacterHeader` indentation consistency
- Alignment title-casing throughout ("lawful good" → "Lawful Good")

### Chore
- Bumped to 0.2.0 — POC BETA release
- Prompt files reorganized into `assets/prompts/decision-prompts/`
- POC build docs archived under `docs/archived/poc/

## [0.1.8] — 2026-06-16

### Added
- UI polish pass: nat20/nat1 highlights, command nav bar, native Separator components
- Per-option stat system on decision screens; passive-insight hints (🟢 earned only)
- `modify_max_stamina` LLM mutation
- Nearby PCs and NPCs shown in `/look`
- `decision-v5` and `decision-v6` prompts — SUCCESS reward rules, PHASE markers, pre-flight checklist
- `/join` wizard now fully data-driven from `assets/char-creation/*.yml` with artwork, choice descriptions, progress ledger, and Start Over on every step
- Public join announcement + immediate `/hi` handoff
- Backpack capacity display, stat breakdown, empty-slot grid
- Stat name abbreviation with emojis (`💪 PHY`, `🧠 WIS`, etc.)

### Changed
- Rolls are now full ability checks: `d20 + ability score + item bonuses` vs DC
- Decision screen restyled with quest path trail, per-option DC, passive-insight colouring
- Outcome renderer overhaul: 🌟/💥 crit highlights, stat emoji prefix, bold roll calculus, action-type emoji labels
- Join announcement simplified to title + Oak image
- `/hi` simplified — shows only location + safety badge (scene deferred to `/look`)
- `/look` shows unsafe indicator
- `/help` formatting cleaned up with native Separators

### Fixed
- Item quantity no longer multiplies modifier in bonus calculation
- `formatCharacterHeader` indentation consistency
- Alignment title-casing

### Chore
- Prompt files reorganised into `assets/prompts/decision-prompts/`
- POC build docs archived under `docs/archived/poc/`
- `status: shipped` added to docs conventions

## [0.1.7] — 2026-06-16

### Added
- **Decision breadcrumb trail** — emoji trail (🔍 → 🗣️ → ⚔️) on action outcomes, backed by 28+ keyword emoji map
- **Action terminal states `bailed` and `done`** — bail resolves as neutral `↩ Bailed` (−1 stamina); LLM `done`/no-choices auto-finishes as neutral `✓ Done`
- `/hi` now shows current location name, description, and safety status
- **LLM audit: `llm_calls` table** — one row per gateway call (including failed/retry) capturing input, context digest, raw response, token usage, latency, finish reason, parse status, and validation warnings
- LLM thinking capture: full reasoning stored on diagnostic calls; `LOG_LLM_THINKING_ALL` toggle for all calls; `reasoning_chars` gauge always stored
- `app_version` on `actions` and `llm_calls` — each row stamped with the app build
- Query shorthands: `llm_calls`, `llm_issues`, `llm_dump` in `scripts/query.mjs`
- **ISO timestamps on all console logs** — monkey-patched at startup
- **`decision-v4` prompt** — roll-first resolution blocks, honour-player-intent rule, decisions must advance, item breakage/loss recipe, expanded mutations, refined JSON contract

### Changed
- **Roll-first resolution** — bot rolls the dice *before* the LLM narrates; second "narration" call tells the LLM the verdict, so outcome text and mutations match the dice
- **Roll line shows stat bonus separately** — `🎲 8 + 7 vs 11 ✓ Success`
- **Standardised outcome footer** — emoji stat glyphs with separator above, items/location on own line
- **Daily work actions: 3 surfaced at random** from a larger pool; seeded per character per day
- **Decision options render as A/B/C buttons** — option text in body, buttons show just the letter
- LLM request/response auditing moved off `actions` table into dedicated `llm_calls` table
- Validation warnings persisted as data, not just logged

### Fixed
- **Failed actions no longer reward the player** — beneficial mutations dropped, flat −2 stamina penalty added on failure
- **Auto-finish coverage** — day-job button and custom-modal paths now render auto-finished outcomes (was `/action <description>` only)
- **Bail rendered as green Success** — now neutral `↩ Bailed`
- **Stamina could exceed max** (`11/10`) — `modify_stamina` clamped to `STAMINA_MAX`
- **Carriage returns** (`␍`) leaking into rendered messages — stripped at the gateway
- **Item trade deleted the whole stack** — `decrementByName` decrements and deletes only at 0
- **Seed NPC duplication** — partial unique index makes re-seeding idempotent

## [0.1.6] — 2026-06-15

### Changed
- **Outcome rendering now shows all changes**: items gained/lost, location changes, health/wealth/stamina deltas derived directly from mutations (no longer relies on buggy caller-provided flags)
- **v3 system prompt**: mandatory mutations on resolution, concrete mutation recipes per scenario (combat→damage, travel→set_location, failure→cost, success→cost+reward)
- Player inventory passed to LLM context so it can make informed remove_item/add_item decisions
- Available location names passed to LLM context — location names must match seeded DB locations exactly

### Fixed
- Mutations validation no longer crashes on malformed entries — invalid mutations are filtered, valid ones applied, errors logged (per spec)
- Idle messages now show during all three loading states (previously only day-job quick action showed them)
- `add_item` mutations from LLM with `stat: null` no longer crash — prompt now explicitly requires stat value, and engine drops malformed entries
- Location scenes now resolve properly — LLM knows the exact names of all 9 seeded locations
- `set_location` to an unknown location is now rejected by the engine (matched case-insensitively against known locations, then snapped to the canonical casing) — prevents the player being moved to a phantom location with no scene
- Removed per-action debug logging from the resolution path

## [0.1.5] — 2026-06-15

### Added
- Item set selection step (step 7) in `/join` wizard, filtered by chosen class
- Starting items auto-assigned from `item-sets.yml` on character creation
- `VERSION` file and startup log line (`[version] 0.1.5` in yellow)
- `scripts/clear-admin.sh` for clearing a user's character from the DB

### Changed
- `/look` is now ephemeral (player-only visibility)

### Fixed
- Prevent spawning parallel `/action` instances for the same character (in-memory mutex + DB guard)
- Custom modal submit now deletes the stale day-job menu message so only the action scene shows
- Button clicks in `/join` wizard immediately grey out via `deferUpdate` — no more double-click lag

## [0.1.4] — 2026-06-15

### Added
- Bail button always shown via `ensureBail` fallback ("Step back" if LLM omits it)
- `Custom…` button on day-job menu opens modal for free-text action input
- Final action outcome posted as public follow-up to the channel

### Changed
- Day-job buttons blank immediately on click, show "Starting…" then decision
- Block new actions when out of rolls with a friendly message instead of empty menu

### Fixed
- Day-job buttons use `deferUpdate` — greys out all buttons, prevents double-clicks
- LLM outcome text shown as prompt when `done:true` returned with no options
- Roll economy enforced at `/action` entry point

## [0.1.3] — 2026-06-15

### Added
- ASCII scene rendering in `/hi` (oak), `/look`, and `/action` (current location)
- Day-job quick action buttons when `/action` called with no description
- Action trail shown during decisions (original input, previous choices, current prompt)
- Action trail shown in final outcome (each decision + DC, then roll result)

### Changed
- `/action` is now ephemeral — prevents cross-user button conflicts
- LLM reasoning content logged as `[llm:thoughts]` when verbose

### Fixed
- Non-array mutations from LLM guarded against and validated
- Variable ordering in decision cap logic fixed

## [0.1.2] — 2026-06-15

### Added
- Loading state with greyed buttons during LLM processing
- All commands classified as ephemeral or public (`stats`, `backpack`, `journal`, `bug`, `feedback`, `help`, `hi`, `join` are player-only)
- Color-coded log tags with ANSI

### Changed
- Decision cap reduced from 3 to 2
- Switched from `message.edit` to Discord built-in spinner + `editReply` for button updates
- Static imports for `join`/`action` handlers — removes latency on every button click

### Fixed
- LLM response validation: warn on missing label, wrong stat, bad `dc_modifier`
- Action button clicks resolve via stored pending decisions (option label, not index)
- DeepSeek thinking mode enabled, 15s fetch timeout added
- LLM fallback errors logged; divine intervention handled in `startAction`

## [0.1.1] — 2026-06-11

### Added
- Probabilistic `/action` flow: LLM-driven decisions, roll mechanics, outcome resolution
- Action state machine with per-character mid-action persistence and resume
- Mutations system: health, stamina, wealth, location, items, NPCs
- `VERBOSE` and `VERBOSE_LLM` env vars for debugging

### Fixed
- `/action` description is optional — blank resumes mid-action, missing + no mid-action shows usage

## [0.1.0] — 2026-06-10

### Added
- Project scaffold: TypeScript, `better-sqlite3`, Discord.js, DeepSeek LLM gateway
- 9-table SQLite schema with idempotent migrations
- 6-step `/join` character creation wizard
- Deterministic commands: `/hi`, `/look`, `/backpack`, `/stats`, `/journal`, `/help`, `/feedback`, `/bug`, `/ping`
- YAML asset loading with fail-fast validation (`classes.yml`, `backgrounds.yml`, `races.yml`, `alignments.yml`, `day-jobs.yml`)
- World tick: `/sleep` admin command, NPC movement, world scaling
- CI/CD: Containerfile, systemd service, LXC provisioning
