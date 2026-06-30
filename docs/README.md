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

_All POC game specs shipped — the code is the living artifact (see `archived/poc/`)._

## ⚙️ engine

how it runs

| Status | Doc | Summary |
|---|---|---|
| ✅ | [Mutation Vocabulary Refinement](./engine/mutation-vocabulary-refinement.md) | **`0.2.x` candidate → ships as `decision-v11`** (after the map doc's `decision-v10`). Tidies the LLM mutation keywords into one verb scheme (`modify_` deltas · `add/update/remove_` entity CRUD · `move_to`), splits the overloaded `set_location` → `move_to` + `reveal_location`, gives NPCs a lifecycle (`add/update/remove_npc`, disposition deferred), and adds a closed `category` enum + soft `category → expected-mutations` map (warn + telemetry, apply anyway). Stepping stone to v12's two-pass dynamic injection; `move_to`/`reveal_location` defer to the map graph, and `locations.created_by_action_id` is ceded to that doc. |

_POC engine specs (tech stack, action-UX) shipped → `archived/poc/`._

## 🖥️ ui

discord presentation

| Status | Doc                                          | Summary                                                         |
| ------ | -------------------------------------------- | --------------------------------------------------------------- |
| 🔭     | [Discord UX](./ui/poc-discord-ux.md)         | Mobile constraints, buttons-only, one-message-per-action, emoji signals, threads, accessibility, command list |

_Example Scenes shipped → `archived/poc/`._

## 📐 decisions

resolved cross-cutting trade-offs (ADRs)

| Status | Doc | Summary |
|---|---|---|
| ✅ | [POC Action UX Refinements](./decisions/poc-action-ux-refinements.md) | Buttons A/B/C, Bail/Skip/Finish terminal states, footer standardisation, generic daily actions |
| ✅ | [Per-Option Stat & Ability-Check Rolls](./decisions/per-option-stat-and-ability-checks.md) | Roll = d20 + char ability + item bonus; per-option stat so approach choice selects the stat tested |
| ✅ | [Roll Economy, Timeouts & World Growth](./decisions/roll-economy-timeouts-and-world-growth.md) | Resolves prod-data D1/D2/D3: refund no-op/timeout rolls (1 free each per day), lazy-create off-map locations via sync stub + async cartographer. Drives the `decision-v8` bump. |
| ✅ | [Edge Bearing Inversion & Region Reconciliation](./decisions/edge-bearing-inversion-and-region-reconciliation.md) | Render-time direction inversion in `neighbours()` (no migration) so `/look` agrees with `/map`; BFS parent fallback for null-region nodes in `renderMap` so unenriched places don't orphan to "Elsewhere." |

---

## 🎯 POC 

| Status | Doc                                                                                                                                                                                                                     | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 🌱     | [Decision Prompt v12 — Combat, World Scaling & Multi-Stage Pipeline](./sparks/prompt-v12-scaling-and-pipeline.md) _(the `0.3.0` prompt **set** = v12; `decision-v10`/`v11` are the map + mutation-vocab `0.2.x` bumps)_ | **POC round 2 (`0.3.0`) kickoff**, builds on the shipped v9 (markdown input + coherence critic, now in `archived/poc/`). The engine-heavy half: (C) combat as a long, frequent, high-reward wilds mode backed by engine scene-state (`combatState`, contested rolls, severity bands, no-one-shot floor); (B) the world scales around the player via a week-indexed World Tier; (D) decompose the mega-call into a classify → decide → resolve pipeline of per-type templates over graph-shaped scene-state (the v9 critic is its first stage). Sim harness is a prerequisite.              |
| 🌱     | [Improved Item Features](./sparks/improved-item-features.md)                                                                                                                                                            | Placeholder for giving items depth — item kinds/layers, use/equip/drop verbs, quest coupling, real inventory management, and an economy tie-in (personal vs. communal coin). Collects the "loot is noise" thread (feedback #11) + soft-cap enforcement deferred from the backpack short-fix. Not yet a direction.                                                                                                                                                                                                                                                                          |

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
