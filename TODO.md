
# TODO

## scratchpad (humans start here)

### TBD — POC polish (small UI wins, no spark warranted)
- [ ] movement on low difficulty terrain can be deterministic for up to a total of 3 effort, 3 times 1 difficulty edges. Or a 1 and 2 difficulty edge. When traversing a 3 (or greater) difficulty edge in one action, the travel prompt has to trigger.
  - actions that involve movement but isn't it directly, like prompting to search the library from the wardens oak, should ensure that the travel beat is first evaluated (could auto travel, or demand travel as a seperate action).
- [ ] morning and evening messages should have some custom prose or interesting message.
- [ ] drop the ascii art from action outcomes? or at least just for newly generated places (while the location tags lazy load and resolve to an actual image)? 
- [ ] add /hi to 'A new hero joins the Oak' message.
- [ ] dynamically request or load context. Instead of sending the LLM all possible context, give it an NCP-like interaction layer.
    - scripts or command that perform lookups from the world state that is provided to the decision and mutations DMAs
- [ ] populate more locaiton edges in the sees
- [ ] improve daily work options
- [ ] on the join screen. lets improve the formatting around the inline skills displayed next to class, race and upbringing. perhaps use more line feeds and bold.
   - also show the emojis of the chosen class, upbringing, and race in the selected crossed out list
- [ ] hints on action message
  - one action remaining, low stamina, unsafe location
- [ ] derived/distilled action should show as an emoji next to the decision head while the action evolves — today the decision title is hardcoded `🤔 Decision` (`action.ts:552`) and the distilled-type emoji only appears on the outcome breadcrumb (`buildOutcomeEmbed`).
- [ ] custom (free-text) actions need a real "thinking" screen — three dots + "thinking…" as its own page. Preset day-job actions already show a ⏳ "Starting…" loading envelope (`action.ts:204`); the custom-modal path shows nothing before `engine.startAction`.
- [ ] `/stats` — show how the character builder (race/class) shaped each base score, and make it prettier. The base+gear breakdown already ships (`+6 (+4 base, +2 🎒)`); levels/upskilling/traits and per-race/class char-creator guidance are deferred → MVP below.
- [ ] global broadcast on a natural 1 or 20 — a short public shout-out when anyone crits or fumbles. (Wider community feedback — tagging, showing off — is deferred → MVP below.)
- [ ] hitting 0 stamina blocks more actions that day. pass out can be evaluated similarly to global message.
   - also, 0 hp should do this but also roll the dice, mkaing a death save...
- [ ] bug: autoresolved rest showed refunded but not the inspiration text?

### Prompt v12 closeout

1. Finish Stage 5 — T7 is not actually done. docs/engine/stage-5-live-cutover-plan.md still has the Checkpoint (real-model smoke run) and Task 7 unchecked, and I verified the code matches: src/engine/action/machine.ts (the legacy v11 ActionStateMachine) still exists and prompt-builder.ts:6 still exports PROMPT_VERSION = 'v11'. The release was cut and prod runs v12, but the legacy path was never deleted. The dead-code sweep (machine, PROMPT_VERSION + its stamp sites, critic dual-injection, the current_source.md test) is the outstanding tail of the plan. Arguably the prod QA session already served as the smoke gate, so this is mostly a cleanup task plus ticking the doc closed.
2. Then the v13 roadmap (docs/engine/prompt-v13-roadmap.md), which gives an explicit suggested order:
    1. F#21 — divine intervention rework (small, player-facing, do early): the fallback must not cost a roll, must refund, and must read as a system failure, not an in-world outcome.
    2. D3/D4 — conversation & puzzle shapes + the free-text security stack: the biggest unspecced chunk; can be specced immediately since the relationship edges are already live. Needs a stage-N-style build plan before implementation.
    3. (after a few live weeks of telemetry) Prose-critic trigger decision from the CombatBeatLog data, recorded as a decisions/ doc.
    4. Stage 4 — Thread B world scaling: also wants live curves before tuning; the scale seam sits at 1.

### Player requests — prod data review (2026-07-08)

Fresh reports from a single QA session (snapshot `warden-20260708-201456`, character BendiusOver — mostly a combat playtest). `F#`/`B#` cite the `feedback`/`bug_reports` row. Cross-refs to existing items noted inline; where an item just re-surfaces a known one, treat this as a fresh datapoint rather than a new task.

