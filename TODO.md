# TODO

## ⏭️ RESUME HERE - JSON seam arc mid-flight: M5, M6, M7.0–M7.2 landed on `feat/json-seam-protocol`; M7.3 (character creation) next (last touched 2026-08-05)

**Read first:** [`docs/engine/json-seam-handover-m7-m8.md`](./docs/engine/json-seam-handover-m7-m8.md) (the M7/M8 lead prompt — the law, gates, execution rules), then the canonical arc spec [`docs/engine/json-seam-protocol.md`](./docs/engine/json-seam-protocol.md) (§ M7 build plan + § Execution state carry the live status). Parent: [[layer-boundaries-and-json-seam]]; the M0–M4 slice pattern: [[json-seam-build-plans]].

**State.** Release A shipped as 0.3.3 (2026-08-02, merged via `dev`, tagged `v0.3.3`; `dev` at `56e127d`). The JSON seam arc runs on branch `feat/json-seam-protocol` (never commit/push/checkout `dev`/`main`). M5 (contract) and M6 (agent as protocol client) landed 2026-08-02; M7 (bookends through the seam) in progress: **M7.0** bookend oracle (16 transcripts, build `9e61011`, review clean), **M7.1** rest+tick (build `e669262` + review fix `d47a835`), **M7.2** `/hi` (build `078aaba` + review fix `8b08059`) — the unsafe-rest rule moved into the engine, `rest.begin` + `hi.open` events, `/sleep` and `/hi` translate + paint, harness rest half through the seam with `tick(true)` engine-direct. Gates: typecheck clean, 92 files / 1866 tests green, M1/M2 + M7.0 snapshots byte-green with zero churn. `dispatchInteraction.ts` untouched. `HEAD` is 12 commits ahead of `origin/feat/json-seam-protocol` (the M7.2 slice: `8a4a230` docs checklist → `078aaba` build → `8b08059` review fix → the outcome record).

**Next (M7.3):** character creation through the seam — the hardest slice, judge candidate. Write the M7.3 slice checklist into the spec doc first, then run the slice loop. It MUST include (per the M6→M7 steer + M7.0 review notes): a `docs/decisions/` record settling wizard state ownership as a genuine extension of parent decision 1 (controller-held session state keyed by `playerId` vs engine-persisted draft); `character.create` + wizard-step events + a wizard view-state carrying the step screen semantically; the free-text name-answer event (the step-1 Discord modal doesn't map onto request/response); the confirm fan-out (✨ announcement + `/hi` swap) crossing as facts/views; the agent seeds its character through the protocol. Cover the unpinned branches the M7.0 review carried: the join `_userInFlight` double-click guard (join.ts:134) and the wizard TTL-expiry branch (WizardSession.ts:163). Also carry the M7.2 watch item: the D2 stale `/hi` resume edge now surfaces as `ok:false 'internal'` (unpinned — pin it in M7.3's oracle or leave recorded). M8 (read-only screens) follows; the M9 byte-identical gate depends on M7.0 coverage staying green.

**Standing cautions (unchanged, still binding).**

