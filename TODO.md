# TODO

## ⏭️ RESUME HERE — POC+ Release A (last touched 2026-07-28)

**Read first:** [`docs/engine/poc-plus-release-a-plan.md`](./docs/engine/poc-plus-release-a-plan.md) — the executor-grade build plan. Its § Execution state carries the running handover (branch, baseline, per-task log, owner locks); its § RA-4 A/B results and § Scouting corrections carry findings that supersede parts of the original task specs. Parent tracking is [[poc-plus-roadmap]] § Re-sequencing.

**Reconcile first, every resume:** branch is `poc-plus/release-a` (cut off `dev` at `b32642a`). Confirm `npm run typecheck` clean and `npm test` green — **baseline is now 88 files / 1611 tests**, not the 86/1576 the M4 handover quoted. Check the plan's § Execution state against `git log` before trusting either.

**All owner locks are settled — nothing is blocked on the owner.** SL-1 = Option A (Release A carries the v13-aligned prompt-set bump, so RA-1, RA-2 and RA-3's full half are all in scope). SL-2 = no lethality (pre-settled). SL-3 = `narrate-gated` (decided on the measured A/B). SL-4 = named foes only, keyed off the `anchor` signal **not** name-presence. SL-5 = the sixth row is its own RA-6.

**Done and committed on the branch:** RA-6 (`8c2bdde`, reviewed clean) and RA-4 (`1ae558f` … `0fb3d16`, including three defect fixes and the live A/B).

**Next, in this order:**

1. **RA-5 (combat terminal polish) + RA-3 bounded (persist the narrated foe)** — do these adjacently, they share the combat-establish seam in `PipelineActionStateMachine.ts`. Both are fully scouted and **both are different from what the plan's original prose says** — read § Scouting corrections before writing any spec. In short: RA-5b is largely already fixed by 0.3.2 C3 (the `'Minion'` fallback is correctly scoped to ambient foes already, so residual B#15 is DECIDE omitting `combatEnemy`, a v13 prompt concern); RA-5 instead picks up two *newly found* bugs — the win frame bands enemy condition against the round's opening HP rather than `enemyMaxHp` (a worn-down foe can read "Healthy"), and `combatEnemy.name` accepts an empty string where its sibling `sceneLocation` does not. RA-3 bounded narrows to exactly one branch: `anchor: 'npc'` where NPC resolution failed.
2. **RA-1 + RA-2 batched** — one resolve/decide prompt-set bump via the `prompt-versioning` skill. Note the tension the RA-4 playtest critic surfaced: it already finds failure costs harsh ("losing gold on a failed tail") and the bail mechanic unrewarding, so RA-1 should raise DCs and make cost *legible* rather than simply heavier. The same run averaged 4.5 outcomes/day against RA-2's ~4.8 target, so the harness reproduces the cadence problem it needs to measure.
3. **Release cut 0.3.3** then the doc loop — per the plan's § Release cut and § Doc loop. The lead never merges `dev` → `main`; prompt the user.

**Discipline (unchanged):** one orchestrated-delegation loop per task — lead scouts and finalises the handoff, executor builds, lead verifies (typecheck + suite + the task's acceptance boxes), commit, fresh-context reviewer critiques, lead triages, fixer lands accepted findings, verify, commit. Atomic commit per task; changelog current per task. Balance tasks get an agent-player before/after run (`npm run agent:play`; there is no `dotenv`, so `set -a; . ./.env; set +a` first). Prod host `192.168.0.242` was unreachable from the last session, so re-pulling the snapshot may not be possible — the agent-player harness is the working signal. Scope fences hold: no lethality, no shared-world plumbing, no classify-accuracy work, no item-economy depth.

**One follow-up decision left open:** `opts.compact` is still plumbed through `buildOutcomeView`/`viewState.ts`/`commands/action.ts` with a unit test, but has had no production caller since RA-6 — delete it or keep it deliberately.

## scratchpad (humans start here)

### POC+ re-sequencing — prod-data review (2026-07-23)

Full-period prod snapshot (`warden-20260723-201953`, 07-07 → 07-23, day 17, `0.3.0`–`0.3.2`; 98 actions / 796 LLM calls / 4 chars / 1 external tester) drove a re-order of the remaining POC+ arc, recorded in [[poc-plus-roadmap]] (§ Re-sequencing). No controlled invite — the rest of POC+ playtesting is agent-driven; human testing is scheduled later. **Release A lands before any more shared-world code.**

**Release A — worth-returning-to (polish / coherence / cost)**

- [ ] **Stakes / difficulty pass** — 83% success, no `final_dc` > 17, 11 failures in 98 actions. Meaningful cost + higher DCs on ambitious actions; no lethality (death track stays deferred). Overlaps the MVP "make wealth (and stamina, health) spendable/meaningful" item below.
- [ ] **Inspiration dial** — `modify_rolls_remaining:+1` on 29% of actions inflates cadence to ~4.8/active-day (F#4 "fun but too broken"). Dial frequency or surface as a named reward. Related to the WAD bonus-rolls item below and F#12 (work shouldn't offer inspiration).
- [ ] **NPC mint-on-first-sight** *(RA-3, next — see the plan's § Scouting corrections before speccing)* — `add_npc` fired twice all period; NPCs narrated but not persisted (F#1). Bounded half narrows to a single branch: `anchor: 'npc'` where NPC resolution failed. Gate on the `anchor` signal, **not** on name-presence — DECIDE authors a name string for wildlife too, so "has a name" would persist "a wolf" as a permanent resident.
- [x] **Critic cost A/B** *(RA-4, done)* — measured live: critic = 26% of calls / 14.7% of tokens (corroborating the prod ~15%), 74% of verdicts `ok`, and the narrate half provably inert (it cannot act on a `major` at all, and the run produced zero `minor`s). Default is now `narrate-gated` per SL-3: decide critic unconditional, narrate critic gated. Framing correction: the critic was never in classify, and it was never the cost centre either — `pipeline-decide` is ~44% of tokens. An agent-player run now prints an LLM-cost summary.
- [ ] **Combat terminal polish** *(RA-5, next — see the plan's § Scouting corrections before speccing)* — "critical" not "dead" on a win + no fatal-blow prompt (F#11). B#15's `'Minion'` half is largely already fixed by 0.3.2 C3 (the fallback only fires for a genuinely un-named foe, as designed), so the residual belongs to the decide prompt (v13). Two bugs found while scouting land here instead: the win frame bands enemy condition against the round's opening HP rather than `enemyMaxHp`, and `combatEnemy.name` accepts an empty string.
- [x] **Private embed parity on auto-resolve paths** *(RA-6, done)* — dropped `{ compact: true }` from `SessionController.renderStartResult`, so all four action paths share the full embed; the `[Unreleased]` claim is now true. Numbered RA-6 rather than folded into RA-5 (different seam: auto-resolve reply paths, not combat rendering).

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
- [ ] **C3 residual — LLM-authored/spawn_npc NPCs have NULL health** *(deferred 0.3.2)*: `seedNpcs` now writes `health` (migration `202607112100_npc_combat_health.ts`), but LLM-authored and `spawn_npc` NPCs still get NULL health. `deriveEnemyMaxHp(DC)` is the fallback. Giving `add_npc` a `health` field means the decision prompt needs a `health` vocab slot → v13 prompt-versioning.

[ ] In-app: start a real combat against a named NPC (e.g. Shadow Stag). Verify the continue card shows the NPC's real name (C3).,
[~] In-app: bail out of a fight mid-way, then re-engage. The opening frame must show banded condition, not ?/? (C4).,
  ROOT CAUSE (fix/combat-reengage-foe, commit 3bd266d): bail resolves the action and clears
  last_action_state, so "/action resume fight" is a FRESH start, not a resume. Its DECIDE step
  names no foe on vague text, and the opener only sourced the name/condition from that hint. Fixed:
  the opener now reads name+condition from the persisted in_combat edge (anchor-guarded). Re-verify
  in-app. Persistence is NOT duplicated on same-location re-engage (set_relation upserts; the bailed
  edge is read back and continued in place).
  Two follow-ups left OUT of this fix (separate items below).
- [ ] **C4 follow-up — abandoned (not bailed) mid-round combat shows no opening frame on resume**: a genuinely unfinished multi-round fight leaves last_action_state set; `/action` then hits the resume branch (`action.ts:162`), which calls `buildDecisionMessage` without `actionType`, so no opening frame renders at all (and `decisionIdx > 0` would gate it out anyway). Latent, not the reported symptom. Needs `resumeAction`/`ActionResumeResult` to carry actionType + remembered foe and the render gate to allow a combat opener on resume.
- [ ] **C4 follow-up — in_combat edge duplication on anchor change**: `set_relation`'s UNIQUE key includes the anchor (`to_type,to_ref`), so a re-engage that resolves to a *different* anchor than the bailed edge creates a second `in_combat` edge; `readCombatState` then picks whichever the DB returns first. Harmless for same-anchor re-engage (the common path). Needs an edge-lifecycle sweep, not part of the C4 symptom fix.
[y] In-app: fight to last-stand. The desperate-choice screen must show the contested-roll readout + banded condition (C5).,
[y?] In-app: land the killing blow. The outcome must show the combat opening frame + terminal card (P2), not a bare location scene.,
[y] In-app: verify the /action 'last action' hint fires only on the genuine last roll (Saturday = 4th, weekday = 3rd). (N3 verified by tests; sanity-check.),
[y] In-app: cross a frontier to a new location. Verify the description resolves (not perpetual placeholder) within ~15s. (N2),
[ ] In-app: on a Saturday, verify the threat NPC is at its announced location on /look and stays there (doesn't wander off). (N1),
[y] In-app: on the unfinished-action screen (/hi), verify the free-text 'or type action <what you do>' line is gone. (N5)

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

> The `ANSI frame polish — T2 live-check follow-up` block (SGR/palette/glyph facts, renderer standardisation off black `chrome` + palette module, decouple render from engine, per-round combat maths visibility, the combat-frame redesign, and opening frames for all seven types + art-post/reply delivery) is **done — shipped in `0.3.1`**. Build plan archived → `docs/archived/poc-plus/poc-plus-0.3.1-polish-plan.md`; state cross-referenced in [[action-features-tracker]]. What remains:

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

1. ~~Finish Stage 5~~ **Done** (`72fb32d`, POC+ stage 1 T0a) — the T7 dead-code sweep landed: legacy machine, PROMPT_VERSION + stamp sites, critic dual-injection, and the current_source.md test are gone; the 2026-07-08 prod QA session stood in as the smoke gate.
2. Then the v13 roadmap (docs/engine/prompt-v13-roadmap.md), which gives an explicit suggested order:
    1. ~~F#21 — divine intervention rework~~ **Done** (`4c51334`, POC+ stage 1 T0b) — the fallback refunds the roll, authors no mutations, and reads as ⚠️ System.
    2. D3/D4 — conversation & puzzle shapes + the free-text security stack: the biggest unspecced chunk; can be specced immediately since the relationship edges are already live. Needs a stage-N-style build plan before implementation.
    3. (after a few live weeks of telemetry) Prose-critic trigger decision from the CombatBeatLog data, recorded as a decisions/ doc.
    4. Stage 4 — Thread B world scaling: also wants live curves before tuning; the scale seam sits at 1.

### Player requests — prod data review (2026-07-08)

Fresh reports from a single QA session (snapshot `warden-20260708-201456`, character BendiusOver — mostly a combat playtest). `F#`/`B#` cite the `feedback`/`bug_reports` row. Cross-refs to existing items noted inline; where an item just re-surfaces a known one, treat this as a fresh datapoint rather than a new task.

**Feedback / feature asks**

- [ ] **NPC coherency — mint on first sight** — narrative said the player sees a caravan, then said they don't; the NPC wasn't persisted to state on first mention (F#1). Mint NPCs immediately so they persist. See [[mvp+npc-economy]], [[mvp-data-model]] (world-state tracking).
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
- [x] ~~**`CharacterRepository.update` allow-list omits `max_stamina`**~~ → **Fixed** (`7513181`, 0.3.1 branch, B#2): added to the allow-list, schema audit found no other gap, the `src/sim/driver.ts` raw-SQL workaround dropped.
- [ ] **schema: normalise location references to FK ids** — locations are keyed by `name` (TEXT) everywhere (`player_characters.location`, `npcs.location`, `location_edges`, `actions.location_name`). `actions.location_name` is a deliberate point-in-time *snapshot* (keep it), but a future polish pass should decide whether the live-reference tables move to `location_id` FKs consistently — a holistic refactor, not a lone divergence. See [[per-player-map-exploration]] §6.
- [ ] use reactions as a way of buffering input before a button is pressed (expend items or use certain abilities to amplify actions, also works for trades)
  `this is cool!!!`
  (but does it work with ephemeral..?)
- [ ] stealth or following mechanics?
- [ ] mechanic — bonus rolls: an LLM `modify_rolls_remaining: +N` reward is a deliberate mechanic, not a bug (the "extra throw" report traces to this; no deterministic double-decrement exists — a roll is spent exactly once per action in startAction). Design it properly: when/why the world grants an extra roll, and surface it to the player so it reads as a reward. Belongs to the roll-economy work in [[mvp-llm-prompt-architecture]]. **Re-verified for 0.3.2 (N4):** the "why am I getting inspiration multiple times a day?" report against 0.3.1 (after the B#3 clobber fix) is the same working-as-designed mechanic — each `modify_rolls_remaining: +N` grant nets against exactly one drain per action (`startActionPipeline` drains once at `WorldEngineImpl.ts:961/1012`; the grant applies to the drained row so it stacks, never clobbers). Proven by `tests/engine/world-engine-impl.test.ts:326` (grant path nets to delta 0, rolls unchanged) and `:358` (no-grant path drains exactly −1). Closes as WAD; the open UX work above (surface the grant as a named reward) remains the only follow-up. No code change.
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
