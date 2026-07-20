
HANDOVER (M3 DONE → M4). Parent spec docs/engine/layer-boundaries-and-json-seam.md; stage plan docs/engine/json-seam-build-plans.md (M4 section). Branch feat/m3-controller-extraction, last commit 5acde89. M3.0–M3.7 ALL DONE: the SessionController (src/controller/SessionController.ts, never imports discord.js) owns every ported flow — feedback/bug submits, action:choice/bail (engine.resolvePendingChoice killed the pendingDecisions map + getChoiceLabel + setPendingDecision + handleActionChoice + applyActionResult), the day-job menu (nav:action + slash /action via composeActionMenu/MenuViewState), the day-job work flow (action:dayjob: via beginDayJob/commuteForWork/runWork), the custom-action modal submit (action:custom:modal via beginCustomAction/runCustomAction + shared renderStartResult), and the slash/nav guards (needsCharacterGate + stampLastPlayed). The dispatcher is now transport + paint only (residual engine reads = getCharacter for nav-button payloads + getMeta for broadcast routing); join: stays adapter-delegation. View-states live in src/view/viewState.ts (Decision/Outcome/Notice/Menu/Loading/Commute); medium step src/discord/viewToDiscord.ts (*ViewToDiscord); discord.js-free view-builders src/view/actionViewState.ts; day-job domain src/controller/dayJob.ts. Baseline: typecheck clean, 82 files / 1519 tests green, ZERO snapshot churn. NEXT: (a) merge feat/m3-controller-extraction → dev (releasing skill; CHANGELOG [Unreleased] already carries the M3 entry), then (b) M4 — agent-player adapter: a second, non-Discord adapter that drives SessionController and consumes the same ViewState DTOs, proving the seam. Read the M4 section of the stage plan first; RECONCILE (checkboxes vs git log, tests green) before building. Established seam (reuse it): adapter extracts transport → controller returns a ViewState (+ semantic facts for broadcast/announceCollapse) → adapter paints. Use orchestrated-delegation (lead specs + verifies + commits between slices; delegate-executor implements to spec; delegate-reviewer adversarially checks behavioural slices; delegate-fixer applies accepted findings). NEVER commit/push/checkout main or dev.

# TODO

## scratchpad (humans start here)

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
