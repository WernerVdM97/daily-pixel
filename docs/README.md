# Docs — Map of Content

The design vault for **The Warden's Oak**. Every doc carries frontmatter; promoted docs graduate from `sparks/` to domain folders.

Read **[CONVENTIONS](./CONVENTIONS.md)** first.

---

🌱 `spark` · 🔭 `exploring` · ✅ `decided` · 🗄️ `shipped` · 🪦 `superseded` · 🚫 `nogo`

---

## 🧭 vision

mission, pillars, north star

| Status | Doc | Summary |
| ------ | --- | ------- |
| ✅ | [Pitch & Pillars](./vision/pitch-and-pillars.md) | Elevator pitch, year-long premise, thematic DNA |
| ✅ | [Hazard Map](./vision/hazard-map.md) | No-gos, rabbit holes, known risks, scope discipline |
| 🔭 | [World & Setting](./vision/world-setting.md) | The Oak, the Threat, emergent map |
| ✅ | [Visual Craft](./vision/visual-craft.md) | Perception, clarity, UX — the visual north star. Monochrome-is-the-asset, colour-as-enhancement, data-card hierarchy, the border intensity/rarity ladder; the `0.3.1` combat-frame redesign as the first worked example. |

## 🎲 game

mechanics, loop, actions

| Status | Doc | Summary |
| ------ | --- | ------- |
| 🔭 | [Player Action Patterns](./game/player-action-patterns.md) | Observed `/action` behaviour from the prod snapshots: session rhythm (morning bursts, 3-11 actions per sitting), the modal 3-beat / 9-call action shape, the LLM-authored intent vocabulary (search as the default verb, class-flavoured faith verbs), five recurring daily loops (resource, temple grind, quest chase, combat day, tourist), and the roll economy as actually spent (63% rolled, DCs 8-14, ~2.5 rolls/day post-RA-2). Grounds balance/pacing work in behaviour rather than intent; refreshed per snapshot. |
| ✅ | [POC+ Roadmap (0.3.x) — the Shared World arc](./game/poc-plus-roadmap.md) | The player-facing engagement arc for the `0.3.x` line, the final POC round before MVP — where [[prompt-v13-roadmap]] makes the game coherent, this makes it sticky. North star: persisted-state multiplayer (shared mutations on shared world state). Items 0–2 and Release A shipped (`0.3.1`–`0.3.3`); the live remainder is stage 2 (nat 1/20 solo reward + broadcast), stage 3 (cross-player buffs) and stage 4 (Saturday shared-boss hunt), with kill credit, buff vocabulary, broadcast stance and frame authorship settled. |
| ✅ | [v12 · World Scaling (Thread B)](./game/prompt-v12-world-scaling.md) | The world sizes to the player (effective strength × week-indexed World Tier) → tougher foes, bigger rewards; no player-side dice buff; the anti-treadmill (Oblivion-style level-scaling) tension, sim-harness-gated. The spec the open stage-4 thread of [[prompt-v13-roadmap]] builds on. |
| 🔭 | [Threat Encounter System](./game/threat-encounter-system.md) | Stochastic encounter gate populating unsafe locations with the Threat's three-tier minion pool, density-scaled by week, with shared threat-persistence across players and asymmetric detection via approach-based gate modifiers. |

## ⚙️ engine

how it runs

