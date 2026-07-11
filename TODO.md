
# TODO

## scratchpad (humans start here)

### TBD — POC polish (small UI wins, no spark warranted)

- [ ] render ansi as images? so mobile works?
- [ ] travel prompt should inject the current location, edge, and final location state. and routes to get there.
- [ ] migrate ascii to ansi in semantics, source files, and references
- [ ] movement on low difficulty terrain can be deterministic for up to a total of 3 effort, 3 times 1 difficulty edges. Or a 1 and 2 difficulty edge. When traversing a 3 (or greater) difficulty edge in one action, the travel prompt has to trigger.
  - actions that involve movement but isn't it directly, like prompting to search the library from the wardens oak, should ensure that the travel beat is first evaluated (could auto travel, or demand travel as a seperate action).
- [x] ~~morning and evening messages should have some custom prose or interesting message maybe even art.~~ → **Prose done** (`4570bf6`, 0.3.1 branch): rotating day-keyed flavour via shared builders. Art for announcements not attempted (no spec; would follow the ANSI register work).
- [x] drop the ascii art from action outcomes? or at least just for newly generated places (while the location tags lazy load and resolve to an actual image)? → **Combat half done** (POC+ stage 1 T2b): scene art suppressed for combat outcomes only; non-combat outcomes keep their art. Full removal tracked as a separate decision per the T2 scope fence.
  - [ ] combat still isn't shown good. We need to list and display each dice role and outcome per decision.
- [ ] dynamically request or load context. Instead of sending the LLM all possible context, give it an NCP-like interaction layer.
  - scripts or command that perform lookups from the world state that is provided to the decision and mutations DMAs
- [ ] populate more locaiton edges in the seeds
- [ ] improve daily work options
- [x] ~~on the join screen. lets improve the formatting around the inline skills displayed next to class, race and upbringing. perhaps use more line feeds and bold.~~ → **Done** (`311369f`, 0.3.1 branch): label / blockquoted bonuses / description split onto their own lines; the ledger shows the chosen option's own emoji.
- [x] ~~hints on action messages, the initial one when calling just /action (one action remaining, low stamina, unsafe location)~~ → **Done** (`e6bd651`, 0.3.1 branch): shared hint builder on both the slash and nav paths.
- [ ] derived/distilled action should show as an emoji next to the decision head while the action evolves — today the decision title is hardcoded `🤔 Decision` (`action.ts:552`) and the distilled-type emoji only appears on the outcome breadcrumb (`buildOutcomeEmbed`).
- [x] ~~custom (free-text) actions need a real "thinking" screen — three dots + "thinking…" as its own page.~~ → **Done** (`f5069ec`, 0.3.1 branch): the modal path shows the player's clipped text + ⏳ Thinking beat before `engine.startAction`; errors clear it.
- [ ] `/stats` — show how the character builder (race/class) shaped each base score, and make it prettier. The base+gear breakdown already ships (`+6 (+4 base, +2 🎒)`); levels/upskilling/traits and per-race/class char-creator guidance are deferred → MVP below.
- [ ] global broadcast on a natural 1 or 20 — a short public shout-out when anyone crits or fumbles. (Wider community feedback — tagging, showing off — is deferred → MVP below.)
- [ ] hitting 0 stamina blocks more actions that day. pass out can be evaluated similarly to global message.
  - also, 0 hp should do this but also roll the dice, mkaing a death save...
- [x] ~~bug: autoresolved rest showed refunded but not the inspiration text?~~ → **Done**: accounting root cause fixed as B#3 (`807bb13`); the display gate (inspired line suppressed by any refund) fixed under F#8 (`e426bc4`).

### ANSI opening-frame follow-ups (2026-07-11, from ANSI-F review)

