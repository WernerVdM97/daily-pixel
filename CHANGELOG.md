# Changelog

All notable changes to The Warden's Oak are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]
### Added
- **`/map` — your map of the world** — renders your discovered subgraph as an indented hub-and-spoke tree grouped by region, with a "roads not yet walked" section for frontier exits and a per-line `emoji · safe/wild · effort` glyph row. Progress is a count ("N charted · M roads into the unknown"), never a fraction; `/map <region>` drills in; over-long maps collapse a region tail into `+K more` and never silently truncate.
- **`/journal` is now a chronicle** — drops the known-locations list (that's `/map`'s job) and shows your recent actions tagged with where each happened (location emoji + name) and a ✓/✗ outcome glyph.
- **Cartographer charts new ground's geometry** — when you cross a frontier, the async cartographer now assigns the new place's region (reusing the land you came from when it fits), emoji, tier, and 1–3 onward frontier exits, so the map keeps unfolding. A per-node spoke cap (5) keeps any place from sprouting endless roads.
- **Shared hub-and-spoke world graph + per-player fog-of-war (map foundation)** — the flat location list becomes one coherent, edge-connected map (`location_edges`), masked per player by what they've discovered (`character_locations`). Locations gain `node_tier`/`region`/`emoji`/`created_by_action_id`. The seed world (the home Vale + 3 named frontier exits) now loads from `assets/world/locations.yml` + `edges.yml` (validated at boot) for fresh instances; a guarded migration (`202606270000_geography`) adds the schema and one-shot-backfills the existing prod DB (off-map nodes from the `set_location` history, per-player visited sets). See [[per-player-map-exploration]]. **Requires no new Discord permissions.**
- **Deterministic, engine-owned travel** — `routeBetween` (Dijkstra over edge `difficulty`) and `getDiscoveredGraph` power movement and the upcoming `/map`. Stamina cost is `Σ(edge difficulty)`; the LLM never emits the number.
- **`cross_frontier` mutation — the exploration verb** — crossing a frontier exit `{ direction, name }` is the ONLY way new ground is born: it mints the destination, binds the exit (shared for everyone after), and fires the cartographer to chart it. A failed roll doesn't break new ground.

### Changed
- **Movement is graph-validated (decision prompt → v10)** — `set_location` now only reaches a charted, reachable node (unknown/unreachable targets are dropped — no more teleport-anywhere / lazy-create-from-thin-air). The decision prompt swaps the global `Known locations` list for a local **"Exits from here"** block (charted exits to travel to · uncharted frontiers to cross) and teaches `set_location` vs `cross_frontier`. `PROMPT_VERSION` → `v10` (`decision-v10.md` + `current_source.md`). New players start with the home Vale already discovered.
- **`actions.location_name`** — each action snapshots the origin location the character acted from (audit/provenance; deliberately a name snapshot, not an FK).

### Internal
- New repos `locationEdge` / `characterLocation`; `geography.ts` pure routing; `applyGeography` replaces the lazy-create path in the engine. Frontier-crossing protocol recorded in [[mutation-vocabulary-refinement]] (`cross_frontier` is a distinct verb; the `set_location → move_to` rename stays v11).

