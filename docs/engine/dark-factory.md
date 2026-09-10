---
title: Dark Factory
status: decided
domain: engine
phase: poc
tags: [process, automation, agents, github]
related:
  - "[[TODO]]"
---
_How this repo runs a continuously-triaging, human-gated agent factory on top of a GitHub Projects board._

---

## What it is

The Dark Factory is a set of scheduled agent loops that keep the backlog triaged, execute approved work, and audit themselves — without ever acting on work a human has not signed off. The **GitHub Project "Dark Factory" (#6)** is the single control plane; the agents read and write it, and the human steers by moving cards.

The one rule that defines the factory: **an agent may only execute an item whose board Status is `Approved`, or that carries a standing-approval `auto:*` label and stays inside that class.** Everything else is read-only. Moving a card to `Approved` is the human's action and the human's alone.

## The board

Status flow (single-select `Status` field):

```text
Inbox → Triaged → Approved → In Progress → In Review → Done
                  ↑ human only
Blocked (needs-human-decision) is reachable from any stage except Done; triage or the human sets it.
```

| Status | Set by | Meaning |
| --- | --- | --- |
| `Inbox` | seeding / triage | Raw item, not yet enriched |
| `Triaged` | factory-triage | Scoped, has acceptance criteria, awaiting human approval |
| `Approved` | **human only** | Signed off; agents may execute |
| `In Progress` | factory-executor | An executor has claimed it |
| `In Review` | factory-executor | PR open, awaiting owner review/merge |
| `Blocked` | triage / human | Needs a human decision (`needs-human-decision` label) |
| `Done` | sweeper / human | PR merged |

`Priority` (P0–P3) ranks within a column. Labels carry two axes: `area:*` (subsystem) and the gate labels `auto:*`, `needs-human-decision`, `factory:seeded`. The declarative source of truth for labels is `.github/labels.yml`. Milestones map to planning horizons: Release A closeout, POC+ arc, v0.3.x polish, MVP, MVP+ / someday.

## Where the factory lives

| Path | What it is |
| --- | --- |
| `.pi/agents/factory-{triage,executor,sweeper,scrumo,escalator}.md` | Loop role definitions: authority, gate, memory scope, report shape |
| `.pi/subagents/schedules/` | The four durable schedules; paused runtime state, not tracked |
| `.pi/factory/project.json` | The board's field and option ids, so agents don't hardcode them |
| `.pi/factory/REQUIREMENTS.md` | The decisions behind scrumo, the escalator and model tiering; implemented 2026-09-10 |
| `.pi/factory/memory/` | The loops' topic-scoped memory |

The loops run with `context: "fresh"`, so `.pi/factory/memory/` is the only thing they remember between runs: a tracked skeleton of topic folders (taxonomy reviewable in a PR) with gitignored `memory.md` contents, per the `factory-memory` skill. One dated fact per line; a stale line is deleted, never contradicted.

## The four loops

Each of the four is a project-scoped agent in `.pi/agents/` plus a durable schedule (`schedule.list`); the escalator is the exception, a child the executor spawns rather than a scheduled loop. All schedules are currently **paused** — nothing runs until the owner fires it manually with `schedule.run` or resumes the schedule.

| Loop | Agent | Cadence (when resumed) | Writes code? |
| --- | --- | --- | --- |
| Triage | `factory-triage` | 6h | No — `Inbox` → `Triaged`/`Blocked`, comments, labels |
| Executor | `factory-executor` | 6h | Yes — the only one, and only behind the gate |
| Sweeper | `factory-sweeper` | 1d | No — gate audit, CI re-check, board hygiene, digest |
| Scrumo | `factory-scrumo` | 1d | No — DM digest, three recommended actions, blocker comments |

**Triage** reads Inbox items, dedupes, resolves `[[doc-links]]`, drafts acceptance criteria, asks clarifying questions as comments, and moves items to Triaged — or to Blocked with `needs-human-decision` when it cannot proceed.

**Executor** picks at most one item: highest-priority-then-oldest among Status=`Approved`, plus any `auto:*`-class item in Inbox/Triaged. It claims the item, builds it in an isolated worktree off `dev` via the repo's orchestrated-delegation loop, runs the full suite + typecheck, gets a fresh-context review, opens a PR to `dev` with `Closes #n`, and moves the item to `In Review`. It never merges.

**Sweeper** is the gate's backstop: it flags any PR whose issue was never Approved and has no `auto:*` label, re-checks CI on idle PRs, lists stale branches, resets stalled `In Progress` items back to `Approved`, marks merged items `Done`, and posts a digest.

**Scrumo** is the unblocker: it reads the board, milestones, PRs and checks, the roadmap, `CHANGELOG.md` and `VERSION`, and DMs the owner a digest of what changed, what is blocked or at risk, and exactly three recommended actions phrased as decisions. It never changes Status, Priority or labels; its only board writes are comments on items it flags as blocked or at risk, and it needs `DISCORD_TOKEN` + `ADMIN_USER_ID` in the repo `.env` for the DM.

**Escalator** is not scheduled: the executor spawns it as a one-shot child (`z-ai/glm-5.3` at `max` thinking) when a slice needs real reasoning: a schema change, an unexplained verification failure, a risky live path. It reads the spec and the exact commit, reproduces the problem, and returns a binding verdict with a concrete plan; the executor lands the work itself and re-verifies.

## The gate

Enforced twice, belt and braces:

1. **Instruction-level** — the executor's role definition refuses anything not Approved/`auto:*`.
2. **Mechanical** — the sweeper audits open PRs against issue approval state and flags violations.

Standing-approval classes (the only work that can run without per-item approval): `auto:docs` (docs/ and comments only), `auto:changelog` (CHANGELOG.md upkeep), `auto:tests` (test-only, no `src/`). Anything else always needs Status=`Approved`.

## Running it (manual, while trust builds)

Schedules live under `.pi/subagents/schedules/` and are paused by default. From a pi session in this repo:

- Fire one triage pass: `subagent({ action: "schedule.run", id: "factory-triage" })`
- Fire one executor pass: `subagent({ action: "schedule.run", id: "factory-executor" })`
- Fire a scrumo digest: `subagent({ action: "schedule.run", id: "factory-scrumo" })`
- Fire a sweep: `subagent({ action: "schedule.run", id: "factory-sweeper" })`

Inspect runs with `schedule.history` and the usual `status`/`fleet` views.

## Promoting to unattended (nightly)

End state: triage nightly, executor 1–2 runs around 04:00–06:00. To get there:

1. Resume the schedules: `schedule.resume` per loop, and tune `every:` to the target cadence.
2. For true lights-out (laptop closed), add an external launcher on the `schedule.run-due` seam — a cron/systemd entry that fires due schedules headlessly. Defer this until the loops have earned trust manually.
3. The watchdog (opt-in adversarial diff review at `agent_end`) is a natural extra review layer once running unattended; see `/subagents-watchdog`.

## Non-goals

- The factory never merges PRs, never pushes to `dev`/`main`, never tags releases. Those stay human per the `releasing` skill.
- The board is for _work items_. Narrative handover, cautions, and design context stay in the docs vault, not on cards.

---

_Board seeded 2026-08-03 from `TODO.md` (71 items); the loop machinery (agents, schedules, memory) was built 2026-09-07 to 09-10, with scrumo, the escalator and the model tiering landing 09-10 per `.pi/factory/REQUIREMENTS.md`. `TODO.md`'s actionable items live on the board; its narrative layer stays in the repo._