- **Do not use the agent-player to validate balance.** It cannot measure RA-2 at all: the brain overwhelmingly picks the day-job menu over free actions, and `stripWorkInspiration` strips inspiration from work actions by design, so both v12 and v13 returned a **structural** 0% grant rate. RA-2's ~10% target and 3.2-3.7 band stay **unverified** pending human play or a harness switch that forces free actions (the `AGENT_FORCE_FREE_ACTIONS` follow-up is the next arc's first task, not this one). The harness remains a good QA/crash instrument.
- **Live runs need `set -a; . ./.env; set +a` first** (no dotenv). The live `npm run agent:play` smoke run is still deferred from M6 — run manually at `AGENT_DAYS=1` (the CI tool's timeout is too short); the deterministic gate is the correctness proof. Carry this into the M7 closeout.
- **Coordinator (kimi-k3) is unreachable as of 2026-08-05** — provider account suspended (insufficient balance). The M6→M7 steer recorded in the spec doc governs; resume coordinator consults when billing is restored.
- **Discipline:** one orchestrated-delegation loop per slice: spec → executor → verify → commit → fresh-context reviewer → triage → fixer → verify → commit → coordinator checkpoint → `/clear`. Atomic commit per slice; changelog current per slice. A green suite is not evidence that a prompt rule is reachable. Scope fences hold: no game-rule/balance/prompt changes (the unsafe-rest penalty moves, it does not change value or conditions), no `sim/` changes, `PROTOCOL_VERSION` stays 1, no `facts` key without a consuming adapter in the same slice, `dispatchInteraction.ts` untouched until M9.

## scratchpad (humans start here)

### Prod-data review — two-week window (2026-07-19 → 08-02, snapshot `warden-20260802-212213`)

Fresh pull succeeded, day 27, 123 actions / 1016 LLM calls / 5 chars — so the RESUME HERE note that prod host `192.168.0.242` was unreachable no longer holds. Two-week window: 37 actions across 8 active days, 3 players (BendiusOver, WernerVanDerMervwe, Sir Gary); **Schlong and Ser Redquad churned after week one** (nothing since 07-13/07-14). BendiusOver is the only tester on new content (45 of 123 lifetime actions) and he ended the week at 1/10 HP after his worst session. The **only feedback filed in the entire window is "This sucked"** (F#14, 08-02 14:41, 12s after bailing a fight) — sentiment is otherwise silent, the player only files when something breaks.

**The 08-02 wolf fight is the pain centre** (B#17-19): 13 combat rounds, 14 LLM calls, ~95k tokens, ~20 min wall-clock (14:20 → 14:40), avg ~19s per round, ending in a bail worth just −1 stamina. Player-reported state inconsistencies: enemy HP bar bounces down and back to full mid-action, difficulty flips hard→medium, card shows a minion instead of the wolf, and a "final stand" fires mid-win with a −7 margin and both sides losing 1 HP. This was also the **first human exposure to the v13 hard 16-18 ladder** and it ended in frustration, so the RESUME HERE "combined feel may read stingy" caution is now a live concern, not theory.

**Latency degraded sharply in the last 3 days**: 07-31 avg 16.1s (5 calls >30s, one 60s abort — the reality-fracture decide), 08-02 avg 18.7s (5 calls >30s, max 43s), vs 5.7-7.9s avg for 07-19 → 07-30. The 07-31 spike ran v12 prompts, so it predates v13 → provider-side contention on deepseek-v4-flash is the prime suspect, not the prompt set. Note 0.3.3's fail-open fix (commit `15277e3`) has not yet absorbed a real abort — the 07-31 one died under 0.3.2.

**Health checks that came back green**: parse_ok 99.8% (2 failures ever, both 60s aborts), zero fallbacks, zero validation warnings, zero HTTP errors, no `done` auto-resolve outcomes at all. Roll-economy question answered: B#16 "was my roll really refunded" — yes, the 07-28 10:30 timed-out fish (DC 14, no roll spent) was retried at 10:36 with a fresh roll and succeeded.

**Follow-ups:**

- [ ] **Combat length**: 13 rounds reads as "repeat spamming press the attack" (F#14/B#19). A round cap or an explicit mid-fight "press the advantage / break off" affordance; the bail path exists but costs nothing and reads as defeat.
- [ ] **Combat state desync**: minion↔wolf mixup, HP-bar bounce, hard→medium drift (B#17-19) point at the persisted in-combat edge disagreeing with what the card renders. Trace the 08-02 calls end-to-end. Related to the open C4 in_combat-edge-duplication item.
- [ ] **Latency investigation**: decide-call latency roughly tripled 07-30 → 07-31/08-02 (avg ~19s on 08-02; 10 calls >30s across two sessions). Suspect provider contention; also check reasoning-length growth per beat. Cross-refs the MVP "LLM latency" item and the classify-critic TBD item.
- [ ] **RA-1/RA-2 first-exposure watch**: the re-anchored ladder's only human test ended in a bail + "This sucked", and the player is at 1/10 HP; combined stinginess remains unmeasured. The next BendiusOver session is the datapoint.
- [ ] **Retention**: 2/5 characters churned after week one; the active tester's worst session was the most recent. Worth revisiting the stage-2 solo-first plan (nat 1/20 beats) as a hook before wider invites.

### POC+ re-sequencing — prod-data review (2026-07-23)

Full-period prod snapshot (`warden-20260723-201953`, 07-07 → 07-23, day 17, `0.3.0`–`0.3.2`; 98 actions / 796 LLM calls / 4 chars / 1 external tester) drove a re-order of the remaining POC+ arc, recorded in [[poc-plus-roadmap]] (§ Re-sequencing). No controlled invite — the rest of POC+ playtesting is agent-driven; human testing is scheduled later. **Release A lands before any more shared-world code.**

**Release A — worth-returning-to (polish / coherence / cost)**

- [x] **Stakes / difficulty pass** *(RA-1)*: item-bonus ceiling, the DC ladder and the reward/failure menus all landed (stage 4), and P1 restated the ladder on the final per-option DC, closing the last open v13 prompt defect. The failure-cost rule measured 21/21 compliant, up from 0/12 on v12. **Residual, re-homed here (not dropped):** the daunting band is now fixed in prose and the arithmetic checks out, but no re-probe was run, so it stays unverified behaviourally, needing isolated DECIDE probes (the kind stage 4 used), not an agent-player run. No lethality (death track stays deferred). Overlaps the MVP "make wealth (and stamina, health) spendable/meaningful" item below.
- [x] **Inspiration dial** *(RA-2)*: all four prompt/engine halves landed (F#12 strip, named-reward line, the v13 frequency dial, the rest-channel fix). **Residual, re-homed here (not dropped):** the ~10% target and 3.2-3.7 band remain unverified, since the agent-player structurally cannot check them (day-job work strips inspiration by design, and the brain overwhelmingly picks day-job work over free actions). Needs human play, or a harness switch that forces free actions, before anyone concludes it worked.
- [x] **NPC mint-on-first-sight** — both halves landed: RA-3's combat half (`anchor: 'npc'` minted on a surviving foe) and stage 4 step 4's `add_npc` `health` vocab plus the mint-on-first-sight instruction for narrated newcomers.

**Release A closeout — three decisions left open** (full write-ups in the plan's § Follow-up logged)

- [?] **`opts.compact` has had no production caller since RA-6** — still plumbed through `buildOutcomeView`/`viewState.ts`/`commands/action.ts` with a unit test. Delete it, or keep it as a deliberate capability.
- [ ] **Give the agent-player a way to exercise the quest loop** — an `AGENT_FORCE_FREE_ACTIONS`-style switch, or a brain prompt that rations day-job picks. Without it the harness can't answer any balance question about free actions (§ RESUME HERE, standing cautions).
- [x] **RESOLVE is told to scale the reward by the DC attempted, and is never sent a DC** *(found by P1's review; fixed as P3 rather than deferred, see [[resolve-difficulty-signal]])* — a DC-checked attempt now carries `final dc`, a fight carries the `foe danger` tier the combat card already renders, and an auto-resolve carries neither. **Two residuals logged in that doc, both balance decisions rather than wiring:** `dangerTier`'s thresholds predate v13's ladder, so an ordinary 16-17 fight reads `hard` (re-tuning them also moves the combat card, so it needs measurement); and the card/narration match is per round, not per fight, because each CONTINUE round re-authors `baseDc`.

**Stage 2 re-scope + later stages**

- [ ] **Stage 2 solo-first** — nat 20 grants extra loot/rolls (F#9), nat 1 a story beat; public broadcast is the bonus layer. Lands at N=1.
- [ ] **Stages 3–4 (buffs, shared boss)** — build + agent-QA only for now; extend the agent-player harness to co-located multi-agent runs; fun-payoff deferred to later user testing.

### M4 agent-player live smoke-run findings (2026-07-21)

Three live DeepSeek smoke runs (1d, 1d, 2d) all completed clean (exit 0, 0 formal findings, coherent gameplay, critic reports). Multi-day path confirmed (day advances, rolls refill, overnight regen + income, rest-to-Oak). These observations are NOT harness bugs (all self-recovered, no state corruption) — logged for maintainer/backlog:

- [ ] **[engine/prompt] LLM authored an out-of-graph `scene_location`** — twice in one run the model named a location outside the geography graph ("The Vale", then "Town Square · The Vale") with no relocate mutation; the travel-gate + graph validator correctly no-op'd both (no player-visible corruption). The `place · region` format matches the display convention (`src/discord/map-render.ts:117`, `src/llm/prompt-builder.ts:243`) — the model is likely echoing a compound display string back into the raw `scene_location` field. Sanity-check whether the prompt/context renders location as `place · region` somewhere the model could mistake it for the field value.
- [ ] **[UX] bail-refund grace has no in-game signal** — the once-per-day free step-back (`last_bail_refund_day`, `src/engine/WorldEngineImpl.ts`) reads as inconsistent to a player (first bail refunds a roll, second same-day doesn't) with nothing explaining it; a small UI note ("first step-back today is free") would remove the ambiguity the critic flagged. Not a bug.
- [ ] **[M4 enhancement] promote engine anomaly logs to transcript findings** — engine-emitted anomaly recoveries (`category-telemetry`, `travel-gate` injections/drops) print to stderr but the agent-player harness doesn't capture them as `finding`s, so they're invisible in the run scoreboard. Surfacing anomalies as findings is the harness's whole job; a future QA-capture slice could hook these engine emissions into transcript warnings. (The `play.ts` stdout-contamination defect the same runs caught is already FIXED — transcript now writes to a file, `AGENT_OUT`.)

### 0.3.2 residuals (prompt-versioning + [[prompt-v13-roadmap]])

*v13 has shipped, so the two items still open here carry to whatever prompt set comes next — route via the `prompt-versioning` skill and remember a published set is copied, never edited in place.*

- [ ] **C6 symptom-A — mis-classification accuracy** *(deferred 0.3.2)*: actions the player intends as combat are sometimes classified as `skill`/`rest`, routing to the wrong spine. The auto-resolve guard (C6) prevents a combat-classified action from resolving without a fight, but the upstream classify decision is a prompt-template concern → route via `prompt-versioning` skill, [[prompt-v13-roadmap]].
- [ ] **`ItemData` has no `kind`/`slot`/`consumable` column** *(RA-1 Stage 1 follow-up)*: the engine can't distinguish a consumable from a weapon and can't hold consumables to +1, so the v13 "consumable reads +1" guidance is prompt-only and unenforced until such a column exists.

**C4 follow-ups left out of that fix:**

- [ ] **C4 follow-up — abandoned (not bailed) mid-round combat shows no opening frame on resume**: a genuinely unfinished multi-round fight leaves last_action_state set; `/action` then hits the resume branch (`action.ts:162`), which calls `buildDecisionMessage` without `actionType`, so no opening frame renders at all (and `decisionIdx > 0` would gate it out anyway). Latent, not the reported symptom. Needs `resumeAction`/`ActionResumeResult` to carry actionType + remembered foe and the render gate to allow a combat opener on resume.
- [ ] **C4 follow-up — in_combat edge duplication on anchor change**: `set_relation`'s UNIQUE key includes the anchor (`to_type,to_ref`), so a re-engage that resolves to a *different* anchor than the bailed edge creates a second `in_combat` edge; `readCombatState` then picks whichever the DB returns first. Harmless for same-anchor re-engage (the common path). Needs an edge-lifecycle sweep, not part of the C4 symptom fix.

### TBD — POC polish (small UI wins, no spark warranted)

- [/] combat or social actions HAVE to mint NPC. no thing can be referenced without existing or spawning to persist? *(largely addressed: RA-3 mints a surviving named foe, and v13's `add_npc` tells the model to mint a narrated newcomer on first sight. What's left is making it a hard guarantee rather than prompt guidance.)*
- [ ] remove critic from classify. conditionally. latency seems high. mine prod for investigation *(note: RA-4 already gated the narrate critic — `CRITIC_GATE_MODE`, default `narrate-gated`; this item is the classify stage specifically.)*
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
