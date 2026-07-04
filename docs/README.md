# Docs — Map of Content

The design vault for **The Warden's Oak**. Every doc carries frontmatter; promoted docs graduate from `sparks/` to domain folders.

Read **[CONVENTIONS](./CONVENTIONS.md)** first.

---

🌱 `spark` · 🔭 `exploring` · ✅ `decided` · 🪦 `superseded` · 🚫 `nogo`

---

## 🧭 vision 

mission, pillars, north star

| Status | Doc                                              | Summary                                             |
| ------ | ------------------------------------------------ | --------------------------------------------------- |
| ✅      | [Pitch & Pillars](./vision/pitch-and-pillars.md) | Elevator pitch, year-long premise, thematic DNA     |
| ✅      | [Hazard Map](./vision/hazard-map.md)             | No-gos, rabbit holes, known risks, scope discipline |
| 🔭     | [World & Setting](./vision/world-setting.md)     | The Oak, the Threat, emergent map                   |

## 🎲 game

mechanics, loop, actions

| Status | Doc | Summary |
| ------ | --- | ------- |
| ✅      | [v12 · Combat (Thread C)](./game/prompt-v12-combat.md) | Combat as a frequent, long, high-reward wilds mode — prompt rules + the engine combat spine (lifted decision cap, `combatState`, contested roll + severity bands, once-per-day no-one-shot floor). Frequency/lethality scale with dynamic location danger; viable everywhere, non-lethal in safe places. |
| ✅      | [v12 · World Scaling (Thread B)](./game/prompt-v12-world-scaling.md) | The world sizes to the player (effective strength × week-indexed World Tier) → tougher foes, bigger rewards; no player-side dice buff; the anti-treadmill (Oblivion-style level-scaling) tension, sim-harness-gated. |

## ⚙️ engine

how it runs

| Status | Doc | Summary |
| ------ | --- | ------- |
| ✅      | [Action Engine Framework](./engine/action-engine-framework.md) | The scaling contract for the action engine: a fixed classify → decide → dice → resolve spine with data-driven registries (ActionTypes, Mutations, DMAs) around it, drawn across three ownership zones (dice / engine / LLM) so every seam is explicit. Formalizes structures already in code (`CATEGORY_MUTATION_MAP`, the post-authoring mutation-adjustment pipeline) so future work — more DMAs, mutations, action types, item interaction — plugs in without touching the spine. Four Mermaid diagrams: the resolution pipeline, ActionType-as-registry-entry, the mutation vocab by entity, and the scene-state graph shape. v12 is its first consumer. |
| ✅      | [v12 — Prompt Separation of Concerns (parent)](./engine/prompt-separation-of-concerns.md) | Parent/overview of the v12 prompt-set rework (POC round 2, `0.3.0`): prerequisites, sequencing, the thread-ownership map, risks, acceptance + a Parts index linking the four parts. The through-line is separation of concerns across the classify → decide → resolve pipeline. |
| ✅      | [v12 · Pipeline (Thread D)](./engine/prompt-v12-pipeline.md) | Classify → decide → resolve pipeline of per-type templates; interaction shapes (D3), free-text security (D4), the cost/data case (D5), and the verification design (D7 — gated coherence critic + faithfulness prose critic, patch-prose-only, no LLM state-authoring). |
| ✅      | [v12 · Scene-State (D1/D2/D6)](./engine/prompt-v12-scene-state.md) | Engine-owned, graph-shaped state carried across beats (D1); typed graph-delta mutations, no LLM SQL (D2); deterministic travel/location coherence via the `scene_location` field + the travel gate (D6). |
| ✅      | [Stage 0a — Sim Harness (plan)](./engine/stage-0a-sim-harness-plan.md) | Handoff-ready build plan for the v12 critical-path first deliverable: an offline, deterministic replay harness driving a character through many actions/weeks via the real `WorldEngineImpl` with a mocked LLM + seeded d20, emitting balance-tuning curves. Every code anchor, type contract, and gotcha (incl. the resolved `tick(true)` day-advance) inlined for execution by a lesser agent. |
| ✅      | [Stage 1 — Thread D backbone (plan)](./engine/stage-1-thread-d-backbone-plan.md) | Handoff-ready build plan for the classify → decide → (dice) → resolve pipeline, built as a **parallel `PipelineActionStateMachine`** exercised through the Stage 0a sim harness so the live v11 path is untouched. Settles the prototype strategy, the D5b mutation-finalization inversion, and heuristic-first classify; decomposes into five delegatable tasks with a scope fence and the risk map from the code-surface exploration. |
| ✅      | [Stage 2 — Scene-state spine + travel gate (plan)](./engine/stage-2-scene-state-spine-plan.md) | Handoff-ready build plan for the typed, graph-shaped scene-state spine (D1), edge-shaped `set_relation`/`update_relation` mutations with no LLM SQL (D2), and the deterministic `scene_location` travel-coherence gate (D6) — all pipeline-only. Two-pass execution: Pass 1 = the foundation (`relations` storage + mutation vocabulary) then a human checkpoint; Pass 2 = spine wiring + travel gate. Settled node-identity/op-name decisions, scope fence, and risk map inlined. |
| ✅      | [POC Build & Deploy](./engine/poc-build-deploy.md) | Local dev, Podman container, DB inspection, LXC Debian production deploy, and systemd auto-deploy setup. |

