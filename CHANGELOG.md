# Changelog

All notable changes to The Warden's Oak are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]
### Added
- **Five-day absence warning DM** — on the world tick, a player who crosses exactly 5 calendar days without interacting receives a one-shot, in-character DM (`⚠️ The Oak stirs without you…`) nudging them to return. Fires once on the 5-day mark (no nightly spam); best-effort delivery (closed DMs degrade to a log). The tick now returns `absentWarnings: string[]` (Discord ids) for the scheduler to DM.
- **Public "goodnight" announcement** — the evening bookend to the morning message, posted at **18:30 UTC** by its own scheduler (idempotent per day, with boot-time catch-up). Posts a public `🌙 Night falls over the Oak` message to the tick channel; when souls are still at unsafe locations it names the count as a cold reminder (*"…will they make it back?"*), otherwise it notes all are home. The count is read **live** at 18:30 via `WorldEngine.countSoulsInUnsafe()` (who's actually out as night falls — not the dawn tick snapshot).
- **Restored view nav buttons** — `Look`, `Stats`, and `Backpack` are back in the navigation bar with page-scoped visibility: the info pages (backpack/stats/journal/look) cross-link to each other, and `Look` also appears on `/hi`. They stay off action-outcome and sleep views. Each page stays within Discord's 5-button row cap.
- **Admin alert on a stalled world** — when the morning announcement is skipped because the nightly tick never completed, `notifyAdmin()` now fires (`World stalled — announcement skipped`) instead of only a console line, so a frozen day surfaces immediately (recoverable via admin `/sleep`).

### Changed
- **Absence no longer costs health** — removed the 3-day `-3 HP` absence penalty (introduced in 0.2.2). It was a net no-op for the common case (safe-location regen `+3` cancelled it) and only bit players at max HP or idling in the wild. Replaced with the soft DM nudge above (threshold raised 3 → 5 days).
- **Daily announcement times** — the morning announcement moved **07:30 → 05:30 UTC**; the new goodnight announcement posts at **18:30 UTC**. Day cycle (UTC): `03:30` tick · `05:30` morning · `18:30` goodnight.

### Fixed

## [0.2.2] — 2026-06-18
### Added
- **The Warden NPC** — The Warden is now a seeded NPC at the Oak: a silent, hooded figure who tends the fire and offers stew. Added to `seedNpcs()` in `migrate.ts` with class `Warden`, location `"The Warden's Oak"`, and a fire-tending description.
- **The Warden's location frozen on world tick** — NPCs with class `Warden` are skipped in the nightly movement loop. The Warden never leaves the Oak.
- **Warden emoji in `/look`** — The Warden renders with a `🔥` emoji in the `/look` entities list.
- **Conditional Warden lore injection** — The Warden's century-spanning secret is injected into the LLM context only when The Warden is nearby, with instructions to drip-feed fragments over the year and never explain the secret outright.
- **Good night message with Action/Feedback buttons** — `/sleep` now shows a Components V2 good-night embed with an ⚔️ Action button (opens day-job menu) and a 💬 Feedback button (opens a modal). The message reports how many souls did not make it home.
- **Unsafe sleep penalty** — sleeping in an unsafe location costs -1 HP. Flavour text reflects the rough night.
- **Feedback & Bug Report buttons on action outcomes** — public action outcome messages now include 💬 Feedback and 🐛 Bug Report buttons that open modals, routing to `engine.submitFeedback()` / `engine.submitBug()`.
- **Three-day absence penalty** — players who haven't interacted in 3+ calendar days lose 3 health at world tick. Tracked via new `last_played_at` column on `player_characters`.
- **Journal narrative** — LLM outcome text is saved as `narrative` on action rows and shown as quoted story beats in `/journal`. Requires the new `actions.narrative` column.
- **Safety emojis on location names** — location names are prefixed with 🛡️ (safe) or ⚠️ (unsafe) in `/hi`, `/look`, and `/journal`.
- **"You are alone here" indicator** — `/look` shows "_Silence. You are alone here._" when no NPCs or other players are present.
- **`countSoulsInUnsafe()`** — new `WorldEngine` method that counts player characters at unsafe locations. Used by the good night message.
- **`modifyHealth()`** — new `WorldEngine` method for flat health modification (clamped 0..max).
- **`updateLastPlayed()`** — stamps the current time on a character's `last_played_at` field. Called on `/action`, `/hi`, `/look`, `/sleep`.
- **Daily-work teleport** — clicking a day-job quick-action button from The Warden's Oak now costs 1 stamina and teleports the character to their workplace before the action starts. Custom actions (`/action <description>`) and actions from non-Oak locations never trigger teleport. Wanderers teleport to a seeded random safe location (deterministic per character per day). See `docs/game/daily-work-teleport.md`.
- **Two new locations** — The Town Forge (Blacksmith workplace) and The Warden's Library (Scribe workplace) are seeded in the locations table with safe-zone status and ASCII scenes.
- **`/hi` workplace display** — the daily-work section now shows the workplace name next to the job title (e.g. `🔨 Blacksmith — The Town Forge`).
- **`workplace_location` in day-jobs YAML** — each job in `assets/char-creation/day-jobs.yml` carries a `workplace_location` field (null for Wanderer, whose destination is computed).
- **`getWorkplaceLocation()` utility** — pure function in `hi.ts` that resolves workplace destinations (with seeded Wanderer logic), exported for testing.
- **DB migration framework** — `src/db/migrations/` holds dated `YYYYMMDDHHMM_<description>.ts` files, each exporting `up(db)`. A runner applies any whose id isn't yet in the new `schema_migrations` ledger table, in chronological order. The `…_baseline` migration wraps the prior `schema.sql` + v2–v7 idempotent ALTERs, so existing production DBs run it as a no-op and are simply stamped; fresh DBs build from scratch. Replaces the single growing `migrate()` function.
- **Applied-mutation insight logging** — every resolved action now persists the mutations *actually applied* (post-validation, post-failure-strip) as JSON in the new `actions.applied_mutations` column, and emits a concise always-on `[mutations]` log line with the net before→after state change (e.g. `rolls 1→0`). Makes anomalies like a roll handed back via `modify_rolls_remaining` greppable from the live log and queryable after the fact.
- **Admin notification on tick failure** — `notifyAdmin()` called when the nightly cron tick or morning announcement fails, so silent errors like `DiscordAPIError 50001 (Missing Access)` are no longer invisible.
- **Hi button on morning announcement** — the daily welcome message now includes a 🌅 Hi button. Clicking it spawns an ephemeral `/hi` screen for the player, reusing the existing nav-button handler.
- **`setMeta()` on `WorldEngine` interface** — allows the morning announcement to write `last_announcement_date` for idempotency.
- **`last_announcement_date` idempotency guard** — prevents double-posting the morning message if the bot restarts.
- **Player class emoji on public action outcomes** (P2) — the global outcome message posted to the channel now leads with the player's class emoji (`⚔️ **Name** — hunt`), so glancing at the feed shows who did what. Backed by a shared `classEmoji()` helper in `discord/format.ts` (single source of truth, also used by the `/join` wizard).
- **`LLM_MODEL` env var** (P1) — overrides the LLM model at boot (e.g. a pro-vs-flash A/B comparison) without a code change; empty falls back to the gateway default. The active model is logged on init.
- **`player_characters.last_played_at` + `actions.narrative` columns** — new dated migration backing the upcoming goodnight/rest features (absence penalty + journal narrative). Schema-only; no behaviour change yet.

### Changed
- **`done` is inferred from the absence of options** (P1) — the action machine no longer trusts the LLM's `done` flag to auto-finish a choice-less, non-required action. If the LLM returns no real options (regardless of `done`), the bot resolves it immediately as a neutral outcome instead of dead-ending on a lone red "Step back". Divine intervention and required (reactive) actions are unchanged. The auto-finish now emits an `[action] auto-finished …` log line noting the option count and whether `done` was inferred, so this path is greppable in the live log.
- **Loading screen echoes the player's choice** (P2) — the "Starting…/Thinking…" interim message now shows what the player did (`**You:** <input or chosen option>`) above the spinner line, so the wait reflects their action instead of a bare "Thinking…". The button handler resolves the chosen label before rendering the wait.
- **Tick decoupled from announcement** — the nightly world tick (DB reset at 3:30 UTC) and the morning announcement (7:30 UTC) are now separate `setTimeout` schedulers. The tick writes `last_tick_players_affected` and `last_tick_npc_movement_count` to meta; the announcement reads them 4 hours later.
- **Decision prompt `v7` — bail/`done` simplification** — now that the engine adds the "Step back" option itself (from `required`) and infers completion from a choice-less beat, the prompt no longer asks the LLM to emit a bail option (`dc_modifier: null`) or lean on `done` to end a no-option beat. `required` stays (it drives the bail inference); `done` stays for `CONTINUE`/`RESOLVE_ROLL`. Also corrects the prompt's `RECENT ACTIONS` doc to the now-fed last-3 narrative thread. `PROMPT_VERSION` → `v7`.
- **`/hi` shows status, not ability scores** — the header now leads with current vitals (`❤️ HP ┃ ⚡ Stamina ┃ 🎲 Rolls ┃ 💰 Wealth`) and drops the PHY/WIS/INT/CHA line. "Rolls" no longer says "remaining"; Wealth is now surfaced. Low-health warning preserved.
- **`/action` gamebook layout** — both the live decision screen and the outcome recap now read as one continuous gamebook page: the DM's narration (quest, each scene prompt, the final resolution) is rendered as Discord blockquotes, and the player's choices stand out in bold (`↪ **Choice**`). Replaces the old mixed `**Decision:** … → *choice*` formatting that ran together in long multi-decision encounters. Each past choice now shows a qualitative difficulty arrow instead of a raw DC number — 🟢⬇️ when the choice lowered the DC (easier), 🔴⬆️ when it raised it (harder). Descriptions degrade gracefully to fit Discord's 4096-char embed cap (full thread → collapse history to a choice breadcrumb → drop the scene art → hard clip), so long encounters never fail to send.
- **Recent-action narrative thread fed to the LLM** — the decision prompt's `RECENT ACTIONS` block now carries each prior action's stored `narrative` (the DM outcome text), rendered oldest→newest for story continuity, and the count fed to the LLM rose from 2 to 3. Previously only `type (outcome)` was passed.
- **Nav button cleanup** — removed `look`, `stats`, and `backpack` from the global navigation bar. Remaining buttons: `hi`, `journal`, `action`, `sleep`.
- **`/hi` location safety display** — moved the safety emoji onto the location name itself instead of a separate text badge.

### Fixed
- **Out of rolls now offers Sleep, not a dead Action button** — the `Action` nav button is hidden exactly when `Sleep` appears (out of rolls and not mid-action), instead of always rendering and dead-ending on the "out of actions for today" guard. The two buttons are now mutually exclusive; `Action` still shows mid-action so a player can resume.
- **`ephemeral` reply-option deprecation** — replaced all deprecated `{ ephemeral: true }` interaction options with `flags: MessageFlags.Ephemeral` across `action.ts`, `join.ts`, and `index.ts`. `buildComponentPayload` now folds the ephemeral bit into its Components V2 `flags` bitfield rather than emitting a separate (and illegal-with-V2) `ephemeral` field.
- `MockWorldEngine` now implements all `WorldEngine` interface methods (`updateLastPlayed`, `modifyHealth`, `countSoulsInUnsafe`).

### Chore
- **`biome.json`** — formatter config enforcing `indentStyle: space, indentWidth: 2` to prevent whitespace churn.
- **Post-PR#14 code-review cleanup** — renamed `computeItemBonus` → `itemStatModifier` and `computeRollBonus` → `abilityCheckBonus` for clarity; reindented `hi.ts` from tabs to 2-space (the last tab-indented file); removed the dead `_getScene` param from `makeHiCommand`; added rogue/scout/guard archetypes to `npcEmoji`; minor `escapeRegex` param rename. See `docs/sparks/handover-code-review-post-pr14.md`.

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