**Bugs**
- [ ] **`max_stamina` gain not persisted** — player received `+2` max stamina but `/stats` still shows 2 (B#2). This is the known `CharacterRepository.update` allow-list gap (see MVP item below) surfacing in prod — prioritise the fix.
- [ ] **Action-count footer mismatch** — footer showed `-1` but total 4 actions when the player was on 3 previously (B#1). Reconcile the remaining-actions delta vs. total display.
- [ ] **Possible infinite inspiration** — player suspected inspiration never decrements / is unbounded (B#3). Verify the inspiration spend/grant accounting.
- [ ] **Item loss is unclear** — a dropped/consumed item just appears listed, not visibly removed or subtracted (B#4). Make item-loss mutations read as a loss. Overlaps F#… item-usage work in [[improved-item-features]].
- [ ] **Combat HP formatting is broken/confusing** — after the first decision it showed `0 HP`, with the rider's HP and the player's crammed onto one line (B#5); a later beat flashed `-5 HP` mid-decision and "reads weirdly" though it persisted correctly (10−5=5) (B#6). Clamp/format negative & mid-resolution HP, and split combatant HP onto separate lines.

**Feedback / feature asks**
- [ ] **NPC coherency — mint on first sight** — narrative said the player sees a caravan, then said they don't; the NPC wasn't persisted to state on first mention (F#1). Mint NPCs immediately so they persist. See [[mvp+npc-economy]], [[mvp-data-model]] (world-state tracking).
- [ ] **Combat outcome should show the maths** — display each roll and HP bars / damage inflicted in the combat outcome; happy to drop the ASCII art to make room (F#7). Feeds [[mvp-combat]] and relates to the "drop ascii from outcomes" TBD item.
- [ ] **Richer `/hi` opening prose** — pressing Hi should generate a prose opener that scales with time since last interaction (referencing days or a few actions) and reminds the player of their work, quests, and loose ends (F#2). Extends the existing "morning/evening custom prose" and "add /hi to the new-hero message" TBD items.
- [ ] **Trim decision emojis** — too many emojis after decisions; the good/bad DC emojis should show only the arrows that convey stakes (drop the green/red), and a spotted passive call should just colour the button green (as it already does) without also listing the emoji (F#3). UI polish; relates to the distilled-type-emoji TBD item.
- [ ] **Rest button feels underwhelming** — the rest button needs some interaction/weight when pressed and its formatting is off (F#8). Relates to the "autoresolved rest — refunded but no inspiration text?" TBD bug.
- [ ] **Journal is cluttered** — wants whitespace/formatting to distinguish parts and emphasise successes vs. failures, plus a little more info on quests / investigated / gathered intel (F#6). Fresh datapoint for the "Improved journal/story" MVP item.
- [ ] **Buttons going missing is annoying — do the menu rework soon** (F#5). Fresh datapoint bumping the "menu framework coupled to views" MVP item / [[discord-interaction-layer]].
- [ ] **Too many actions available** — "fun but perhaps too broken" (F#4). Fresh datapoint for the "cap rolls per action type + short-rest" MVP item.

### Player requests — prod data review (2026-07-03)

Open *feature* asks mined from the `feedback`/`bug_reports` tables (snapshot `warden-20260703-133521`). Bug-shaped reports already fixed in `[Unreleased]`/0.2.5–0.2.6 are omitted; these are the requests still open. `F#`/`B#` cite the feedback/bug row. The four POC-sized Discord/comms wins are lumped into the **[[polish-v0.2.8]]** spark; the rest route to MVP/sparks.
- [ ] **Player-founded structures become real locations** — a player who *starts building* a temple expects it to exist as its own explorable/buildable place, not resolve to an existing or adjacent location (F#4, B#8 — Ulrich's temple). Relates to lazy world growth + world-state tracking [[mvp-data-model]].
- [ ] **Cross-player buff actions** — praying/blessing "for everyone" should actually apply a buff mutation to the other players present, not no-op (B#11). Needs a multiplayer-aware mutation; see [[multiplayer]].
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
- [ ] saturday special event, spawn an "evil npc" somewhere with a hint. Incentivise hunting it/them and add npc death mutation
- [ ] choose age
- [ ] Improved journal/story
  - track or show quests or hints?
  - add clue system? also grants +1 roll
- [>] travelling to existing or already explored areas should be deterministic based on the distance and/or difficulty. → now designed in [[per-player-map-exploration]] (engine-owned routing + `stamina = Σ edge difficulty`; `distance` reserved for the time mechanic).
- [ ] **`CharacterRepository.update` allow-list omits `max_stamina`** — the column exists and is settable, but `update`'s field allow-list leaves it out, so `max_stamina` can't be persisted through the repo (the sim harness routes around it with raw SQL in `src/sim/driver.ts`). Add it to the allow-list (and audit the list against the schema for other gaps) so callers don't have to bypass the repo.
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