## 🖥️ ui

discord presentation

| Status | Doc                                          | Summary                                                         |
| ------ | -------------------------------------------- | --------------------------------------------------------------- |
| 🔭     | [Discord UX](./ui/poc-discord-ux.md)         | Mobile constraints, buttons-only, one-message-per-action, emoji signals, threads, accessibility, command list |

_Example Scenes shipped → `archived/poc/`._

## 📐 decisions

resolved cross-cutting trade-offs (ADRs)

| Status | Doc                                                                                                               | Summary                                                                                                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅      | [POC Action UX Refinements](./decisions/poc-action-ux-refinements.md)                                             | Buttons A/B/C, Bail/Skip/Finish terminal states, footer standardisation, generic daily actions                                                                                                             |
| ✅      | [Per-Option Stat & Ability-Check Rolls](./decisions/per-option-stat-and-ability-checks.md)                        | Roll = d20 + char ability + item bonus; per-option stat so approach choice selects the stat tested                                                                                                         |
| ✅      | [Roll Economy, Timeouts & World Growth](./decisions/roll-economy-timeouts-and-world-growth.md)                    | Resolves prod-data D1/D2/D3: refund no-op/timeout rolls (1 free each per day), lazy-create off-map locations via sync stub + async cartographer. Drives the `decision-v8` bump.                            |
| ✅      | [Edge Bearing Inversion & Region Reconciliation](./decisions/edge-bearing-inversion-and-region-reconciliation.md) | Render-time direction inversion in `neighbours()` (no migration) so `/look` agrees with `/map`; BFS parent fallback for null-region nodes in `renderMap` so unenriched places don't orphan to "Elsewhere." |
| ✅      | [v12 Prompt-Set Versioning](./decisions/v12-prompt-set-versioning.md)                                             | Extends one-file-per-version prompt versioning to a directory-per-set convention (`decision-prompts/v12/`) for the classify → decide → resolve pipeline; one `PROMPT_SET_VERSION` constant, derived `version/template` stamps, no `current_source.md` for sets |

---

## 🎯 POC 

