# Changelog

All notable changes to The Warden's Oak are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Stat name abbreviation with emojis** — all rendered stat lines now show compact emoji+abbrev (`💪 PHY`, `🧠 WIS`, `📖 INT`, `💬 CHA`) instead of full names, improving mobile readability
- **Backpack stat breakdown** — `/backpack` now groups items by stat with per-stat total bonus (`💪 Physical (+3)`) and a separate Utility section for zero-modifier items
- **`shipped` status** to docs conventions — `status: shipped` marks implemented-and-archived specs; finished POC build docs moved from `engine/` and `decisions/` to `docs/archived/poc/`
- **Decision breadcrumb trail** — the action outcome embed now shows a concise emoji breadcrumb (e.g. 🔍 → 🗣️ → ⚔️) above the scene, tracing the distilled action types the player moved through. Backed by a `distilledActionEmoji()` keyword↔emoji map (28+ keywords, case-insensitive, substring-matched, fallback ✴️) and a `distilledType` field stamped on each `ActionDecisionRecord` by the state machine.
- **Action terminal states `bailed` and `done`** — bailing a real decision now resolves as a neutral `↩ Bailed` (costs −1 stamina), and an LLM `done`/no-choices outcome (travel/rest) **auto-finishes** as a neutral `✓ Done` instead of presenting a red "Step back". Auto-finished actions are logged to `actions` like any other (with `llm_call` link + `app_version`).
- `/hi` now shows the current location's name, description, and safety status
- **LLM audit: `llm_calls` table** — one row per gateway call (including failed and retry attempts) for POC behavioural analysis. Captures the player input, a compact deduped `context_digest`, raw response, token usage, latency, finish reason, `parse_ok`, validation warnings, error, HTTP status, and retry tier. Linked to the action it produced via `action_id`.
- LLM thinking capture: `raw_prompt` and full `reasoning` (thinking) are stored on diagnostic calls — a transport error, a malformed/unparseable response, or a fallback retry (hardcoded); `reasoning` is additionally stored on **all** well-formed calls when `LOG_LLM_THINKING_ALL=true`; every call keeps the cheap `reasoning_chars` gauge regardless
- **`app_version` on `actions` and `llm_calls`** — each row is stamped with the app build (`VERSION`) that produced it, for historic data mining (the `llm_calls` stamp covers failed/retry calls that never produce an action row); shared `src/version.ts` (`APP_VERSION`) replaces the inline read in `index.ts`
- Query shorthands: `llm_calls`, `llm_issues`, `llm_dump` in `scripts/query.mjs`
- **ISO timestamps on all console logs** — `console.log`/`warn`/`error` are monkey-patched at startup to prefix `[YYYY-MM-DD HH:mm:ss.SSS]` timestamps
- **decision-v4 prompt** — evolved from v3: roll-first resolution blocks (`ROLL RESULT: SUCCESS/FAILURE`), honour-player-intent rule (no silent type conversion), decisions must advance (consequences on call 2+, never re-present), item breakage/loss recipe, expanded mutation examples, refined JSON contract

### Changed
- Map of content pruned — shipped POC docs removed from `docs/README.md` active tables, catalogued under a new Archived section
- Cross-references in 5 active docs updated to point to `archived/poc/` paths
- TODO.md reorganized — addressed scratchpad items marked `[x]` with links to shipped docs; POC polish vs MVP fuel separated
- **Roll-first resolution** — the bot now rolls the d20 (+ stat bonus) vs the DC *before* the LLM narrates, then makes a second "narration" call telling the LLM the verdict, so the outcome text and mutations match the dice. Previously the LLM authored the outcome blind to the roll, so a "Success" could carry a failure narration (and vice-versa). Adds one LLM call per resolution. (Implements the "roll before flavour" idea from `mvp-llm-prompt-architecture`.)
- **Roll line shows the stat bonus separately** — e.g. `🎲 8 + 7 vs 11 ✓ Success`, so it's clear why a low die still passed (the item/stat bonus was previously hidden)
- **Standardised outcome footer** — emoji stat glyphs (`❤️ HP ┃ ⚡ stamina ┃ 🎲 rolls ┃ 💰 wealth`) with a separator above it, and items/location on their own line, so outcomes scan cleanly on mobile
- **Daily work actions: 3 surfaced at random** from a larger pool — each day-job now has ~8 actions (rewritten tighter/more generic) plus a shared `COMMON_ACTIONS` (hybrid) pool of 8, so each job draws 3 of ~16. The pick is seeded per character per day, so `/hi`, the `/action` buttons, and the click handler agree within a day and refresh each game day.
- **Decision options render as A/B/C buttons** — the option text now lists in the message body (lettered); buttons show just the letter (plus a worded bail button), so long captions no longer truncate on mobile
- LLM request/response auditing moved off the `actions` table into the dedicated `llm_calls` table; the legacy `actions.llm_request`/`llm_response` columns are retained but no longer written
- Validation warnings (bad stat, out-of-range DC, empty labels, non-array mutations) are now persisted as data, not just logged

### Fixed
- `/stats`, `/hi` header, and `/backpack` all consistently use abbreviated stat labels with emojis
- Backpack layout no longer a flat emoji grid — stat groupings make item bonuses scannable at a glance
- Carriage returns, stamina ceiling, bail→neutral, item stack loss, auto-finish, A/B/C buttons, standardised footer all confirmed shipped in the POC build archive
- **Failed actions no longer reward the player** — on a failed roll, beneficial mutations (wealth/stamina/health gains, gained items) are dropped and a flat −2 stamina penalty is added so a loss carries weight; costs and world changes (e.g. `set_location`) are kept. With roll-first resolution the narration now also matches the verdict, so failures read as failures.
- **Auto-finish coverage** — the day-job button and custom-modal action paths now render an auto-finished outcome too (previously only the typed `/action <description>` path did)
- **Bail rendered as green Success** — bailing a non-required action showed a green success banner; now neutral `↩ Bailed`. (Root cause: the pre-resolved `done` case was conflated with bail; split into auto-finish vs genuine bail.)
- **Stamina could exceed max** (`11/10`) — `modify_stamina` now clamps to `STAMINA_MAX` (10), like `modify_health`
- **Carriage returns** (`␍`) leaking into rendered messages — stripped from LLM prose at the gateway
- **Item trade deleted the whole stack** — `remove_item` carries a quantity; `ItemRepository.decrementByName` decrements and deletes only at 0 (trading 1 of 2 leaves 1)
- **Seed NPC duplication**: `seedNpcs()` re-inserted all 8 NPCs on every startup (no UNIQUE constraint), bloating the table to 100+ rows and leaking dozens of duplicate NPCs into every LLM prompt. Migration dedupes existing rows and a partial unique index makes re-seeding idempotent

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
