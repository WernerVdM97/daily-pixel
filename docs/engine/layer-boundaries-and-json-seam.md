---
title: Layer Boundaries & the JSON Seam
status: decided
domain: engine
phase: mvp
tags: [architecture, layering, discord, engine, render, controller, json, seam, agent-player, sim, testing]
related:
  - "[[discord-interaction-layer]]"
  - "[[mvp-architecture]]"
  - "[[mvp-llm-prompt-architecture]]"
---
How the layers wire together today versus a frontend-neutral target where every frontend (Discord, a DM-agent player, a future web UI) talks to the game through one JSON seam. The engine and renderers are already clean; the missing piece is an application/controller layer, currently smeared across the Discord handlers. Extracting it is the prerequisite for the "all features on, driven by agents" short-term sim, and doubles as the future frontend-swap seam. All open questions were settled 2026-07-18 (see Decisions); this is now the running spec, with progress tracked in the build plan below.

---

## The layers (glossary)

Six responsibilities. The problem is not that they exist; it is that three of them currently live in one place (the Discord layer) instead of being separated.

[I] **Transport / frontend adapter** — talks the wire protocol of one client. Today: `discord.js`. Captures input events, paints output.
[I] **Application / flow orchestration** — the game *as played*: guards, which screen to show, menu composition, resume, auto-finish-vs-buttons, nav routing, per-session working state. Frontend-agnostic by nature.
[I] **Presentation / rendering** — turns semantic outcome data into a medium (ANSI frames, embeds, plain text).
[I] **Engine / domain** — all game rules and state transitions. Plain data in, plain data out.
[I] **Persistence** — durable state behind repositories.
[I] **LLM pipeline** — decision/critic/classify gateways, injected into the engine.

---

## Now — current state

```mermaid
flowchart TB
  classDef clean fill:#1e3a2f,stroke:#3fb37f,color:#e6ffee
  classDef messy fill:#3a1e22,stroke:#d16a70,color:#ffe6e8
  classDef neutral fill:#26262e,stroke:#7a7a90,color:#e8e8f0

  subgraph L1["Discord layer — index.ts + src/discord/* (does too much)"]
    direction TB
    IN["Input extraction<br/>interaction.user.id · options · customId"]:::messy
    FLOW["Flow orchestration — index.ts dispatcher<br/>guards · day-job menu · resume<br/>auto-finish vs buttons · nav routing"]:::messy
    CMD["Command files — src/discord/commands/*<br/>action · sleep · hi hold resume/lastActionState flow too"]:::messy
    SESS["Session state<br/>pendingDecisions · menuMessages · inFlight"]:::messy
    VIEW["View assembly<br/>buildDecisionMessage / buildOutcomeEmbed<br/>welded to discord.js EmbedBuilder"]:::messy
    LEAK["Direct DB write — rule leak<br/>commute rule: charRepo.update (index.ts, the commute block)"]:::messy
  end

  RENDER["render/* — pure<br/>DTO in, string out"]:::clean
  ENGINE["Engine — WorldEngine seam<br/>plain data · game rules<br/>(some inline SQL)"]:::clean
  LLM["LLM gateways (injected)"]:::neutral
  DB["Persistence — repositories/*"]:::neutral
  SIM["sim/ harness<br/>LLM-cut · scales months of data"]:::clean

  IN --> FLOW
  FLOW --> CMD
  FLOW --> SESS
  FLOW --> VIEW
  CMD --> VIEW
  VIEW --> RENDER
  FLOW --> ENGINE
  CMD --> ENGINE
  LEAK -.->|bypasses engine| DB
  ENGINE --> LLM
  ENGINE --> DB
  SIM ==>|enters at engine| ENGINE
```

[p] **The engine boundary was drawn deliberately and holds.** `WorldEngine` is a plain-serialisable seam (its header says so), the engine imports nothing from `discord.js` or `render/`, and `sim/` proves it runs standalone.
[p] **`render/*` is genuinely pure** — its own input DTOs, string output, zero imports from engine/db/discord.
[c] **The application boundary above the engine was never drawn.** Flow, session state, and view-assembly all accreted inside the Discord handlers because a single `discord.js` `Interaction` bundles input + response + identity, so guard→engine→build-embed→reply in one handler is the path of least resistance. The `index.ts` dispatcher is now a ~2460-line `if/else` on `customId` with 20-plus branches, and it is not the only home: the `src/discord/commands/*` files (`action`, `sleep`, `hi`) carry their own resume/`lastActionState` flow, so the extraction is bigger than one file.
[!] **One real rule leak:** the "commute from the Oak to workplace" path writes character stamina + location straight to the DB via `charRepo.update` (`index.ts`, under the `── Commute from the Oak to the workplace ──` block — the sole direct repo write in the whole Discord layer), bypassing the engine. It is the canary: a game rule living in the UI. Contained (one site) but it is exactly the drift that grows.