| Status | Doc                                                                                                                                                                                                                     | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 🌱     | [Improved Item Features](./sparks/improved-item-features.md)                                                                                                                                                            | Placeholder for giving items depth — item kinds/layers, use/equip/drop verbs, quest coupling, real inventory management, and an economy tie-in (personal vs. communal coin). Collects the "loot is noise" thread (feedback #11) + soft-cap enforcement deferred from the backpack short-fix. Not yet a direction.                                                                                                                                                                                                                                                                          |
| 🔭     | [Polish Pass — v0.2.8](./sparks/polish-v0.2.8.md)                                                                                                                                                                       | POC-beta polish bump (`0.2.7 → 0.2.8`) lumping the small Discord/comms wins from the 2026-07-03 prod-data review: show a character's owner on outcomes (F#3/8), distinct release-notes vs recap pin emoji (F#20), trim pinned-message noise (F#18), weekly-recap thread UX rework (F#19). Larger asks from the same review routed to MVP/sparks.                                                                                                                                                                                                                                            |

## 🔥 MVP 

core game loop

| Status | Doc                                                                                          | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🌱     | [Core Loop](./sparks/mvp-core-loop.md)                                                       | Daily/weekly rolls, co-op bonuses, auto-sim, stamina                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 🌱     | [LLM Prompt & Resolution](./sparks/mvp-llm-prompt-architecture.md)                           | Roll-before-flavour, markdown prompts, agent chaining, sim harness, captured-call mocks                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 🌱     | [Combat](./sparks/mvp-combat.md)                                                             | Roll-resolution combat as a first-class mode (no twitch)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 🌱     | [Architecture](./sparks/mvp-architecture.md)                                                 | High-level system diagram (target, not POC)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 🌱     | [Convergence & Climax](./sparks/mvp-progression.md)                                          | Fellowship formation, December climax, player lifecycle                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 🌱     | [Data Model](./sparks/mvp-data-model.md)                                                     | Node types, edge types, query patterns, data/prose split                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 🌱     | [Character Drivers](./sparks/mvp-character-drivers.md)                                       | D&D layer: alignment, ideals, flaws, bonds                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🌱     | [Social Model](./sparks/mvp-social-model.md)                                                 | Sentiment, bonds, relationships — three axes                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 🌱     | [ASCII Render Pipeline](./sparks/mvp-ascii-render-pipeline.md)                               | `ascii-image-converter` pipeline. Deferred from POC                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 🌱     | [Discord UX — MVP+](./sparks/mvp-discord-ux.md)                                              | Reactions, free text, select menus, batch strategy                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 🌱     | [Discord Interaction Layer](./sparks/discord-interaction-layer.md)                           | Standardise & optimise the interaction *plumbing* (ack/defer, loading envelope, shared component+embed builders, error funnel, in-flight guard) into one shared layer so correctness is by-construction, not per-button. `DiscordAPIError[10062]` is the symptom that exposed it; the crash-stop slice is an ASAP bug report, this is the MVP layer underneath. Orthogonal to *Discord UX — MVP+* (that's input modalities; this is plumbing).                                                                |
| 🌱     | [Example Scenes — MVP](./sparks/mvp-example-scenes.md)                                       | Co-op scouting, NPC talk, travel convergence                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## 🚀 MVP+

deferred depth & polish

| Status | Doc                                                              | Summary                                                   |
| ------ | ---------------------------------------------------------------- | --------------------------------------------------------- |
| 🌱     | [NPC Economy](./sparks/mvp+npc-economy.md)                       | Deterministic NPC routines, town economy                  |
| 🌱     | [World State Projection](./sparks/mvp+world-state-projection.md) | Graph DB → markdown vault at ~0 tokens                    |
| 🌱     | [Moral Drift](./sparks/mvp+moral-drift.md)                       | Continuous moral vector, derived alignment, governor loop |
| 🌱     | [Login Streaks](./sparks/mvp+login-streaks.md)                   | Retention incentives, bonus rolls                         |

---

## 🚫 No-gos

explored & rejected (`nogo`) or replaced (`superseded`) — kept so we don't re-litigate

| Status | Doc                                            | Summary                                                                     |
| ------ | ---------------------------------------------- | --------------------------------------------------------------------------- |
| 🚫     | [Obsidian CLI](./archived/obsidian-cli.md)     | Vault automation via CLI — rejected in favor of Python scripts              |