## [0.2.5] - 2026-06-27
### Added
- **Feedback & bug reports capture the action they came from** — the Feedback/Bug buttons on an action outcome now thread that action's id through the button → modal → submission, and `submitFeedback`/`submitBug` store it in a new nullable `action_id` FK on `feedback` and `bug_reports` 
- **Markdown LLM input + coherence critic (decision prompt v9)** — decision context is now a markdown briefing (pre-joined `Score + Gear = Bonus` ability-check table, structured inventory, scene safety tag, split NPC/player lists, story-so-far, known locations, player input as a blockquote; Warden lore moved to an out-of-character GM note) instead of a `key=value`/JSON dump. Response JSON contract unchanged. Adds a coherence critic (on by default; `ENABLE_COHERENCE_CRITIC=false` to disable): a second pass that rewrites only the prose to match engine truth — never mutations/DC/rolls — and fails open. Critic calls audited in `llm_calls` as `call_kind=critic`.
- **YAML asset schema validation (fail-fast at boot + tests)** — every char-creation asset is validated against `src/assets/asset-schemas.ts` on load, so a malformed file crashes boot with a precise file+entry+field message instead of flowing a `NaN` into `computeStats`. New `tests/assets/` cover schema, modifier completeness, a `computeStats` round-trip over every class×background×race, cross-file integrity, and a release-notes tag=filename sweep. Seeded locations now exported from `migrate.ts` as the single source of truth.
- **Weekly recap thread (Monday rollover)** — each week gets one pinned header + thread in the play channel; public action outcomes post into that week's thread (the private outcome is unchanged). Mondays (with the 03:30 UTC tick, aligning to the action refresh) rewrite the prior week's header into a short LLM chronicle and open a fresh week; headers stay pinned as an archive. Best-effort: LLM failure falls back to a count summary, an unreachable thread falls back to the channel, and a current-week thread is recreated on boot only when genuinely deleted (Discord `10003`) — a transient fetch failure keeps the current week. **Requires _Create Public Threads_ + _Send Messages in Threads_** (plus _Manage Messages_ for pinning).
- **Pinned announcements** — the bot pins the latest leaderboard (unpinning older), and every release-notes and Saturday-threat message. Best-effort: needs **Manage Messages** in the announcement channel, else messages still post unpinned.

### Fixed
- **No-op roll refunds are now visible — and a roll grant no longer stacks on the refund** — an auto-finished no-op (e.g. a "look") refunds the roll, but the footer's `🎲` line inferred the change from a heuristic (`rolled? −1 : 0`) and showed nothing, so the unchanged count read as a bug. The engine now reports the real roll accounting on the outcome (`rollsDelta` + `rollRefunded`); the footer shows `🎲 N (refunded)` on a genuine net-zero refund, and the true delta otherwise (a charged no-op the heuristic previously got wrong). Separately, a resolution that **grants** rolls (`modify_rolls_remaining` > 0, e.g. a "rest") now counts as world-changing, so the action is charged like any other — a +1 grant nets against the −1 cost (stays put) instead of stacking a free roll on top of the refund. The footer now also reports the start-drained roll on **bail**, **server-timeout**, and **divine-intervention** outcomes — a `−1` (or `(refunded)` on a refunded timeout) it previously omitted because those resolutions carry no dice roll. (Player-reported.)
- **Nav buttons on an action outcome no longer crash with `DiscordAPIError[50035]`** — clicking Hi/Journal/Action/Rest on the (legacy-embed) outcome message tried to `update()` it into a Components-V2 payload, which preserves the old embeds and clashes with the V2 flag. The nav dispatcher now edits in place only for a V2 ephemeral source and spawns a fresh per-clicker ephemeral otherwise, via a pure `navResponseMode` helper. (`MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2`.)
- **Player-discovered locations now get scene tags** — the D3 cartographer enrichment was filling a provisional location's `is_safe` + `description` but never its `tags`, so every explored/created place stayed `tags=NULL` and always rendered the fallback `unknown` ASCII scene. The cartographer now picks 3-6 tags from the scene palette, and `enrichProvisional` persists them (COALESCE — a tagless enrichment leaves any existing tags intact).
- **Recurring `DiscordAPIError[10062]` across buttons** — a global in-flight guard at the dispatcher (`src/index.ts`), keyed per user+source for buttons and per user+`customId` for modals, drops a duplicate click (silent `deferUpdate`) instead of racing an already-edited message into a 10062; previously only `/join` deduped. A shared `isDeadInteraction` helper (`10062`/`40060`) makes dead interactions a uniform no-op, killing the "could not surface error to user" double-log.
- **Daily-work pay & presentation** — clicking a preset day-job task now pays its per-action `income` into the resolved outcome (shown as a `💰` delta in the footer, after the failure-strip; not paid on bail) instead of being dropped. Preset work is labelled `Work:` (profession emoji) not `🧭 Quest:`, via an `ActionKind` carried through resolution. The commute `−1 stamina` is merged into the thinking page.
- **Custom day-job action from the nav menu now clears its stale menu** — the nav-button day-job menu now stashes its message id like the `/action` slash path, so opening a Custom… action triggers the existing delete-on-modal-open and the old ephemeral menu no longer lingers.
- **Weekly recap survives a missed Monday tick** — boot now catches up a rollover skipped while the bot was down (downtime across the 03:30 UTC Monday window), instead of leaving the week un-finalized and the placeholder header frozen until the *next* Monday.
- **No-op refund no longer denied by a phantom `remove_item`** — only an inventory change that actually happens (an owned item removed, or a real item added) counts as world-changing; a hallucinated removal of an item the player doesn't own stays a refundable no-op.
- **Timeout roll-refund keeps the Saturday bonus** — the refund now caps at the day's real allowance (4 on Saturday), not the bare weekday 3, so a Saturday timeout no longer silently eats the bonus roll.

