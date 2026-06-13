# Docs — Map of Content

The design vault for **The Warden's Oak**. Every doc here carries frontmatter (`status`, `domain`) and lives in a domain folder. New to this? Read **[CONVENTIONS.md](./CONVENTIONS.md)** first.

Status legend: 🌱 `spark` · 🔭 `exploring` · ✅ `decided` · 🪦 `superseded`

---

## 🧭 vision/ — mission, pillars, north star
_The "why." Goals and non-goals._

- 🔭 [The Warden's Oak — Pitch & Pillars](./vision/pitch-and-pillars.md) — the elevator pitch, the year-long premise, and the Thematic DNA table (frieren, dnd, lotr, castlevania, fable…).

## 🎲 game/ — mechanics, loop, economy, world
_What the game **is** to play._

- 🔭 [Core Loop — Rolls, Weekly Rhythm, Co-op](./game/core-loop.md) — daily/weekly rolls, the weekly floor & death track, co-op bonuses, auto-sim, stamina.
- 🔭 [NPC Simulation & Town Economy](./game/npc-economy.md) — deterministic NPC daily loop, weekly LLM sentiment pass, light town economy, the Garrick worked example.
- 🔭 [Convergence, Climax & Player Lifecycle](./game/progression.md) — how the fellowship forms, the December climax, the year-arc timeline.
- 🔭 [World & Setting](./game/world-setting.md) — the Warden's Oak, the Threat, the emergent world map.
- 🔭 [Hazard Map](./game/hazard-map.md) — no-gos, rabbit holes, and known risks. The scope-discipline doc.

## ⚙️ engine/ — graph DB, render, sim, LLM
_How it **runs** under the hood._

- 🔭 [Technical Architecture](./engine/architecture.md) — the high-level system diagram, token-optimization strategy, graph DB schema, ASCII art engine.
- 🔭 [Graph Data Model — Schema Reference](./engine/data-model.md) — standalone reference: all node types, edge types, per-entity frontmatter schema, query patterns.
- 🔭 [The Vault View — World State Projection](./engine/world-state-projection.md) — graph DB → markdown vault at ~0 tokens; the render pipeline, data-vs-prose split, two mechanisms.
- 🔭 [Character Drivers — the D&D Layer](./engine/character-drivers.md) — how alignment/class/ideals/flaws/bonds are modeled along the data↔prose spectrum.
- 🔭 [Sentiment, Bonds & Relationships](./engine/social-model.md) — the three social axes and how each updates and drives the sim.
- 🔭 [Moral Drift](./engine/moral-drift.md) — continuous moral vector, derived alignment label, the governor loop, ambient corruption.
- ✅ [ASCII Render Pipeline](./engine/ascii-render-pipeline.md) — confirmed POC render path: photos → ASCII via CLI → Discord code blocks.
- 🌱 [Render Engine — Size Estimates](./engine/render-engine-estimates.md) — PNG/MP4 file-size data vs. Discord limits (a possible MVP+ richer-visual path).

## 🖥️ ui/ — Discord UX & mockups
_What the player sees and touches._

- 🔭 [Discord UX — Command Flows & Interaction Patterns](./ui/discord-ux.md) — the action layer, command structure, daily roll flow, button/reaction patterns, mobile-first constraints.
- 🔭 [Example Scenes — Rendered Mockups](./ui/example-scenes.md) — the Day-47 daily-roll card and the Warden-at-night interaction, as ASCII.
- 🖼️ `ui/mockups/roll_result_card.png` — image mockup of a roll result card.

## 📌 decisions/ — resolved trade-offs (ADRs)
_Where conflicts get settled, once._

- ✅ [Render Strategy: ASCII for POC, PNG/MP4 deferred](./decisions/render-strategy.md) — reconciles the ASCII pipeline vs. the PNG/MP4 estimates.

## 💡 sparks/ — raw brainstorm inbox
_Unsorted, allowed to be messy. Promote into a domain when it earns one._

- 🌱 [Login Streaks](./sparks/login-streaks.md) — reward consecutive logins (e.g. the bonus roll in the example scene). To be scoped.
- 🌱 [Obsidian CLI](./sparks/obsidian-cli.md) — using Obsidian CLI for vault automation, frontmatter linting, MOC generation, and agentic access.

---

> Maintenance: when you add a doc, add its line here. When you change a doc's `status`, update the badge here. This map is the canary — if a file exists that isn't listed, it's drifting toward slop.
