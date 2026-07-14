---
title: Layer Boundaries & the JSON Seam
status: spark
domain: spark
phase: mvp
tags: [architecture, layering, discord, engine, render, controller, json, seam, agent-player, sim, testing]
related:
  - "[[discord-interaction-layer]]"
  - "[[mvp-architecture]]"
  - "[[mvp-llm-prompt-architecture]]"
---
How the layers wire together today versus a frontend-neutral target where every frontend (Discord, a DM-agent player, a future web UI) talks to the game through one JSON seam. The engine and renderers are already clean; the missing piece is an application/controller layer, currently smeared across the Discord handlers. Extracting it is the prerequisite for the "all features on, driven by agents" short-term sim, and doubles as the future frontend-swap seam.

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

  subgraph L1["Discord layer — src/discord/*, index.ts (does too much)"]
    direction TB
    IN["Input extraction<br/>interaction.user.id · options · customId"]:::messy
    FLOW["Flow orchestration<br/>guards · day-job menu · resume<br/>auto-finish vs buttons · nav routing"]:::messy
    SESS["Session state<br/>pendingDecisions · menuMessages · inFlight"]:::messy
    VIEW["View assembly<br/>buildDecisionMessage / buildOutcomeEmbed<br/>welded to discord.js EmbedBuilder"]:::messy
    LEAK["Direct DB write — rule leak<br/>commute rule: charRepo.update (index.ts:2058)"]:::messy
  end

  RENDER["render/* — pure<br/>DTO in, string out"]:::clean
  ENGINE["Engine — WorldEngine seam<br/>plain data · game rules<br/>(some inline SQL)"]:::clean
  LLM["LLM gateways (injected)"]:::neutral
  DB["Persistence — repositories/*"]:::neutral
  SIM["sim/ harness<br/>LLM-cut · scales months of data"]:::clean

  IN --> FLOW
  FLOW --> SESS
  FLOW --> VIEW
  VIEW --> RENDER
  FLOW --> ENGINE
  LEAK -.->|bypasses engine| DB
  ENGINE --> LLM
  ENGINE --> DB
  SIM ==>|enters at engine| ENGINE
```

[p] **The engine boundary was drawn deliberately and holds.** `WorldEngine` is a plain-serialisable seam (its header says so), the engine imports nothing from `discord.js` or `render/`, and `sim/` proves it runs standalone.
[p] **`render/*` is genuinely pure** — its own input DTOs, string output, zero imports from engine/db/discord.
[c] **The application boundary above the engine was never drawn.** Flow, session state, and view-assembly all accreted inside the Discord handlers because a single `discord.js` `Interaction` bundles input + response + identity, so guard→engine→build-embed→reply in one handler is the path of least resistance. The `index.ts` dispatcher is now a ~2460-line `if/else` on `customId` with 20-plus branches.
[!] **One real rule leak:** the "commute from the Oak to workplace" path writes character stamina + location straight to the DB via `charRepo.update` (`index.ts:2058`), bypassing the engine. It is the canary: a game rule living in the UI. Contained (one site) but it is exactly the drift that grows.

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

## Open questions / brainstorm

[!] **Fix the canary first, standalone:** move the commute rule (and any other handler-resident rule) into the engine before the larger extraction. Small, safe, proves the direction.
[?] **Session-state ownership.** Does the controller hold `pendingDecision`, or does the engine absorb option-resolution into its already-persisted action state so the controller stays *stateless*? Engine already persists `lastActionState` + `resumeAction`; folding index→label resolution into the engine keeps the controller thin. Leaning engine-owned.
[?] **Rendering split.** Controller emits a semantic view-state and each adapter styles it (Discord→embeds, agent→text), versus a shared presentation service emitting a neutral view-spec adapters merely paint. Leaning semantic view-state + shared pure renderers.
[?] **Protocol transport.** In-process first (agent harness imports the controller, passes JSON objects) versus a network JSON-RPC server from day one. Leaning in-process; the socket is a later bolt-on once agents must run out-of-process. The protocol is the asset, not the transport.
[?] **Relationship to [[discord-interaction-layer]].** That doc standardises Discord *plumbing* (ack/defer, loading envelope, component/embed builders, error funnel, in-flight guard). It cleans the adapter; it does not extract the controller. After extraction, its "five concerns" become the thin adapter's internal job, much smaller. Sequence: controller extraction first, plumbing on top. (Its own closing note already senses an "engine/ui boundary" to draw.)
[?] **sim vs agent-player.** Keep both, don't merge: `sim/` = engine-level, deterministic, LLM-cut, scale; agent-player = controller-level, real LLM, all features. Different depths, different jobs.
[I] **Declarative controller.** Could the controller be a route table rather than hand-written branches, folding in the interaction-layer's route-table idea so both frontends and the ack model share one declaration?

Why do it now, not later:
[p] The "all features on, agent-driven" target is **unreachable** without the controller — those features live in the handlers, so `sim/` cannot reach them. Extraction is a prerequisite, not polish.
[p] Same seam serves the eventual frontend swap. Build once.
[p] Stops further rule/flow accretion in the handlers (the commute leak is the warning shot).
[c] The bulk is untangling the ~2460-line `index.ts` dispatcher — the busiest file in the repo.
[c] Regression risk in the live Discord flow during extraction. Mitigate by migrating screen-by-screen with the existing flows as the behavioural oracle.

---

Next steps: agree the seam depth and the session-state ownership question, then inventory the `index.ts` dispatcher branches into `pure-Discord` vs `game-flow` buckets to size the extraction. Related: [[discord-interaction-layer]] (adapter plumbing), [[mvp-architecture]] (system target), [[mvp-llm-prompt-architecture]] (sim harness lineage).
