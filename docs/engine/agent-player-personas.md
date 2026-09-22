---
title: Agent-Player Personas: the playtest panel
status: decided
domain: engine
phase: mvp+
tags: [playtest, agent-player, qa, personas, review, harness, retention, engagement]
related:
  - "[[layer-boundaries-and-json-seam]]"
  - "[[roll-economy-timeouts-and-world-growth]]"
  - "[[json-seam-protocol]]"
  - "[[player-action-patterns]]"
  - "[[pitch-and-pillars]]"
  - "[[mvp-progression]]"
  - "[[poc-plus-roadmap]]"
  - "[[prompt-v13-roadmap]]"
---
_The agent-player harness (`src/agent/`, the DA-5 opt-in QA adapter) gets a persona layer: ten player-type presets that roleplay a gamer with real wants, see the screens a real player sees, and judge the run against the game's own long-horizon promise rather than one day's fun. Reviews split **engagement** from **fulfilment**, tag friction by recurrence, and track a per-day series so decay is visible._

---

The existing expert critic stays as the design voice; the personas are the player voice. This is the follow-up to #93. That task proved the point with a blunt switch, `AGENT_FORCE_FREE_ACTIONS`, and its own baseline (see the snapshot below) showed both that free-text play reads qualitatively better and that forcing it only reaches one menu a day. The persona layer replaces the switch with motivation.

---

## The benchmark

- [!] **The core goal is to stay engaging and fulfilling over a long time.** [[pitch-and-pillars]] is explicit that this is a year-long ritual: a game about memory, about the spaces between, where the world advances whether you show up or not and names get carved into bark. [[mvp-progression]] lays out the arc a player is meant to live through: ordinary life and the crack (weeks 0-2), paths crossing (2-3), the fellowship (3+), deepening bonds (month 2), the herald (month 6), final preparation (month 11), the December climax, the wipe. So agent-player feedback is worthless if it only answers "was today fun". It has to answer whether a _person_ would still be here in month three.

Two currencies, and they are not the same thing:

| Currency | Question | Failure mode it detects |
| --- | --- | --- |
| **Engagement** | Did I want to play today, and would I come back tomorrow? | Boredom, friction, unclear payoff |
| **Fulfilment** | Am I building something that would matter to me if I stopped? | A game that is fun but disposable |

A session can be engaging and unfulfilling (a good grind with nothing to remember) and that is precisely the failure this game cannot afford.

Every persona review must therefore answer three questions, and the panel report is built around them:

1. **Would I come back tomorrow?** (engagement)
2. **Is there something I am building that I would miss if I stopped?** (fulfilment: a thread, a project, a person, a reason)
3. **What would make me quit, and how soon?** (churn trigger and horizon: day, week, month)

- [I] The third question is the one the repo has never been able to ask a player. [[player-action-patterns]] found two of five testers churned inside a week and called retention the live risk, but the only retention evidence is absence from a table. A persona that names what would stop it is a churn model, not a hunch.

### The rubric

Free-form reviews cannot be compared across personas or tracked across months, and the whole point is to compare feedback against one idea. So each review also scores five named criteria, each lifted from a pillar the game already claims:

| Criterion | Pillars it tests | Currency | Question the persona answers |
| --- | --- | --- | --- |
| **Ritual pull** | mud, maplestory, frieren | engagement | Was today's one visit worth it, and is tomorrow's? |
| **Visible stakes** | dnd, castlevania | engagement | Were the dice and the danger legible, and worth caring about? |
| **Something to build** | frieren, lotr | fulfilment | Is there a thread, project or bond in progress that I would miss? |
| **Aliveness** | mud, lotr | fulfilment | Did the world feel like it moves without me, and did that make showing up matter? |
| **Memory** | the pitch's thesis, frieren | fulfilment | Would anything I did survive being forgotten, by me or by the world? |

Scored 1-5 (1 = absent, 3 = present but thin, 5 = the pillar delivered), or marked `unobserved`.

The original ask named this criterion **Company** ("did I feel one of many, or alone in a text"), and the harness cannot answer that: a run has one player in it, so there is nobody to be one of. It is kept, renamed and narrowed to the world's independence from the player, which the instrument _can_ see: NPCs at their posts and wandering, the tick having moved the world on without you, an absence that cost something. Real co-play is a harness capability that does not exist yet, and it sits in Risks as deferred rather than silently inflating this criterion's score.

- [!] **A run may not score what it could not have seen.** A one-day breadth run cannot honestly rate _Aliveness_ or _Memory_: convergence is a week-3 event by design ([[mvp-progression]]). So a criterion the session had no chance to exercise is marked `unobserved` and excluded from the panel mean, rather than scored low. Without this rule the breadth panel manufactures false negatives on exactly the criteria the game is built around, and the rubric would read as a damning verdict on day one. The panel report carries per-criterion **coverage** alongside the means.

---

## Instrument limits

What the harness cannot see, stated once so that no criterion and no panel shape is read as a verdict it cannot deliver. The rubric above cites these, and the build plan assumes them.