---

## Target — best-practice future

```mermaid
flowchart TB
  classDef adapter fill:#1e2c3a,stroke:#5b9bd5,color:#e6f0ff
  classDef core fill:#1e3a2f,stroke:#3fb37f,color:#e6ffee
  classDef seam fill:#3a331e,stroke:#d5b45b,color:#fff6e0

  subgraph FE["Frontend adapters — thin: transport + render only"]
    direction LR
    DISC["Discord adapter"]:::adapter
    AGENT["Agent-player adapter<br/>DM agents · test · feedback · data-gen"]:::adapter
    WEB["Web adapter (future)"]:::adapter
  end

  PROTO{{"JSON protocol seam<br/>input events  ⇅  view-state DTOs"}}:::seam

  CTRL["Session controller / application layer (NEW)<br/>flow · guards · menu compose · resume<br/>emits semantic view-state — no discord.js"]:::core

  PRES["Presentation — shared, pure<br/>render/* + view-state → medium"]:::core
  ENGINE2["Engine / domain<br/>ALL rules incl. commute · plain data"]:::core
  DB2["Persistence — engine is the ONLY writer"]:::core
  LLM2["LLM gateways (injected)"]:::core

  DISC <--> PROTO
  AGENT <--> PROTO
  WEB <--> PROTO
  PROTO <--> CTRL
  CTRL --> ENGINE2
  CTRL --> PRES
  DISC -.reuses.-> PRES
  AGENT -.reuses.-> PRES
  ENGINE2 --> LLM2
  ENGINE2 --> DB2

  SIM2["sim/ harness<br/>LLM-cut · months of data"]:::core
  SIM2 ==>|still enters at engine| ENGINE2
```

The shape in one sentence: **Discord and the agent-player become peer adapters over one JSON seam; a new session controller owns all flow; the engine owns all rules; rendering is a shared pure service any adapter can reuse.**

[I] **Adapters shrink to two jobs:** translate their transport's events into protocol input-events, and paint the returned view-state in their medium. No game logic.
[I] **The controller is the new layer** and is transport-neutral: it never imports `discord.js`. It emits a *semantic* view-state DTO (screen kind, prompt, narration, options, art slots, footer), not embeds.
[I] **Rendering is shared:** the pure `render/*` frames plus a view-state→medium step, callable by any adapter, so an agent can see close to what a Discord player sees.
[I] **Two test depths, kept distinct:** `sim/` still enters at the *engine* (fast, deterministic, LLM cut — for months of data); the *agent-player* enters at the *protocol/controller* (all features on, real LLM — for bug-hunting and feedback). This is the "in between" target: a shorter sim of the whole game, not the engine core alone.

---

## Gap — how far from target

| Layer | Now | Target | Distance |
| --- | --- | --- | --- |
| Engine / domain | Clean seam; a couple of rules leaked up (commute); some inline SQL | All rules in engine; sole DB writer | **Small** |
| Persistence | Behind repos mostly; engine inline SQL + 1 Discord direct write | Every write via repos, engine-only | **Small–med** |
| Presentation | `render/*` already pure ✓; view-assembly welded to `discord.js` | Semantic view-state DTO + shared pure renderers | **Medium** |
| Application / controller | Does not exist; flow spread across `index.ts` dispatcher + command files | Dedicated transport-neutral controller (flow + session state) | **Large — the bulk** |
| Protocol seam | Does not exist | JSON input-events + view-state DTOs | **Medium (design-led, foundational)** |
| Frontend adapters | Discord only, fat | Thin adapters; + agent-player, + web later | **Medium** |
| Test harnesses | `sim/` at engine level only | `sim/` (engine) + agent-player (controller, all features) | **Agent-player is net-new** |

Already banked (the reason this is a refactor, not a rewrite): the engine seam, the pure renderers, the repository layer, the `sim/engine-factory` wiring, and the JSON-serialisable action state that already round-trips through the DB.

---

## Decisions — settled 2026-07-18

Every open question from the spark phase is resolved below. Changing any of these now requires a `decisions/` record.

