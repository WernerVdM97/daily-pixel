# TODO

## ⏭️ RESUME HERE — POC+ Release A (last touched 2026-07-29)

**Read first:** [`docs/engine/poc-plus-release-a-plan.md`](./docs/engine/poc-plus-release-a-plan.md) — the executor-grade build plan. Its § Execution state carries the running handover (branch, baseline, per-task log, owner locks); its § RA-4 A/B results and § Scouting corrections carry findings that supersede parts of the original task specs. Parent tracking is [[poc-plus-roadmap]] § Re-sequencing.

**Reconcile first, every resume:** all of Release A's engine work is **merged and pushed** — `dev` and `origin/dev` are both at `baa7cdf`. Stage 4 continues on `poc-plus/release-a`, checked out in the **primary** working directory `~/projects/daily-pixel` — the separate `termic/tasks` worktree has been removed, so there is one checkout and no wrong place to verify in. Baseline is **89 files / 1657 tests**, typecheck clean. Check the plan's § Execution state against `git log` before trusting it: the task log there stops at RA-3 (`29b8754`) and still quotes an 88/1611 baseline, so it is stale for stages 1-3.

**All owner locks are settled — nothing is blocked on the owner.** SL-1 = Option A (Release A carries the v13-aligned prompt-set bump, so RA-1, RA-2 and RA-3's full half are all in scope). SL-2 = no lethality (pre-settled). SL-3 = `narrate-gated` (decided on the measured A/B). SL-4 = named foes only, keyed off the `anchor` signal **not** name-presence. SL-5 = the sixth row is its own RA-6.

**Landed:** RA-6, RA-4, RA-5, RA-3 bounded (+SL-6, SL-7), and stages 1-3 of the RA-1/RA-2/v13 sequence (item-bonus ceiling, the `fatalBlow`/`decisionPrompt` handoff, the engine F#12 strip and the named-reward line). Per-task detail is in the plan's § Task log and `CHANGELOG.md` `[Unreleased]`.

**Next, in this order:**

1. **Stage 4 — the v13 prompt set (one atomic commit)** per the plan's § Stage 4, steps 0-7, routed via the `prompt-versioning` skill. **Step 0 is already done but is NOT committed:** `assets/prompts/decision-prompts/v13/` exists as a byte-identical 26-file copy of `v12/` and is currently **untracked** (`git status` shows `?? .../v13/`). Verify `diff -r v12 v13` is still empty before editing, and do not redo the copy. v12 is published and has produced attributable rows, so it is copied, never edited. Remaining work is steps 1-7: the DC ladder in `decide/BASE.md`, the reward/failure menus and frequency dial in `resolve/BASE.md`, the per-category recipes, `add_npc`'s `health` vocab, the spare branch in `combat/success.md`, then the `PROMPT_SET_VERSION = 'v13'` bump with the four hardcoded `'v12'` literals de-hardcoded, the `current_source/` resync, and the test retarget.
2. **Release cut 0.3.3** then the doc loop, per the plan's § Release cut and § Doc loop. The lead never merges `dev` → `main`; prompt the user.

**Overshoot risk to watch when stage 6 measures, flagged before stage 4 was written:** RA-1 and RA-2 push the same direction at once and compound multiplicatively rather than additively. RA-1 raises DCs so more attempts fail, and RA-2 cuts the grant rate so there are fewer attempts per day: fewer turns, each likelier to cost than to pay. The RA-4 playtest critic already reported failure costs as harsh ("losing gold on a failed tail") and the bail mechanic as unrewarding, and that was on the *pre-change* tuning. If stage 6 lands at the bottom of the acceptance band, the honest reading is "stingy", not "tense". If one dial has to be relaxed, relax **RA-2's frequency dial rather than RA-1's ladder**: stakes are the release's stated purpose, cadence is a comfort setting. Note also that RA-1's anti-crush mechanism is a *rule* (every option set keeps one option in the routine band), not a softer ladder, so if playtests still read as crushing, check whether the model is honouring that rule before touching the numbers.

**A decomposition worth reusing for stage 4:** delegate by **file ownership, not by step**. `resolve/BASE.md` is touched by steps 2, 3, 4 and 5, so parallel executors split by step would collide on it. The fences that work are E1 = `decide/BASE.md`, E2 = `resolve/BASE.md` (sole owner, all four steps' portions), E3 = the `resolve/*/{success,failure}.md` recipes, then E4 = steps 6-7 (`src/` constants, `current_source/` resync, tests) which must run last because the content-assertion tests depend on E2 and E3 landing. Re-derive the executor handoff from the plan doc's § Stage 4.

**Blocker hit on 2026-07-29:** every `delegate-executor` spawn failed with `API Error: 529 Overloaded`, on three concurrent attempts and again on retry. No partial edits landed (`diff -r v12 v13` stayed empty), so stage 4 is cleanly at post-step-0. Retry the delegation when capacity returns, or build steps 1-7 in-lead if it persists.

**Discipline (unchanged):** one orchestrated-delegation loop per task — lead scouts and finalises the handoff, executor builds, lead verifies (typecheck + suite + the task's acceptance boxes), commit, fresh-context reviewer critiques, lead triages, fixer lands accepted findings, verify, commit. Atomic commit per task; changelog current per task. Balance tasks get an agent-player before/after run (`npm run agent:play`; there is no `dotenv`, so `set -a; . ./.env; set +a` first). Prod host `192.168.0.242` was unreachable from the last session, so re-pulling the snapshot may not be possible — the agent-player harness is the working signal. Scope fences hold: no lethality, no shared-world plumbing, no classify-accuracy work, no item-economy depth.

**One follow-up decision left open:** `opts.compact` is still plumbed through `buildOutcomeView`/`viewState.ts`/`commands/action.ts` with a unit test, but has had no production caller since RA-6 — delete it or keep it deliberately.

## scratchpad (humans start here)

### POC+ re-sequencing — prod-data review (2026-07-23)

Full-period prod snapshot (`warden-20260723-201953`, 07-07 → 07-23, day 17, `0.3.0`–`0.3.2`; 98 actions / 796 LLM calls / 4 chars / 1 external tester) drove a re-order of the remaining POC+ arc, recorded in [[poc-plus-roadmap]] (§ Re-sequencing). No controlled invite — the rest of POC+ playtesting is agent-driven; human testing is scheduled later. **Release A lands before any more shared-world code.**

**Release A — worth-returning-to (polish / coherence / cost)**

- [ ] **Stakes / difficulty pass** *(RA-1)* — 83% success, no `final_dc` > 17, 11 failures in 98 actions. Item-bonus ceiling landed; the DC ladder and the reward/failure menus are stage 4 steps 1-2. No lethality (death track stays deferred). Overlaps the MVP "make wealth (and stamina, health) spendable/meaningful" item below.
- [ ] **Inspiration dial** *(RA-2)* — `modify_rolls_remaining:+1` on 29% of actions inflates cadence to ~4.8/active-day (F#4 "fun but too broken"). F#12 (work no longer offers inspiration) and the named-reward line landed; the frequency dial itself is stage 4 step 3, targeting ~10%.
- [ ] **NPC mint-on-first-sight** — bounded half **landed** (RA-3: `anchor: 'npc'` where resolution failed, minted on a surviving foe). Residual is the non-combat half, now stage 4 step 4's `add_npc` `health` vocab.

**Stage 2 re-scope + later stages**

- [ ] **Stage 2 solo-first** — nat 20 grants extra loot/rolls (F#9), nat 1 a story beat; public broadcast is the bonus layer. Lands at N=1.
- [ ] **Stages 3–4 (buffs, shared boss)** — build + agent-QA only for now; extend the agent-player harness to co-located multi-agent runs; fun-payoff deferred to later user testing.

### M4 agent-player live smoke-run findings (2026-07-21)

Three live DeepSeek smoke runs (1d, 1d, 2d) all completed clean (exit 0, 0 formal findings, coherent gameplay, critic reports). Multi-day path confirmed (day advances, rolls refill, overnight regen + income, rest-to-Oak). These observations are NOT harness bugs (all self-recovered, no state corruption) — logged for maintainer/backlog:

- [ ] **[engine/content] `search`-category grants wealth, tripping category-telemetry** — `[category-telemetry] unexpected mutation "modify_wealth" on category "search" — flagged for tuning` fired on search-category actions in two independent runs. Either the category→mutation allow-list is stale or search outcomes shouldn't grant wealth. Check the config behind that telemetry line.
- [ ] **[content/balance] wealth rose on every outcome, including failures** — one run granted wealth on 3/4 actions that were failures (confront/train/search failure branches). Possibly intended consolation, possibly a failure-outcome-table tuning bug. Confirm against the intended outcome tables.
- [ ] **[engine/prompt] LLM authored an out-of-graph `scene_location`** — twice in one run the model named a location outside the geography graph ("The Vale", then "Town Square · The Vale") with no relocate mutation; the travel-gate + graph validator correctly no-op'd both (no player-visible corruption). The `place · region` format matches the display convention (`src/discord/map-render.ts:117`, `src/llm/prompt-builder.ts:243`) — the model is likely echoing a compound display string back into the raw `scene_location` field. Sanity-check whether the prompt/context renders location as `place · region` somewhere the model could mistake it for the field value.
- [ ] **[UX] bail-refund grace has no in-game signal** — the once-per-day free step-back (`last_bail_refund_day`, `src/engine/WorldEngineImpl.ts`) reads as inconsistent to a player (first bail refunds a roll, second same-day doesn't) with nothing explaining it; a small UI note ("first step-back today is free") would remove the ambiguity the critic flagged. Not a bug.
- [ ] **[M4 enhancement] promote engine anomaly logs to transcript findings** — engine-emitted anomaly recoveries (`category-telemetry`, `travel-gate` injections/drops) print to stderr but the agent-player harness doesn't capture them as `finding`s, so they're invisible in the run scoreboard. Surfacing anomalies as findings is the harness's whole job; a future QA-capture slice could hook these engine emissions into transcript warnings. (The `play.ts` stdout-contamination defect the same runs caught is already FIXED — transcript now writes to a file, `AGENT_OUT`.)

### 0.3.2 residuals → v13 (prompt-versioning + [[prompt-v13-roadmap]])

- [ ] **C6 symptom-A — mis-classification accuracy** *(deferred 0.3.2)*: actions the player intends as combat are sometimes classified as `skill`/`rest`, routing to the wrong spine. The auto-resolve guard (C6) prevents a combat-classified action from resolving without a fight, but the upstream classify decision is a prompt-template concern → route via `prompt-versioning` skill, [[prompt-v13-roadmap]].
- [ ] **C3 residual — LLM-authored/spawn_npc NPCs have NULL health** *(deferred 0.3.2)*: `seedNpcs` now writes `health` (migration `202607112100_npc_combat_health.ts`), but LLM-authored and `spawn_npc` NPCs still get NULL health. `deriveEnemyMaxHp(DC)` is the fallback. Giving `add_npc` a `health` field means the decision prompt needs a `health` vocab slot → v13 prompt-versioning. **Now scoped as stage 4 step 4 of the Release A plan (vocab only, since the engine already accepts and stores `health`); not yet landed, so this stays open.**
- [ ] **`ItemData` has no `kind`/`slot`/`consumable` column** *(RA-1 Stage 1 follow-up)*: the engine can't distinguish a consumable from a weapon and can't hold consumables to +1, so the v13 "consumable reads +1" guidance is prompt-only and unenforced until such a column exists.

**In-app checks still outstanding:**

- [ ] Start a real combat against a named NPC (e.g. Shadow Stag); the continue card must show the NPC's real name (C3).
- [ ] Bail out of a fight mid-way, then re-engage; the opening frame must show banded condition, not `?/?` (C4). Fix shipped in `3bd266d` (the opener now reads name + condition off the persisted `in_combat` edge, anchor-guarded); this is the in-app re-verification.
- [ ] On a Saturday, verify the threat NPC is at its announced location on `/look` and stays there, rather than wandering off (N1).

**C4 follow-ups left out of that fix:**

- [ ] **C4 follow-up — abandoned (not bailed) mid-round combat shows no opening frame on resume**: a genuinely unfinished multi-round fight leaves last_action_state set; `/action` then hits the resume branch (`action.ts:162`), which calls `buildDecisionMessage` without `actionType`, so no opening frame renders at all (and `decisionIdx > 0` would gate it out anyway). Latent, not the reported symptom. Needs `resumeAction`/`ActionResumeResult` to carry actionType + remembered foe and the render gate to allow a combat opener on resume.
- [ ] **C4 follow-up — in_combat edge duplication on anchor change**: `set_relation`'s UNIQUE key includes the anchor (`to_type,to_ref`), so a re-engage that resolves to a *different* anchor than the bailed edge creates a second `in_combat` edge; `readCombatState` then picks whichever the DB returns first. Harmless for same-anchor re-engage (the common path). Needs an edge-lifecycle sweep, not part of the C4 symptom fix.

### TBD — POC polish (small UI wins, no spark warranted)

- combat or social actions HAVE to mint NPC. no thing can be referenced without existing or spawning to persist?
- remove critic from classify. conditionally. latency seems high. mine prod for investigation
- many frame has two spaces for padding left. refactor to 1
- map seems formatted weird:
```
The Vale (home)
🌳🛡️ The Warden's Oak
├─ 🌿⚠️🏃 The Forest Edge  ◀ you are here
│  └─ 🌲⚠️🧗 The Dark Pines
├─ 🛤️⚠️🚶 The East Road
│  └─ 🏚️⚠️🧗 The Broken Keep
├─ 🌊⚠️🏃 The River Crossing
├─ ⛪🛡️🚶 The Shrine of the First Flame
└─ 🏛️🛡️🚶 Town Square
   ├─ 🔥🛡️🚶 The Town Forge
   ├─ 📚🛡️🚶 The Warden's Library
   └─ 🍺🛡️🚶 The Weary Lantern Inn
Unexplored paths
🛤️ The East Road
└─ 🏃 ↗️ the road runs on to the eastern town
🌲 The Dark Pines
└─ 🧗 ⬇️ the trees never thin — the deep woods swallow the trail
🌊 The River Crossing
└─ 🧗 ⬅️ downriver the banks close in, and caves breathe cold air
🌿 The Forest Edge
└─ 🏃 ➡️ The Stag's Den
```
the bottom unexplored path for the stags den should actually render in the top, but greyed out or something to show its unexplored.
one would look at the "you are here" first , then aroud you, and having the forest edge not show there is bad UX
- [ ] improve art blocks on messages
  - drop the old ugly scene ascii. this will be only used for look.
  - like the art on the classified outcome page should be redisplayed on the thinking page.
  - and maintained on the decision outcomes.
  - art should be considered the main viewport, and the discord messaging a sub menu or interaciton layer with inline art blocks.
  - maybe drop the location ascii image from actions
- [ ] the thinking block might as well show the full decision history exactly like action outcome
  - it should also show the main frame block
  - same for the epemeral version of actions responses.
  - it should have a hints block that the player can reed while waiting. periodically scrape the docs and features for interactions lesser known of (like regex resolving, ...)
- [ ] footer emoji for location changes should show location emoji
- [ ] travel prompt should inject the current location, edge, and final location state. and routes to get there.
- [ ] movement on low difficulty terrain can be deterministic for up to a total of 3 effort, 3 times 1 difficulty edges. Or a 1 and 2 difficulty edge. When traversing a 3 (or greater) difficulty edge in one action, the travel prompt has to trigger.
  - actions that involve movement but isn't it directly, like prompting to search the library from the wardens oak, should ensure that the travel beat is first evaluated (could auto travel, or demand travel as a seperate action).
- [ ] dynamically request or load context. Instead of sending the LLM all possible context, give it an NCP-like interaction layer.
  - scripts or command that perform lookups from the world state that is provided to the decision and mutations DMAs
- [ ] populate more locaiton edges in the seeds
- [ ] improve daily work options
- [ ] hitting 0 stamina should block more actions that day.
  - also, 0 hp should do this but also roll the dice, mkaing a death save...
- [ ] last stand buttons and captions need to look cooler. add emojis or a combat scene frame and shit.
- [ ] clearing bad people in an unsafe space should grant a short rest if it is your last action of the day. maybe helps your reach the oak during the night? (slightly risky?)
  - there should be a short version of rest this is usable once per day before or between actions. Drop blocker
- [ ] On consequtive action decision screens, the art block should evolve/update accordingly, sometime zoom or change the scene. etc
  - the inline art block no longers has to display HP if the main frame does

### ANSI — outstanding work (consolidated 2026-07-11)

**Opening-frame runtime gaps** (from the ANSI-F review — the frame ships but misses these paths):

- [ ] Opening frame on auto-resolved actions: travel/rest often resolve at start with no decision beat, so they show no opening frame today (3 auto-finish call sites + the public-broadcast embed question). Extend the frame to the outcome path.
- [ ] Resume-mid-action shows no opening frame at decisionIdx 0 (`resumeAction` doesn't carry `actionType`); rare, degrades gracefully.
- [ ] Combat opening frame renders "Unknown foe" pre-first-step; `PipelineDecideResult.combatEnemy` exists but isn't exposed publicly — enrich when worth it.
- [ ] Cartographer enrichment has no active retry sweep (N2 residual): the mint→fire wiring is fixed (`mintedSince` diff fires the async cartographer for freshly-crossed frontiers), but a `enrich()` that throws is only `console.warn`-logged and leaves the row `enrichment_pending = 1` forever — nothing re-attempts it. Add a bounded retry/reconciler (e.g. sweep pending rows on tick, capped by a retry counter) so a transient LLM failure self-heals instead of leaving a permanent placeholder.

**Art depth & migration** (deferred / mvp+):

- [ ] Fragment catalogue (enemy sprites, NPC busts, campfire, PC poses) — gates real art in the opening/combat frames; until it lands, sprite/scene slots render as deliberate placeholder scenes. See [[ansi-art-classification-framework]] §9, [[mvp+ansi-art]]. This is now the single next bottleneck for POC+ art coverage.
- [ ] migrate ascii to ansi in semantics, source files, and references — the 23 `assets/scenes/*.ascii` still coexist with the new `src/render/` ANSI system.
- [ ] render ansi as images? so mobile works? (colour degrades to monochrome on mobile today.) Longer-term, MVP(+) below wants the ANSI engine rewritten into compiled pixel-art images.
- [ ] Stage-2 BROADCAST_CARD frame — reuses the renderer; built when stage 2 (nat 1/20 broadcast) lands.

### action pipeline framework refactor closeout

Remaining from the v13 roadmap (`docs/engine/prompt-v13-roadmap.md`), in its suggested order:

1. D3/D4 — conversation & puzzle shapes + the free-text security stack: the biggest unspecced chunk; can be specced immediately since the relationship edges are already live. Needs a stage-N-style build plan before implementation.
2. (after a few live weeks of telemetry) Prose-critic trigger decision from the CombatBeatLog data, recorded as a decisions/ doc.
3. Roadmap stage 4 — Thread B world scaling: also wants live curves before tuning; the scale seam sits at 1.

### Player requests — prod data review (2026-07-08)

Fresh reports from a single QA session (snapshot `warden-20260708-201456`, character BendiusOver — mostly a combat playtest). `F#`/`B#` cite the `feedback`/`bug_reports` row. Cross-refs to existing items noted inline; where an item just re-surfaces a known one, treat this as a fresh datapoint rather than a new task.

**Feedback / feature asks**

- [ ] **NPC coherency — mint on first sight** — narrative said the player sees a caravan, then said they don't; the NPC wasn't persisted to state on first mention (F#1). Mint NPCs immediately so they persist. Combat half landed (RA-3); the non-combat half is stage 4 step 4. See [[mvp+npc-economy]], [[mvp-data-model]] (world-state tracking).
- [ ] **Richer `/hi` opening prose** — pressing Hi should generate a prose opener that scales with time since last interaction (referencing days or a few actions) and reminds the player of their work, quests, and loose ends (F#2). Extends the existing "morning/evening custom prose" and "add /hi to the new-hero message" TBD items.
- [ ] **Buttons going missing is annoying — do the menu rework soon** (F#5). Fresh datapoint bumping the "menu framework coupled to views" MVP item / [[discord-interaction-layer]].

### Player requests — prod data review (2026-07-03)

Open *feature* asks mined from the `feedback`/`bug_reports` tables (snapshot `warden-20260703-133521`). Bug-shaped reports already fixed in `[Unreleased]`/0.2.5–0.2.6 are omitted; these are the requests still open. `F#`/`B#` cite the feedback/bug row. The four POC-sized Discord/comms wins are lumped into the **[[polish-v0.2.8]]** spark; the rest route to MVP/sparks.

- [ ] **Player-founded structures become real locations** — a player who *starts building* a temple expects it to exist as its own explorable/buildable place, not resolve to an existing or adjacent location (F#4, B#8 — Ulrich's temple). Relates to lazy world growth + world-state tracking [[mvp-data-model]].
- [ ] **Cross-player buff actions** — praying/blessing "for everyone" should actually apply a buff mutation to the other players present, not no-op (B#11). Needs a multiplayer-aware mutation.
- [ ] **Items should be usable, not stat-bonus clutter** — players accumulate notes/keys/etc. that only grant a passive stat bonus and never get *used*; make items actually do something (F#11). Tracked in [[improved-item-features]] but not previously on this list.
- [ ] **Communal / offering currency separate from personal gold** — a player wanted to spend offering-basket funds (not their own coin) on temple supplies; distinguish a shared/temple purse from personal wealth (F#9). Nuance under the MVP "make wealth spendable/meaningful" item below.

## MVP — deferred

- [ ] any periodic channel message should be re evaluated.
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
- [ ] **schema: normalise location references to FK ids** — locations are keyed by `name` (TEXT) everywhere (`player_characters.location`, `npcs.location`, `location_edges`, `actions.location_name`). `actions.location_name` is a deliberate point-in-time *snapshot* (keep it), but a future polish pass should decide whether the live-reference tables move to `location_id` FKs consistently — a holistic refactor, not a lone divergence. See [[per-player-map-exploration]] §6.
- [ ] use reactions as a way of buffering input before a button is pressed (expend items or use certain abilities to amplify actions, also works for trades)
  `this is cool!!!`
  (but does it work with ephemeral..?)
- [ ] stealth or following mechanics?
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

# MVP(+)?

- [ ] the ansi art engine should be re written in custom font character that are compiled into an actual image and sent as pixelated art.
