# Docs — Map of Content

The design vault for **The Warden's Oak**. Every doc carries frontmatter. Promoted docs graduate from `sparks/` to domain folders. 

Every doc carries frontmatter. Promoted docs graduate from `sparks/` to domain folders. 

Read **[CONVENTIONS](./CONVENTIONS.md)** first.

> **Maintenance:** 
> When you add a doc, add its row to the right table.
> When status or phase changes, update the badge and table.
> If a file exists that isn't listed, it's drifting toward slop.

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
|---|---|---|
| ✅| [The POC — Intent](./game/the-poc.md) | The one question, the daily ritual, what ships, what's deliberately out |
| ✅| [Daily-Work Teleport](./game/daily-work-teleport.md) | Commute from the Oak to your workplace. Costs 1 stamina, free transit. |
| ✅| [Onboarding](./game/poc-onboarding.md) | Deterministic `/join` wizard. Data in `assets/char-creation/` |

## ⚙️ engine

how it runs

| Status | Doc                                          | Summary                                                             |
| ------ | -------------------------------------------- | ------------------------------------------------------------------- |
| ✅      | [POC Tech Stack](./engine/poc-tech-stack.md) | Tech choices, architecture diagrams, hosting, no-gos for POC vs MVP |
| ✅     | [Build — Action UX (Spec)](./engine/poc-build-action-ux.md) | Action-UX refinements + §7 bug fixes (implemented): A/B/C buttons, Bail/Skip/Finish, footer, daily actions |

## 🖥️ ui

discord presentation

| Status | Doc                                          | Summary                                                         |
| ------ | -------------------------------------------- | --------------------------------------------------------------- |
| ✅      | [Example Scenes](./ui/poc-example-scenes.md) | `/join`, `/hi`, `/action hunt`, `/backpack`, `/stats`, `/sleep` |
| 🔭     | [Discord UX](./ui/poc-discord-ux.md)         | Mobile constraints, buttons-only, one-message-per-action, emoji signals, threads, accessibility, command list |

## 📐 decisions

resolved cross-cutting trade-offs (ADRs)

| Status | Doc | Summary |
|---|---|---|
| ✅ | [POC Action UX Refinements](./decisions/poc-action-ux-refinements.md) | Buttons A/B/C, Bail/Skip/Finish terminal states, footer standardisation, generic daily actions |
| ✅ | [Per-Option Stat & Ability-Check Rolls](./decisions/per-option-stat-and-ability-checks.md) | Roll = d20 + char ability + item bonus; per-option stat so approach choice selects the stat tested |
| ✅ | [Roll Economy, Timeouts & World Growth](./decisions/roll-economy-timeouts-and-world-growth.md) | Resolves prod-data D1/D2/D3: refund no-op/timeout rolls (1 free each per day), lazy-create off-map locations via sync stub + async cartographer. Drives the `decision-v8` bump. |

---

## 🎯 POC 

| Status | Doc | Summary |
|---|---|---|
| 🌱 | [Polish Pass — v0.2.4](./sparks/polish-pass-v0.2.4.md) | Two-sweep bug/coherency/thematic punch list for the next patch. Highs: 5 `/join` backgrounds yield `NaN` stats; stale `/2` roll footer. Plus duplicate-threat-NPC race, class/job emoji, `/stats` stamina, prompt typo, `done`-flag drift, ops nits. No features. |
| 🌱 | [Prod Data Review — v0.2.3](./sparks/prod-data-review-v0.2.3.md) | Player-voice + LLM-telemetry mining of the live prod DB (8 players, 67 actions, 216 LLM calls). Critical: auto-resolve (`done`) eats a roll for no agency (28% of v0.2.3 actions, worsening); timeout drops travel + keeps roll + ghost-renders. Core-loop gaps: leaky roll economy, invisible unsafe-rest HP rule, world can't grow new locations. Confirms & upgrades polish-pass §E4 with prod evidence. |

## 🔥 MVP 

core game loop

| Status | Doc | Summary |
|---|---|---|
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
| 🌱 | [Example Scenes — MVP](./sparks/mvp-example-scenes.md) | Co-op scouting, NPC talk, travel convergence |

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

| Status | Doc                                        | Summary                                                        |
| ------ | ------------------------------------------ | -------------------------------------------------------------- |
| 🚫     | [Obsidian CLI](./archived/obsidian-cli.md) | Vault automation via CLI — rejected in favor of Python scripts |
| 🪦     | [POC Build Plan](./archived/poc-build-plan.md) | Old root/sections index — superseded by build specs in `docs/archived/poc/` |