1. **Session state is engine-owned.** The engine absorbs option-resolution (button index → option label) into its already-persisted action state — `lastActionState.pendingDecision` carries the options and `WorldEngineImpl` already parses them — so the controller stays stateless. The Discord-side `pendingDecisions` map (`src/discord/commands/action.ts`) is deleted, not relocated.
2. **Rendering: semantic view-state + shared pure renderers.** The controller emits a semantic view-state DTO (screen kind, prompt, narration, options, art slots, footer); the pure `render/*` frames plus a view-state→medium step turn it into the medium; adapters only paint. No per-adapter styling logic, so an agent sees close to what a Discord player sees.
3. **Protocol transport: in-process first.** The agent harness imports the controller and passes JSON objects. The protocol shape is the asset; a network JSON-RPC socket is a later bolt-on once agents must run out-of-process.
4. **Sequencing: commute fix first; oracle before extraction.** The commute rule moves into the engine as a standalone first slice — one site, engine-testable in isolation, needs no Discord-flow oracle. The behavioural oracle (a characterisation baseline of current Discord behaviour to diff against) is a hard prerequisite for the dispatcher extraction only. Oracle mechanism is the implementing lead's call; golden transcripts through the live handlers look cheaper than standing the agent-player up against the unextracted flow, since the agent-player needs its own adapter work first.
5. **Relationship to [[discord-interaction-layer]]: controller extraction first, plumbing on top.** That doc standardises Discord *plumbing* (ack/defer, loading envelope, component/embed builders, error funnel, in-flight guard); it cleans the adapter but does not extract the controller. After extraction its "five concerns" become the thin adapter's internal job, much smaller.
6. **sim vs agent-player: keep both, don't merge.** `sim/` = engine-level, deterministic, LLM-cut, months-of-data scale. Agent-player = controller-level, real LLM, all features on. Different depths, different jobs.

Carried idea, not a commitment: [I] **declarative controller** — a route table rather than hand-written branches, folding in the interaction-layer's route-table idea so both frontends and the ack model share one declaration. The lead may adopt it during M3 if it pays for itself.

Why now, not later:
[p] The "all features on, agent-driven" target is **unreachable** without the controller — those features live in the handlers, so `sim/` cannot reach them. Extraction is a prerequisite, not polish.
[p] Same seam serves the eventual frontend swap. Build once.
[p] Stops further rule/flow accretion in the handlers (the commute leak is the warning shot).
[c] The bulk is untangling the ~2460-line `index.ts` dispatcher — the busiest file in the repo.
[c] Regression risk in the live Discord flow during extraction. Mitigated by M1 (oracle first) and migrating screen-by-screen against it.

---

## Build plan — progress

Milestones, not tasks — the implementing lead breaks each into its own build plan. Order is binding: M0 → M1 → M2 → M3 → M4 (M2 may start alongside M1; nothing extraction-shaped lands before M1 is green).

[x] **M0 — Commute rule into the engine.** _(done 2026-07-18, commit `98a4de1` — plan + execution state in [[json-seam-build-plans]])_ The engine's work-action path owns "at the Oak → move to workplace, −1 stamina"; the handler only renders the outcome. Deletes the sole direct `charRepo.update` in the Discord layer (`src/index.ts`, the commute block). Covered by engine tests; `sim/` exercises it for free.
[x] **M1 — Behavioural oracle.** _(done 2026-07-19, oracle `2a3a069` + resolved-path fix `0bd0401`, on the minimal DI hoist `b9b4c4a` — plan + execution state in [[json-seam-build-plans]])_ Golden-transcript characterisation of all 17 dispatcher leaves (incl. the resolved/outcome render path), cascade order pinned; diffable after every extraction step. Hard prerequisite for M3, now met.
[ ] **M2 — Semantic view-state DTO + shared renderers.** Define the view-state and the view-state→medium step; port `buildDecisionMessage` / `buildOutcomeEmbed` behind it so Discord output is unchanged.
[ ] **M3 — Controller extraction, screen-by-screen.** A transport-neutral session controller absorbs the `index.ts` dispatcher branches and the command-file flow (`action`, `sleep`, `hi`); the engine absorbs option-resolution (decision 1); the `pendingDecisions` map dies; the oracle stays green after each screen.
[ ] **M4 — Agent-player adapter.** In-process adapter over the JSON seam driving the controller with a real LLM, all features on — the "whole game, shorter horizon" sim.

---

Next step: hand to an orchestrated-delegation lead; first slice is M0. Inventorying the `index.ts` dispatcher branches into `pure-Discord` vs `game-flow` buckets is the lead's first sizing task for M3. Related: [[discord-interaction-layer]] (adapter plumbing, sequenced after), [[mvp-architecture]] (system target), [[mvp-llm-prompt-architecture]] (sim harness lineage).