| Status | Doc | Summary |
| ------ | --- | ------- |
| ✅ | [Action Engine Framework](./engine/action-engine-framework.md) | The scaling contract for the action engine: a fixed classify → decide → dice → resolve spine with data-driven registries (ActionTypes, Mutations, DMAs) around it, drawn across three ownership zones (dice / engine / LLM) so every seam is explicit. Formalizes structures already in code (`CATEGORY_MUTATION_MAP`, the post-authoring mutation-adjustment pipeline) so future work plugs in without touching the spine. Four Mermaid diagrams: the resolution pipeline, ActionType-as-registry-entry, the mutation vocab by entity, and the scene-state graph shape. |
| 🔭 | [Combat System v12](./engine/combat-system-v12.md) | How the v12 contested-roll combat spine executes inside the pipeline action state machine: the eight DMAs, the state machine with termination ladder, the band table and contested-roll math, and the known grievances (cap-derive fraction bias favouring the higher-max-HP combatant, enemy bonus outpacing player stats, one extra round before cap-derive fires). Two Mermaid diagrams. |
| 🔭 | [ANSI Art Classification & Rendering Framework](./engine/ansi-art-classification-framework.md) | Register taxonomy (14 frames), three-zone ownership model, slot-binding contracts, colour-role vocabulary, fragment DB schema, and renderer assembly pipeline. Five MVP registers (COMBAT_FRAME, COMBAT_CRIT, DATA_CARD, BROADCAST_CARD, DIALOGUE_MODAL); nine deferred to mvp+. |
| 🔭 | [Prompt v13 — post-cutover roadmap](./engine/prompt-v13-roadmap.md) | The open prompt-set threads: stage-4 world scaling (needs its build plan), D3/D4 conversation/puzzle shapes + the free-text security stack, the prose-critic trigger decision from live beat-log data, and the carried cleanups (enforced `allowedMutations`, `distilledType` retirement, per-relType schemas). |
| ✅ | [RESOLVE difficulty signal](./engine/resolve-difficulty-signal.md) | Why RESOLVE receives the difficulty it was already instructed to reward, and why one field would have been wrong: a DC-checked attempt carries its final DC, a fight carries the worded danger tier the combat card already renders, and an auto-resolve carries neither. Two balance residuals logged, both since closed: `dangerTier`'s thresholds predated v13's ladder (fixed, #96), and the card/narration tier matched per round rather than per fight (fixed, #97). |
| ✅ | [POC Build & Deploy](./engine/poc-build-deploy.md) | Local dev, Podman container, DB inspection, LXC Debian production deploy, and systemd auto-deploy setup. |
| 🔭 | [OpenRouter keys and cache observability](./engine/openrouter-keys-and-cache-observability.md) | Who spends on which OpenRouter key (four actors, four keys since #160) and why the host pin added with the route change cannot be verified yet. Records the credential-precedence trap that makes an exported env var useless (`--api-key` beats `auth.json`, which beats the environment), why `--api-key` on a wrapper never reaches the children it spawns and the shadow agent dir that hands them the factory key instead, the `$5`-a-day cap the factory key carries and the `limit_remaining` read that makes a spent cap a skipped tick rather than a 401 storm, and the five `llm_calls` columns that turn "is the pin holding and is the cache warm?" into a query: `provider` is already returned on every response, so unlike the pi-side `cachestat` pattern this needs no id-to-host backfill. |
| ✅ | [Dark Factory](./engine/dark-factory.md) | The continuously-triaging, human-gated agent factory that runs this repo: the GitHub Projects "Dark Factory" board as control plane, the scheduled loops (triage / executor / sweeper / scrumo / meta-oil, plus the Sunday-night memory pair and the bi-weekly librarian) with their topic-scoped memory under `.pi/factory/memory/`, the executor-spawned escalator, and the approval gate (agents only execute Status=`Approved` or an `auto:*` class; merging, releases, and `dev`/`main` stay human). Board seeded from TODO.md 2026-08-03. |
| ✅ | [Dark Factory job ledger](./engine/dark-factory-job-ledger.md) | One board item becomes a tracked job (`.pi/factory/jobs/<item>.json`) whose stages run one per process with their own budgets: build → review → fix → deliver → reconcile → done, with an owner's change-requested review re-entering at revise, a conflicted merge at resolve, and an applied meta-oil proposal adopted from its own branch (three revise cycles at most, 100 minutes total). Moves the gate, the delivery step and the merge reconciliation into code, so a killed run can no longer leave an item `In Progress` with no PR, a second failure blocks and pages instead of retrying silently, and a merged PR closes its own card and issue. |
| ✅ | [Agent-Player Personas](./engine/agent-player-personas.md) | The playtest panel: ten player-type presets (explorer, socialite, soldier, homesteader, grinder, collector, storyteller, tourist, casual, lapsed returner) that roleplay a gamer, see the screens a real player sees (`/map`, `/journal`, `/backpack`, recap, intent and arc notes), get recon moves that cost no roll, and judge the run against the game's own long-horizon promise rather than one day's fun. Reviews split **engagement** from **fulfilment**, tag friction by recurrence (a daily-ritual annoyance is a churn driver, a once-a-run one is trivia), and track a per-day engagement/fulfilment series so decay is visible. Panel runs in three shapes: breadth (all ten, one day), arc (a subset over a week), interrupted (absence, then return). Also the first realistic route to observing the RA-2 inspiration dial, since free-text-preferred personas are what a work-dominated run can never be. |
| ✅ | [Layer Boundaries & the JSON Seam](./engine/layer-boundaries-and-json-seam.md) | Current vs target layering with mermaid, the gap table, and the design questions settled 2026-07-18 (engine-owned session state, semantic view-state + shared renderers, in-process transport). The arc it specced ran M0–M10 and **closed 2026-08-09** — the milestone record lives in `archived/`. Sits above _Discord Interaction Layer_ (that's adapter plumbing; this draws the boundary). |

## 🖥️ ui

discord presentation

| Status | Doc | Summary |
| ------ | --- | ------- |
| 🔭 | [Discord UX](./ui/poc-discord-ux.md) | Mobile constraints, buttons-only, one-message-per-action, emoji signals, threads, accessibility, command list |
| ✅ | [Discord Window Size Reference](./ui/discord-window-size.md) | The measured screen budget: 60 × 32 as the code-block ceiling on the phone client, ~30 columns as the safe portrait width for scene text |

## 📐 decisions

resolved cross-cutting trade-offs (ADRs)

| Status | Doc | Summary |
| ------ | --- | ------- |
| ✅ | [POC Action UX Refinements](./decisions/poc-action-ux-refinements.md) | Buttons A/B/C, Bail/Skip/Finish terminal states, footer standardisation, generic daily actions |
| ✅ | [Per-Option Stat & Ability-Check Rolls](./decisions/per-option-stat-and-ability-checks.md) | Roll = d20 + char ability + item bonus; per-option stat so approach choice selects the stat tested |
| ✅ | [Roll Economy, Timeouts & World Growth](./decisions/roll-economy-timeouts-and-world-growth.md) | Resolves prod-data D1/D2/D3: refund no-op/timeout rolls (1 free each per day), lazy-create off-map locations via sync stub + async cartographer. Drives the `decision-v8` bump. |
| ✅ | [Edge Bearing Inversion & Region Reconciliation](./decisions/edge-bearing-inversion-and-region-reconciliation.md) | Render-time direction inversion in `neighbours()` (no migration) so `/look` agrees with `/map`; BFS parent fallback for null-region nodes in `renderMap` so unenriched places don't orphan to "Elsewhere." |
| ✅ | [v12 Prompt-Set Versioning](./decisions/v12-prompt-set-versioning.md) | Extends one-file-per-version prompt versioning to a directory-per-set convention (`decision-prompts/v12/`) for the classify → decide → resolve pipeline; one `PROMPT_SET_VERSION` constant, derived `version/template` stamps, no `current_source.md` for sets |
| ✅ | [Wizard Session State Ownership](./decisions/wizard-session-ownership.md) | The JSON-seam M7.3 settle: the join wizard's multi-step draft becomes controller-held session state keyed by `playerId`, as a scoped extension of the seam's decision 1 (engine-owned session state) rather than an engine-persisted draft |

---

## 🎯 POC

| Status | Doc | Summary |
| ------ | --- | ------- |
| 🌱 | [Improved Item Features](./sparks/improved-item-features.md) | Placeholder for giving items depth — item kinds/layers, use/equip/drop verbs, quest coupling, real inventory management, and an economy tie-in (personal vs. communal coin). Collects the "loot is noise" thread (feedback #11) + soft-cap enforcement deferred from the backpack short-fix. Not yet a direction. |

## 🔥 MVP

core game loop

| Status | Doc | Summary |
| ------ | --- | ------- |
| 🌱 | [Core Loop](./sparks/mvp-core-loop.md) | Daily/weekly rolls, co-op bonuses, auto-sim, stamina |
| 🌱 | [LLM Prompt & Resolution](./sparks/mvp-llm-prompt-architecture.md) | Roll-before-flavour, markdown prompts, agent chaining, sim harness, captured-call mocks |
| 🌱 | [Combat](./sparks/mvp-combat.md) | Roll-resolution combat as a first-class mode (no twitch) |
| 🌱 | [Architecture](./sparks/mvp-architecture.md) | High-level system diagram (target, not POC) |
| 🌱 | [Convergence & Climax](./sparks/mvp-progression.md) | Fellowship formation, December climax, player lifecycle |
| 🌱 | [Data Model](./sparks/mvp-data-model.md) | Node types, edge types, query patterns, data/prose split |
| 🌱 | [Character Drivers](./sparks/mvp-character-drivers.md) | D&D layer: alignment, ideals, flaws, bonds |
| 🌱 | [Social Model](./sparks/mvp-social-model.md) | Sentiment, bonds, relationships — three axes |
| 🌱 | [ASCII Render Pipeline](./sparks/mvp-ascii-render-pipeline.md) | `ascii-image-converter` pipeline. Deferred from POC |
| 🌱 | [Discord UX — MVP+](./sparks/mvp-discord-ux.md) | Reactions, free text, select menus, batch strategy |
| 🌱 | [Discord Interaction Layer](./sparks/discord-interaction-layer.md) | Standardise & optimise the interaction _plumbing_ (ack/defer, loading envelope, shared component+embed builders, error funnel, in-flight guard) into one shared layer so correctness is by-construction, not per-button. `DiscordAPIError[10062]` is the symptom that exposed it; the crash-stop slice is an ASAP bug report, this is the MVP layer underneath. Orthogonal to _Discord UX — MVP+_ (that's input modalities; this is plumbing). |
| 🌱 | [Example Scenes — MVP](./sparks/mvp-example-scenes.md) | Co-op scouting, NPC talk, travel convergence |

## 🚀 MVP+

deferred depth & polish

| Status | Doc | Summary |
| ------ | --- | ------- |
| 🌱 | [NPC Economy](./sparks/mvp+npc-economy.md) | Deterministic NPC routines, town economy |
| 🌱 | [World State Projection](./sparks/mvp+world-state-projection.md) | Graph DB → markdown vault at ~0 tokens |
| 🌱 | [Moral Drift](./sparks/mvp+moral-drift.md) | Continuous moral vector, derived alignment, governor loop |
| 🌱 | [Login Streaks](./sparks/mvp+login-streaks.md) | Retention incentives, bonus rolls |
| 🌱 | [ANSI Art — Coloured Frames & Splash](./sparks/mvp+ansi-art.md) | Discord `ansi` colour: tested constraints, colour roles, frame slots, splash |
| 🌱 | [ANSI Hand-Drawn Designs](./sparks/ansi-handdrawn-designs.md) | Sketches for frames and components the ANSI work has not built yet, kept next to their images (the health-bar families so far) |
| 🔭 | [Last-Stand Screen: Emoji Captions & Combat Scene Frame](./sparks/last-stand-ux.md) | The desperate-choice beat settled: the combat frame leads the decision screen as the game's screen, the card below keeps only the round ledger, and both captions take one emoji under one button convention, inside the measured mobile caption budget |

---

## 🗄️ archived

retired docs, grouped by why (`shipped` spec, `superseded` direction, `nogo` rejection) and ordered by arc. Kept for history: the code, the changelog and git own the present.

| Reason | Arc | Doc | Domain | Summary |
| ------ | --- | --- | ------ | ------- |
| 🗄️ shipped | poc | [Bug Analysis — v0.2.2 Release](./archived/bug-analysis-v0.2.2.md) | spark | Three reviewers over the v0.2.2 diff: engine + migrations, Discord commands, scheduler + LLM |
| 🗄️ shipped | poc | [Code Review — Changes since PR #14](./archived/handover-code-review-post-pr14.md) | spark | The same sweep for `24e67b9..47700ca`, plus the punch list it produced |
| 🗄️ shipped | poc | [Daily-Work Teleport — Commute to the Job](./archived/daily-work-teleport.md) | game | The workplace location, the travel, and the stamina it costs |
| 🗄️ shipped | poc | [Decision Prompt v9 — Markdown Input & Coherence Critic](./archived/prompt-v9-markdown-and-critic.md) | spark | Markdown as prompt input, and the critic that fires on a decide beat |
| 🗄️ shipped | poc | [Example Scenes — POC](./archived/poc-example-scenes.md) | ui | The hand-written scenes used as the render baseline |
| 🗄️ shipped | poc | [Goodnight, Absence Penalty, and Rest Features](./archived/goodnight-and-rest-features.md) | game | `/goodnight`, what an absence costs, and resting in a safe zone |
| 🗄️ shipped | poc | [Map & Exploration](./archived/per-player-map-exploration.md) | engine | Shared hub-and-spoke geography, deterministic travel, fog-of-war `/map` |
| 🗄️ shipped | poc | [Mutation Vocabulary Refinement](./archived/mutation-vocabulary-refinement.md) | engine | Verb cleanup, NPC lifecycle, and the action-category map |
| 🗄️ shipped | poc | [Onboarding — Character Creation Wizard](./archived/poc-onboarding.md) | game | The `/join` wizard and the character it creates |
| 🗄️ shipped | poc | [POC Build — Action UX Refinements](./archived/poc-build-action-ux.md) | engine | Buttons A/B/C, bail/skip/finish as terminal states, footer standardisation |
| 🗄️ shipped | poc | [POC Build — ASCII Scenes](./archived/poc-build-scenes.md) | engine | The scene loader, validator, tag resolver and render template |
| 🗄️ shipped | poc | [POC Build — Deploy](./archived/poc-build-deploy.md) | engine | CI, the Podman dev container, LXC provisioning, the systemd auto-deploy timer |
| 🗄️ shipped | poc | [POC Build — Plan of Attack](./archived/poc-build-poa.md) | engine | The seam, the session plan, and where a session starts and stops |
| 🗄️ shipped | poc | [POC Build — Polish](./archived/poc-build-polish.md) | engine | S6–S7: help content, flavour, the pre-deploy checklist |
| 🗄️ shipped | poc | [POC Build — Probabilistic Actions](./archived/poc-build-probabilistic.md) | engine | S3–S4: dice, the two-tier LLM fallback, outcome rendering |
| 🗄️ shipped | poc | [POC Build — Scaffold](./archived/poc-build-scaffold.md) | engine | S1–S2: the deterministic commands, then scenes |
| 🗄️ shipped | poc | [POC Spec Reconciliation](./archived/poc-spec-reconciliation.md) | engine | The POC spec's settled decisions: the `meta` table, fail-fast, DC sign |
| 🗄️ shipped | poc | [POC Tech Stack](./archived/poc-tech-stack.md) | engine | The stack chosen for the one-week proof of concept |
| 🗄️ shipped | poc | [Polish Pass — Follow-up (post-0.2.7)](./archived/polish-pass-follow.md) | spark | What 0.2.7 left open |
| 🗄️ shipped | poc | [Polish Pass — v0.2.4](./archived/polish-pass-v0.2.4.md) | spark | Bugs, coherency and thematics on surfaces the player already touches |
| 🗄️ shipped | poc | [Polish Pass — v0.2.7](./archived/polish-v0.2.7.md) | spark | The 0.2.7 pass |
| 🗄️ shipped | poc | [Polish Pass — v0.2.8](./archived/polish-v0.2.8.md) | spark | Render- and comms-only wins from the prod-data review, independent of the prompt refactor |
| 🗄️ shipped | poc | [Prod Data Review — v0.2.3](./archived/prod-data-review-v0.2.3.md) | spark | What the live DB said, mined from `feedback`, `bug_reports`, `actions` and `llm_calls` |
| 🗄️ shipped | poc | [The POC — One-Week Proof of Concept](./archived/the-poc.md) | game | The one-week POC: scope, session plan, success criteria |
| 🗄️ shipped | poc | [v0.3.0 feedback & bug triage](./archived/v0.3.0-feedback-bug-triage.md) | spark | The dev-DB scrape behind the 0.3.0 fixes |
| 🗄️ shipped | poc | [v12 QA — prod data review](./archived/v12-QA-findings.md) | spark | The v12 QA findings; every one shipped in `0.3.0` |
| 🗄️ shipped | poc | [World Tick — Daily Simulation](./archived/poc-build-world-tick.md) | engine | S5: `/sleep`, the idempotent cron, seeded NPC movement |
| 🗄️ shipped | poc | [YAML Asset Schemas & Test Coverage](./archived/yaml-asset-schemas-and-tests.md) | spark | Hand-rolled per-asset validators, fail-fast boot, coverage tests |
| 🗄️ shipped | poc-plus | [POC+ 0.3.1 — combat-readability polish & hardening](./archived/poc-plus-0.3.1-polish-plan.md) | engine | The interstitial cut that paid down the debt the T2 live check surfaced |
| 🗄️ shipped | poc-plus | [POC+ 0.3.2 — combat-correctness & prod-bug release](./archived/poc-plus-0.3.2-polish-plan.md) | engine | 14 deliverables: C1–C6 combat correctness, P1–P2 presentation, N1–N5 bugs |
| 🗄️ shipped | poc-plus | [POC+ Release A — worth-returning-to](./archived/poc-plus-release-a-plan.md) | engine | RA-1…RA-6, shipped as `0.3.3`; the RA-1/RA-2 residuals carry forward |
| 🗄️ shipped | poc-plus | [POC+ Stage 1](./archived/poc-plus-stage-1-plan.md) | engine | The v12 tail, the welcome tag, the combat maths reveal |
| 🗄️ shipped | json-seam | [JSON Seam — M7/M8 Handover Briefing](./archived/json-seam-handover-m7-m8.md) | engine | Lead prompt for the bookends and read-only screens through the seam |
| 🗄️ shipped | json-seam | [JSON Seam — M9 Handover Briefing](./archived/json-seam-handover-m9.md) | engine | Lead prompt for the Discord adapter rebuilt onto the protocol |
| 🗄️ shipped | json-seam | [JSON Seam — Milestone Build Plans (M0–M4)](./archived/json-seam-build-plans.md) | engine | Per-milestone task breakdown, execution state and commit hashes |
| 🗄️ shipped | json-seam | [JSON Seam — Protocol & Full-Seam Refactor (M5–M10)](./archived/json-seam-protocol.md) | engine | The seam: one JSON channel every frontend crosses, so smoke runs play what players play |
| 🗄️ shipped | v12-build-plans | [Decide-stage scene narration, action-options & stat icons](./archived/decide-scene-narration-spec.md) | engine | Restore the game master's narration; options as concrete actions with visible risk |
| 🗄️ shipped | v12-build-plans | [Decision Prompt v12 — parent spec](./archived/prompt-separation-of-concerns.md) | engine | The `0.3.0` prompt set's frame: prerequisites, sequence, scope fences, acceptance gate |
| 🗄️ shipped | v12-build-plans | [Prompt v12 — Scene-State (D1/D2/D6)](./archived/prompt-v12-scene-state.md) | engine | The graph-shaped spine, typed mutations with no LLM SQL, travel coherence |
| 🗄️ shipped | v12-build-plans | [Prompt v12 — Thread C: Combat as a First-Class Mode](./archived/prompt-v12-combat.md) | game | Combat as a frequent, long, richly-rewarded wilds mode |
| 🗄️ shipped | v12-build-plans | [Prompt v12 — Thread D: The Multi-Stage Pipeline](./archived/prompt-v12-pipeline.md) | engine | classify → decide → resolve, plus the interaction shapes, the security stack and the cost case |
| 🗄️ shipped | v12-build-plans | [Stage 0a — Sim Harness](./archived/stage-0a-sim-harness-plan.md) | engine | The offline deterministic replay harness the v12 path was proven on |
| 🗄️ shipped | v12-build-plans | [Stage 1 — Thread D backbone](./archived/stage-1-thread-d-backbone-plan.md) | engine | The pipeline state machine, built parallel to the live v11 path |
| 🗄️ shipped | v12-build-plans | [Stage 2 — Scene-state spine + travel gate](./archived/stage-2-scene-state-spine-plan.md) | engine | The typed spine, edge-shaped mutations, the travel gate |
| 🗄️ shipped | v12-build-plans | [Stage 3 — Thread C combat spine](./archived/stage-3-combat-spine-plan.md) | engine | Contested roll, severity bands, the once-per-day no-one-shot floor, a lifted round cap |
| 🗄️ shipped | v12-build-plans | [Stage 5 — Live cutover](./archived/stage-5-live-cutover-plan.md) | engine | Sim-calibrate, prove the real model against the v12 templates, then hard-flip with a DB wipe |
| 🗄️ shipped | v12-build-plans | [T1 — combat calibration](./archived/T1-combat-calibration.md) | engine | The seeded multi-fight harness and the balance curves it recorded |
| 🗄️ shipped | v12-build-plans | [T3 follow-up — voluntary mid-combat bail](./archived/T3-followup-combat-bail-spec.md) | engine | Flee at a cost: the mid-combat exit |
| 🗄️ shipped | v12-build-plans | [T3 iteration 2 — floor + loss ladder](./archived/T3-iteration-2-spec.md) | engine | The loss ladder and the floor under it |
| 🗄️ shipped | v12-build-plans | [T4 — v12 combat prompt templates](./archived/T4-combat-templates-spec.md) | engine | The templates the combat spine renders through |
| 🗄️ shipped | v12-build-plans | [T5 — per-round combat beat logging](./archived/T5-combat-telemetry-spec.md) | engine | Beat logging, the sim combat scenario, and the metrics that read them |
| 🗄️ shipped | factory | [Dark Factory requirements (scrumo + model tiering)](./archived/dark-factory-requirements.md) | engine | The fourth loop, its escalator child, and the per-loop model pins |
| 🪦 superseded | poc | [POC Build Plan](./archived/poc-build-plan.md) | engine | The first cut of the POC build plan, replaced by [[poc-build-poa]] |
| 🪦 superseded | poc-plus | [Action Features & Art Integration Tracker](./archived/action-features-tracker.md) | engine | A 0.3.1-era action/art coverage snapshot, superseded by the code |
| 🪦 superseded | json-seam | [JSON Seam — Smoke-Run Upgrade Brainstorm](./archived/json-seam-smoke-handover.md) | engine | Superseded by [[json-seam-protocol]] § Smoke-run tooling plan (M8.5) |
| 🚫 nogo | — | [Obsidian CLI](./archived/obsidian-cli.md) | spark | Vault automation via CLI — rejected in favour of Python scripts |