- **One player per world.** A run boots a fresh `:memory:` DB and creates exactly one character (a per-session `agent:play-<timestamp>` id, or `AGENT_BRAIN_CHOOSES_CHAR=1` for a brain-authored one). Nothing in a run is co-play, so "one of many" can only be read off the seeded NPC cast, which the engine walks on a timer of its own.
- **Bounded hand-written content.** The world is eleven locations (`assets/world/locations.yml` + `edges.yml`) and eight seeded NPCs (`seedNpcs`, `src/db/migrate.ts`), plus whatever the action pipeline mints in-run. Content-exhaustion questions hit that ceiling on day one and belong to the arc panel, not to a breadth run.
- **No cross-process continuation.** The engine's DB is `:memory:`, so an arc is one process with `AGENT_DAYS=n`. `AGENT_INHERIT=1` plus `AGENT_USER_ID` looks like continuation and is not: the previous process's world is gone, no character is found, and the run exits 1 on the `no-character` guard. A panel of ten personas is therefore ten processes and ten review files, aggregated offline.
- **The world clock is pinned for multi-day runs, and it is only the clock.** The nightly tick and `hiScreen` read `new Date()` for the Saturday bonus, the five-day absence nudge and the weekend greeting, so a fast multi-day run used to stay on whatever weekday the process happened to start. `pinAdvancingClock` (`src/agent/clock.ts`, driven by `AGENT_START_DATE`) now pins `new Date()` and `Date.now()` to the run's start instant, and the harness steps it forward **one calendar day immediately before each nightly tick**, so an `AGENT_DAYS=n` run crosses real weekdays and the absence consequences and the Saturday bonus actually fire. It covers those two read forms and nothing else: statics like `Date.parse`, an explicitly-argumented `new Date(x)`, timers and intervals are all untouched, so it is not a general fake-timer. Replay steps its clock one day per tick marker the same way. What that discharges is the **tick's** calendar-dependent behaviour, which is UTC on both sides (`getUTCDay() === 6`, `WorldEngineImpl.ts`), so the Saturday bonus and the absence nudge reproduce rather than accidentally match. What it does not discharge is any text that reads a **local** weekday: the greeting goes through `isWeekend()` (`src/controller/hiScreen.ts`), which is `new Date().getDay()` on the host's timezone, and a pin fixes the instant rather than the host's offset from it, so the same instant can render the weekend greeting on one host and the weekday greeting on another. That is why a panel's `AGENT_START_DATE` must be a noon-UTC instant (`.pi/skills/agent-smoke/SKILL.md`), and why replay of a multi-day recording is byte-green only on a host whose local weekday matches the recording's.
- **The boot differs between environments.** `migrate()` skips the world and NPC seeders under `VITEST` (`src/db/migrate.ts`), which is why `establishBootParity` exists. A scripted or in-process panel that does not go through boot parity plays an empty world.

## Baseline: the 2026-09-13 snapshot

Four live runs on `dev` at `9ecb306`, taken to ask whether enforcing free-text actions makes the harness play more like a player. ~535k tokens and 146 LLM calls, no crashes, no invariant breaches. Every number below is a thing this rework has to move.

The numbers came from `temp-agent-player-before.md`, a scratch note that was never committed and has since been deleted; it said of itself that it was "not for landing; delete when the comparison is done". So the recipe lives here:

```
set -a && . ./.env && set +a
AGENT_FORCE_FREE_ACTIONS=1 AGENT_DAYS=1 AGENT_OUT=/tmp/oak-smoke/<id>.json npm run agent:play
```

Forced means `AGENT_FORCE_FREE_ACTIONS=1`; unforced is the same command without it. The runs are not byte-reproducible (a live brain, a live action pipeline and a real d20), so read the table as one sample of a stochastic instrument rather than as a fixture. The note's own artefacts sat under `/tmp/oak-smoke/` and are ephemeral.

| Run | Days | Forced | Free actions | Turns / outcomes | Dead-ends | Findings | Day end |
| --- | --- | --- | --- | --- | --- | --- | --- |
| forced-a | 1 | yes | 1 | 12 / 4 | 0 | clean | `no-rolls` |
| forced-b | 1 | yes | 1 | 10 / 4 | 0 | clean | `no-rolls` |
| forced-c | 2 | yes | 2 | 18 / 5 | 5 | 1 warn | day 1 `no-rolls`, day 2 **`stalled`** |
| baseline | 1 | no | 0 | 10 / 4 | 0 | clean | `no-rolls` |

### What it established

- [I] **Free-text play is qualitatively different, and the difference is in the _description_.** Forced runs opened on authored actions ("Ask the duty sergeant for a patrol assignment along the town walls") and produced named threads: the Oath/Recruit beat, the Warden's charge about the Shrine of the First Flame, the Confiscated Strongbox. The unforced baseline never touched the free-text slot, opened on the "Stand the gate" button, and its critic's headline complaint was that the menu re-offered the identical three tasks after every action. Put plainly in the note: **forced-arm critics describe scenes; the baseline critic describes buttons.** So the quality of the playtest signal tracks the richness of the move surface, which is the whole argument for B and C.

- [I] **Enforcement is a blunt instrument.** It fires on **one menu per day**; once the debt is paid the brain reverts to day-job buttons for the rest of the day, reading player-like at the opening and like a menu-driver after. Two of three forced days also closed on two consecutive bails, exactly like the baseline.

- [!] **The brain cannot learn from a dead-end.** `forced-c` day 2 picked the same rejected option five times in a row until `STUCK_LIMIT` ended the day `stalled`. No memory of a rejection is carried into the next turn, so the identical menu comes back and the identical pick follows. This is the amnesia gap above, demonstrated live, and it is why the day-log in B is not a nicety.

- [!] **The day-job menu is not location-aware.** At The East Road the menu still offered town jobs, each rejected as unsafe ground, while `sleep` was the only offered move that actually leaves. Enforcement makes this much easier to hit, because a free action can travel you somewhere the work menu then cannot be used.

### Success criteria for this rework

