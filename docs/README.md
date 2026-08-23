# Docs — Map of Content

The design vault for **The Warden's Oak**. Every doc carries frontmatter; promoted docs graduate from `sparks/` to domain folders.

Read **[CONVENTIONS](./CONVENTIONS.md)** first.

---

🌱 `spark` · 🔭 `exploring` · ✅ `decided` · 🪦 `superseded` · 🚫 `nogo`

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
| ✅ | [RESOLVE difficulty signal](./engine/resolve-difficulty-signal.md) | Why RESOLVE receives the difficulty it was already instructed to reward, and why one field would have been wrong: a DC-checked attempt carries its final DC, a fight carries the worded danger tier the combat card already renders, and an auto-resolve carries neither. Two balance residuals logged: `dangerTier`'s thresholds predate v13's ladder, and the card/narration tier matches per round rather than per fight. |
| ✅ | [POC Build & Deploy](./engine/poc-build-deploy.md) | Local dev, Podman container, DB inspection, LXC Debian production deploy, and systemd auto-deploy setup. |
| ✅ | [Layer Boundaries & the JSON Seam](./engine/layer-boundaries-and-json-seam.md) | Current vs target layering with mermaid, the gap table, and the design questions settled 2026-07-18 (engine-owned session state, semantic view-state + shared renderers, in-process transport). The arc it specced ran M0–M10 and **closed 2026-08-09** — the milestone record lives in `archived/json-seam/`. Sits above _Discord Interaction Layer_ (that's adapter plumbing; this draws the boundary). |

_v12 parent + thread specs (incl. the Thread C combat spec), decide-scene-narration spec, stage-5 cutover plan, and the T1/T3–T5 records shipped → `archived/v12-build-plans/` (alongside stages 0a–3)._

_JSON seam **delivery** docs (M0–M4 + M5–M10 build plans, the M7/M8 and M9 lead handovers, the smoke-run brainstorm) shipped → `archived/json-seam/`; the design doc above stays live._

_POC+ build plans (stage 1, `0.3.1`/`0.3.2` polish, Release A) and the action-features/art-coverage tracker shipped → `archived/poc-plus/`; the live parent tracking doc is [[poc-plus-roadmap]]._

## 🖥️ ui

discord presentation

| Status | Doc | Summary |
| ------ | --- | ------- |
| 🔭 | [Discord UX](./ui/poc-discord-ux.md) | Mobile constraints, buttons-only, one-message-per-action, emoji signals, threads, accessibility, command list |

_Example Scenes shipped → `archived/poc/`._

## 📐 decisions

resolved cross-cutting trade-offs (ADRs)

| Status | Doc | Summary |
| ------ | --- | ------- |
| ✅ | [POC Action UX Refinements](./decisions/poc-action-ux-refinements.md) | Buttons A/B/C, Bail/Skip/Finish terminal states, footer standardisation, generic daily actions |
| ✅ | [Per-Option Stat & Ability-Check Rolls](./decisions/per-option-stat-and-ability-checks.md) | Roll = d20 + char ability + item bonus; per-option stat so approach choice selects the stat tested |
| ✅ | [Roll Economy, Timeouts & World Growth](./decisions/roll-economy-timeouts-and-world-growth.md) | Resolves prod-data D1/D2/D3: refund no-op/timeout rolls (1 free each per day), lazy-create off-map locations via sync stub + async cartographer. Drives the `decision-v8` bump. |
| ✅ | [Edge Bearing Inversion & Region Reconciliation](./decisions/edge-bearing-inversion-and-region-reconciliation.md) | Render-time direction inversion in `neighbours()` (no migration) so `/look` agrees with `/map`; BFS parent fallback for null-region nodes in `renderMap` so unenriched places don't orphan to "Elsewhere." |
| ✅ | [v12 Prompt-Set Versioning](./decisions/v12-prompt-set-versioning.md) | Extends one-file-per-version prompt versioning to a directory-per-set convention (`decision-prompts/v12/`) for the classify → decide → resolve pipeline; one `PROMPT_SET_VERSION` constant, derived `version/template` stamps, no `current_source.md` for sets |

---

## 🎯 POC

| Status | Doc | Summary |
| ------ | --- | ------- |
| 🌱 | [Improved Item Features](./sparks/improved-item-features.md) | Placeholder for giving items depth — item kinds/layers, use/equip/drop verbs, quest coupling, real inventory management, and an economy tie-in (personal vs. communal coin). Collects the "loot is noise" thread (feedback #11) + soft-cap enforcement deferred from the backpack short-fix. Not yet a direction. |

_Polish pass v0.2.8 shipped → `archived/poc/` (alongside the earlier polish passes)._

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

---

## 🚫 No-gos

explored & rejected (`nogo`) or replaced (`superseded`) — kept so we don't re-litigate

| Status | Doc | Summary |
| ------ | --- | ------- |
| 🚫 | [Obsidian CLI](./archived/obsidian-cli.md) | Vault automation via CLI — rejected in favor of Python scripts |
