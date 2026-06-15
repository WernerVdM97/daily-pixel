---
title: POC Build — Plan of Attack
status: decided
domain: engine
phase: poc
tags:
- poc
- architecture
- agents
- build-plan
related:
- '[[poc-tech-stack]]'
- '[[poc-spec-reconciliation]]'
- '[[poc-build-scaffold]]'
- '[[poc-build-probabilistic]]'
- '[[poc-build-world-tick]]'
---

# POC Build — Plan of Attack

> *Build root + meta-doc: which patterns/principles apply to each part of the POC build, and how to run it as a sequence of focused, fresh-context sessions with handover. The build slices: [[poc-build-scaffold]], [[poc-build-probabilistic]], [[poc-build-scenes]], [[poc-build-polish]], [[poc-build-world-tick]], [[poc-build-deploy]].*

---

## 1. Intent

Two questions:

- [?] What design principles let us build the POC fast **without** painting the MVP into a corner?
- [?] How do we slice the work into focused sessions that one agent can finish, test, and hand over cleanly?

One answer threads both: **draw one clean seam, then walk the build in test-gated sessions.** The seam is the contract each session codes against; the session boundaries keep a single fresh context focused on one demonstrable milestone.

- [!] **We do not parallelise agents.** Each session is a fresh session (fresh context), picking up from the previous one's handover. Sizing and handover — not worktrees or lane ownership — are the coordination tools.

---

## 2. Architectural stance — one process, one light seam

The POC is a monolith ([[poc-tech-stack]]), but we draw **one load-bearing seam** between the Discord-facing frontend and the world engine. Everything crosses it as plain serializable data — never a `discord.js` object, never an ASCII string, never a SQLite row.

```
  ┌─────────────────────────┐         ┌──────────────────────────┐
  │ FRONTEND (adapter)      │  port   │  BACKEND (world engine)  │
  │ src/discord/, src/scenes│ ──────▶ │  src/engine/, src/db/    │
  │ • slash-command routing │  data   │  • domain model + rules  │
  │ • buttons / modals      │ (JSON)  │  • action state machine  │
  │ • ASCII render          │ ◀────── │  • tick / sim / repos    │
  │ • knows Discord         │         │  • knows nothing of      │
  │                         │         │    Discord or ASCII      │
  └─────────────────────────┘         └──────────────────────────┘
   WorldEngine interface = the only thing both sides import
```

- [!] **Replaceability test:** swapping the in-process `WorldEngine` for an HTTP client that implements the same interface must change **zero** frontend code. If a future move to a separate instance touches `src/discord/`, the seam leaked — fix the seam, not the frontend.
- [>] **Ceremony level: lightweight.** One module boundary + the serializable-data rule. **No** formal hexagonal port layer, **no** stub HTTP adapter, **no** contract-test harness yet — that's MVP-grade architecture and would eat the week. Portability is *preserved as a property*, not *exercised*.
- [p] In-process now = no network, no serialization cost, single `tsx` process — matches the monolith/no-Docker stance.
- [p] Later = lift `src/engine/` into its own instance; the frontend swaps an in-process `WorldEngine` for an HTTP one. The MVP split in [[poc-tech-stack]] becomes a deployment change, not a rewrite.

### Principles that keep the seam honest