| Baseline behaviour | Target | Read from | Status after the 2026-09-14/15 panels |
| --- | --- | --- | --- |
| The free-text slot used zero times in an unforced run | Personas whose priors reach for it use it unprompted, and the Grinder still works. The histogram differs **by persona**, which is the test that personas are real | Verb histogram, G | **Met on the smoke, Grinder arm unread.** 0% in the baseline becomes 8% for the unset control and 22% (Soldier) / 33% (Explorer) for the personas whose priors reach for it, while the Homesteader stays on buttons at 0%; the arc panel holds the same divide (32.2% / 24.1% / 4.0% / 0.0%). The Grinder ran the arc, not the smoke, so "the Grinder still works" is unread |
| Play opens as a scene, then reverts to buttons | The scene-quality divide closes for the personas who want it, without a forcing switch | Reviewer prose + histogram | **Unmeasured.** The reach is real (a third of the Explorer's arc moves are free text, a quarter of the Soldier's), but nobody has scored the critic and persona prose for scenes-versus-buttons the way the baseline snapshot did |
| A rejected move repeats until the day stalls | No rejected move is repeated within a day | Dead-end count per run; the day-log in B | **Partly.** The day log ships and carries rejections, which is the mechanism the target is read from, and no day in either panel ended `stalled` or `crashed` after the retry fix; the per-run dead-end counts have not been scored against the target |
| One voice, one verdict | Ten voices, each with a rubric and a churn horizon | Panel report, H | **Mechanically produced.** Ten persona fragments exist and their `arcNote`/`quitTrigger` distinctiveness is pinned by test, and four of them voiced the arc panel with their own rubric scores and `quitHorizon`; the ten-voice panel itself has not been paid for |

- [I] `AGENT_FORCE_FREE_ACTIONS` stays as a diagnostic, but it stops being _the way_ the harness reaches free-action play. Persona priors are the principled replacement: the Homesteader and the Soldier reach for the custom slot because of who they are, not because a debt is owed.

- [>] The snapshot's own product findings route to the board, not into this spec: the doubled article in the unsafe-ground copy is #141, the location-blind work menu is #134, and the inconsistent bail dice display — the worked example of recurrence below — is #153. This document owns the harness.

---

## Panel evidence: the 2026-09-14 and 2026-09-15 runs

