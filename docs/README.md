# Docs — Map of Content

The design vault for **The Warden's Oak**. Every doc carries frontmatter. Promoted docs graduate from `sparks/` to domain folders. 

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
| 🔭 | [The POC — Intent](./game/the-poc.md) | What the POC is, what ships, action flow, two action types |
| ✅ | [Onboarding](./game/poc-onboarding.md) | Deterministic `/join` wizard. Data in `assets/char-creation/` |

## ⚙️ engine

how it runs

| Status | Doc                                          | Summary                                                             |
| ------ | -------------------------------------------- | ------------------------------------------------------------------- |
| ✅      | [POC Tech Stack](./engine/poc-tech-stack.md) | Tech choices, architecture diagrams, hosting, no-gos for POC vs MVP |
| ✅      | [POC Build Plan](./engine/poc-build-plan.md) | Root doc. Links to sub-docs below                                   |
| 🔭     | [Build — Scaffold](./engine/poc-build-scaffold.md) | Project init, DB, character creation, deterministic commands     |
| 🔭     | [Build — Probabilistic](./engine/poc-build-probabilistic.md) | `/action` flow, reactive LLM decisions, roll/skip, mutations     |
| 🔭     | [Build — Scenes](./engine/poc-build-scenes.md) | ASCII fragment catalog, tag matching, integration, mobile testing     |
| 🔭     | [Build — Polish](./engine/poc-build-polish.md) | Error handling, LLM fallback, outcome rendering, help content, final pass     |
| 🔭     | [World Tick](poc-world-tick.md) | `/sleep` daily tick: admin command + cron, player updates, NPC movement, world scaling |
| 🔭     | [Build — Deploy](./engine/poc-build-deploy.md) | CI/CD, LXC provisioning, systemd, auto-update, tester invite, observation     |

## 🖥️ ui

discord presentation

| Status | Doc                                          | Summary                                                         |
| ------ | -------------------------------------------- | --------------------------------------------------------------- |
| ✅      | [Example Scenes](./ui/poc-example-scenes.md) | `/join`, `/hi`, `/action hunt`, `/backpack`, `/stats`, `/sleep` |

---

## 🎯 POC 

ongoing sparks

| Status | Doc                                                          | Summary                                                       |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------- |
| 🌱     | [Discord UX](./sparks/poc-discord-ux.md)                     | Mobile constraints, button rules, emoji signals, command list |

## 🔥 MVP 

core game loop

| Status | Doc | Summary |
|---|---|---|
| 🌱 | [Core Loop](./sparks/mvp-core-loop.md) | Daily/weekly rolls, co-op bonuses, auto-sim, stamina |
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

## 🚫 Nogo

explored and rejected — kept so we don't re-litigate

| Status | Doc                                        | Summary                                                        |
| ------ | ------------------------------------------ | -------------------------------------------------------------- |
| 🚫     | [Obsidian CLI](./archived/obsidian-cli.md) | Vault automation via CLI — rejected in favor of Python scripts |
