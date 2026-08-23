# TODO

## ▶️ NEXT UP - `AGENT_FORCE_FREE_ACTIONS`

The agent-player **cannot validate balance today**, which blocks two Release A residuals. The brain overwhelmingly picks the day-job menu over free actions, and `stripWorkInspiration` strips inspiration from work actions by design, so v12 and v13 both returned a **structurally** 0% grant rate - a measurement artefact, not a finding. The M8.5 realism arm did *not* fix it; the brain still funnels into `menu-pick 0` / `choice 0`.

Scope: a switch (or a brain-prompt ration) that makes free actions reachable, then a measurement pass over RA-2's ~10% target and 3.2-3.7 band. The harness is otherwise a good QA/crash instrument - this is about what it can *measure*.

**Live runs need `set -a; . ./.env; set +a` first** (no dotenv), are opt-in per the `agent-smoke` skill, and cost real tokens - keep `AGENT_DAYS` small. The deterministic suite is the correctness proof.

## scratchpad (humans start here)

### Prod-data review - two-week window (2026-07-19 → 08-02, snapshot `warden-20260802-212213`)

Day 27; 37 actions over 8 active days, 3 active players, **2 of 5 characters churned after week one**. The 08-02 wolf fight is the pain centre (F#14 "This sucked", B#17-19): 13 rounds, ~20 min wall-clock, ending in a bail, with visible state desync. It was also the first human exposure to the v13 16-18 ladder. Decide latency roughly tripled over the last 3 days (avg ~19s on 08-02; 10 calls >30s) - provider contention suspected, since the spike predates v13. Health checks green: parse_ok 99.8%, zero fallbacks, zero validation warnings, zero HTTP errors.

**Follow-ups:**

- [ ] **Combat length**: 13 rounds reads as "repeat spamming press the attack" (F#14/B#19). A round cap or an explicit mid-fight "press the advantage / break off" affordance; the bail path exists but costs nothing and reads as defeat.
- [ ] **Combat state desync**: minion↔wolf mixup, HP-bar bounce, hard→medium drift (B#17-19) point at the persisted in-combat edge disagreeing with what the card renders. Trace the 08-02 calls end-to-end. Related to the open C4 in_combat-edge-duplication item.
- [ ] **Latency investigation**: decide-call latency roughly tripled 07-30 → 07-31/08-02 (avg ~19s on 08-02; 10 calls >30s across two sessions). Suspect provider contention; also check reasoning-length growth per beat. Cross-refs the MVP "LLM latency" item and the classify-critic TBD item.
- [ ] **RA-1/RA-2 first-exposure watch**: the re-anchored ladder's only human test ended in a bail + "This sucked", and the player is at 1/10 HP; combined stinginess remains unmeasured. The next BendiusOver session is the datapoint.
- [ ] **Retention**: 2/5 characters churned after week one; the active tester's worst session was the most recent. Worth revisiting the stage-2 solo-first plan (nat 1/20 beats) as a hook before wider invites.

### Release A residuals (shipped 2026-08-02 as v0.3.3; only the unverified survives)

Write-ups: [[resolve-difficulty-signal]], archived `docs/archived/poc-plus/poc-plus-release-a-plan.md`.

- [ ] **RA-1 daunting band unverified behaviourally** - the band is fixed in prose and the arithmetic checks out, but no re-probe was run. Needs isolated DECIDE probes (the kind stage 4 used), *not* an agent-player run.
- [ ] **RA-2 inspiration frequency unverified** - the ~10% target and 3.2-3.7 band. Blocked on `AGENT_FORCE_FREE_ACTIONS` (see top) or human play.
- [ ] **`dangerTier` thresholds predate the v13 ladder** - an ordinary 16-17 fight reads `hard`. Re-tuning also moves the combat card, so it needs measurement first.
- [ ] **Combat card/narration match is per round, not per fight** - each CONTINUE round re-authors `baseDc`.
- [?] **`opts.compact` has had no production caller since RA-6** - still plumbed through `buildOutcomeView`/`viewState.ts`/`commands/action.ts` with a unit test. Delete it, or keep it as a deliberate capability.

**Later stages** - POC+ stages 2-4 (nat 1/20 solo reward + broadcast, cross-player buffs, Saturday shared boss) are specced in [[poc-plus-roadmap]]; build + agent-QA only until the human testing round.

### M4 agent-player live smoke-run findings (2026-07-21)

Three live DeepSeek runs, all clean (exit 0, no state corruption). These are observations, not harness bugs:

- [ ] **[engine/prompt] LLM authored an out-of-graph `scene_location`** - twice in one run the model named a location outside the geography graph ("The Vale", then "Town Square · The Vale") with no relocate mutation; the travel-gate + graph validator correctly no-op'd both (no player-visible corruption). The `place · region` format matches the display convention (`src/discord/map-render.ts:117`, `src/llm/prompt-builder.ts:243`) - the model is likely echoing a compound display string back into the raw `scene_location` field. Sanity-check whether the prompt/context renders location as `place · region` somewhere the model could mistake it for the field value.
- [ ] **[UX] bail-refund grace has no in-game signal** - the once-per-day free step-back (`last_bail_refund_day`, `src/engine/WorldEngineImpl.ts`) reads as inconsistent to a player (first bail refunds a roll, second same-day doesn't) with nothing explaining it; a small UI note ("first step-back today is free") would remove the ambiguity the critic flagged. Not a bug.
- [ ] **[M4 enhancement] promote engine anomaly logs to transcript findings** - engine-emitted anomaly recoveries (`category-telemetry`, `travel-gate` injections/drops) print to stderr but the agent-player harness doesn't capture them as `finding`s, so they're invisible in the run scoreboard. Surfacing anomalies as findings is the harness's whole job; a future QA-capture slice could hook these engine emissions into transcript warnings. (The `play.ts` stdout-contamination defect the same runs caught is already FIXED - transcript now writes to a file, `AGENT_OUT`.)

### M8.5 live agent-player smoke-run findings (2026-08-06)

First live runs on the M8.5 harness (realism arm on). **The seam held end to end** - all three wizard walks recorded through the protocol, zero invariant breaches, every DeepSeek timeout absorbed by the designed fail-open. Findings:

- [ ] **[harness] No watchdog for a wedged in-flight LLM request** *(smoke-c died mid-day-1)* - after a successful move the process sat alive-but-silent 4-6 min with no abort logged; the 30s/60s abort either never fired or didn't interrupt the fetch (a wedged socket can outlive an AbortController). One wedged request stalls a live run indefinitely - needs a top-level guard (heartbeat + hard kill, or a per-call timeout that actually aborts the socket).
- [ ] **[harness] Single-end `writeFileSync` in `finally` defeats the repro guarantee on signal death** *(smoke-c)* - a kill skips `finally`: zero transcript, zero protocol log, zero scoreboard (the run's death itself was the only artifact). A live-run harness that can outlive its controlling shell should append the transcript incrementally so a killed run still leaves evidence.
- [ ] **[engine/prompt] Failure branch keeps the success reward - wealth +3 on a failed `search`** *(smoke-b; also smoke-a: +3 on every resolved action incl. failures)* - a failed search applied `-item:Fresh Hare, stamina-1, wealth+3`: the failure template looks like the success template with only the item sign flipped, leaving `modify_wealth` on a failure. The `CATEGORY_MUTATION_MAP` telemetry flagged `modify_wealth`/`remove_item` as unexpected on `search`, and smoke-b's critic independently called the "- Fresh Hare alongside +💰 3" screen contradictory. Either the resolve-mutate prompt template for `search` leaks the reward into failure, or the model mirrors the success recipe with the item flipped - route via the `prompt-versioning` skill. *(The telemetry-flag↔findings disconnect is the existing [M4 enhancement] item above - telemetry flags never surface as transcript findings.)*
- [ ] **[infra] Decide-stage DeepSeek timeouts spike under concurrent live runs** *(a: 3, b: 2, c: 2 decide timeouts in a ~15-min window)* - three parallel live runs on one key plausibly contributed to provider flakiness (new datapoint on the known 07-31/08-02 latency degradation). The fail-open paths all held. Future fleets: ≤2 concurrent, or stagger.
- [ ] **[game-design] Favoured-option risk mismatch** *(smoke-a critic)* - a favoured option rolling 8 vs DC 8 read as FAILURE (strict-beat ties fail) with harsh fallout (-1 HP, -2 stamina, -kit) while a cautious option succeeded comfortably - the arrow/favoured hints don't match actual risk. Cross-refs the v13 ladder "combined feel may read stingy" caution.
- [ ] **[QA] The multi-day live path remains unverified** - smoke-c died mid-day-1 (no day boundary, no roll refill/regen/income observation). Needs a re-run (quieter window, ≤2 concurrent) once the watchdog + incremental-write items land.
- [>] **[harness] The realism arm didn't fix move variety** - the a/b brains picked `menu-pick 0` / `choice 0` (or the favoured option) almost exclusively; the brain still funnels into the day-job menu. Re-confirms the standing caution (no balance validation via the agent-player; `AGENT_FORCE_FREE_ACTIONS` remains the next arc's first task).

### 0.3.2 residuals (prompt-versioning + [[prompt-v13-roadmap]])

*v13 has shipped, so the two items still open here carry to whatever prompt set comes next - route via the `prompt-versioning` skill and remember a published set is copied, never edited in place.*

- [ ] **C6 symptom-A - mis-classification accuracy** *(deferred 0.3.2)*: actions the player intends as combat are sometimes classified as `skill`/`rest`, routing to the wrong spine. The auto-resolve guard (C6) prevents a combat-classified action from resolving without a fight, but the upstream classify decision is a prompt-template concern → route via `prompt-versioning` skill, [[prompt-v13-roadmap]].
- [ ] **`ItemData` has no `kind`/`slot`/`consumable` column** *(RA-1 Stage 1 follow-up)*: the engine can't distinguish a consumable from a weapon and can't hold consumables to +1, so the v13 "consumable reads +1" guidance is prompt-only and unenforced until such a column exists.

**C4 follow-ups left out of that fix:**

- [ ] **C4 follow-up - abandoned (not bailed) mid-round combat shows no opening frame on resume**: a genuinely unfinished multi-round fight leaves last_action_state set; `/action` then hits the resume branch (`action.ts:162`), which calls `buildDecisionMessage` without `actionType`, so no opening frame renders at all (and `decisionIdx > 0` would gate it out anyway). Latent, not the reported symptom. Needs `resumeAction`/`ActionResumeResult` to carry actionType + remembered foe and the render gate to allow a combat opener on resume.
- [ ] **C4 follow-up - in_combat edge duplication on anchor change**: `set_relation`'s UNIQUE key includes the anchor (`to_type,to_ref`), so a re-engage that resolves to a *different* anchor than the bailed edge creates a second `in_combat` edge; `readCombatState` then picks whichever the DB returns first. Harmless for same-anchor re-engage (the common path). Needs an edge-lifecycle sweep, not part of the C4 symptom fix.

### TBD - POC polish (small UI wins, no spark warranted)

- [/] combat or social actions HAVE to mint NPC. no thing can be referenced without existing or spawning to persist? *(largely addressed: RA-3 mints a surviving named foe, and v13's `add_npc` tells the model to mint a narrated newcomer on first sight. What's left is making it a hard guarantee rather than prompt guidance.)*
- [ ] remove critic from classify. conditionally. latency seems high. mine prod for investigation *(note: RA-4 already gated the narrate critic - `CRITIC_GATE_MODE`, default `narrate-gated`; this item is the classify stage specifically.)*
- [ ] many frame has two spaces for padding left. refactor to 1
- [ ] map seems formatted weird:

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
└─ 🧗 ⬇️ the trees never thin - the deep woods swallow the trail
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

### ANSI - outstanding work (consolidated 2026-07-11)

**Opening-frame runtime gaps** (from the ANSI-F review - the frame ships but misses these paths):

- [ ] Opening frame on auto-resolved actions: travel/rest often resolve at start with no decision beat, so they show no opening frame today (3 auto-finish call sites + the public-broadcast embed question). Extend the frame to the outcome path.
- [ ] Resume-mid-action shows no opening frame at decisionIdx 0 (`resumeAction` doesn't carry `actionType`); rare, degrades gracefully.
- [ ] Combat opening frame renders "Unknown foe" pre-first-step; `PipelineDecideResult.combatEnemy` exists but isn't exposed publicly - enrich when worth it.
- [ ] Cartographer enrichment has no active retry sweep (N2 residual): the mint→fire wiring is fixed (`mintedSince` diff fires the async cartographer for freshly-crossed frontiers), but a `enrich()` that throws is only `console.warn`-logged and leaves the row `enrichment_pending = 1` forever - nothing re-attempts it. Add a bounded retry/reconciler (e.g. sweep pending rows on tick, capped by a retry counter) so a transient LLM failure self-heals instead of leaving a permanent placeholder.

**Art depth & migration** (deferred / mvp+):

- [ ] Fragment catalogue (enemy sprites, NPC busts, campfire, PC poses) - gates real art in the opening/combat frames; until it lands, sprite/scene slots render as deliberate placeholder scenes. See [[ansi-art-classification-framework]] §9, [[mvp+ansi-art]]. This is now the single next bottleneck for POC+ art coverage.
- [ ] migrate ascii to ansi in semantics, source files, and references - the 23 `assets/scenes/*.ascii` still coexist with the new `src/render/` ANSI system.
- [ ] render ansi as images? so mobile works? (colour degrades to monochrome on mobile today.) Longer-term, MVP(+) below wants the ANSI engine rewritten into compiled pixel-art images.
- [ ] Stage-2 BROADCAST_CARD frame - reuses the renderer; built when stage 2 (nat 1/20 broadcast) lands.

### Action-pipeline framework — remaining threads

Tracked in [[prompt-v13-roadmap]] (suggested order there): D3/D4 conversation/puzzle shapes + the free-text security stack, the prose-critic trigger decision from live CombatBeatLog data, then stage-4 world scaling. Each needs a stage-N-style build plan before implementation.

### Player requests - prod data review (2026-07-08)

Fresh reports from a single QA session (snapshot `warden-20260708-201456`, character BendiusOver - mostly a combat playtest). `F#`/`B#` cite the `feedback`/`bug_reports` row. Cross-refs to existing items noted inline; where an item just re-surfaces a known one, treat this as a fresh datapoint rather than a new task.

**Feedback / feature asks**

- [ ] **Richer `/hi` opening prose** - pressing Hi should generate a prose opener that scales with time since last interaction (referencing days or a few actions) and reminds the player of their work, quests, and loose ends (F#2). Extends the existing "morning/evening custom prose" and "add /hi to the new-hero message" TBD items.
- [ ] **Buttons going missing is annoying - do the menu rework soon** (F#5). Fresh datapoint bumping the "menu framework coupled to views" MVP item / [[discord-interaction-layer]].

### Player requests - prod data review (2026-07-03)

Open *feature* asks mined from the `feedback`/`bug_reports` tables (snapshot `warden-20260703-133521`). `F#`/`B#` cite the feedback/bug row; the rest route to MVP/sparks.

- [ ] **Player-founded structures become real locations** - a player who *starts building* a temple expects it to exist as its own explorable/buildable place, not resolve to an existing or adjacent location (F#4, B#8 - Ulrich's temple). Relates to lazy world growth + world-state tracking [[mvp-data-model]].
- [ ] **Cross-player buff actions** - praying/blessing "for everyone" should actually apply a buff mutation to the other players present, not no-op (B#11). Needs a multiplayer-aware mutation.
- [ ] **Items should be usable, not stat-bonus clutter** - players accumulate notes/keys/etc. that only grant a passive stat bonus and never get *used*; make items actually do something (F#11). Tracked in [[improved-item-features]] but not previously on this list.
- [ ] **Communal / offering currency separate from personal gold** - a player wanted to spend offering-basket funds (not their own coin) on temple supplies; distinguish a shared/temple purse from personal wealth (F#9). Nuance under the MVP "make wealth spendable/meaningful" item below.

## MVP - deferred

- [ ] any periodic channel message should be re evaluated.
- [ ] dnd statblock scraper
- [ ] menu framework coupled to views - standardise the views/command/message terminology and a tab/subtab layout per message. See [[discord-interaction-layer]] (the interaction-plumbing layer; subtabs are explicitly MVP there).
- [ ] make wealth (and stamina, health) spendable/meaningful, and define death / 0 HP. The death track is deferred from the POC by design ([[the-poc]]); see [[mvp-progression]] (lifecycle/death), [[mvp-combat]] (HP stakes), [[mvp+npc-economy]] (wealth sink).
- [ ] cap rolls per action type + add a short-rest option; reward slow build-up / daily-work play on subsequent actions instead of jumping straight in. Check for hard-coded roll caps. Extends [[roll-economy-timeouts-and-world-growth]].
- [ ] character progression depth - levels, upskilling, traits; the char creator shows which stats matter per race/class and how each modifies them. See [[mvp-progression]], [[mvp-character-drivers]].
- [ ] richer community feedback in chat - tag people (not too spammy), let players show off to each other. See [[mvp-social-model]], [[mvp-discord-ux]].
- [ ] use both models differently, flash for generating quick responses and daily work, pro for decision trees.
- [>] saturday special event, spawn an "evil npc" somewhere with a hint. Incentivise hunting it/them and add npc death mutation → minimal slice (one scripted weekly boss, shared HP) now [[poc-plus-roadmap]] item 5; npc death mutation and the wider event pool stay MVP.
- [ ] choose age
- [ ] **LLM latency** *(deferred from [[polish-v0.2.8]], 2026-07-04)* - the 2026-07-04 snapshot shows mean ~12.8s, 94 calls >20s, 26 >30s (max 47.5s); this is what surfaces to players as `timed_out`/`bailed` outcomes. Rein in reasoning length and tighten the timeout+fallback. Overlaps the model-split above and the thinking-on/off experiments in [[mvp-llm-prompt-architecture]].
- [ ] Improved journal/story
  - track or show quests or hints?
  - add clue system? also grants +1 roll
- [ ] **schema: normalise location references to FK ids** - locations are keyed by `name` (TEXT) everywhere (`player_characters.location`, `npcs.location`, `location_edges`, `actions.location_name`). `actions.location_name` is a deliberate point-in-time *snapshot* (keep it), but a future polish pass should decide whether the live-reference tables move to `location_id` FKs consistently - a holistic refactor, not a lone divergence. See [[per-player-map-exploration]] §6.
- [ ] use reactions as a way of buffering input before a button is pressed (expend items or use certain abilities to amplify actions, also works for trades)
  `this is cool!!!`
  (but does it work with ephemeral..?)
- [ ] stealth or following mechanics?
- [>] `[[mvp-llm-prompt-architecture]]` - prompt refactor:
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
- [>] `[[mvp-data-model]]` - graph db for backend coherency (relationships, items, distances, groups)
  - better world state tracking, which areas are hostile, how hostile, what type of faction or encounters to expect
- [>] `[[mvp+npc-economy]]` - introduce NPCs more often in interactions and save them (also reuse them more often)
- [>] `[[mvp+world-state-projection]]` - rethink sleep mechanic, yes we want people to sleep at the wardens oak, but they shouldnt be able to just tp out of an unsafe or far away location.
  - related to world state tracking too: finishing your day in an unsafe location should have conesquences
    (you dont sleep well or you get put in jail and must escape)
- [>] `[[mvp-ascii-render-pipeline]]` - scrape prettier ascii art or images for converting with ascii image converter

# MVP(+)?

- [ ] the ansi art engine should be re written in custom font character that are compiled into an actual image and sent as pixelated art.
