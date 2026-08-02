# Changelog

All notable changes to The Warden's Oak are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.3.3] - 2026-08-02

### Added

- **A newcomer the story names now arrives with a body** *(RA-3, non-combat half / F#1)* — the narrator mints a named newcomer the moment it is described rather than leaving it as prose, and `add_npc` gained an optional `health` field so the townsperson you met is a real, re-encounterable NPC a later fight can measure itself against.
- **A won fight now ends on a choice: finish the foe, or show mercy** *(RA-5c / SL-6)* — depleting an enemy's HP used to jump silently to the outcome card, so the killing blow never landed as a beat (F#11). The win now pauses on one interstitial screen showing the broken foe, offering **Finish it** or **Show mercy**; the fight resolves as a win either way. Sparing records the foe as a wounded survivor, so meeting it again is a real but easier fight rather than a fresh one at full strength — and that survivor is what makes a narrated foe worth persisting at all. The terminal card names which ending you chose. The beat costs nothing: no extra roll, no stamina, no LLM call, and abandoning it refunds the roll exactly as any other unfinished action does.

### Fixed

- **A found item can no longer carry an arbitrary stat bonus** *(RA-1 stage 1)* — the narrator authors `add_item.modifier` freely with nothing capping it, so one generous roll could hand out a permanently game-warping +7 sword. Bonuses are now clamped to +2 rather than dropped, so the item still arrives, just within the intended band; a malformed or non-finite modifier reads as 0, not the ceiling (commits `03b200c`, `69f0418`).
- **An earned roll now always says so** *(RA-2)* — the `✨ Inspired` line was gated on the grant netting to zero against the action's own roll spend, so an action that granted *and* netted positive showed the reward only as a bare `+1` beside the dice glyph. It now fires on the grant itself, and reads `✨ Inspired: +N roll(s)` (commit `689daf4`).
- **A foe the world named but never had now becomes real once you let it live** *(RA-3, bounded half)* — the oldest open complaint (F#1, the vanishing caravan): the narrator would name a specific person, you would fight or meet them, and the world never persisted anyone, so they simply ceased to exist. When a fight is established against a foe the narrator anchored to a named NPC that the world does not actually contain, and that foe walks away alive, it is now written into the world as a real NPC carrying the wound it took. Meet it again and it is the same individual, remembered and weakened. Deliberately narrow: a foe that was already a real NPC needs no minting, and ambient wildlife stays ephemeral even though the narrator gives it a name — otherwise every wolf you met would become a permanent resident.
- **A slain foe now reads "Slain", and a worn-down foe no longer reads "Healthy"** *(RA-5a)* — two separate bugs on the same outcome frame. The enemy condition band had no terminal tier, so a foe at 0 HP bottomed out at "Critical" beside an empty pip bar (F#11): killing something never said so. Separately, the outcome frame banded the foe against its HP at the *start of the final round* rather than its maximum, so a 20-HP foe worn down to 10 that took 2 more damage read as `8/10` → "Healthy" when it was actually at 40% → "Bloodied". The frame now bands against the foe's real maximum, which the other two condition-band call sites already did.
- **A foe the narrator left unnamed no longer shows a blank nameplate** *(RA-5a)* — DECIDE naming a combat enemy as an empty string passed validation, because the enemy-name field lacked the emptiness check its sibling scene-location field has. That established a fight with a nameless foe, and it slipped past the "Minion" fallback, which only fires when the enemy hint is missing altogether. An empty or whitespace name now drops the hint so the intended ambient fallback takes over.
- **Re-engaging a bailed fight with vague text no longer shows "Unknown foe ?/?"** *(0.3.2 C4 follow-up)*. When DECIDE names no foe, the combat opener now reads the foe's name and banded condition from the persisted `in_combat` edge, guarded by an anchor check so a stale edge can't leak onto an unrelated fight (commit `3bd266d`).
- **Private outcome embed now matches the public one on every action path** *(RA-6)* — day-job work and the nav-button custom action resolve straight to an outcome with no decision embed first, so the compact private reply (F#19c, "the player just saw the thread") left those two paths missing the gamebook trail the public copy carried. All four action paths now share the same full embed.
- **HP numbers and right-aligned columns on combat cards no longer run flush against the right border** *(0.3.2 P1 follow-up)* — the continue card's right-aligned columns (enemy contested roll, band word, HP deltas) and the opening frame's PC HP suffix were computed to fill exactly to the interior edge, leaving no gap before the border glyph. Both now leave one space, matching the player HP bar that already had it.

### Changed

- **Hard things are now actually hard** *(RA-1 / v13 prompt set)* — the old ladder capped the contract at DC 18 while calling 17+ "daunting", so no observed action ever exceeded 17 and 83% of everything succeeded. The bands are re-anchored to routine 11-13, hard 16-18, daunting 20-24, and every option set must still keep one option in the routine band, so an ungeared character always has a real approach and the top of the ladder is a gamble you choose. Reward prose is now asked to track how ambitious the attempt was, since RESOLVE is never told a DC of any kind and can only read ambition off the chosen option's label.
- **The daunting band is now actually reachable** *(P1 / v13 prompt set)* - the ladder above was stated on the anchor DC (`baseDc`), but a roll is always made against the anchor plus its option's modifier, so a measured 0 of 21 option sets ever reached daunting, even on deliberately extreme prompts. The ladder now names each band by the final per-option DC and derives every offset from the band that option must land in, so an anchor placed mid-range can reach routine, hard and daunting from one set without widening the existing ±5 modifier cap. Whether play now actually reaches daunting is unmeasured by design, pending isolated DECIDE probes rather than an agent-player run (commits `9a8bc8d`, `75dc928`).
- **A failure now costs something a success does not** *(RA-1 / v13 prompt set)* — both verdicts charged stamina, so failing read as "success minus the reward" on the same axis. A failure must now carry a non-stamina cost (coin, an item, or a point of health), with stamina demoted to a secondary. The rest and search recipes, which could previously fail for free, comply.
- **Inspiration is now rare and earned** *(RA-2)* — an extra roll landed on 29% of actions, inflating the day to ~4.8 rolls and making the three-a-day economy meaningless. It is off the routine skill, rest and catch-all menus, marked as an exceptional grant everywhere else, and a natural 20 now pays +1 rather than +2. Target is ~10% of actions, roughly 3.3 rolls per active day.
- **A spared foe is no longer narrated as dead** *(RA-5c, prompt half)* — the combat-success recipe opened "the engine already resolved the kill" and looted "the fallen" regardless of the ending chosen. It now branches on the `fatal blow` token: sparing narrates a foe alive, wounded and remembered, and any reward is what the fight yielded rather than what was taken off a body.
- **Day-job work no longer grants inspiration** *(RA-2 / F#12)* — the day job pays coin, not cadence. It is the reliable floor of the daily loop, so a guaranteed-income action handing out extra rolls was a leak rather than a bonus; inspiration is meant to be the exceptional reward for an ambitious attempt. Enforced in the engine, so no prompt wording can reintroduce it. A cost still passes through: only the positive direction is stripped (commits `689daf4`, `9a25005`).
- **The coherence critic no longer reviews narration, only decisions** *(RA-4)* — a measured A/B (recorded in the Release A build plan) found the narrate half of the critic inert: it cannot act on a `major` verdict at all, because dice and mutations are already final by then, so only a prose-patching `minor` can change anything — and across a two-day run every narrate call returned `ok`. The decide half earned its keep (6 real corrections in ~22 beats) and still fires on every beat. `CRITIC_GATE_MODE` selects the policy: `narrate-gated` (new default), `always` (the previous behaviour), or `anomaly` (gate both). `ENABLE_COHERENCE_CRITIC` remains the global off-switch. Net effect is ~30% fewer critic calls with no measured loss of corrections.

### Internal

- **The active prompt set is now v13** — `PROMPT_SET_VERSION` bumped, and the four hardcoded `'v12'` literals in `src/` (the production `ProdPipelineGateway` default among them) now derive from the constant, so the set is stamped as a unit and the next bump is a one-line change. `v12/` stays on disk and still loads, since historical `actions`/`llm_calls` rows stamped `v12/...` must remain attributable.
- **The resolve handoff now carries the chosen fight ending and the decision prompt** *(RA-1 stage 2)* — plumbing for the coming v13 prompt set: `fatalBlow` (finish or spare) and the originating decision prompt are threaded into RESOLVE, so the narration can stop describing a spared foe as dead. No player-visible change on its own; the prompts that read these tokens land with the v13 bump (commits `e0f81de`, `66143bc`).
- **An agent-player run now reports what the LLM cost** *(RA-4)* — the run prints calls and tokens per `call_kind`, the critic verdict spread, and a per-beat critic split, backed by a new nullable `llm_calls.beat` column recording which beat a critic call reviewed. The headline finding is that the critic was never the cost centre: `pipeline-decide` is a quarter of calls but ~44% of tokens, while critic calls are roughly a third the size of a decide. **Also fixes a latent gap found on the way:** the harness never wired a coherence critic at all, so every agent-player run to date silently skipped it regardless of `ENABLE_COHERENCE_CRITIC`.

- **Day-job commute rule moved into the engine** *(JSON-seam M0)* — `WorldEngine.commuteToWorkplace` now owns "at the Oak → move to workplace, −1 stamina"; the Discord handler only renders the result, deleting the UI layer's sole direct DB write. The engine's single-purpose `recordVisit` seam method is absorbed and removed (commit `98a4de1`).
- **Dispatcher made testable + a behavioural oracle** *(JSON-seam M1)* — the ~930-line `dispatchInteraction` closure was hoisted verbatim out of `main()` into an injectable `src/discord/dispatchInteraction.ts` (deps passed via `DispatchDeps`; the in-flight guard/error funnel stays at the registration site), with zero behaviour change. A golden-transcript oracle (`tests/discord/dispatch-oracle.test.ts`) now characterises all 17 dispatcher leaves plus the resolved/outcome render path and pins the customId cascade order, as the diff-against baseline for the coming controller extraction (commits `b9b4c4a`, `2a3a069`, `0bd0401`).
- **Action rendering split behind a semantic view-state seam** *(JSON-seam M2)* — `buildDecisionMessage`/`buildOutcomeEmbed` now assemble a transport-neutral view-state DTO (`src/view/viewState.ts`, no `discord.js`) via `buildDecisionView`/`buildOutcomeView`, which a single medium step (`src/discord/viewToDiscord.ts`) maps to Discord embeds/components — the block join, the embed-length degradation ladder, and all `EmbedBuilder`/`ButtonBuilder` construction live there. Pure internal refactor: Discord output is byte-identical (the M1 oracle and action snapshots are unchanged). This is the shared-renderer seam the coming controller (M3) and agent-player (M4) emit into (commits `2275a42`, `a04ede2`).
- **Session flow extracted into a transport-neutral controller** *(JSON-seam M3)* — the game-flow smeared across the Discord dispatcher (action-choice resolution, the day-job menu + work flow, custom actions, feedback/bug submits, the character-gate reroute, last-played stamping) now lives in `src/controller/SessionController.ts`, which never imports `discord.js` and emits `ViewState` DTOs the adapter paints. The engine absorbed option-resolution (`resolvePendingChoice`), so the Discord-side `pendingDecisions` map is gone; the dispatcher is left with transport + paint only. Byte-identical throughout (M1 oracle + M2 snapshots unchanged). This is the controller M4's agent-player reuses (commits `825ae41`…`d9e96a0`).
- **In-process agent-player QA/playtest harness** *(JSON-seam M4)* — a Discord-free peer adapter (`src/agent/`) that stands up a real `WorldEngine` + `SessionController` and plays the whole game across days with a real DeepSeek brain, all features on. It captures exceptions, dead-ends, and invariant breaches as structured transcript findings (a throwing run still writes a repro), and a critic LLM turns a completed run into a qualitative playtest report. Opt-in via `npm run agent:play` (needs `DEEPSEEK_API_KEY`; optional `AGENT_DAYS`, `DEEPSEEK_MODEL`); tests use deterministic stubs so CI never hits the network. Imported by neither `discord/` nor `sim/` (commits `6d03890`…`384309e`).

## [0.3.2] - 2026-07-11

### Changed

- **Combat trades now reward the higher roller, and every round shows both HP outcomes** *(0.3.2 C2)* — a `trade`-band round (a close contest) used to deal a flat −2 to both fighters, so edging the roll higher yet still losing 2 HP read as a contradiction. The margin's sign now decides who takes the lighter hit: whoever rolled higher takes −1, the other −2 (a dead tie stays −2/−2). Both combat cards now print each fighter's HP delta (`you −1  foe −2`) beside the band word, so the band, the HP change, and the verdict tell one story. Per-round beats stay band-led (no win/loss word); an unqualified `WON`/`LOST` now appears only on the fight-over card. Band thresholds and the margin maths are unchanged.

### Fixed

- **Saturday threat NPC stays put at its announced location** *(N1)* — the weekly wilderness threat was spawned at the announced spot (e.g. The Forest Edge), but the very next nightly tick's NPC wander (80% move chance) drifted it off, so async players arriving later found no-one there. Spawned threats are now anchored to their `home_location` and skip the wander, holding their post for the whole weekend; `spawnNpc` is also idempotent (re-announcing the same foe at a spot it still occupies no longer stacks a duplicate mob).
- **Crossed frontiers now enrich instead of staying placeholders** *(N2)* — a frontier crossing mints a provisional location (`"An uncharted place… (Mapping…)"`, unsafe, no tags) inside the state machine's finalize, but the engine's `applyResolution` re-runs finalize against the now-bound edge and so reported *no* minted names — meaning the async cartographer was never fired and the placeholder never resolved to a real description + scene tags. The engine now recovers the minted rows by diffing the `enrichment_pending` set across the machine call (`mintedSince`) on both the single-beat auto-resolve and multi-beat step paths, so a crossed frontier reliably schedules enrichment. Failed enrichments are still logged (best-effort, fire-and-forget); an active retry sweep of stuck rows is tracked as follow-up in `TODO.md`.
- **Unfinished-action screen no longer advertises an impossible continue** *(N5)* — the `/hi` pending-action panel offered "type `action <what you do>` to continue", but a mid-action resume replays the saved decision verbatim and ignores any description, so that free-text path never did anything. The line now reads simply "Press the **Action** button to continue." The `to start` menus keep their free-text hint, where `/action <description>` genuinely works.

- **Combat actions never silently auto-resolve** *(0.3.2 C6)* — when CLASSIFY routes an action to `combat` but DECIDE returns no options, the machine previously auto-resolved the fight as a one-shot skill action, producing no contested-roll spine or combat screens. A boss fight could resolve to a single line of prose. This was the empty-decision auto-resolve branch firing for any action type, including combat. Now, a combat action with an empty `decision[]` synthesises a single "Press the attack" first decision with a voluntary flee, so at least one contested round runs — fails closed to a real fight. (The root-cause companion — actions the player intends as combat being classified as `skill`/`rest` — is a classify-prompt-template accuracy concern deferred to v13.)

- **Combat outcomes show the combat opening frame instead of the plain location scene** *(0.3.2 P2)* — the killing blow previously rendered a bare location scene or nothing at all on the outcome embed, losing the visual fight context. Now, a combat outcome pairs the terminal card (dice reveal) with the combat opening frame (enemy nameplate, HP-condition band, player nameplate), so the flow reads scene → dice as a coherent visual story. The margin and band are already on the terminal card from C1/C2. No Stage-2 broadcast plumbing is added.

- **Combat cards keep padding between the HP number and the edge, and the terminal label never truncates mid-word** *(0.3.2 P1)* — the player's `N/MM` HP figure on the continue card ran flush against the right border with no gap. The HP bar width now leaves a space inside the border. A `clipWord` safety net ensures any display text entering the card interior clips on a word boundary with an ellipsis, never mid-glyph.

- **Re-entering a fight shows the foe's remembered condition, and the opener names a known foe** *(0.3.2 C4)* — bailing out of a fight leaves the enemy remembered with its persisted damage, but re-engaging showed a blank `?/?` enemy bar as if the fight were fresh. The combat opening frame now reads that persisted `in_combat` edge and shows the foe's banded condition (a pip bar plus a wound word — `Bloodied`/`Battered`/`Critical`, never exact numbers, matching the continue card), so the damage you dealt carries over visibly. It renders only when the remembered foe matches and is genuinely still damaged; a fresh fight is byte-for-byte unchanged. The opener's foe nameplate (already plumbed from the decision's combat signal) is confirmed to name a known enemy, with "Unknown foe" reserved for a genuinely unnamed encounter.
- **The foe now fights at its real HP and under its real name** *(0.3.2 C3)* — a combat against a known NPC (a 24-HP stag) rendered as a generic `Minion 6/14`, because the enemy's max HP was sized from the encounter DC and the name fell back to a default. When a combat resolves to a nearby NPC, the fight now seeds its name and its own `health` as the combat max (real NPC health beats the LLM hint beats the DC-derived guess), clamped to the combat bounds; a nameless/ambient foe still derives from the DC. `enemyMaxHp` is held fixed for the fight, so the bar only ever shrinks — it can no longer grow or reset between rounds or across the last-stand path. Threaded the NPC's `health` through the nearby-NPC resolver shape to make it available at combat start.
- **Combat continue card now shows the contested roll, not a misleading `[DC N]`** *(0.3.2 C1)* — the between-decisions card printed a boxed `[DC N]` that read as a pass/fail threshold, so a player who rolled 22 against a shown "DC 15" and lost the contest saw a contradiction. It now mirrors the fight-over card: the player's total floated left, the enemy's contested total (`vs {d20} {bonus} = {total}`) right, so the sign of the margin is self-evident. The DC is demoted to a worded encounter-danger tag on the foe's nameplate (`easy`/`medium`/`hard`/`risky`/`fatal`), never a beat threshold.

### Internal

- **Saturday last-action hint verified correct and regression-locked** *(N3)* — the "🎲 Last action of the day" hint keys off rolls *remaining* (`=== 1`), not the day's allowance, so it already fires only on the genuine last roll whether the day grants 3 or Saturday's bonus 4 — the reported "premature on Saturday" firing does not reproduce against the current `buildActionHints`. Added Saturday-framed regression tests (no warning at 2 rolls left, warning at 1) and a clarifying comment so the allowance-agnostic invariant can't silently drift.

## [0.3.1] - 2026-07-11

### Changed

- **Combat frames redesigned** — the between-decisions continue card and the fight-over terminal card rebuilt per the [[visual-craft]] creed: a floated, colour-coded roll readout with the DC boxed and emphasised (`[DC N]`) instead of spelled out, the `d20` label dropped, the band word and `+`/`x` marker carrying the meaning in monochrome, and the HP bars using banded enemy condition pips instead of exact numbers. The border register escalates with intensity and rarity (single box-drawing → heavy double-line when bloodied → ornamental crest-interrupt rim on a nat-20), so a punishing round or a critical hit looks different before a word is read. `src/render/AnsiRenderer.ts` gains the `BorderStyle` ladder and `BORDERS` registry; `src/render/CombatCardRenderer.ts` adds `renderCombatContinueCard` and `bandColor` and redesigns `renderCombatTerminalCard`. Supersedes the plain dice-line readout from `d7a3cb5`.

### Added

- **Opening frame before every action's first decision** *(ANSI-F)* — after `classify` routes an `/action` to one of the seven types (combat/travel/social/skill/search/rest/other), an ANSI scene-setter frame now leads the decision message: a foe/PC nameplate for combat, the origin location for travel, an NPC bust for social, and deliberate placeholder scenes for the fragment-gated types (the `fragments` catalogue stays deferred). Delivered as a leading embed ahead of the narration+options embed — Discord can't reply to an ephemeral response, so the literal two-message art-post convention applies to public surfaces only (recorded in the framework doc). Known gap: actions that auto-resolve at start (common for travel/rest) show no frame yet — tracked in `TODO.md`. New `src/render/OpeningFrameRenderer.ts`, 67 tests.
- **`/action` menu hints** — the initial day-job menu now surfaces contextual hints on both the slash and nav-button paths: 🎲 last action of the day, 😮‍💨 low stamina (≤25% of max, floored at 2), ⚠️ unsafe location. Nothing renders when nothing applies.
- **Welcome tag on the new-hero broadcast** — the public "✨ A new hero joins the Oak" announcement now mentions the owner (pings suppressed, matching the 0.2.8 identity treatment) and carries the 🌅 `Hi` re-entry button. Commit `068e96b`.
- **Combat maths reveal** — combat outcomes now render an ANSI-coloured frame showing the dice roll vs DC, the margin, and per-combatant HP bars with signed damage floaters. The ASCII scene art is dropped from combat outcomes to make room. Enemy HP is banded (condition bar + wound word) on the continue screen and exact on the terminal outcome. Header and footer each get their own HP-bar line, never crammed onto one line. Displayed HP is clamped to `[0, max]`, never negative. Built on the new `AnsiRenderer` (`src/render/`). Commits `500efca`–`94ecbee`. Closes F#7, B#5, B#6, and the combat half of the "drop ascii from outcomes" TODO item.

### Fixed

- **Custom actions show a thinking screen** — the free-text modal path now renders your submitted text plus a ⏳ Thinking… beat (matching the day-job loading envelope) before the LLM call, instead of Discord's bare spinner; an error during the call clears the thinking page rather than sticking beside the error text.
- **Rest button has weight, and a refunded rest no longer swallows its inspiration text** *(F#8)* — the Rest nav button gave no feedback on click; it now shows an immediate 🏕️ "Bedding down…" beat before the result lands, mirroring the day-job loading envelope, and the rest body's unsafe-penalty and closing prose read as distinct sections instead of one run-on paragraph. Separately, the ✨ inspired (+N roll) line was gated on the roll *not* being refunded, so any refunded action swallowed its grant text — refund and grant are independent facts and both now render together (the "auto-resolved rest showed refunded but no inspiration text" report, closing B#3's display follow-up).
- **Item losses now read as a subtraction, not a bullet** *(B#4)* — a dropped/consumed item rendered as `- {name}`, which Discord treats as an unordered-list marker, so a loss read as merely *listed* rather than removed (and dropped the item emoji that gains show). Losses now render with a real minus glyph (`−`), mirror the gain format (emoji when present, `×N` when a quantity is set), and can never turn into a stray bullet.
- **Inspiration/bonus-roll accounting fixed on the auto-resolve path** *(B#3, also closes B#1)* — when an action resolved instantly at start and its outcome granted a roll (`modify_rolls_remaining`), the resolution wrote its rolls count off the stale pre-drain value, silently clobbering the start-drain: a character on 3 rolls ended on 4 instead of 3, while the footer still reported `-1`. The auto-resolve branch now drains the in-memory row before applying the outcome (mirroring the step path), so drain and grant net correctly, and the reported delta reflects the true net. This is the accounting behind the "auto-resolved rest showed refunded but no inspiration text" report, and it is the same root cause as the "footer showed `-1` but the count rose from 3 to 4" report (B#1) — that footer symptom is now impossible on every resolved path.
- **`max_stamina` gains now persist** *(B#2)* — `CharacterRepository.update`'s field allow-list omitted `max_stamina`, so a `+N` max-stamina reward never saved (the player saw the gain but `/stats` kept the base value). Added to the allow-list, audited the list against the schema (no other column was missing), and dropped the raw-SQL workaround in `src/sim/driver.ts` that routed around the gap.
- **Divine intervention no longer costs a roll** *(F#21)* — the pipeline's typed classify-fallback refunds the roll, authors no mutations, and renders as a distinct grey ⚠️ System embed (the initial `4c51334` embed was unreachable, so divine mis-rendered as a normal outcome and misreported the refund; now fixed). Commits `4c51334`, `6e04929`, `ecc4741`.

### Internal

- **Per-round combat maths persisted** *(ANSI-D round log)* — `CombatBeatLog` gains the full round maths (`playerD20`, `playerBonus`, `dc` — the round's `baseDc` feeding the enemy bonus, not a pass/fail threshold — `enemyD20`, `enemyBonus`, `margin`), lifted from the transient round outcome instead of discarded. The accumulated per-fight list persists on the pending-decision record between beats and rides the terminal outcome (`combatRounds`), tolerant of old in-flight states without it. Engine data only; the dice-line rendering follows.
- **Combat-status rendering decoupled from the engine** *(ANSI-C)* — `ActionDecision.combatStatus` now carries structured `CombatStatusData` (enemy name, wound band, pips, clamped player HP/delta) instead of a pre-rendered ANSI string persisted in state JSON; the Discord layer composes the frame. Old in-flight actions with a string status still render via a tolerant read (regression-tested). `OutcomeRenderer`'s terminal combat frame is composed the same way (frame renderer injected by the caller), so `src/render/` has no engine-side importer. One-way door: rolling back past this commit with a combat action still in flight would render the persisted `CombatStatusData` object as `[object Object]` on the continue screen (cosmetic, not a crash).
- **`AnsiRenderer` standardised on a palette module** *(ANSI-B)* — the colour vocabulary (`Role`, role→SGR maps) moves out of `AnsiRenderer.ts` into new `src/render/palette.ts`, which exports a `Palette` shape and a `PALETTES` registry (`house` default plus `ember`/`gloom` mood variants); `renderFrame` now takes an optional palette argument instead of reading a hardcoded map, and `chrome` moves off SGR 30 (black, invisible on Discord's dark code-block background) to 37 pending ANSI-A's bright-SGR verdict. The existing combat frame's rendered output is unchanged except for that one chrome code, proven by a regression test against a pre-change fixture.
- **Combat round-card wireframes** *(ANSI-D mocks)* — canonical monochrome mocks for the between-decisions continue card (enemy condition band + player HP + the new round dice line) and the fight-over terminal card (full data-card conversion: dim label, focal d20, calc line, `+`/`x` verdict, flavour — no sprite chrome, no duplication of the embed stats footer), each as a slot template beside a filled example under `assets/ansi/wireframes/`, width-validated by `tests/render/combat-round-wireframes.test.ts` and indexed in the wireframes README. The frame code follows these.
- **ANSI-A live verdicts recorded (2026-07-11)** — the operator probe session settled all three renderer questions: bright fg 90-97 render no colour anywhere (chrome stays 37, final — the skill's chrome=90 guidance corrected); bg 40-47 are desktop-only and completely invisible on mobile (never carry meaning); box-drawing/half-blocks are single-width on desktop and mobile (border prettification un-gated); and the palette is Solarized-custom, not standard ANSI (hex recorded in `palette.ts`). Facts folded into the `ansi-frames` skill, `mvp+ansi-art`, and the probe checklist.
- **ANSI SGR/palette/glyph probe set** *(ANSI-A)* — five `00_PROBE-*.ansi` frames (fg 30-37, bright 90-97, bg 40-47, glyph rows against a column ruler, Solarized-vs-standard palette comparison) plus an operator checklist in `docs/assets/ansi/test/colour/`, delivered via `send-ansi` to settle the three live-only renderer questions (bright-SGR support, palette hex, box-drawing width on mobile) blocking the renderer standardisation.
- **Single-width glyph hard rule for frame art** — confirmed live that emoji and Miscellaneous-Symbols/Dingbats glyphs (`⚠ ☺ ✦ ❖ ✓ ✗`) plus East-Asian-Ambiguous punctuation (`§`, `→`) render double-width in Discord `ansi` blocks, pushing the row's border out of line. Rule codified in the `ansi-frames` and `game-art-static` skills, the classification framework, `mvp+ansi-art`, and the wireframes README (with ASCII substitutes: `! @ * x # >`); the colour test set corrected to comply.
- **Admin-DM preview scripts** — new `scripts/send-dm.ts` (`npm run send-dm`) DMs one arbitrary message to the admin from a CLI arg, file, or piped stdin (optional `--fence`/`--title`), and exports `sendToAdmin(payload)` so a throwaway script can post real `src/` builder output for a manual look. `scripts/send-ansi.ts` reworked to repo-relative paths (runs on the dev Mac and the deploy host unchanged) and now refuses to send any frame that violates the single-width glyph rule.
- **Opening-frame wireframe library** — canonical monochrome `.ascii` mocks under `assets/ansi/wireframes/`, per classified action type a slot template beside a filled example, width-validated by `tests/render/opening-wireframes.test.ts`. Reference art for the `AnsiRenderer`, not yet emitted at runtime. Introduces the **opening frame** (post-`classify` scene-setter) and the universal **art-post + reply-body** delivery convention, formalised in `docs/engine/ansi-art-classification-framework.md` §2b/§2c/§3.0.
- **v12 dead-code sweep** — the legacy `ActionStateMachine`, the `PROMPT_VERSION` indirection, the critic dual-injection, and the v11-only tests are deleted; the engine is pipeline-only. Closes stage-5 T7. Commit `72fb32d`.
- **Visual-craft vision doc** — `docs/vision/visual-craft.md` enshrines the presentation north star (perception, clarity, UX): monochrome-is-the-asset, colour-as-enhancement, the data-card typographic hierarchy, and a border register that escalates with intensity and rarity. Carries the `0.3.1` combat-frame redesign (floated roll readout with a boxed/emphasised DC; the standard → heavy → crit border ladder) as its first worked example. Registered in the map of content under `vision`.
- **`0.3.1` polish release planned** — `docs/engine/poc-plus-0.3.1-polish-plan.md` (build plan) bundles the ANSI frame-polish block (the T2 live-check debt: settle SGR/palette facts, standardise the renderer off black `chrome` + palette module, decouple render from engine, per-round combat maths visibility, opening-frame delivery), the 2026-07-08 prod bug batch (B#1-B#4), and small UX wins into the `0.3.1` interstitial release before stage 2. Roadmap tracking, stage-1 T2 live-check reconciliation, and the map of content updated to match.
- **POC+ Shared World arc decided** — `docs/game/poc-plus-roadmap.md` flips to `decided` (kill credit, buff vocabulary, broadcast stance, and frame authorship settled; versions unpinned; the v12 tail folded in as item 0) and gains its stage-1 build plan `docs/engine/poc-plus-stage-1-plan.md` (v12 tail + welcome tag + combat maths reveal), written as the orchestrated-delegation handover.
- **`AnsiRenderer` built** — new `src/render/AnsiRenderer.ts` module for coloured Discord `ansi`-fenced frames with colour-by-role, 30-char width enforcement, and backtick escaping. Intended as the shared renderer for the POC+ arc (combat frames now, broadcast frames in stage 2). Commits `500efca`, `712d946`.

### Changed

- **Every combat round's dice are now visible when it happens** *(ANSI-D frame code)* — the between-decisions continue frame gains a dice line (`d20 N +B vs DC D`, then `margin ±M BAND`) drawn from the round just fought, so rolls no longer surface only at the fight's end. The fight-over terminal frame is rebuilt as a data card — a dim `COMBAT RESOLVED` label, the focal d20, its calc line, an ASCII `+`/`x` win/loss verdict with the margin, and one line of flavour — dropping the enemy nameplate and HP bars that duplicated the outcome embed's own stats footer. Both read off the persisted per-round log (`combatRounds`), falling back to the terminal beat for a fight predating it. New `src/render/CombatCardRenderer.ts`. Closes the "list each dice roll/outcome per decision" TODO item.
- **Morning and evening announcements carry rotating prose** — dawn and dusk messages now draw a scene-setting flavour line from a small pool, rotated deterministically by day number (same day, same prose everywhere). The builders live in `src/discord/announcements.ts` and are shared by the live cron posts and the admin `/sleep` tick, so the two can no longer drift; the data lines (Day N, souls stirred, unsafe-souls warning, Saturday threat heads-up) are unchanged.
- **Journal decluttered** *(F#6)* — `/journal` splits into distinct sections (Chronicle, NPCs Encountered) with bold headers and native separators; successes and failures render as bold colour-coded tags (✅ **Success** / ❌ **Failed**) instead of a bare ✓/✗, so a run of failures is scannable. Actions that revealed a location or introduced an NPC show that intel as a rail under the entry (🗺️ Discovered / 🤝 Met), read from the action's already-stored mutations — no new tracking.
- **`/join` wizard readability** — option lines no longer crowd label, stat bonuses, and description onto one dash-separated line: the label sits on its own line, bonuses set off as a blockquote, description beneath. The progress ledger now shows the chosen class/upbringing/race's own emoji next to its crossed-out entry.
- **Decision emojis trimmed** *(F#3)* — decision options now show only the stakes arrow (⬇️ easier / ⬆️ harder) for DC shifts, and a spotted passive insight is conveyed solely by the favoured button's green colour — the doubled-up 🟢/🔴 dots are gone from the option text and the footer hint.
- **Logging/debug env vars consolidated** — `LOG_LLM_THINKING_ALL`, `LLM_LOG_ALL_PROMPTS`, and `REASONING_SPIRAL_CHARS` are removed (no aliasing); replaced by `LLM_LOG_THINKING=errors|spiral|all` (default `spiral`) and `LLM_SPIRAL_CHARS`, read once at boot via `src/config/env.ts`. A stale var still set in `.env` now logs a loud `[env]` boot warning naming its replacement instead of silently doing nothing.
- **Pipeline gateway now honours the spiral threshold** — `ProdPipelineLlmGateway` previously ignored `REASONING_SPIRAL_CHARS` entirely, so a 15.8k-char reasoning chain was dropped in prod; both gateways now share one `DeepCapturePolicy` (`src/llm/capture-policy.ts`).
- **`VERBOSE_LLM` now covers the v12 pipeline too** — previously a documented no-op on `ProdPipelineGatewayConfig`, it now logs a per-stage summary (stage, model, latency, tokens, response snippet) under the `[pipeline:<stage>]` prefix. Stage errors and parse failures are now always logged to console (unconditionally), with the verbose flag adding the per-stage success summary on top.

## [0.3.0] - 2026-07-07

### Changed

- **DECIDE now authors scene-framing `narration` on CONTINUE beats** — restoring the v12 action screen's game-master voice after the pipeline split stripped it. The LLM sets the scene from the second decision onward (the consequence of the player's last choice); the first beat stays lean, framed by the player's own input. Combat rounds narrate the just-resolved exchange faithfully against engine-owned dice truth. Each option renders with its stat emoji and a difficulty hint, and the gamebook story thread reads as scene → choice, not a repeated generic prompt. No extra LLM calls — narration travels alongside the decide result. Commits `c804706`–`c84c6c5`. Closes `docs/engine/decide-scene-narration/spec.md`.
- **Pipeline DeepSeek timeout bumped to 60s** — the per-call abort moves from 15s→60s so CONTINUE-beat decide calls have headroom to finish before the re-click poison loop triggers.

### Fixed

- **Day-job work no longer blocked at a wild workplace** — the daily-work safety gate now exempts a job's own seeded workplace, so Hunters and Herbalists (workplace The Forest Edge, `is_safe: 0`) can work while standing there. The gate still blocks day-job work on any *other* unsafe or unknown/procedural ground, preserving the original intent.
- **Pipeline decide timeout now resolves gracefully** — when a decide call times out (AbortError), the engine resolves the action as `timed_out` instead of re-throwing and re-presenting the same stuck decision screen. The roll is refunded (system fault grace), stamina −1 is applied, and state is cleared so the player moves on.
- **Decision critic now fires on every decide beat** — the `required` gate that restricted `critiqueDecide()` to high-stakes beats only is removed. The critic now reviews every LLM-generated decision, catching single-option outputs and incoherent choices (e.g. `add_item` on a travel action) that would previously pass through unchecked. A re-decide on `major` verdicts gives the LLM one chance to fix the issue with the critic's guidance.
- **Auto-resolve restored on first-beat `decision: []`** — when the LLM returns an empty decision array on beat 1, the resolve pipeline (RESOLVE-MUTATE → RESOLVE-NARRATE) runs inside `start()` instead of serving a bail-only decision screen. Travel and similar deterministic actions now resolve in one shot with a full outcome.
- **Auto-resolve transaction errors now clear stale state** — when `applyResolution` throws inside `startActionPipeline`, the catch block clears `last_action_state` before re-throwing. Previously an external write (e.g. admin sleep) could restore a resolved-but-unpersisted state, trapping the player on an empty decision screen. The `startAction` guard now also detects resolved-but-unpersisted states and silently clears them.
- **Single-option validator added** — after the critic pass, if the final decision has exactly one option, a bounded re-decide fires with guidance to produce real choices (2-4 distinct approaches) or return `[]` to resolve outright.
- **Pipeline outcomes now carry `category`** — `PipelineActionStateMachine.resolve()`, `resolveCombat()`, and `resolveDivineIntervention()` all set `outcome.category` so the geography-finalize telemetry can flag mutation-category deviations on pipeline-resolved actions, matching the legacy path.

### Internal

- **Pipeline LLM call IDs now wired into `llmCallIds`** — `ProdPipelineLlmGateway.runStage()` returns the `llm_calls` row ID alongside the stage result; every pipeline stage accumulates its call ID into `PipelineInternalActionState.llmCallIds`, which flows through to the existing `linkAction()` backfill at resolution time so the full audit chain is mineable.
- **`LLM_LOG_ALL_PROMPTS` env var added** — when set to `1`, `ProdPipelineGateway.runStage()` logs raw prompts and DeepSeek reasoning content on every call regardless of success/failure. Intended as a QA debugging tool; turn off in steady state.
- **Archived shipped v12 build-plan docs** — Stage 0a–3 build plans and T3–T5 child-task specs moved to `docs/archived/v12-build-plans/`; superseded by the living code.

## [0.2.8] - 2026-07-05

### Added

- **Owner identity on public outcome messages** *(F#3, F#8)* — the character's owner (as a `<@discordId>` mention with pings suppressed) now appears next to the character name on the shared public outcomes so testers can tell who's who.
- **`Hi` button on public outcomes** — action outcomes posted to the weekly thread now carry a 🌅 `Hi` re-entry button ahead of the feedback/bug buttons, so a reader can jump straight into play from the thread. The `nav:hi` handler already spawns a fresh per-clicker ephemeral on public messages, so no new routing was needed.

### Changed

- **Release notes get their own pin icon** *(F#20)* — 📬 now marks release announcements in the pin list, distinct from the weekly recap's 📜.
- **Saturday threat pins are now self-replacing** *(F#18)* — only the latest week's wilderness threat stays pinned; older ones are cleaned up automatically.
- **Weekly chronicle moves to the bottom of a locked thread** *(F#19b)* — at Monday finalize, the recap digest is posted as a new message at the bottom of the week's thread and the thread is locked; the pinned header stays as the archive anchor.

### Fixed

- **Players now join the week's thread when their outcome posts** *(F#19a)* — the acting player is added to the recap thread (`thread.members.add`) just before the outcome is broadcast. The owner mention is ping-suppressed and so never subscribed them, leaving the thread out of their sidebar and the outcome unseen; the add is idempotent and best-effort (a failed add still posts the outcome).
- **Outcome footer now shows `max_stamina` changes** — a `modify_max_stamina` mutation renders a labelled `(max +N)` or `(max −N)` suffix on the stamina line so ceiling gains are no longer silently invisible.
- **Private outcome reply no longer duplicates the story thread** *(F#19c)* — the private embed now shows only the outcome text + stats, not the full gamebook trail the player just saw in the decision embed.

### Internal

- **v12 action-pipeline groundwork (not live)** — an offline sim harness plus a parallel `PipelineActionStateMachine` (classify → decide → dice → resolve), first-class combat + scene-state relations, and the phase-split v12 prompt set (per-phase `decide/`, per-verdict `resolve/`, `MAX_DECISIONS_PER_ACTION` cap) all landed behind the sim; prod still runs v11, with the live cutover tracked for `0.3.0` (see [[stage-5-live-cutover-plan]]).

## [0.2.7] - 2026-07-01

### Added

- **One free bail per day** — the first time you step back from a decision each day refunds the roll (mirrors the no-op/timeout "made whole" graces); later bails that day still spend it, and bailing always costs stamina. Guarded migration `202606300000_player_last_bail_refund_day` adds `player_characters.last_bail_refund_day` (own column so the bail grace never burns — or is burned by — the no-op/timeout graces).

### Changed

- **`/hi` header shows the place's own glyph** — drops the hardcoded 🏠 for the location's map emoji (📍 fallback) + safety glyph, mirroring the 0.2.6 `/look` fix.
- **Character-gated commands reroute to character creation** — running `/hi` (or `/look`, `/stats`, `/map`, `/backpack`, `/journal`, `/action`, `/sleep`) before you have a character now opens the join wizard instead of a "type /join" dead-end.
- **`/look` paths and `/map` drill-in roads show the destination's glyph** — each path/road line carries the destination's place emoji + safe/wild glyph (full-map node parity), not just its name.
- **`/join` options show their stat bonuses** — classes, backgrounds, races, and starting kits display the stats each boosts as emoji (💪/🧠/📖/💬 with signed amounts), not only free-text flavour.
- **`/backpack` item lists get box-drawing rails** — items hang off each stat group with `├─ │ └─` connectors, matching `/map`.
- **Saturday threat warned at dawn** — the wilderness-threat heads-up folds into the 05:30 morning message (place + hint); the full reveal and NPC spawn still happen at the 12:00 beat.

### Fixed

- **Edge bearings are now inverted on the far side of a road** — `/look` paths and the decision-prompt context now show the compass direction as seen from where you stand, not the stored canonical direction (feedback #14, bug #12). `neighbours()` returns directions relative to the queried node; reverse edges get `oppositeDirection()` applied in the repo.
- **Null-region nodes no longer orphan to "Elsewhere" on `/map`** — a place whose cartographer enrichment is absent or predated the region logic now inherits its nearest BFS ancestor's region, so it groups with its geographic neighbours (feedback #14, bug #12).
- **Frontier crossings now show the destination in the outcome footer** — a `cross_frontier` travel (e.g. arriving at Eastvale for the first time) now renders the `→ Place` line, matching `set_location` (feedback #16).
- **A roll grant that nets to zero is no longer invisible** — when an action rewards `+1 roll` but the action cost cancels it out, the outcome now shows `✨ inspired (+1 roll)` in the changes line so the grant is never silently swallowed (feedback #13, bug #1).
- **Backpack no longer reads past its capacity** — `BACKPACK_CAPACITY` raised `10 → 40` and the slot grid wraps at 10 per row (a tidy 10×4 grid), so a full-ish pack stops showing nonsense like `12/10`. The cap stays soft for now; enforcement + item depth tracked in [[improved-item-features]].
- **Degenerate decision beats no longer reach the player** — a beat that would present ≤1 real option (no real choice) is retried once; if still degenerate it resolves as a refundable no-op (the roll is free, no grace consumed) rather than a dead-end single-button "decision". The degenerate first call is always logged to `llm_calls.validation_warnings`. Universal shape guard from [[mutation-vocabulary-refinement]] §5a, shipped standalone ahead of the v11 framework.

### Internal

- **`ActionOutcome.systemRefund`** — engine flag marking a system-fault no-op (degenerate decision shape) that always hands the roll back, independent of the per-day no-op/timeout/bail graces. The per-turn **stamina clamp** (polish-v0.2.7 Feedback #1) is deferred to v11 — per-action-type caps key off the `category` enum the mutation refactor introduces.
- **Agent conventions folded into auto-discovered skills** — moved the per-task sections of `AGENTS.md` (git/releasing, changelog, prompt-versioning, docs) into `.claude/skills/` and migrated the game-dev skills from `agent/skills/` (flattened so Claude Code auto-discovers them). `AGENTS.md` now keeps only always-on guardrails + a skills index.
- **Trimmed `docs/CONVENTIONS.md` (169→103 lines)** — deduped the frontmatter block and list-marker catalog into `docs/templates/doc-template.md` and the index rule into `docs/README.md`; CONVENTIONS stays the single source of truth for the rules and now points at those homes instead of restating them.

## [0.2.6] - 2026-06-28

### Added

- **Feedback & bug reports record the app build that produced them** — `feedback` and `bug_reports` gain a nullable `app_version` column (the `VERSION` build), stamped on every `/feedback`/`/bug` submission for the same data-mining attribution `actions`/`llm_calls` already carry. Guarded migration `202606280000_feedback_bug_app_version`; pre-existing rows stay NULL.
- **`/map` — your map of the world** — an ephemeral, region-grouped hub-and-spoke tree drawn with box-drawing connectors (`├─ │ └─`) so levels read on mobile, sections divided by Discord separators, and an **Unexplored paths** section listing frontier exits grouped by where they leave from. Each node line carries an `emoji · safe/wild · effort` glyph row. Progress is a count ("N charted · M roads into the unknown"), never a fraction; `/map <region|place>` drills in with **fuzzy matching** (tolerates typos/casing — `/map town` finds Town Square, focusing on the roads connected to it); over-long maps collapse a region tail into `+K more` and never silently truncate. A 🗺️ **Map** button cross-links from the other info pages (Hi/Journal/Stats/Backpack/Look).
- **`/journal` is now a chronicle** — drops the known-locations list (that's `/map`'s job) and shows your recent actions tagged with where each happened (location emoji + name) and a ✓/✗ outcome glyph.
- **Cartographer charts new ground's geometry** — when you cross a frontier, the async cartographer now assigns the new place's region (reusing the land you came from when it fits), emoji, tier, and 1–3 onward frontier exits, so the map keeps unfolding. A per-node spoke cap (5) keeps any place from sprouting endless roads.
- **Shared hub-and-spoke world graph + per-player fog-of-war (map foundation)** — the flat location list becomes one coherent, edge-connected map (`location_edges`), masked per player by what they've discovered (`character_locations`). Locations gain `node_tier`/`region`/`emoji`/`created_by_action_id`. The seed world (the home Vale + 3 named frontier exits) now loads from `assets/world/locations.yml` + `edges.yml` (validated at boot) for fresh instances; a guarded migration (`202606270000_geography`) adds the schema and one-shot-backfills the existing prod DB (off-map nodes from the `set_location` history, per-player visited sets). See [[per-player-map-exploration]]. **Requires no new Discord permissions.**
- **Engine-validated travel + graph queries** — `routeBetween` (Dijkstra over edge `difficulty`) gates `set_location` to charted, reachable nodes and `getDiscoveredGraph` powers `/map`. (Automatic `Σ(difficulty)` travel-*stamina* is deferred to the future fast-travel feature — see [[per-player-map-exploration]] §9; for now travel stamina stays LLM-authored and `difficulty` shows on `/map`/`/look` as terrain-demand flavour only.)
- **`cross_frontier` mutation — the exploration verb** — crossing a frontier exit `{ direction, name }` is the ONLY way new ground is born: it mints the destination, binds the exit (shared for everyone after), and fires the cartographer to chart it. A failed roll doesn't break new ground.

### Changed

- **`/look` shows the location's own emoji and its exits** — the header used a hardcoded 🏠; it now shows the place's map glyph (📍 fallback), and a new **🧭 Paths** section lists the charted neighbours (direction → name + effort) and uncharted frontier exits you can see from where you stand. New `engine.getExits` + `emoji` on `LocationInfo`.
- **Movement is graph-validated (decision prompt → v10)** — `set_location` now only reaches a charted, reachable node (unknown/unreachable targets are dropped — no more teleport-anywhere / lazy-create-from-thin-air). The decision prompt swaps the global `Known locations` list for a local **"Exits from here"** block (charted exits to travel to · uncharted frontiers to cross) and teaches `set_location` vs `cross_frontier`. `PROMPT_VERSION` → `v10` (`decision-v10.md` + `current_source.md`). New players start with the home Vale already discovered.
- **`actions.location_name`** — each action snapshots the origin location the character acted from (audit/provenance; deliberately a name snapshot, not an FK).

### Fixed

- **LLM-authored place names, regions, and frontier teasers are sanitized before they're stored** — a coined name like `**The** ## Void` is stripped of markdown/section/mention control chars, whitespace-collapsed, and length-capped (`sanitizeAuthored`) at the mint/cartographer boundary, so it can't break `/map` layout or inject a fake section into the decision prompt. Teasers also gain a hard length cap so they can't bloat every future prompt from that node.
- **`/map`'s "no match" message renders an unknown query literally** — a markdown-laden `/map <arg>` (e.g. `**boom**`) now shows inside an inline-code span instead of formatting the error line.
- **Same-action `cross_frontier` + `set_location` to the just-minted place no longer depends on emit order** — `applyGeography` resolves frontier crossings in a first pass, so a follow-up `set_location` to the new place validates regardless of order.
- **Geography migration surfaces real `ALTER TABLE` failures** — the idempotent `addColumn` now swallows only the duplicate-column case; a locked DB / disk-full / permission error throws instead of being masked as "already migrated".

### Internal

- New repos `locationEdge` / `characterLocation`; `geography.ts` pure routing; `applyGeography` replaces the lazy-create path in the engine (now two-pass, with a `resolveCrossFrontier` helper that guards the frontier-bind result). Frontier-crossing protocol recorded in [[mutation-vocabulary-refinement]] (`cross_frontier` is a distinct verb; the `set_location → move_to` rename stays v11).

## [0.2.5] - 2026-06-27

### Added

- **Feedback & bug reports capture the action they came from** — the Feedback/Bug buttons on an action outcome now thread that action's id through the button → modal → submission, and `submitFeedback`/`submitBug` store it in a new nullable `action_id` FK on `feedback` and `bug_reports`
- **Markdown LLM input + coherence critic (decision prompt v9)** — decision context is now a markdown briefing (pre-joined `Score + Gear = Bonus` ability-check table, structured inventory, scene safety tag, split NPC/player lists, story-so-far, known locations, player input as a blockquote; Warden lore moved to an out-of-character GM note) instead of a `key=value`/JSON dump. Response JSON contract unchanged. Adds a coherence critic (on by default; `ENABLE_COHERENCE_CRITIC=false` to disable): a second pass that rewrites only the prose to match engine truth — never mutations/DC/rolls — and fails open. Critic calls audited in `llm_calls` as `call_kind=critic`.
- **YAML asset schema validation (fail-fast at boot + tests)** — every char-creation asset is validated against `src/assets/asset-schemas.ts` on load, so a malformed file crashes boot with a precise file+entry+field message instead of flowing a `NaN` into `computeStats`. New `tests/assets/` cover schema, modifier completeness, a `computeStats` round-trip over every class×background×race, cross-file integrity, and a release-notes tag=filename sweep. Seeded locations now exported from `migrate.ts` as the single source of truth.
- **Weekly recap thread (Monday rollover)** — each week gets one pinned header + thread in the play channel; public action outcomes post into that week's thread (the private outcome is unchanged). Mondays (with the 03:30 UTC tick, aligning to the action refresh) rewrite the prior week's header into a short LLM chronicle and open a fresh week; headers stay pinned as an archive. Best-effort: LLM failure falls back to a count summary, an unreachable thread falls back to the channel, and a current-week thread is recreated on boot only when genuinely deleted (Discord `10003`) — a transient fetch failure keeps the current week. **Requires *Create Public Threads* + *Send Messages in Threads*** (plus *Manage Messages* for pinning).
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
