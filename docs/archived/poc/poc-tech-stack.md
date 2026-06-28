---
title: POC Tech Stack
status: shipped
domain: archived
phase: poc
superseded_by: "implemented in code"
tags:
- poc
- engine
related:
- '[[the-poc]]'
- '[[archived/poc/poc-build-poa|poc-build-poa]]'
- '[[archived/poc/poc-spec-reconciliation|poc-spec-reconciliation]]'
---
,
# POC Tech Stack

> *Extracted from [[the-poc]]. Technology choices for the one-week proof-of-concept — and what's explicitly deferred to MVP.*

---

## Tech Stack (POC)

| Layer         | Choice                     | Why                                                                                                                          |
| ------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Language      | TypeScript                 | Same as planned. discord.js is the gold standard.                                                                            |
| Bot framework | discord.js                 | Slash commands, buttons, message editing — all first-class.                                                                  |
| Runtime       | Node.js + tsx              | No build step. `tsx` runs TS directly.                                                                                       |
| Database      | SQLite (`better-sqlite3`)  | File-based, zero ops. Lives in the LXC container. Sync API — no connection pool, no async overhead for a single-process bot. |
| LLM           | DeepSeek V4 Flash API      | Cheap, fast. ~$0.14/1M input tokens.                                                                                         |
| Game data     | YAML (`js-yaml`)           | Char-creation options + item sets in `assets/char-creation/*.yml`. Loaded + validated at startup, fail-fast.                  |
| ASCII art     | File-loaded fragments      | 21 `.ascii` files in `assets/scenes/` with tag frontmatter, parsed via `js-yaml`. Deterministic tag matching — see [[poc-build-scenes]]. |
| Hosting       | LXC Debian container       | Single container, single process. No Docker overhead for POC.                                                                |

---

## Architecture (POC)

```
┌─────────────────────────────────┐
│         LXC Debian              │
│                                 │
│  ┌───────────────────────────┐  │
│  │    Node.js process        │  │
│  │                           │  │
│  │  discord.js  ── Discord   │  │
│  │  LLM client  ── DeepSeek  │  │
│  │  SQLite      ── file.db   │  │
│  │  ASCII frags ── strings   │  │
│  └───────────────────────────┘  │
│                                 │
└─────────────────────────────────┘
```

Monolith. One process does everything. Good enough for a POC with one concurrent player.

---

## Architecture (MVP Target)

```
┌──────────────────┐     ┌──────────────────────┐
│   Frontend       │     │   Backend            │
│   (TypeScript)   │     │   (TBD runtime)      │
│                  │     │                      │
│  discord.js      │────▶│  World sim engine    │
│  Command router  │     │  Tick scheduler      │
│  ASCII renderer  │     │  Graph DB (SQLite)   │
│  LLM gateway     │     │  NPC routines        │
│                  │     │  Economy tick        │
│                  │     │  CRUD API            │
└──────────────────┘     └──────────────────────┘
  Docker container         Docker container
```

Split for MVP: TypeScript handles Discord I/O only (the "frontend"). A separate backend runtime handles the world simulation, graph DB CRUD, and cron ticks. Communicates over HTTP or a simple IPC bridge. Docker Compose for local dev, two containers.

**Why split?** The Discord process should never block on a long-running sim tick. The backend can be written in a language better suited to deterministic simulation and graph traversal — Ruby, Scala, Rust, Go, or even Python are all on the table for the MVP backend decision.

---

## No-Gos for POC (revisited at MVP)

| No-Go | Rationale | Revisit |
|---|---|---|
| **Split front/back architecture** | POC is a monolith. One process, one container. Splitting adds dev complexity without proving anything about engagement. | MVP — when sim ticks and multi-player concurrency matter. |
| **Backend runtime other than Node** | TypeScript does everything in POC. No need to learn/debug a second language stack yet. | MVP — when the world sim needs a dedicated runtime. |
| **Docker / Docker Compose (prod)** | Production runs in an LXC Debian container. One `apt install nodejs`, one `npm install`, one `tsx index.ts`. A Podman `Containerfile` exists for **local dev parity only** ([[poc-build-deploy]] §2) — no orchestration. | MVP — when front + back need orchestration. |
| **Graph DB / edge model** | SQLite with flat tables is enough. `players` + `actions` + `items`. No recursive CTEs, no graph traversal. | MVP — when the 2-hop subgraph queries actually matter. |
| **Connection pooling / async DB** | `better-sqlite3` is synchronous. Single process = no contention. | MVP — if the backend handles concurrent player requests. |
| ~~**Cron / tick scheduler**~~ | **Superseded by [[poc-spec-reconciliation]] (D2).** The POC now runs an admin-gated `/sleep` **and** a nightly 3:30 UTC cron — see [[poc-build-world-tick]]. | — |

---

## Hosting

| | POC | MVP |
|---|---|---|
| **Environment** | LXC Debian container on a Debian host | Docker Compose (2 containers: front + back) |
| **Provisioning** | Manual — `apt install`, `git clone`, `npm install` | Dockerfile + `docker compose up` |
| **Persistence** | SQLite file in container. Backup: `scp file.db` off-box. | SQLite file in backend container. Volume mount for dev. |
| **Process management** | `tsx index.ts` in a tmux session or systemd unit | `docker compose up -d` |