- [ ] Opening frame on auto-resolved actions: travel/rest often resolve at start with no decision beat, so they show no opening frame today (3 auto-finish call sites + the public-broadcast embed question). Extend the frame to the outcome path.
- [ ] Resume-mid-action shows no opening frame at decisionIdx 0 (`resumeAction` doesn't carry `actionType`); rare, degrades gracefully.
- [ ] Combat opening frame renders "Unknown foe" pre-first-step; `PipelineDecideResult.combatEnemy` exists but isn't exposed publicly — enrich when worth it.

### ANSI frame polish — T2 live-check follow-up (2026-07-10)

> **Now tasked in [[poc-plus-0.3.1-polish-plan]]** (with the 2026-07-08 prod bug batch and the small UX wins below) as the `0.3.1` polish release. This block is Part 1 of that plan; tick these rows as its tasks land.

The T2 live check passed on content (colours good on desktop, monochrome clean on mobile) but surfaced styling and architecture debt. Standardise before stage 2 builds broadcast frames on the same renderer. Go in order: A settles the facts B–D depend on.

**A — settle first**

- [x] ~~Live-test bright SGR codes (90–97)~~ → **Settled 2026-07-11** (ANSI-A probes): 90-97 render no colour anywhere; the skill's chrome=90 lost and is corrected to 37 (final). Also settled: bg 40-47 desktop-only; box-drawing single-width on mobile.
- [x] ~~Settle the [[mvp+ansi-art]] line 35 palette `[?]`~~ → **Solarized-ish confirmed** (same session); hex recorded in `src/render/palette.ts` + the spark doc.

**B — renderer standardisation**

- [x] ~~Fix `chrome` away from 30~~ → **Done** (`d98258d`, then `b1a5d28`): chrome at 37; entire renderer redesigned with box-drawing borders, border-style ladder, and palette-driven colours.
- [x] ~~Extract the role→SGR map into a palette module~~ → **Done** (`d98258d`): `src/render/palette.ts`.
- [x] ~~Prettier borders~~ → **Done** (`b1a5d28` combat-frame redesign): box-drawing standard/heavy/crit border ladder with crest-interrupt rim; supersedes the ASCII `+`/`-`/`|` defaults.
- [~] Wireframe/mock library → **Continue + terminal done** (`d45b5ec` mocks, `b1a5d28` redesign); broadcast frame still deferred.

**C — architecture**

- [x] ~~Decouple render from engine~~ → **Done** (`62cc332`, 0.3.1 branch ANSI-C): engine emits `CombatStatusData`; the Discord layer composes the frame; legacy in-flight strings render via a tolerant read.
- [x] ~~Rehome the `OutcomeRenderer` → `AnsiRenderer` dependency~~ → **Done** (`62cc332`): frame renderer injected by the caller; `src/render/` has no engine-side importer (grep-proven).

**D — combat visibility**

- [x] ~~Track every round~~ → **Done** (`79d48a3`): per-round maths on `CombatBeatLog`.
- [x] ~~Show the round's maths between decisions~~ → **Done** (`d7a3cb5` then redesigned `b1a5d28`): floated readout with boxed DC; band-coloured margin + band word on the continue card.
- [x] ~~De-noise the terminal frame~~ → **Done** (`d7a3cb5` redesign `b1a5d28`): pure data card, no HP bars; `d20` label dropped, DC boxed, ASCII `+`/`x` marker.

**E — doc loop**

- [/] Fold every settled decision back into the `ansi-frames` skill and [[mvp+ansi-art]]; tick the stage-1 plan's live-check box with the border defect logged. → **Settled facts recorded** (ANSI-A); border redesign supersedes the logged defect; live-check batched via `scripts/live-check-0.3.1.ts`.

**F — opening frame + delivery (new surface, designed 2026-07-10; tasked at full scope in [[poc-plus-0.3.1-polish-plan]] ANSI-F)**

- [ ] Implement the opening frame: after `classify` and before the first decision, render the per-type OPENING register (wireframes in `assets/ansi/wireframes/`; spec in [[ansi-art-classification-framework]] §2c/§3.0). Depends on B landing first (palette + readable chrome).
- [ ] Implement the universal **art-post + reply-body** delivery ([[ansi-art-classification-framework]] §2b): the frame is its own message, the narration/options/speech a reply beneath it. Today the frame is inline in the decision embed (`buildDecisionMessage` `combatStatus`), so this is a two-message delivery change, not just a render path — relates to C (decouple render from engine).
- [ ] Gated on fragment art: the opening frame's sprite/scene slots (enemy, NPC bust, campfire, PC poses) need the `fragments` catalogue ([[ansi-art-classification-framework]] §9), which is mvp+/deferred. Until it exists, `skill`/`other`/`travel` openers stay placeholder scenes (PC sprite only) per the wireframes.

### action pipeline framework refactor closeout

1. ~~Finish Stage 5~~ **Done** (`72fb32d`, POC+ stage 1 T0a) — the T7 dead-code sweep landed: legacy machine, PROMPT_VERSION + stamp sites, critic dual-injection, and the current_source.md test are gone; the 2026-07-08 prod QA session stood in as the smoke gate.
2. Then the v13 roadmap (docs/engine/prompt-v13-roadmap.md), which gives an explicit suggested order:
    1. ~~F#21 — divine intervention rework~~ **Done** (`4c51334`, POC+ stage 1 T0b) — the fallback refunds the roll, authors no mutations, and reads as ⚠️ System.
    2. D3/D4 — conversation & puzzle shapes + the free-text security stack: the biggest unspecced chunk; can be specced immediately since the relationship edges are already live. Needs a stage-N-style build plan before implementation.
    3. (after a few live weeks of telemetry) Prose-critic trigger decision from the CombatBeatLog data, recorded as a decisions/ doc.
    4. Stage 4 — Thread B world scaling: also wants live curves before tuning; the scale seam sits at 1.

### Player requests — prod data review (2026-07-08)

Fresh reports from a single QA session (snapshot `warden-20260708-201456`, character BendiusOver — mostly a combat playtest). `F#`/`B#` cite the `feedback`/`bug_reports` row. Cross-refs to existing items noted inline; where an item just re-surfaces a known one, treat this as a fresh datapoint rather than a new task.

**Bugs**

- [x] ~~**`max_stamina` gain not persisted**~~ (B#2) → **Fixed** (`7513181`, 0.3.1 branch): `max_stamina` added to the `CharacterRepository.update` allow-list, schema audit found no other gap, sim raw-SQL workaround dropped.
- [x] ~~**Action-count footer mismatch**~~ (B#1) → **Resolved by B#3** (`807bb13`, recorded `c491f94`): the rolls-grant clobbering the start drain was the whole mismatch; impossible on every resolved path now.
- [x] ~~**Possible infinite inspiration**~~ (B#3) → **Leak found and fixed** (`807bb13`, 0.3.1 branch): the auto-resolve branch applied a rolls-grant off the stale pre-drain value, clobbering the start drain; drain now applied before the outcome, regression-tested.
- [x] ~~**Item loss is unclear**~~ (B#4) → **Fixed** (`d660b19` + tests `4cddda3`, 0.3.1 branch): losses render as a real minus glyph mirroring the gain format, never a Discord list bullet. Item *usage* still tracked in [[improved-item-features]].

**Feedback / feature asks**

- [ ] **NPC coherency — mint on first sight** — narrative said the player sees a caravan, then said they don't; the NPC wasn't persisted to state on first mention (F#1). Mint NPCs immediately so they persist. See [[mvp+npc-economy]], [[mvp-data-model]] (world-state tracking).
- [ ] **Richer `/hi` opening prose** — pressing Hi should generate a prose opener that scales with time since last interaction (referencing days or a few actions) and reminds the player of their work, quests, and loose ends (F#2). Extends the existing "morning/evening custom prose" and "add /hi to the new-hero message" TBD items.
- [x] ~~**Trim decision emojis**~~ (F#3) → **Done** (`4815832`, 0.3.1 branch): stakes arrows only, green button as the sole passive tell.
- [x] ~~**Rest button feels underwhelming**~~ (F#8) → **Done** (`e426bc4`, 0.3.1 branch): pressed "Bedding down…" beat, sectioned rest body, and the inspired line now renders alongside a refund (the linked TBD bug).
- [x] ~~**Journal is cluttered**~~ (F#6) → **Done** (`3114411`, 0.3.1 branch): sectioned Chronicle/NPCs, bold outcome tags, intel rails from stored mutations. Deeper quest/story tracking stays with the "Improved journal/story" MVP item.
- [ ] **Buttons going missing is annoying — do the menu rework soon** (F#5). Fresh datapoint bumping the "menu framework coupled to views" MVP item / [[discord-interaction-layer]].
- [ ] **Too many actions available** — "fun but perhaps too broken" (F#4). Fresh datapoint for the "cap rolls per action type + short-rest" MVP item.

### Player requests — prod data review (2026-07-03)

Open *feature* asks mined from the `feedback`/`bug_reports` tables (snapshot `warden-20260703-133521`). Bug-shaped reports already fixed in `[Unreleased]`/0.2.5–0.2.6 are omitted; these are the requests still open. `F#`/`B#` cite the feedback/bug row. The four POC-sized Discord/comms wins are lumped into the **[[polish-v0.2.8]]** spark; the rest route to MVP/sparks.

- [ ] **Player-founded structures become real locations** — a player who *starts building* a temple expects it to exist as its own explorable/buildable place, not resolve to an existing or adjacent location (F#4, B#8 — Ulrich's temple). Relates to lazy world growth + world-state tracking [[mvp-data-model]].
- [ ] **Cross-player buff actions** — praying/blessing "for everyone" should actually apply a buff mutation to the other players present, not no-op (B#11). Needs a multiplayer-aware mutation.
- [ ] **Items should be usable, not stat-bonus clutter** — players accumulate notes/keys/etc. that only grant a passive stat bonus and never get *used*; make items actually do something (F#11). Tracked in [[improved-item-features]] but not previously on this list.
- [ ] **Communal / offering currency separate from personal gold** — a player wanted to spend offering-basket funds (not their own coin) on temple supplies; distinguish a shared/temple purse from personal wealth (F#9). Nuance under the MVP "make wealth spendable/meaningful" item below.

## MVP — deferred

- [ ] dnd statblock scraper
- [ ] menu framework coupled to views — standardise the views/command/message terminology and a tab/subtab layout per message. See [[discord-interaction-layer]] (the interaction-plumbing layer; subtabs are explicitly MVP there).
- [ ] make wealth (and stamina, health) spendable/meaningful, and define death / 0 HP. The death track is deferred from the POC by design ([[the-poc]]); see [[mvp-progression]] (lifecycle/death), [[mvp-combat]] (HP stakes), [[mvp+npc-economy]] (wealth sink).
- [ ] cap rolls per action type + add a short-rest option; reward slow build-up / daily-work play on subsequent actions instead of jumping straight in. Check for hard-coded roll caps. Extends [[roll-economy-timeouts-and-world-growth]].
- [ ] character progression depth — levels, upskilling, traits; the char creator shows which stats matter per race/class and how each modifies them. See [[mvp-progression]], [[mvp-character-drivers]].
- [ ] richer community feedback in chat — tag people (not too spammy), let players show off to each other. See [[mvp-social-model]], [[mvp-discord-ux]].
- [ ] use both models differently, flash for generating quick responses and daily work, pro for decision trees.
- [ ] **LLM latency** *(deferred from [[polish-v0.2.8]], 2026-07-04)* — the 2026-07-04 snapshot shows mean ~12.8s, 94 calls >20s, 26 >30s (max 47.5s); this is what surfaces to players as `timed_out`/`bailed` outcomes. Rein in reasoning length and tighten the timeout+fallback. Overlaps the model-split above and the thinking-on/off experiments in [[mvp-llm-prompt-architecture]].
- [ ] **Auto-resolve roll refund** *(deferred from [[polish-v0.2.8]], 2026-07-04)* — bug reports say a `done` auto-resolve can consume a roll while doing nothing / not refund it (B#1, B#10). The no-op/timeout/bail refund graces already exist and this list concluded there's no deterministic double-decrement in `startAction`, so the job is to verify the `done` path specifically hands the roll back on a true no-op. Part of the broader auto-resolve wound owned by the prompt refactor.
- [>] saturday special event, spawn an "evil npc" somewhere with a hint. Incentivise hunting it/them and add npc death mutation → minimal slice (one scripted weekly boss, shared HP) now [[poc-plus-roadmap]] item 5; npc death mutation and the wider event pool stay MVP.
- [ ] choose age
- [ ] Improved journal/story
  - track or show quests or hints?
  - add clue system? also grants +1 roll
- [>] travelling to existing or already explored areas should be deterministic based on the distance and/or difficulty. → now designed in [[per-player-map-exploration]] (engine-owned routing + `stamina = Σ edge difficulty`; `distance` reserved for the time mechanic).
- [x] ~~**`CharacterRepository.update` allow-list omits `max_stamina`**~~ → **Fixed** (`7513181`, 0.3.1 branch, B#2): added to the allow-list, schema audit found no other gap, the `src/sim/driver.ts` raw-SQL workaround dropped.
- [ ] **schema: normalise location references to FK ids** — locations are keyed by `name` (TEXT) everywhere (`player_characters.location`, `npcs.location`, `location_edges`, `actions.location_name`). `actions.location_name` is a deliberate point-in-time *snapshot* (keep it), but a future polish pass should decide whether the live-reference tables move to `location_id` FKs consistently — a holistic refactor, not a lone divergence. See [[per-player-map-exploration]] §6.
- [ ] use reactions as a way of buffering input before a button is pressed (expend items or use certain abilities to amplify actions, also works for trades)
  `this is cool!!!`
  (but does it work with ephemeral..?)
- [ ] stealth or following mechanics?
- [ ] mechanic — bonus rolls: an LLM `modify_rolls_remaining: +N` reward is a deliberate mechanic, not a bug (the "extra throw" report traces to this; no deterministic double-decrement exists — a roll is spent exactly once per action in startAction). Design it properly: when/why the world grants an extra roll, and surface it to the player so it reads as a reward. Belongs to the roll-economy work in [[mvp-llm-prompt-architecture]].
- [>] `[[mvp-llm-prompt-architecture]]` — prompt refactor:
  - optimise prompt to llm as markdown (more friendly) not json. Response can remain json
  - options should still be produced by the llm, but there should be some rolls before to influence it
    example: player prompts they want to hunt. llm responds with choices, player succeeds, bot then rolls for rarity of an item, llm generates item.
    example: player trains at camp, llm provides choices, player fails, bot rolls for the severity (loses a lot of stamina), llm gives outcome message.
    THIS IDEA NEEDS A LOT OF REFINEMENT or just better system prompts.
  - outcomes should be rolled before the response flavour is generated.
    roll as DM and add certain promp elements. determine outcome sentiment before prompting.
  - utilise multiple agent in short bursts for actions or chain agents instead of one big chat?
  - try disabling thinking again? Or use A B testing with thinking on and off
  - optimise prompts with simulations to see when LLM digresses
  - use testing data as a couple of LLM mocks (for dev'ing or unit testing)
- [>] `[[mvp-combat]]` — there is no combat, this should be a core mechanic..!
- [>] `[[mvp-data-model]]` — graph db for backend coherency (relationships, items, distances, groups)
  - better world state tracking, which areas are hostile, how hostile, what type of faction or encounters to expect
- [>] `[[mvp+npc-economy]]` — introduce NPCs more often in interactions and save them (also reuse them more often)
- [>] `[[mvp+world-state-projection]]` — rethink sleep mechanic, yes we want people to sleep at the wardens oak, but they shouldnt be able to just tp out of an unsafe or far away location.
  - related to world state tracking too: finishing your day in an unsafe location should have conesquences
    (you dont sleep well or you get put in jail and must escape)
- [>] `[[mvp-ascii-render-pipeline]]` — scrape prettier ascii art or images for converting with ascii image converter

---

## Triaged out of TBD (for provenance — 2026-06-26)

- **Done / shipped (struck):** preset work labelled `Work:` not `🧭 Quest:` and commute `−1 stamina` shown on the thinking page; the no-op refund scope question (stamina-/roll-only "shrug" is again a refundable no-op — D1 follow-up). All in `[Unreleased]`.
- **Working as designed (struck):** post-`/join` welcome shows no "Hi" button because that screen *is* the Hi screen (`getNavButtons` filters the current command — `format.ts:137`).
- **Routed to sparks:** Warden NPC duplicates (hooded figure vs The Warden) → [[mutation-vocabulary-refinement]] §2 (NPC name-resolution); world evolves with time / rising DC / new threats → [[prompt-separation-of-concerns]] Thread B (World Tier); global rumours pulling players toward dangerous unexplored locations → [[prompt-separation-of-concerns]] Thread B + [[per-player-map-exploration]] (`reveal_location` leaf); end-to-end flow tests with mocked LLM + scripted button presses → [[mvp-llm-prompt-architecture]].

# MVP(+)?

- [ ] the ansi art engine should be re written in custom font character that are compiled into an actual image and sent as pixelated art.
