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
| ✅ | [The POC — Intent](./game/the-poc.md) | The one question, the daily ritual, what ships, what's deliberately out |
| ✅ | [Onboarding](./game/poc-onboarding.md) | Deterministic `/join` wizard. Data in `assets/char-creation/` |

## ⚙️ engine

how it runs

| Status | Doc                                          | Summary                                                             |
| ------ | -------------------------------------------- | ------------------------------------------------------------------- |
| ✅      | [POC Tech Stack](./engine/poc-tech-stack.md) | Tech choices, architecture diagrams, hosting, no-gos for POC vs MVP |
| ✅      | [Build — Plan of Attack](./engine/poc-build-poa.md) | Build root: patterns per slice, light portable-backend seam, sequential session plan (deepseek-v4-pro) |
| ✅      | [Build — Scaffold](./engine/poc-build-scaffold.md) | Project init, DB, character creation, deterministic commands     |
| ✅      | [Build — Probabilistic](./engine/poc-build-probabilistic.md) | `/action` flow, reactive LLM decisions, roll/skip, mutations     |
| ✅      | [Build — Scenes](./engine/poc-build-scenes.md) | ASCII fragment catalog, tag matching, integration, mobile testing     |
| ✅      | [Build — Polish](./engine/poc-build-polish.md) | Error handling, LLM fallback, outcome rendering, help content, final pass     |
| ✅      | [World Tick](./engine/poc-build-world-tick.md) | `/sleep` daily tick: admin command + cron, player updates, NPC movement, world scaling |
| ✅      | [Build — Deploy](./engine/poc-build-deploy.md) | CI/CD, LXC provisioning, systemd, auto-update, tester invite, observation     |

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
| ✅ | [POC Spec Reconciliation](./decisions/poc-spec-reconciliation.md) | Resolves POC contradictions: outcome narration, cron tick, ASCII scenes, DC sign, supporting fixes |

---

## 🎯 POC 

ongoing sparks

_No open POC sparks — all promoted to domain folders._

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

## 🚫 Archived

explored & rejected (`nogo`) or replaced (`superseded`) — kept so we don't re-litigate

| Status | Doc                                        | Summary                                                        |
| ------ | ------------------------------------------ | -------------------------------------------------------------- |
| 🚫     | [Obsidian CLI](./archived/obsidian-cli.md) | Vault automation via CLI — rejected in favor of Python scripts |
| 🪦     | [POC Build Plan](./archived/poc-build-plan.md) | Old root/sections index — superseded by [[poc-build-poa]]; criteria moved to deploy §6 |