### Changed
- **`/hi` vitals are emoji-only** — the header's HP/Stamina/Rolls/Wealth line drops the text labels, leaving just `❤️ ⚡ 🎲 💰` with their values (also affects the post-join ephemeral `/hi` screen).
- **Action-outcome buttons split private vs public** — the private ephemeral outcome view now carries the global nav row (**Hi**, **Journal**, **Action**/**Rest**) plus **Feedback** (💬) and **Bug Report** (🐛); it previously had no buttons. The public Oak's-log copy is trimmed to just Feedback + Bug Report (the nav row, which spawned a per-clicker ephemeral, is dropped).
- **Char-creation emoji moved into the YAML** — each class/background/race/alignment/day-job entry carries its own `emoji:` (validated non-empty at boot) and `/join` reads it off the def, removing five hardcoded name→emoji maps. Character-only surfaces (`/stats`, `/hi`, `/action`, outcome broadcasts) resolve via a boot-seeded registry in `format.ts`; the `/join` ledger and headings derive from one `STEPS` table.
- **Critic backfills the flagged decision's own audit row** — the critiqued call's `raw_prompt` + `reasoning` are written onto its own `llm_calls` row (via `promoteDeepCapture`, COALESCE so it never erases an existing capture), so the rejected output is mineable on its own row. Added `critic_flags`/`critic_rate` shortcuts to `scripts/query.mjs`.
- **Critic verdict is now a queryable column** — `llm_calls.critic_severity` (`ok`/`minor`/`major`, NULL on decision calls) surfaces the verdict without parsing `response_json`; on a flag, thinking + raw prompt are always kept regardless of `LOG_LLM_THINKING_ALL`. Distinct from `validation_warnings` (the deterministic per-decision validator).
- **Auto-capture "spiral" calls** — any call whose reasoning exceeds `REASONING_SPIRAL_CHARS` (default ~6000, observed p90) always persists thinking + raw prompt even with `LOG_LLM_THINKING_ALL` off. Tunable via env; applies to decision and critic calls.
- **Fuller LLM audit for data mining** — `LOG_LLM_THINKING_ALL=true` now also captures the full `raw_prompt` on every well-formed call, and every `llm_calls` row an action produces is linked via `action_id` (previously only the final call), so the whole call chain is mineable. Idempotent backfill; no schema change.
- **Dropped the legacy `actions.llm_request` / `llm_response` columns** — superseded by the `llm_calls` table and NULL since v4. Removed via a guarded idempotent migration; per-call audit is unaffected.
- **No-op refund no longer denied by a stamina or roll-only change (D1 follow-up)** — the auto-resolve refund treats a resolution as world-changing only on a meaningful delta (health, max-stamina, wealth, location, item, NPC). A stamina-only or roll-only "shrug" is again a refundable no-op (first per character per day).
- **Item bonuses now surfaced on `/stats` and the might leaderboard** — `/stats` shows each ability's effective score with gear broken out (e.g. `+6  (+4 base, +2 🎒)`), and the Wed/Sun "Mightiest" board ranks on effective scores.
- **Weekly thread auto-archives after a week, not a day** — the recap thread opens with a 1-week `autoArchiveDuration` so a quiet day no longer archives it mid-week and bounces outcomes back to the channel (the guild may downgrade it by boost tier).
- **Weekly header pins are bounded** — only the newest 12 headers stay pinned (older ones persist as ordinary messages, threads intact), so the play channel never silently hits Discord's 50-pin cap and stops pinning new headers.
- **Player action input is capped and single-lined** — `/action` and the custom-action modal cap free text at 300 chars, and multi-line input is collapsed to one line before reaching the prompt so injected markdown can't impersonate prompt/engine sections.
- **Day-job prompts lead with the task** — preset work now sends the LLM the task label (e.g. `Walk the rounds`) ahead of its flavour hook, so the action reads as a clear, payable task instead of atmosphere alone. Reworked the few entries that weren't actually paid work (inn meal → wait tables, listen for news → muck out stables, practise a tune → compose to commission).

### Internal
- **`llm_calls.call_kind` split into its own idempotent migration (`202606250001`).** It was added inside the baseline migration, which never re-runs once recorded — so on every existing DB the column was missing on upgrade and *every* `llm_calls` insert silently failed (audit data lost). Now a standalone guarded `ALTER`, with a regression test that upgrades a baseline-recorded DB.
- **Review hardening** — the critic re-decide carries its corrective note through the tier-1 stripped retry; the resolution critic skips canned divine-intervention narration; a failed outcome broadcast can no longer repaint a resolved action as an error; `pinReplacing` only unpins the bot's own boards; and the weekly finalize fetches its header before spending the LLM digest call.
- **Decision-pipeline integration tests** — `tests/engine/decision-pipeline.test.ts` drives start→step→resolve through the real `WorldEngineImpl` (not the machine in isolation), asserting the persistence seam: roll drained, character deltas + item rows applied on success, failure reward-strip reflected in the stored character, action row written, and `resumeAction` rehydrating from the DB with no fresh LLM call. Plus `navResponseMode` unit tests guarding the 50035 update-vs-reply decision.

## [0.2.4] — 2026-06-21
### Added
- **Lazy world growth — locations created from play (D3)** — a resolved `set_location` to an unknown place now creates a provisional `locations` row immediately (unsafe, placeholder, `enrichment_pending`) so the player lands somewhere renderable; an async "cartographer" LLM call then fills `is_safe` + a real description and clears the flag (idempotent, never blocks resolution). A name matching an existing location (any casing) reuses that row.
- **`KNOWN LOCATIONS` in the decision prompt (v8)** — the LLM receives the full charted-location list and is told to prefer exact known names, inventing a new name only for genuine off-map exploration.

### Changed
- **Roll economy — a roll is the price of a *resolved* action, not a started one (D1)** — a world-changing or actually-rolled auto-resolve still costs a roll; a true no-op now refunds it, but only the first no-op per character per day.
- **Timeouts are made whole and explained (D2)** — a 30-minute server-side timeout now refunds the roll (first per character per day) and renders an explicit in-character message naming the delay and whether the roll was refunded, instead of a grey "ghost" card.
- **Unsafe-rest HP cost is now explained (G2)** — resting away from the Oak/workplace still costs 1 HP, but `/sleep` now names the rule, the location, and how to avoid it. No mechanic change.
- **Decision prompt bumped to v8** — folds in the above rules plus a typo fix, and settles the `done`-flag contract (an empty `decision` array means resolve; legacy `done` is honoured only as a backstop).
- **Class and day-job emoji on character surfaces** — `/stats` and `/hi` use the per-class emoji instead of a hardcoded ⚔️; the day-job menu uses the per-job emoji instead of a hardcoded 🔨.
- **`/stats` rolls line drops the word "remaining"** — one rolls vocabulary across `/stats` and `/hi`.
- **Divine-intervention fallback copy** — now reads "The Warden's hand" (was lowercase), consistent with the NPC's name.

### Fixed
- **Outcome footer no longer shows a stale `🎲 N/2`** — the daily allowance is 3 (Saturday 4), so the hardcoded `/2` rendered nonsense (`🎲 3/2`); the footer now prints the bare roll count and the spent roll as `(−1)`.
- **`/stats` stamina now shows its ceiling** — reads `N/maxStamina`, consistent with `/hi` (was a bare number).
- **Empty LLM turns no longer burn a roll** — the decision gateway rejects and retries a completely empty response (no options, mutations, or outcome text).
- **Saturday threat NPC can no longer double-spawn** — `last_threat_date` is now stamped on the irreversible spawn, not after the announcement post (a failed post left the guard unstamped, spawning a duplicate).
- **`max_stamina` now persisted on character creation** — the INSERT omitted the column and relied on the DB default; the passed value is now written.
- **`countSoulsInUnsafe()` hardening** — the 18:30 goodnight count builds a name→safety map once and treats an unknown location as unsafe.

### Internal
- `package.json` version synced to `VERSION` (`0.2.3`).
- `expectTimestamp` (user repo) inlines the `users` table instead of interpolating a table-name param — removes an injection-shaped footgun.
- `/journal` command handler is now `async`, matching every other command.
- Mock fixtures aligned to live defaults: `MockWorldEngine` health/maxHealth `10`/`10`, rolls `3`; `MockLlmGateway.defaultDecision()` populates `mutations` + `outcomeText`.
- `.env.example` documents `SLEEP_ADMIN_TICK` and `CLEAR_CHANNEL_ID`.

## [0.2.3] — 2026-06-19
### Added
- **Player-facing release notes** — a YAML file per release tag (`assets/release-notes/<tag>.yml`) holds non-technical highlights; on boot, if the running tag differs from the `last_release_announced` meta and a file exists, the bot posts them with a Request/Feedback button (routes to `submitFeedback`) and stamps the meta (fires once per tag). No file → nothing posts, meta untouched. Gated on `TICK_CHANNEL_ID`.
- **Saturday wilderness threat** — at 12:00 UTC Saturdays the afternoon beat names one unsafe location, spawns a themed hostile NPC there, and nudges players to engage. Location rotates weekly through the five wilderness spots. New `WorldEngine.spawnNpc()` (no `created_by_action_id`); idempotent per UTC day via `last_threat_date`.
- **Wealth + might leaderboards** — Wed and Sun at 12:00 UTC the afternoon beat posts richest-by-coin and mightiest-by-ability boards. New `WorldEngine.getLeaderboards(limit)`; idempotent via `last_leaderboard_date`.
- **Public collapse notices at 0 HP / 0 stamina** — an action, rest, or tick dropping a character to 0 broadcasts a third-person notice to the announcement channel, fired only on the *transition* to 0. Decoupled via `setCollapseBroadcaster`; the tick returns `collapsedNames` for a batched overnight announcement. No death mechanic — 0 is a floor.
- **`hasRestedToday` on character data** — derived from the new `last_rested_day` column vs `day_number`; drives the Rest button's visibility.
- **Five-day absence warning DM** — a player crossing exactly 5 calendar days idle gets a one-shot in-character DM on the tick; best-effort (closed DMs degrade to a log). The tick returns `absentWarnings` (Discord ids).
- **Public "goodnight" announcement** — posted at 18:30 UTC by its own scheduler (idempotent per day, boot catch-up); names the live count of souls still at unsafe locations via `countSoulsInUnsafe()`, otherwise notes all are home.
- **Restored view nav buttons** — `Look`, `Stats`, `Backpack` are back with page-scoped visibility (info pages cross-link; `Look` also on `/hi`); off action-outcome and sleep views, within Discord's 5-button row cap.
- **Admin alert on a stalled world** — `notifyAdmin()` now fires (`World stalled — announcement skipped`) when the morning announcement is skipped because the tick never completed.
- **Daily work blocked at unsafe locations** — quick day-job buttons refuse to start from an unsafe/unknown location with an in-character nudge; freeform `/action <description>` is unaffected.

### Changed
- **Daily action allotment raised 2 → 3** — characters start each day with 3 rolls (creation and nightly reset).
- **Saturday bonus roll for everyone** — the Saturday (UTC) tick grants +1 roll (4 total), tied to the real-world weekday; the threat announcement calls it out.
- **"Sleep" nav button renamed to "Rest" (🏕️)** — now hides once you've rested for the day (was lingering while out of rolls). Internal command id stays `sleep`.
- **Custom day-job action dismisses the menu immediately** — Custom… deletes the stale menu when the modal opens, not on submit.
- **Afternoon beat scheduler (12:00 UTC)** — dispatches by UTC weekday (Sat → threat, Wed/Sun → leaderboards); gated on `TICK_CHANNEL_ID`.
- **Absence no longer costs health** — removed the 3-day `-3 HP` penalty (a net no-op for the common case); replaced with the 5-day DM nudge above.
- **Daily announcement times** — morning moved 07:30 → 05:30 UTC; goodnight at 18:30. Day cycle (UTC): `03:30` tick · `05:30` morning · `18:30` goodnight.

### Fixed
- **Stale stats on auto-finished actions** — the custom-modal and day-job quick-action paths rendered from the pre-action snapshot (old roll count/stamina, wrong nav buttons). Both now re-read the character after `startAction`. The `/action <description>` path was already correct.
- **Missing Feedback / Bug Report buttons on auto-finished actions** — those paths now attach the 💬 Feedback and 🐛 Bug Report buttons too.
- **Mid-action resolve no longer dead-ends** — `step()` now infers resolution from no real options (mirroring `start()`), instead of gating on the deprecated `done` flag; also dropped a stale `done: true` narration instruction and reworded a false-positiving validation warning.

## [0.2.2] — 2026-06-18
### Added
- **The Warden NPC** — a seeded silent, hooded figure at the Oak who tends the fire and offers stew. Added to `seedNpcs()` in `migrate.ts` with class `Warden`.
- **The Warden's location frozen on world tick** — `Warden`-class NPCs are skipped in the nightly movement loop.
- **Warden emoji in `/look`** — renders with `🔥` in the entities list.
- **Conditional Warden lore injection** — the Warden's century-spanning secret is injected into LLM context only when nearby, with instructions to drip-feed it and never explain it outright.
- **Good night message with Action/Feedback buttons** — `/sleep` shows a Components V2 embed with an ⚔️ Action button (day-job menu) and a 💬 Feedback button, reporting how many souls didn't make it home.
- **Unsafe sleep penalty** — sleeping in an unsafe location costs -1 HP, with flavour text.
- **Feedback & Bug Report buttons on action outcomes** — public outcomes now include 💬 Feedback and 🐛 Bug Report buttons routing to `submitFeedback()`/`submitBug()`.
- **Three-day absence penalty** — players idle 3+ calendar days lose 3 health at world tick. Tracked via the new `last_played_at` column.
- **Journal narrative** — LLM outcome text is saved as `narrative` on action rows and shown as quoted beats in `/journal`. Needs the new `actions.narrative` column.
- **Safety emojis on location names** — names prefixed with 🛡️ (safe) / ⚠️ (unsafe) in `/hi`, `/look`, `/journal`.
- **"You are alone here" indicator** — `/look` shows it when no NPCs or other players are present.
- **`countSoulsInUnsafe()`** — new `WorldEngine` method counting player characters at unsafe locations; used by the good night message.
- **`modifyHealth()`** — new `WorldEngine` method for flat health modification (clamped 0..max).
- **`updateLastPlayed()`** — stamps `last_played_at`; called on `/action`, `/hi`, `/look`, `/sleep`.
- **Daily-work teleport** — a day-job quick action from the Oak costs 1 stamina and teleports to the workplace first; custom actions and non-Oak actions never teleport. Wanderers go to a seeded random safe location (deterministic per character per day). See `docs/game/daily-work-teleport.md`.
- **Two new locations** — The Town Forge (Blacksmith) and The Warden's Library (Scribe), seeded safe with ASCII scenes.
- **`/hi` workplace display** — the daily-work section shows the workplace name next to the job title.
- **`workplace_location` in day-jobs YAML** — each job carries it (null for Wanderer, whose destination is computed).
- **`getWorkplaceLocation()` utility** — pure function in `hi.ts` resolving workplace destinations (with Wanderer logic), exported for testing.
- **DB migration framework** — `src/db/migrations/` holds dated `YYYYMMDDHHMM_<description>.ts` files (`up(db)`), applied in order for any id not in the new `schema_migrations` ledger. The `…_baseline` migration wraps the prior `schema.sql` + v2–v7 ALTERs, so existing DBs run it as a no-op stamp and fresh DBs build from scratch. Replaces the single growing `migrate()`.
- **Applied-mutation insight logging** — every resolved action persists the mutations actually applied (post-validation, post-failure-strip) as JSON in the new `actions.applied_mutations` column, and emits an always-on `[mutations]` log line with the before→after change (e.g. `rolls 1→0`).
- **Admin notification on tick failure** — `notifyAdmin()` on nightly tick / morning announcement failure, so silent errors like `DiscordAPIError 50001` aren't invisible.
- **Hi button on morning announcement** — a 🌅 Hi button spawns an ephemeral `/hi` for the player via the existing nav handler.
- **`setMeta()` on `WorldEngine`** — lets the morning announcement write `last_announcement_date`.
- **`last_announcement_date` idempotency guard** — prevents double-posting the morning message on restart.
- **Player class emoji on public action outcomes (P2)** — the channel outcome leads with the player's class emoji (`⚔️ **Name** — hunt`), via a shared `classEmoji()` helper in `discord/format.ts` (also used by `/join`).
- **`LLM_MODEL` env var (P1)** — overrides the LLM model at boot; empty falls back to the gateway default. Active model logged on init.
- **`player_characters.last_played_at` + `actions.narrative` columns** — new dated migration backing the goodnight/rest features. Schema-only.

### Changed
- **`done` is inferred from the absence of options (P1)** — the action machine resolves a choice-less, non-required beat immediately instead of trusting the LLM's `done` flag (dead-ending on a lone "Step back"). Divine intervention and required actions are unchanged; emits an `[action] auto-finished` log line.
- **Loading screen echoes the player's choice (P2)** — the interim message shows `**You:** <input or chosen option>` above the spinner.
- **Tick decoupled from announcement** — the 3:30 UTC tick and 7:30 announcement are now separate schedulers; the tick writes `last_tick_players_affected` / `last_tick_npc_movement_count` meta the announcement reads later.
- **Decision prompt `v7` — bail/`done` simplification** — now that the engine adds "Step back" itself and infers completion, the prompt no longer asks the LLM to emit a bail option or lean on `done` to end a no-option beat (`required` and `done` for `CONTINUE`/`RESOLVE_ROLL` stay). Also corrects the `RECENT ACTIONS` doc. `PROMPT_VERSION` → `v7`.
- **`/hi` shows status, not ability scores** — the header leads with `❤️ HP ┃ ⚡ Stamina ┃ 🎲 Rolls ┃ 💰 Wealth` and drops the PHY/WIS/INT/CHA line; Wealth surfaced, low-health warning preserved.
- **`/action` gamebook layout** — decision screen and outcome recap read as one gamebook page: narration as blockquotes, choices in bold (`↪ **Choice**`), and a qualitative difficulty arrow per past choice (🟢⬇️ easier / 🔴⬆️ harder) instead of a raw DC. Degrades gracefully to fit Discord's 4096-char cap (collapse history → drop art → hard clip).
- **Recent-action narrative thread fed to the LLM** — `RECENT ACTIONS` now carries each prior action's stored `narrative`, oldest→newest, count raised 2 → 3 (was `type (outcome)` only).
- **Nav button cleanup** — removed `look`/`stats`/`backpack` from the global nav bar (remaining: `hi`, `journal`, `action`, `sleep`).
- **`/hi` location safety display** — safety emoji moved onto the location name instead of a separate badge.

### Fixed
- **Out of rolls now offers Sleep, not a dead Action button** — `Action` is hidden exactly when `Sleep` appears (out of rolls, not mid-action); the two are now mutually exclusive. `Action` still shows mid-action so a player can resume.
- **`ephemeral` reply-option deprecation** — replaced `{ ephemeral: true }` with `flags: MessageFlags.Ephemeral` across `action.ts`, `join.ts`, `index.ts`; `buildComponentPayload` folds the bit into the Components V2 `flags` bitfield.
- `MockWorldEngine` now implements all `WorldEngine` interface methods (`updateLastPlayed`, `modifyHealth`, `countSoulsInUnsafe`).

### Chore
- **`biome.json`** — formatter config enforcing `indentStyle: space, indentWidth: 2`.
- **Post-PR#14 code-review cleanup** — renamed `computeItemBonus` → `itemStatModifier` and `computeRollBonus` → `abilityCheckBonus`; reindented `hi.ts` to 2-space; removed the dead `_getScene` param; added rogue/scout/guard archetypes to `npcEmoji`. See `docs/sparks/handover-code-review-post-pr14.md`.

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
