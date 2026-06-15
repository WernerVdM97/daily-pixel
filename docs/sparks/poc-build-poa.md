---
title: POC Build — Plan of Attack
status: spark
domain: spark
phase: poc
tags:
- poc
- architecture
- agents
- build-plan
related:
- '[[poc-build-plan]]'
- '[[poc-tech-stack]]'
- '[[poc-spec-reconciliation]]'
- '[[poc-build-scaffold]]'
- '[[poc-build-probabilistic]]'
- '[[poc-build-world-tick]]'
---

# POC Build — Plan of Attack

> *Spark. Meta-doc: which patterns/principles to apply to each part of the [[poc-build-plan]], and how to set up agents to execute the parts independently. Graduates to `engine/` once the contracts firm up.*

---

## 1. Intent

Two questions:

- [?] What design principles let us build the POC fast **without** painting the MVP into a corner?
- [?] How do we carve the work so several agents build in parallel without colliding?

One answer threads both: **freeze the seams first, then fan out.** The seams are the contracts; once they exist, patterns fall out per slice and agents can work blind to each other.

---

## 2. Architectural stance — one process, one hard seam

The POC is a monolith ([[poc-tech-stack]]), but we draw **one load-bearing seam** between the Discord-facing frontend and the world engine. Everything crosses it as plain serializable data — never a `discord.js` object, never an ASCII string, never a SQLite row.

```
  ┌─────────────────────────┐         ┌──────────────────────────┐
  │  FRONTEND (adapter)      │  port   │  BACKEND (world engine)  │
  │  src/discord/, src/scenes│ ──────▶ │  src/engine/, src/db/    │
  │  • slash-command routing │  DTOs   │  • domain model + rules  │
  │  • buttons / modals      │ (JSON)  │  • action state machine  │
  │  • ASCII render          │         │  • tick / sim / repos    │
  │  • knows Discord         │         │  • knows nothing of      │
  │                          │ ◀────── │    Discord or ASCII      │
  └─────────────────────────┘         └──────────────────────────┘
        WorldEngine port = the only thing both sides import
```

- [!] **The replaceability test:** swapping the in-process `WorldEngine` for an HTTP client that implements the same interface must change **zero** frontend code. If an edit to move the backend out-of-process touches `src/discord/`, the seam leaked — fix the seam, not the frontend.
- [p] In-process now = no network, no serialization cost, single `tsx` process — matches the POC no-Docker/monolith stance.
- [p] Later = lift `src/engine/` into its own instance; the frontend swaps `InProcessWorldEngine` for `HttpWorldEngine`. The MVP split in [[poc-tech-stack]] becomes a deployment change, not a rewrite.
- [c] Costs discipline up front: DTOs and an interface that could otherwise be skipped in a monolith. Worth it — it's the one thing that's expensive to retrofit.

### Principles that enforce the seam

- [I] **Ports & Adapters (hexagonal):** `WorldEngine` is a port. `InProcessWorldEngine` and (future) `HttpWorldEngine` are adapters. Same for the LLM (`LlmGateway` port) and persistence (repository interfaces).
- [I] **Dependency inversion:** the frontend depends on the `WorldEngine` interface, never on `src/engine/` internals.
- [I] **Backend speaks data, frontend speaks Discord:** the engine returns `{ locationName, tags, description, decision, outcome }`; the frontend turns tags into ASCII and DTOs into embeds/buttons. Rendering never leaks across the seam — this is what keeps the engine portable.
- [I] **Anti-corruption layer:** a thin mapping at the boundary translates Discord interaction payloads ↔ engine DTOs, so neither side's vocabulary infects the other.

---

## 3. Pattern map — per build slice

| Build doc | Patterns / principles | Why |
|---|---|---|
| [[poc-build-scaffold]] | Repository pattern; schema migrations; **fail-fast** config/asset validation at boot; command-handler registry | Localize SQLite→graph-DB swap behind repos; bot never comes online with bad data; one place to register commands |
| [[poc-build-probabilistic]] | **State machine** (validate→decide→roll→resolve); **Strategy/adapter** for the LLM (`LlmGateway`); retry + **circuit-breaker**; DTO contract for decisions/mutations | The action lifecycle *is* a state machine; LLM provider must be swappable; fallback tiers are a degradation chain |
| [[poc-build-scenes]] | **Pure function** resolver (tags→scene); **memoization** (cache per location); loader/validator at boot | Deterministic, testable in isolation, zero LLM; lives entirely frontend-side |
| [[poc-build-world-tick]] | **Scheduled job** + idempotency (cron no-op if already ticked); **seeded determinism** (`NPC.id + day_number`); single-writer | Reproducible sim; admin `/sleep` and cron converge on the same effect |
| [[poc-build-polish]] | **Chain of responsibility** (LLM → simpler retry → template/divine fallback); centralized error mapper | Graceful degradation; one error-handling vocabulary |
| [[poc-build-deploy]] | Dev/prod **container parity**; CI quality gates; immutable-ish deploy (pull + restart) | Reproducible environment; auto-update without ceremony |