- [I] **One cohesive `WorldEngine` interface** (not segmented read/command/tick — that's premature for a POC).
- [I] **Backend speaks data, frontend speaks Discord/ASCII:** the engine returns `{ locationName, tags, description, decision, outcome }`; the frontend turns tags into ASCII and data into embeds/buttons. **Scene resolution lives frontend-side** — the engine stays presentation-free.
- [I] **Repository pattern** for persistence so the SQLite→graph-DB swap is localized.
- [I] **Mocks as a testing convenience, not a contract layer:** `MockWorldEngine` / `MockLlmGateway` exist so sessions can test in isolation — they are test fixtures, nothing more.

---

## 3. Pattern map — per build slice

| Build doc | Patterns / principles | Why |
|---|---|---|
| [[poc-build-scaffold]] | Repository pattern; schema migrations; **fail-fast** config/asset validation at boot; command-handler registry | Localize the DB swap; bot never comes online with bad data; one place to register commands |
| [[poc-build-probabilistic]] | **State machine** (validate→decide→roll→resolve); **Strategy/adapter** for the LLM (`LlmGateway`); retry + **circuit-breaker** | The action lifecycle *is* a state machine; the in-game LLM provider must be swappable; fallback tiers are a degradation chain |
| [[poc-build-scenes]] | **Pure function** resolver (tags→scene); **memoization** (cache per location); loader/validator at boot | Deterministic, testable in isolation, zero LLM; lives entirely frontend-side |
| [[poc-build-world-tick]] | **Scheduled job** + idempotency (cron no-op if already ticked); **seeded determinism** (`NPC.id + day_number`); single-writer | Reproducible sim; admin `/sleep` and cron converge on the same effect |
| [[poc-build-polish]] | **Chain of responsibility** (LLM → simpler retry → template/divine fallback); centralized error mapper | Graceful degradation; one error-handling vocabulary |
| [[poc-build-deploy]] | Dev/prod **container parity**; CI quality gates; pull-and-restart deploy | Reproducible environment; auto-update without ceremony |

---

## 4. The seam — what S0 freezes

S0 produces the thin set of things every later session codes against. Frozen after S0; a later session that needs a change raises it rather than editing silently.

- [ ] `src/engine/WorldEngine.ts` — the one interface + the plain data types crossing the seam (action start/step/resolve, look, tick result).
- [ ] `src/llm/LlmGateway.ts` — one method, `decide(context) → Decision`, so the in-game provider and the mock are interchangeable.
- [ ] `src/db/schema.sql` + repository interfaces — the nine tables ([[poc-build-scaffold]]) and their typed accessors.
- [ ] `MockWorldEngine`, `MockLlmGateway` — test fixtures for isolation.

---

## 5. Session plan

Single-threaded. Each session is a fresh context that starts from the prior handover, builds **one milestone**, and stops when its **test suite is green** (the robust-tests requirement is the literal stop condition). **TDD is the backbone**; other skills layer on per session.

> **Coding model:** every session runs on `deepseek-v4-pro`. (This is the *coding* model — distinct from the *in-game* LLM, which is v4-flash per [[poc-tech-stack]].)

| # | Milestone (start → stop) | Coding style / skills | Build doc |
|---|---|---|---|
| **S0** | Foundation & seam: init, tsconfig, deps, `.env`; schema + repos; `WorldEngine` + `LlmGateway` + mocks; asset loaders (fail-fast); `/ping` smoke | spec-driven + incremental; **doubt-driven on the seam** | [[poc-build-scaffold]] |
| **S1** | `/join` 6-step wizard → character in DB; `/stats`, `/backpack` | TDD + frontend-ui-engineering | [[poc-build-scaffold]] |
| **S2** | Remaining deterministic commands (`/look`, `/journal`, `/help`, `/feedback`, `/bug`, `/hi`) + scenes (loader, validator, tag resolver, render template) | TDD (pure resolver) + incremental | [[poc-build-scaffold]], [[poc-build-scenes]] |
| **S3** | One action end-to-end: state machine, DeepSeek `LlmGateway`, reactive decision loop, DC math (literal/signed), roll/skip/bail, mutation validate+apply, mid-action persistence + resumption | **TDD (hard)** + **doubt-driven** + source-driven (API client) | [[poc-build-probabilistic]] |
| **S4** | Action polish: two-tier LLM fallback, template fallback for `outcome_text` (logged), error mapper, idle messages, outcome rendering | TDD (inject failing mock) + doubt-driven | [[poc-build-polish]] |
| **S5** | World tick: `/sleep` (admin tick + non-admin rest), idempotent cron, `meta` (day/cron), player effects, seeded NPC movement, scaling | TDD (seeded determinism) + incremental | [[poc-build-world-tick]] |
| **S6** | Polish pass + pre-deploy: help content, flavor, end-to-end checklist, mobile pass, restart persistence | verify + code-review-and-quality + code-simplification | [[poc-build-polish]] |
| **S7** | Deploy: CI, Containerfile (Podman dev), LXC provision, systemd, deploy-check, invite testers | ci-cd-and-automation + shipping-and-launch | [[poc-build-deploy]] |

### Tests — the exit gate per session

- [x] **S0:** schema migration applies; repository CRUD against in-memory SQLite; asset-loader fail-fast cases; mocks satisfy interfaces.
- [x] **S1:** wizard state transitions; guards (already-has-character, 10-min timeout, name validation); stat computation from YAML modifiers.
- [x] **S2:** tag-resolver units (overlap score, tie→first, zero→`unknown.ascii`); scene validation failures (width >30, bad frontmatter); command output snapshots.
- [x] **S3:** DC accumulation + item bonus; skip wisdom check; mutation validation (bounds, max counts, atomic with `actions` insert); state-machine transitions; resumption round-trip. Mock `LlmGateway`.
- [x] **S4:** fallback tier transitions (tier-1 retry → tier-2 divine); `meta.llm_fallback_count` increments; template fallback selection; error mapping.
- [x] **S5:** idempotent cron (no double-tick same UTC day); seeded NPC movement reproducibility; player effects (recovery/decay/income/roll reset); admin vs non-admin `/sleep` branch.
- [ ] **S6:** scripted end-to-end happy path; the [[poc-build-polish]] pre-deploy checklist.
- [ ] **S7:** CI runs `tsc --noEmit` + the test suite; smoke deploy comes online.

---

## 6. Handover between sessions

A fresh session has none of the prior context. Two cheap habits carry it:

- [I] **Progress markers** — each session ticks the `[ ]` / `[/]` / `[x]` items in the build doc it touched (CONVENTIONS §1), so the next session sees state at a glance.
- [I] **Handover block** — at session end, append a 5-line block to the build doc just worked on:
  - `[x]` *Shipped:* what now works.
  - `[!]` *Frozen:* interfaces / decisions later sessions must honor.
  - `[x]` *Tests:* suite status + the command to run them.
  - `[>]` *Next:* the entry point for the following session.
- [p] Co-locating the handover with the work means the next session reads **one doc** to resume — no separate log to hunt down.
- [?] Open: keep handover blocks inline in each build doc, or collect them in one running `poc-build-handover.md`? Inline for now; revisit if it gets noisy.

---
