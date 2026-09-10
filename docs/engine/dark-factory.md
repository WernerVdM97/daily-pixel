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

One loop points the other way: **`meta-oil`** studies the factory itself — its transcripts, token spend, retry loops, and gate history — and proposes fixes to the machinery. It is subject to the same rule, applied to its own proposals: it edits a factory file only when that exact numbered proposal has been approved.

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
| `.pi/agents/meta-oil.md` | The improvement loop's role definition |
| `.pi/subagents/schedules/` | The durable schedules (`factory-*` plus `meta-oil-{fri,sat}`); paused runtime state, not tracked |
| `.pi/factory/project.json` | The board's field and option ids, so agents don't hardcode them |
| [[dark-factory-requirements]] (in `docs/`) | The decisions behind scrumo, the escalator and the model tiering; implemented 2026-09-10 |
| `.pi/factory/memory/` | The loops' topic-scoped memory |
| `.pi/factory/inbox/` | The owner's answers to a digest (files + drain state); runtime only, gitignored |
| `scripts/factory-friction.ts` | Ranks friction signals out of the session transcripts |
| `scripts/factory-inbox.ts` | Drains the owner's answers: inbox files, DM reactions, DM text |

The loops run with `context: "fresh"`, so `.pi/factory/memory/` is the only thing they remember between runs: a tracked skeleton of topic folders (taxonomy reviewable in a PR) with gitignored `memory.md` contents, per the `factory-memory` skill. One dated fact per line; a stale line is deleted, never contradicted.

## The loops

Each loop is a project-scoped agent in `.pi/agents/` plus a durable schedule (`schedule.list`); the escalator is the exception, a child the executor spawns rather than a scheduled loop. All schedules are currently **paused** — nothing runs until the owner fires it manually with `schedule.run` or resumes the schedule.

| Loop | Agent | Cadence (when resumed) | Writes code? |
| --- | --- | --- | --- |
| Triage | `factory-triage` | 6h | No — `Inbox` → `Triaged`/`Blocked`, comments, labels |
| Executor | `factory-executor` | 6h | Yes — the only one, and only behind the gate |
| Sweeper | `factory-sweeper` | 1d | No — gate audit, CI re-check, board hygiene, digest |
| Scrumo | `factory-scrumo` | 1d | No — DM digest, three recommended actions, blocker comments |
| Meta-oil | `meta-oil` | Fri + Sat 18:00Z | No — friction analysis and numbered proposals; edits a factory file only once that exact proposal is approved |

**Triage** reads Inbox items, dedupes, resolves `[[doc-links]]`, drafts acceptance criteria, asks clarifying questions as comments, and moves items to Triaged — or to Blocked with `needs-human-decision` when it cannot proceed.

**Executor** picks at most one item: highest-priority-then-oldest among Status=`Approved`, plus any `auto:*`-class item in Inbox/Triaged. It claims the item, builds it in an isolated worktree off `dev` via the repo's orchestrated-delegation loop, runs the full suite + typecheck, gets a fresh-context review, opens a PR to `dev` with `Closes #n`, and moves the item to `In Review`. It never merges.

**Sweeper** is the gate's backstop: it flags any PR whose issue was never Approved and has no `auto:*` label, re-checks CI on idle PRs, lists stale branches, resets stalled `In Progress` items back to `Approved`, marks merged items `Done`, and posts a digest.

**Scrumo** is the unblocker: it reads the board, milestones, PRs and checks, the roadmap, `CHANGELOG.md` and `VERSION`, and DMs the owner a digest of what changed, what is blocked or at risk, and exactly three recommended actions phrased as decisions. It never changes Status, Priority or labels; its only board writes are comments on items it flags as blocked or at risk, and it needs `DISCORD_TOKEN` + `ADMIN_USER_ID` in the repo `.env` for the DM.

**Escalator** is not scheduled: the executor spawns it as a one-shot child (`z-ai/glm-5.3` at `max` thinking) when a slice needs real reasoning: a schema change, an unexplained verification failure, a risky live path. It reads the spec and the exact commit, reproduces the problem, and returns a binding verdict with a concrete plan; the executor lands the work itself and re-verifies.