---

## 4. Contracts to freeze before fan-out

These are the seams. They are authored **once** (Phase 0), then frozen — fan-out agents code against them and may not edit them unilaterally.

- [ ] `src/engine/port.ts` — the `WorldEngine` interface + all DTOs crossing the seam (action start/step/resolve, look, tick result).
- [ ] `src/llm/port.ts` — the `LlmGateway` interface (one method: `decide(context) → DecisionDTO`), so providers and mocks are interchangeable.
- [ ] `src/db/schema.sql` + repository interfaces — the nine tables ([[poc-build-scaffold]]) and their typed accessors.
- [ ] Mock adapters — `MockWorldEngine`, `MockLlmGateway` — so frontend and backend agents test in isolation without each other.
- [!] Contract tests both sides run: prove an adapter satisfies its port. This is the integration safety net that lets agents work blind.

---

## 5. Agent execution plan

### Dependency graph

```
        ┌──────────────────────────────┐
        │ Phase 0 — FOUNDATION (1 agent)│  freezes contracts §4
        └───────────────┬──────────────┘
        ┌───────────────┼───────────────┬───────────────┐
        ▼               ▼               ▼               ▼
  A: det. commands  B: action engine  C: scenes     D: world tick
     (frontend)        (backend)      (frontend)      (backend)
        └───────────────┴───────┬───────┴───────────────┘
                                ▼
                  Phase 2 — INTEGRATION + POLISH (1 agent)
                                ▼
                  Phase 3 — DEPLOY (1 agent)
```

- [<] **Phase 0 is the gate** — everything depends on it. One agent, no parallelism here. Output: contracts frozen, `/ping` smoke passes, mocks in place.
- [I] **Phase 1 fans out** against frozen contracts. File ownership keeps them apart:
  - `[ ]` **A — deterministic commands** → owns `src/discord/commands/*`, `/join` wizard. Reads via `WorldEngine` + repos. Tests against `MockWorldEngine`.
  - `[ ]` **B — probabilistic engine** → owns `src/engine/action/*`, `src/llm/deepseek.ts`. Tests against `MockLlmGateway`.
  - `[ ]` **C — scenes** → owns `src/scenes/*`. Pure, no backend dependency — most independent of all.
  - `[ ]` **D — world tick** → owns `src/engine/tick/*`, `meta` repo. Seeded-deterministic, testable standalone.
- [!] **B and D both live in `src/engine/`** — the one real collision risk. Mitigate with sub-module ownership (`engine/action/` vs `engine/tick/`) and a shared, frozen `engine/domain/` from Phase 0. If they need to touch shared domain, that's a Phase-0-owner change, not a free-for-all.
- [<] **Phase 2** wires the real adapters in place of mocks, builds the fallback chains, runs the end-to-end pre-deploy pass.
- [<] **Phase 3** is [[poc-build-deploy]] — independent of everything once the app runs.

### How to brief each agent

- [I] **Isolation:** one git worktree per Phase-1 agent (`isolation: worktree`) — they edit disjoint paths and never block each other.
- [I] **Inputs per agent:** its build doc + the frozen contracts (§4) + its file-ownership list + "do not edit the ports."
- [I] **Skills to run, in order:** `spec-driven-development` (only if the slice's doc is thin) → `incremental-implementation` → `test-driven-development` → `code-review-and-quality`.
- [x] **Definition of done (per agent):** contract tests green + module tests green + `tsc --noEmit` clean. No "seems right."
- [c] Parallelism caps out at ~4 here — more agents wouldn't help, the slices are the natural unit. Don't over-shard.

---

## 6. Open questions

- [?] Does scene resolution belong fully frontend-side, or should the engine return a resolved `sceneId` (keeping tag logic backend)? Leaning frontend — keeps the engine presentation-free.
- [?] Is the `WorldEngine` port one fat interface or several (read vs command vs tick)? Several is cleaner (interface segregation) but more to freeze.
- [?] Do we let agents run truly concurrently, or sequence B→D to dodge the `src/engine/` collision entirely? Sequencing is safer for a POC; concurrency is faster if the sub-module split holds.
- [?] Worth a thin contract-test harness in Phase 0, or is `tsc` + manual integration enough for a one-week POC?