Live DeepSeek on the persona stack: the breadth smoke against layer 2 (#127, the review and the aggregator), the arc panel against layer 3 (#128, the Homesteader's run repeated after that layer's retry fix, whose first attempt is the day-3 crash the fix was written for). Same caveat as the baseline: a live brain, a live action pipeline and a real d20, so read these as one sample of a stochastic instrument and not as a fixture. The artefacts sat under `/tmp/agent-panel/` and were not retained, so the tables below are the whole record; re-running the breadth smoke is how to re-derive them against a later build.

### The breadth smoke (2026-09-14, one day each)

Three personas plus the `AGENT_PERSONA`-unset control the panel is read against. Move kinds come from each transcript's `turn` events; free-text share is `custom` over all moves.

| Run | menu-pick | custom | choice | bail | recon | free-text | Day end | Day note | Error findings |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| explorer | 0 | 4 | 6 | 1 | 1 | 33% | `no-rolls` | 1 | 0 |
| soldier | 1 | 2 | 6 | 0 | 0 | 22% | `no-rolls` | 1 | 0 |
| homesteader | 4 | 0 | 4 | 2 | 0 | 0% | `no-rolls` | 1 | 0 |
| control (no persona) | 3 | 1 | 7 | 1 | 0 | 8% | `no-rolls` | 1 | 0 |

All four ended `no-rolls` and all four still captured a day note, which is the path that used to lose the rating, and there were zero error findings. The histogram moves the way the priors predict: the Explorer, whose priors name look/map/travel/search, reaches for both free text and recon, while the Homesteader stays on buttons. That is the acceptance test of § A passing on real data. The panel over the three reviews reports `aliveness` and `memory` at coverage 0/3 as gaps rather than scoring them low, and all three personas could name something they were building.

### The arc panel (2026-09-15 to 2026-09-19, four personas × five days)

20 persona-days, 678 LLM calls, ~3.1M tokens, `AGENT_START_DATE=2026-09-15T12:00:00Z` so the arc runs Tuesday to Saturday.

| Persona | Free-text share | Recon | Fulfilment series (days 1-5) | Dead-ends | Error findings |
| --- | --- | --- | --- | --- | --- |
| explorer | 32.2% | 5 | 3, 3, 2, 3, 4 | 1 | 0 |
| soldier | 24.1% | 1 | 3, 3, 3, 4, 4 | 0 | 0 |
| homesteader | 4.0% | 0 | 3, 3, 3, 3, 3 | 0 | 0 |
| grinder | 0.0% | 0 | 3, 3, 3, 3, 3 | 0 | 0 |

Rubric coverage (how many of the four could honestly score each criterion): `ritualPull` 4/4, `visibleStakes` 4/4, `somethingToBuild` 4/4, `aliveness` 2/4, `memory` 2/4. All four named something they were building; none answered `building: "nothing"`. All 20 days closed `no-rolls` or `slept`, and the Saturday bonus roll fired on day 5 in every run (the greeting reads `🎲 4` where every earlier day reads `🎲 3`).

Three readings the panel exists to produce, and all three are bad news for the game rather than the harness:

- **Fulfilment flat-lines.** It sits at 3 for all five days for the Grinder and the Homesteader, while engagement holds at 3-5: the engaging-but-unfulfilling failure the benchmark names. The arc note repeats verbatim in mid-arc as well, the Grinder's days 2 to 4 being the same sentence and the Homesteader's days 2-3 and 4-5 repeating in pairs.
- **The work menu being location- and thread-blind is the top theme, and every persona raised it in its own words** (the Explorer mid-scout on the East Road, the Soldier over a live strongbox thread on the day's last roll, the Grinder re-offered an unchanged lockup job, the Homesteader funnelled from the weekend screen back to gate work), corroborated by the engine's own `travel-gate` and `set_location` warnings in the same transcripts. The panel's phrase clustering is lexical and deliberately conservative (Dice similarity over content tokens, threshold 0.4, chosen because a wrongly merged theme hides a finding while a split one only under-ranks it), so it collapses the four reports that share the "0 rolls remaining" vocabulary into one 3-persona theme worth 104, and the Explorer's four wordings into one 1-persona theme worth 104, while the Homesteader's wording of the same defect ("offered gate options after my rolls were spent") shares no content word with them and stays separate at 26. The ranking therefore still understates a defect all four personas hit. Closing that needs a controlled category vocabulary on the friction report rather than a lexical measure, which is a follow-up rather than a threshold to tune. Every friction in the arc was tagged `periodic` and none `ritual`, which is itself a reading: a defect met every day is being weighted as fortnightly.
- **The free-text slot is now used unprompted** at 32.2% / 24.1% / 4.0% / 0.0% by persona, the Grinder reaching for it not at all. That is the histogram differing by persona, which is § A's test.

Two things the panels still cannot measure, stated so no reader infers them from the tables: **co-play** (every run holds one player, so Aliveness stays a reading of the world's independence from the player, not of company) and **the year the pitch is about** (five days is not month three; the flat lines above are the earliest sign of the failure the year would settle, not the verdict on it). The interrupted shape's machinery is built (`AGENT_SKIP_DAYS`) and has not been run live.

---

## Why now

Two structural gaps cap what the harness can tell us today, and neither is a prompt problem.

- [!] **The brain is blind.** `ask()` (`harness.ts`) hands it the current screen, the legal `MOVES`, and a one-line digest (`name/class/hp/stamina/rolls/wealth/location`). Nothing else. `/map`, `/journal`, `/backpack`, `/stats`, `/look` and `/help` already cross the seam as `screen.*` events and route fine (`router.ts`), but their views are **never shown to the brain**. The day-start beats dispatch `hi.open` + `screen.stats` and the look-after-outcome beat dispatches `screen.look`, yet all three land in the transcript, not the context. An explorer persona that "walks the map" cannot see the map.

- [!] **The brain is amnesiac.** Every turn is stateless. No yesterday, no goal, no thread being chased. Fulfilment is by definition a cross-day property, so a brain with no memory cannot even perceive the thing we are trying to measure. Persona consistency across a day, let alone across weeks, is impossible without a running intent.

- [I] The repo already has the scar: the pre-persona finding that the realism arm did not fix move variety, where the a/b brains still funnelled into `menu-pick 0` — superseded, because the panel has since produced the reading it asked for (a verb histogram that differs by persona). Personas layered onto today's surface produce _flavoured funnel_, not new behaviour. Widening the information and move surfaces is the actual level-up; the persona prompt is what makes the widened surface pay off.

- [I] **Second-order win: the RA-2 dial becomes observable.** `stripWorkInspiration` strips inspiration from `kind: 'work'` actions by design, so a work-dominated run measures a structural 0% and the harness "structurally cannot check" RA-2. Explorer, Socialite and Storyteller personas reach for the free-text `custom` slot by character, and those are exactly the non-work actions inspiration can land on. A panel is the first realistic route to a measured grant rate.

---

## Settled decisions

| Decision | Choice |
| --- | --- |
| Review structure | Keep the expert critic **and** add a per-persona review panel. Two artifacts, two audiences. |
| Scope of the first cut | Full: information surface + recon moves + personas + handbook + friction capture + reviews. |
| Roster | All ten personas. |
| Review output | Human-readable on stderr, machine-readable at `<AGENT_OUT>.reviews.json`, aggregated offline by `agent:panel`. |
| Review lens | Benchmarked against the long-arc promise above, not against a single session's fun. |
| Benchmark form | A named rubric derived from the pillars, scored per persona, **plus** the free-form review. |
| Panel sequencing | The three-persona smoke, then the arc run (the only shape that answers the core goal), then the ten-persona breadth run, then the interrupted shape. |

---

## Design

### A. The persona model

A persona is a versioned prompt fragment plus a small behavioural brief. It carries three things and nothing more:

- **Voice**: how its review reads, what it notices, what it complains about.
- **Priors**: which verb families it favours, risk appetite, how long it plays before `/sleep`, what it does when a thread stalls.
- **Want and quit condition**: the single thing it is here for, and the thing that will make it leave.

The persona does **not** get a mechanical vote-weighting in the harness. A persona that mechanically biases the picker is not a player, it is a rig. Behaviour changes come from (a) the recon moves existing, (b) the priors, (c) the intent note anchoring across turns.

- [!] **Personas must be verifiable, not theatre.** The panel report carries a per-persona **verb histogram** (which move kinds and action verbs it actually took) and its three-question answers. If the Soldier's histogram does not skew combat and the Homesteader's does not skew rest and gather, the persona is decoration and the prompt needs work. This is the acceptance test for the whole layer.

Two cheap second checks ride with it, because a histogram can skew by accident of prompt wording: the ten personas' `arcNote` lines and their `quitTrigger` lines must actually differ. A persona that cannot name a _different_ thing it is building is decoration whatever its verb counts say.

### B. Information surface

What the brain sees each turn grows from "this screen" to "this screen plus the context a player carries":

- **Recap block** at day start: yesterday's outcome lines in order, the day's ending disposition, its own intent note, and its own `arcNote` (see E) so it can feel a plan survive across days.
- **Day log** (today's, not yesterday's): the actions already attempted today and what they returned, **rejections and dead-ends included**. This is the fix for the baseline's five-identical-picks stall: a brain that just had an option refused must be told it was refused, or it picks it again. Cheap to carry, and it is the difference between a persona that adapts and one that wedges.
- **Intent note**: one short line the brain rewrites when its plan changes ("heading north for the archive, stamina low, no rolls left"). Persisted across turns and days.
- **Arc note**: one short line naming what it is building ("the temple; three consecrations left"). This is the handle on fulfilment: if the brain cannot name an arc, the game has not given it one, and that is a finding in itself.
- **Recon text on demand**: the rendered `/look`, `/map`, `/stats`, `/backpack`, `/journal`, `/help` screens, delivered when the brain asks for them (see C). Free, deterministic, no roll, no day advance.

Keep these blocks small and structured. The point is a player's working memory, not a data dump: the transcript already holds everything for the critic.

### C. Move surface

`RECON` joins the move vocabulary alongside `menu-pick` / `choice` / `custom` / `bail` / `sleep`.

```ts
| { kind: 'recon'; screen: 'look' | 'map' | 'stats' | 'backpack' | 'journal' | 'help' }
```

- Offered on the menu screen only. A real player can run `/map` at any moment (the router's `screen.*` branches carry no pending-action gate; only the _button_ is absent mid-decision), so this is deliberate narrowing rather than parity: it keeps a decision beat about the decision. If a persona's churn trigger turns out to be "I could not look something up when it mattered", widen it.
- Dispatched through the existing `screen.*` events, rendered with `viewToText`, recorded as a transcript `recon` event, fed back as the next turn's context.
- Costs no roll and does not advance the day, but it **is** a turn: the brain sees the result and picks again. A player who stares at the map has spent a moment, not a roll.
- Capped twice: per screen (a small constant, e.g. 2) and per day in total (e.g. 6), because a day's shape is read in turns and twelve free recon turns would distort the per-day ratings. Hitting either cap withholds that screen rather than crashing, and logs a warning finding.
- Replay must learn about it. `recon` is a new legal move kind, so `src/agent/replay.ts`'s DC-S5 choice-fidelity checks (`isLegal` / `menuLegalMoves` / `decisionLegalMoves`) and its chrome carve-out need the treatment the scripted beats got, and the transcript union gains a `recon` event. Replay is the repo's drift net; it appears in T1 and T9 for that reason.

### D. The handbook

A `handbook.md` fragment in the brain's system prompt: what a first-time player needs to know.

Covers the command list (`/join`, `/hi`, `/action`, `/sleep`, `/look`, `/map`, `/stats`, `/backpack`, `/journal`, `/help`), the `/join` wizard (seven steps plus the confirm screen), the roll economy (three rolls a day, `SATURDAY_BONUS_ROLLS = 1` on Saturdays, no-roll deterministic screens, `/sleep` to end the day), the emoji signal vocabulary, and the interaction model (most moves are buttons; the free-text `/action` slot is the exception, and it is the one the personas are meant to reach for). It also states the **shape of the game's promise**: a day is a ritual, the world advances without you, the arc runs to December.

- [!] **Do not transcribe the two infographics in `docs/assets/`** (`core-loop.png` and `character-creation.png`). They are LLM-authored NotebookLM posters, and at least one claim is already wrong: `core-loop.png` states "2 Rolls Per Day" (and "Rolls: 0/2") while the engine is `DAILY_ROLL_ALLOWANCE = 3`, plus `SATURDAY_BONUS_ROLLS = 1` on Saturdays (`WorldEngineImpl.ts`). [[pitch-and-pillars]] said "two rolls" too and so did the in-game `/help` copy, which also called `/join` a 6-step wizard when the wizard's own footer counts seven, so the stale figures had reached the one source this handbook is told to trust. Both copies are now corrected (the pitch and `/help` in the same change that lands this spec, the wizard length in `/help`), because a tutorial that teaches wrong rules is worse than no tutorial. T2 then adds a test that reads the handbook fragments and asserts every roll figure against those two constants, so the next copy cannot drift.

### E. Feedback, in three layers

One end-of-run review is lossy, and for a long-horizon game it is also the wrong shape: a single verdict cannot show a _decay_. Capture in the moment, track by the day, review the arc.

| Layer | Shape | Cost |
| --- | --- | --- |
| Per-turn friction | Optional `friction` in the brain's existing JSON reply, with a **recurrence** classification (below) | 0 extra calls |
| Per-day note | Folded into the day's last turn (a `sleep` pick when the brain ends the day itself; see the Build log, the note is day-level rather than sleep-level): an engagement rating 1-5, a fulfilment rating 1-5, one line on the day, and the updated `arcNote` | 0 extra calls |
| Arc review | One call at run end, persona-voiced, over the distilled series | 1 call per run |

- [!] **Recurrence is the point.** In a ritual game played daily for a year, the cost of a friction is `severity × how often you meet it`. A once-a-session clunky screen is trivia; a screen you read every single day is a churn driver. So each per-turn friction carries a recurrence tag:

| Tag | Meaning | Weight |
| --- | --- | --- |
| `once` | A one-off, unlikely to repeat | Trivia |
| `periodic` | Hits every few sessions | Watch |
| `ritual` | Hits every day, part of the loop the game demands | Churn risk |

The panel ranks friction by projected exposure over a campaign, not by raw count. This is the single most important measurement difference between testing a session-based game and testing this one.

The baseline gives the rule a worked example. Its second finding is that bail dice read inconsistently: `🎲 1 (refunded)` on one bail and `🎲 0 (-1)` on the next for the same "Step back" move, flagged by three of four critics (#153). That is `periodic` friction at worst for most players, and untagged it would rank alongside trivia. For the **Soldier**, who fights and therefore bails as a habit, it is `ritual`, and it outranks almost anything else in the run. Same defect, different weight, decided by the persona. That is the instrument working.

The per-day rating pair also gives the panel its headline artefact: an **engagement and fulfilment series across days**. A run where engagement holds at 4 while fulfilment slides 4 → 2 has found something a single number cannot express, and it is the shape that predicts churn.

### F. The two voices

| Voice | Runs | Answers | Output |
| --- | --- | --- | --- |
| Expert critic (existing) | 1 per run | Is this well designed? Design gaps, clarity, difficulty fairness | `PlaytestReport`: pacing / clarity / fun / difficulty / summary |
| Persona review (new) | 1 per persona | Did someone _like_ me get engaged and stay fulfilled? | `PersonaReview` below |

```json
{
  "persona": "explorer",
  "rubric": {
    "ritualPull": 4,
    "visibleStakes": 3,
    "somethingToBuild": 2,
    "aliveness": "unobserved",
    "memory": "unobserved"
  },
  "scores": { "engagement": 4, "fulfilment": 3, "clarity": 2, "challenge": 4, "variety": 2 },
  "returnTomorrow": "yes | probably | no",
  "hook": "the one thing that would bring me back",
  "building": "what I am working toward that I would miss if I stopped",
  "quitTrigger": "the specific thing that would stop me playing",
  "quitHorizon": "day 2 | week 2 | month 3 | never on this evidence",
  "engaging": ["..."],
  "boring": ["..."],
  "clunky": ["..."],
  "best": "the single best moment, named",
  "worst": "the single worst moment, named",
  "verdict": "would play again tomorrow | would drift off | would churn",
  "review": "three to six sentences in the persona's own voice"
}
```

`quitHorizon`, `hook` and `building` are the fields the design goal actually needs. A panel where eight personas say `building: "nothing"` is a verdict on the game's long arc, however good the individual days felt.

Two contract notes. `rubric` values are `number | "unobserved"` (1-5, or that exact string), and both the parser and the aggregation must accept each; T9 pins it. And `scores` deliberately repeats three of the critic's dimensions (clarity, challenge, variety) so the panel matrix and the expert report can be read side by side: it is not a second opinion on design quality. The persona's design-adjacent findings are the friction list, not these.

### G. Panel shape and the time axis

Cost makes the honest instrument multi-stage. `AGENT_DAYS` already plays N consecutive days in one process (the harness DB is `:memory:`, so an arc has to be one run; there is no cross-process continuation). Three panel shapes:

- **Breadth panel**: all ten personas, one day each. This is an **onboarding instrument**: first-session clarity, the first-session funnel, and the cheap version of every persona's voice. It cannot speak to the core goal, because on day one there is no memory, no co-play and no content exhaustion, so most of its rubric cells are `unobserved` by construction and its report says so in its own header. A day-one panel is not a verdict on month three.
- **Arc panel**: a subset (the personas whose motivation is longest-lived, e.g. Grinder, Homesteader, Storyteller, Collector) over five to seven days. **This is the retention instrument, and the only shape that speaks to the core goal**: the engagement/fulfilment series, the day the arc note stops growing, and the content-exhaustion readings a breadth run could never take.
- **Interrupted panel**: the Lapsed Returner plays, then the world advances without play for several days, then it resumes. Tests the absence consequence the pitch leans on ("some weeks you disappear entirely, and the world moves on without you, cruelly, indifferently"). `skipDays(n)` must reuse the machinery that already exists: `advanceDays` (`src/sim/time.ts`) for the admin-style tick (a non-admin `tick(false)` no-ops once `last_cron_date` matches today) and `pinClock` (`src/agent/clock.ts`, DC-M10.6) to move the calendar one day per skipped tick. Without the pinned clock the five-day absence nudge and the Saturday bonus read the real date, so nothing this panel exists to measure actually fires.

Before paying for a ten-persona breadth run, smoke the panel machinery with three personas over one day. That exercises the aggregation, the review parsing and the anti-theatre checks for roughly a tenth of the tokens, and the failure it catches (a JSON contract that does not parse) is the one every panel shape would otherwise hit at full price.

### H. Panel aggregation

After all personas report, one aggregation step prints one matrix and writes it beside the reviews:

- **One entry point, `npm run agent:panel <dir>`** (a new `src/agent/panel.ts`, since `play.ts` is one persona per process): it reads the `<AGENT_OUT>.reviews.json` files in that directory and writes `panel.md` plus `panel.json` beside them. A panel is N processes, so the aggregate is an offline reader and never something a single run prints.
- Persona × score (engagement / fulfilment / clarity / challenge / variety), plus verdict and `quitHorizon`.
- **Rubric matrix**: persona × criterion, with per-criterion means and **coverage** (how many personas could honestly score it). Coverage is what stops a day-one panel reading as a verdict on week three.
- **Engagement and fulfilment series** per persona for arc runs, as a text sparkline, so decay is visible at a glance.
- **Top friction themes by exposure**, ranked with the `ritual`-tagged items separated out. A friction raised by one persona is taste; raised by four, or tagged `ritual` by anyone, is a design finding.
- **Fulfilment signal**: how many personas could name something they were `building`, and how many answered `building: "nothing"`.
- Per-persona verb histogram, the anti-theatre check from A, plus the `arcNote` and `quitTrigger` distinctiveness table that rides with it.
- Run cost (the existing `formatLlmCostSummary` already covers this).

---

## Roster

Ten presets. The first four are the asked-for set; the rest come from the loops observed in the prod snapshot ([[player-action-patterns]] records five recurring session shapes) plus the two retention-shaped players, whose whole purpose is the long horizon.

| Persona | Want | Play signature | Long-horizon read |
| --- | --- | --- | --- |
| **Explorer / Adventurer** | clues, places, a thread to pull | look → map → travel → search, chases one thread to its end | does the map keep opening, or run out |
| **Socialite / Diplomat** | people, towns, a bargain | talk, barter, help, gossip, investigate NPCs | do relationships deepen across weeks |
| **Soldier** | danger and glory | scout → approach → fight, seeks unsafe ground | does escalation keep pace with power |
| **Homesteader** | comfort, no risk | rest → fish → cook → eat, ends days at the Oak | does cosy play sustain for months |
| **Grinder / Optimiser** | numbers: XP, wealth, efficiency | highest-expected-value move, repeats the paying verb | where the reward curve flattens |
| **Collector / Completionist** | everything, everywhere | sweeps the map, hoards, closes every thread | how much content actually exists |
| **Storyteller / Lorekeeper** | narrative colour and continuity | unusual in-world actions, follows NPC arcs | does the story remember what I did |
| **Tourist / Newcomer** | to work out what this game is | reads help, tries everything once, gets stuck | the first-session funnel |
| **Casual / Drifter** | a quick fix | hi → one action → sleep | does a two-minute visit still pay |
| **Lapsed Returner** | to catch up after a gap | hi → journal → resume the old thread | re-entry, absence cost, whether coming back is worth it |

Two roster rows ask content questions the breadth shape cannot answer: the Explorer's "does the map keep opening, or run out" and the Collector's "how much content actually exists". Both hit the eleven-location, eight-NPC ceiling on day one, so they are arc-panel readings; on day one those two personas are worth their voice and the chattiness of their priors, not their answer.

- [?] **Farmers split into two deliberately.** The ask named one "farmer who collects XP and goes fishing". Those are two different motivations with different failure modes: the _Grinder_ leaves when the reward curve flattens, the _Homesteader_ leaves when the world stops feeling safe. One persona could not report both.

---

## Versioning and wiring

Both agent prompt families become **set-based** (multiple templates fired together), which the `prompt-versioning` skill already covers. `v1` files freeze in place.

```
assets/prompts/agent-player/v2/{brain.md, handbook.md, personas/*.md}
assets/prompts/agent-critic/v2/{critic.md, persona-review.md}
```

- Stamps become `agent-v2/<persona>` and `agent-critic-v2/<template>`, derived by a small helper, never hand-written.
- `current_source/` directory mirrors replace the single-file `current_source.md` mirrors.
- `AGENT_PERSONA=<name>` selects the persona. Read in `play.ts`, the runner, so the harness library stays env-free (the existing DC-S1 rule that `AGENT_PROTOCOL_BEATS` and `AGENT_FORCE_FREE_ACTIONS` already follow). Unset means no persona fragment at all, which is today's behaviour and the baseline arm a panel is read against.
- Persona identity is stamped on the protocol-log header alongside `brain` and `backend`, so a recorded run is attributable in replay.

Touch points: `AgentPlayerGateway.ts` (`AgentMove` gains `recon`; `ChooseMoveInput` gains recap, recon text, intent and arc note), `agentMoves.ts` (recon legal moves, per-day caps), `harness.ts` (recon dispatch, recap composition, intent and arc persistence, friction capture, the sleep-turn day note, `skipDays`), `ProdAgentPlayerGateway.ts` (user-message sections; `friction`, `dayNote`, `intent` and `arcNote` in the JSON contract), `transcript.ts` (`recon`, `friction`, `day-note` events; persona in the header), `replay.ts` (DC-S5 legality for the new move kind), the two prompt loaders, `panel.ts` (the aggregation entry point), `PlaytestCriticGateway.ts` + `ProdPlaytestCriticGateway.ts` (`PersonaReview` + a `review()` method), `play.ts` (env, reviews file, panel print).

---

## Build plan

- [x] **T1 · surface.** Recon move class, recon dispatch and both caps (per screen, per day), the recon event's DC-S5 legality in `replay.ts`, recap block, the day log (today's attempts, rejections included), intent note, arc note, transcript `recon` event. Brain still on `agent-v1` behaviour; verify by hand that a run can read a map, act on it, and _not_ repeat a refused option.
- [x] **T2 · prompts v2.** Set-based layout for both families, `current_source/` mirrors, derived stamp helper, `v1` frozen. Handbook written from repo sources, stating the seven-step wizard, the interaction model and the year-long promise, plus a test that asserts its roll figures against `DAILY_ROLL_ALLOWANCE` and `SATURDAY_BONUS_ROLLS`.
- [x] **T3 · personas.** The ten `personas/*.md` fragments and the loader; `AGENT_PERSONA` in `play.ts` (unset = no fragment); header stamp.
- [x] **T4 · friction and the day note.** Per-turn `friction` with recurrence tags; the day note folded into the day's last turn (see the Build log; engagement + fulfilment ratings, the line, the `arcNote` update); transcript events.
- [x] **T5 · review.** `PersonaReview` seam with the three benchmark questions and the five-criterion rubric (including the `unobserved` allowance), `persona-review.md`, review gateway, `.reviews.json` output.
- [x] **T6 · panel aggregation, and the smoke.** `src/agent/panel.ts` + `npm run agent:panel <dir>`: the rubric matrix with coverage, the score matrix, the engagement/fulfilment sparkline, exposure-ranked friction, the fulfilment-signal count, verb histograms, and the `arcNote` / `quitTrigger` distinctiveness check. Then the three-persona one-day smoke, which is the gate on everything after it.
- [x] **T7 · the arc panel, then breadth.** The arc panel (a subset over five to seven days) as the first real use, because it is the only shape that speaks to the core goal, then the ten-persona day-1 breadth run scored against the 2026-09-13 baseline's success criteria and labelled an onboarding instrument in its own report. _(The arc panel ran 2026-09-15 to 09-19 and is recorded in § Panel evidence; the ten-persona breadth run has not been paid for.)_
- [x] **T8 · the interrupted panel.** `skipDays(n)` on the harness via `pinAdvancingClock` (its `advanceDays` steps one calendar day per skipped tick), and the absence-then-return path. _(Machinery and unit coverage shipped; no live interrupted run yet.)_
- [x] **T9 · stubs and tests.** Scripted gates stay persona-neutral and offline and go through boot parity; unit tests for recon legality and both caps, the replay legality carve-out, recap shaping, friction recurrence parsing, the split day-note, review parsing (including `unobserved`), sparkline, exposure ranking and the handbook figures. `npm test` still never touches the network.
- [x] **T10 · skill and changelog.** Update `.pi/skills/agent-smoke/SKILL.md` to run panels rather than single runs, with the three shapes and the smoke step; CHANGELOG `[Unreleased]`.

---

## Risks and non-goals

- **Cost.** The 2026-09-13 baseline paid ~535k tokens and 146 calls for four one-day runs, so roughly 130k tokens per run, dominated by the real game pipeline. Measured against the live runs of this rework the figure is higher: one-day runs cost 144k-185k tokens each, and a five-day arc run costs roughly 750k, so ~150k per run-day. A breadth panel of ten personas is therefore nearer 1.6M tokens than the 1.3M first estimated, and an arc panel of four personas over five days is roughly 3M (measured: 3.1M for 678 calls over 20 persona-days). This is the expensive QA instrument in the repo, and the breadth run buys onboarding only. Shape it deliberately, in this order: the three-persona smoke, the arc panel (the only shape that answers the core goal), then the ten-persona breadth run, then the interrupted panel.
- **Context.** The per-day note and the arc note exist to keep long runs tractable: the reviewer reads a two-line-per-day series plus the friction list, not forty screens. Do not push arc runs past a week for a panel.
- **Co-play is out of reach, not out of taste.** Every run holds one player, so "one of many" cannot be measured until the harness can seat synthetic co-players in the same DB (seed N characters, play them or leave them standing). That is a real capability this spec does not include: name it as the dependency behind the narrowed Aliveness criterion rather than letting that criterion stand in for it.
- **Not the in-game feedback path.** Persona reviews land on stderr and in `.reviews.json`, not as `feedback.submit` rows. Keeps agent output out of the player-feedback stream.
- **False negatives from short runs.** The `unobserved` rule in the rubric is load-bearing, not a nicety. Enforce it in the review prompt and in the aggregation, or a breadth panel will report that the game has no aliveness and no memory when it simply had no week three. The Instrument limits section is the list of which criteria that can happen to, and why.
- **Friction is not a bug report.** The transcript's `finding`s are the harness's bug channel; persona friction is a design signal. Keep them apart, exactly as the agent-smoke skill already separates engine anomalies from harness findings.

---

## Build log

Shipped in three stacked branches off `dev` (`feat/agent-panel-1-surface`, `-2-feedback`, `-3-panels`), task by task, with `npx tsc --noEmit`, `npx tsc -p tsconfig.test.json` and `npx vitest run` green before every commit. T1-T10 are done; the readings the panel produced are under § Panel evidence.

Decisions taken during the build, where they diverge from this document or from its task numbering:

- **The day note is day-level, not sleep-level** (this diverges from § E, which folds the note into the `sleep` pick). Reason: a day usually ends because the rolls ran out, and `menu.open` returns `no-rolls` at zero rolls (`SessionController.openActionMenu`), so the brain is never asked again and its last offered turn always has exactly one roll left. Evidence: across the four live five-day arc runs, 18 of the 20 persona-days ended `no-rolls` (the other two ended `slept`) and **all 20 still captured a day note**; the 18 that ended `no-rolls` would each have lost their rating had the note stayed sleep-only, and the arc panel's headline series would have been empty. `ChooseMoveInput.lastRoll` now tells the brain when its last roll is being spent, a note may ride any turn with the last one winning, and a day that closes unrated logs a warning finding. Still zero extra LLM calls.
- **T4 moved into layer 1**, after T2/T3: T2's prompt requests `friction` and `dayNote`, so the parsing had to land in the same change or layer 1 would have asked for fields its own gateway drops.
- **Tests are allocated by module, not by task number**, so each layer carries the tests for what it introduces rather than deferring them all to T9.
- **The clock is pinned for all multi-day runs, not only `skipDays`** (owner decision), so the Saturday bonus roll and the five-day absence nudge actually fire instead of reading the real date.
- **`facts.distilledType` is not the classify vocabulary.** It is the action model's own open-vocabulary label ("one word preferred"), so the panel reports `actionVerbs` as an observed label frequency table and the priors-versus-behaviour comparison runs on move kinds instead.
- **Stale task numbering corrected.** The tests task is T9, so the two inline "T8" references (the replay coverage in § C and the review parsing in § F) now read T9.

Still open, and named here rather than left to be inferred: the interrupted shape has not been run live, the ten-persona breadth panel has not been paid for, and the flat fulfilment series (#137) and blind work menu (#134) in § Panel evidence are product tickets on the board, not harness defects.