**Meta-oil** (`openrouter/deepseek/deepseek-v4.1-flash` at `xhigh`) is the only loop whose subject is the factory rather than the game. It runs twice a week, Friday and Saturday evening: a *survey* pass that measures and proposes, then a *confirm* pass that re-measures and deepens the top offender only, sending no DM unless a decision is pending. It works from the session transcripts under `~/.pi/agent/sessions/`, where every tool call, error flag and token count is recorded, rather than from anyone's impression of the run.

"Perplexity" is not measurable, so meta-oil does not claim to measure it. `scripts/factory-friction.ts` computes proxies over a window and ranks them by the tokens burned in the sessions where they fire: failed tool calls, the same bash command run 3+ times, the same file edited 4+ times, sessions that edited files and never committed, owner corrections, aborted turns. A ranking only says where to look; meta-oil then sends read-only children to read the offending transcripts and name the cause. Up to five fixes come back as numbered proposals in a DM, and each fixes a piece of the machinery: a prompt, an agent definition, verbosity, a model tier, an epic's shape, a schedule, a gate rule.

**Cache economy** is the second axis, and the one where intuition is worst. The same script reads the `pi-cache-optimizer` shards (per-process, atomically written, split by provider and model) and reports each route's request and token hit rates, its full-price input tokens, and an effective cost per million tokens that weights cached tokens at the cache-read rate. Headline prices mislead badly here: a route with the cheap headline can cost more per useful token than an expensive route that caches better, and `miss $` is the amount actually recoverable. Every model tiering proposal is therefore priced on the effective column. Three limits are reported with the numbers rather than glossed over: the shards are estate-wide rather than repo-scoped, prefix churn is not visible in them at all (every epoch reads `initial:*`, so a cold prefix cannot be told from a warm one), and `cacheWrite` is zero everywhere because caching is provider-side and implicit.

Applying one needs an explicit token from the owner. The digest carries numbered proposals and arrives **already loaded with the vote reactions**, seeded by the same script that watches it, so answering is one click rather than a trip through the emoji picker: the owner taps `1️⃣`…`5️⃣` for a proposal, `✅` all, `❌` none, `🔁` re-run, `⏸` hold, or replies in text. The bot's own seeded reactions are excluded from the tally, so a digest with no answer reads as no answer rather than as a wall of votes. Meta-oil's next run drains the answer with `scripts/factory-inbox.ts` before doing anything else. **Reactions rather than buttons, deliberately:** a button click is an interaction event that is lost forever unless a gateway listener is connected at that instant, while a reaction is plain REST data on a message the bot sent, readable retroactively by the same one-shot script. Approval is per proposal and per message; silence is not consent, and nothing carries to the next run. An approved proposal is applied in a worktree off `dev` on `chore/meta-oil-<n>`, as a PR to `dev` — never merged, and only ever touching the files that proposal listed.

The intake has three tiers, in order of how little they need: inbox files under `.pi/factory/inbox/` (always work, no Discord), DM reactions (no listener, no privileged intent), and DM message text. Text needs no privileged intent either: `MessageContent` gates *guild* messages, and Discord delivers DM content to a bot holding only `DirectMessages`, verified against this repo's own bot. `MessageContent` would only become relevant if the intake moved into a channel. A button or modal intake inside the running bot is real work in `src/` behind a flag, and is therefore exactly the kind of change that has to go through the gate like any other.

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
- Fire a meta-oil survey: `subagent({ action: "schedule.run", id: "meta-oil-fri" })`
- Fire a meta-oil confirm: `subagent({ action: "schedule.run", id: "meta-oil-sat" })`

To answer a meta-oil digest, react on the DM it sent. If the run could not record its own message id (see `scripts/factory-inbox.ts --record <id>`), the watcher says so instead of quietly reporting no decisions.

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

_Board seeded 2026-08-03 from `TODO.md` (71 items); the loop machinery (agents, schedules, memory) was built 2026-09-07 to 09-10, with scrumo, the escalator and the model tiering landing 09-10 per [[dark-factory-requirements]]. The meta-oil improvement loop, its friction and cache metrics and its owner intake landed the same day. Only `.pi/agents/` and `.pi/factory/project.json` are tracked: the seeding payloads, the runbook and the memory contents stay local. `TODO.md`'s actionable items live on the board; its narrative layer stays in the repo._
