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
| `In Progress` | job ledger | A job has claimed it: a stage is ready, running or blocked |
| `In Review` | job ledger (`deliver`) | PR open, awaiting owner review/merge |
| `Blocked` | triage / human | Needs a human decision (`needs-human-decision` label) |
| `Done` | job ledger (`reconcile`) / sweeper / human | PR merged, linked issue closed |

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
| `scripts/factory-jobs.ts` | The job ledger: claims or adopts an item, drains one stage per tick, and prunes merged branches ([spec](./dark-factory-job-ledger.md)) |
| `.pi/factory/jobs/` | Runtime job records, artifacts and the drain lock; gitignored |
| `scripts/factory-friction.ts` | Ranks friction signals out of the session transcripts |
| `scripts/factory-inbox.ts` | Drains the owner's answers: inbox files, DM reactions, DM text |

The loops run with `context: "fresh"`, so `.pi/factory/memory/` is the only thing they remember between runs: a tracked skeleton of topic folders (taxonomy reviewable in a PR) with gitignored `memory.md` contents, per the `factory-memory` skill. One dated fact per line; a stale line is deleted, never contradicted.

## The loops

Each loop is a project-scoped agent in `.pi/agents/` plus a durable schedule (`schedule.list`); the escalator is the exception, a child the executor spawns rather than a scheduled loop. All seven schedules are **enabled**, so they fire themselves through the headless launcher; a schedule flipped back to `paused` runs only when the owner fires it by hand with `schedule.run`.

| Loop | Agent | Cadence | Writes code? |
| --- | --- | --- | --- |
| Triage | `factory-triage` | 12h, phase-anchored to 07:30 local (so 07:30 and 19:30) | No — `Inbox` → `Triaged`/`Blocked`, comments, labels |
| Executor | `factory-executor` (starter only) | 24h, anchored 06:00 local | Yes — via the ledger's `build` stage, and only behind the gate |
| Sweeper | `factory-sweeper` | 48h, anchored 21:00 local (so 21:00 on alternating days) | No — gate audit, CI re-check, board hygiene, digest |
| Scrumo | `factory-scrumo` | 7d × 3: 19:00 local Tue and Thu, 14:00 local Sun | No — DM digest (linked, one message), three recommended actions, blocker comments |
| Meta-oil | `meta-oil` | Fri + Sat 18:00Z (20:00 local) | No — friction analysis and numbered proposals as one digest of cards: an index card, then one card per proposal; edits a factory file only once that exact proposal is approved |

**Clock times are approximate, and pi has no calendar trigger.** The scheduler knows one-shot `at` triggers and fixed intervals only (`on` and `timezone` are refused outright), so "07:30" is not a slot: it is a phase. A 12h interval anchored at 07:30 does fire at 07:30 and 19:30 forever, because the next run is plain arithmetic off the anchor and catch-up preserves that phase rather than resetting it, but the _actual_ start is quantised by the systemd tick (5 min, plus up to 30s of jitter), so a pass lands in the 07:30 to 07:35 window rather than on the minute. Tuesday plus Thursday is not expressible as one interval at all, since the gap alternates between 2d and 5d, which is why scrumo is a set of weekly schedules (`factory-scrumo` on Tuesday, `factory-scrumo-thu` on Thursday, `factory-scrumo-sun` at 14:00 on Sunday) exactly as meta-oil is (`meta-oil-fri`, `meta-oil-sat`). Changing a cadence means editing `schedule.json` directly: the API exposes create/list/show/history/pause/resume/run/delete, and deliberately no update.

**Triage** reads Inbox items, dedupes, resolves `[[doc-links]]`, drafts acceptance criteria, asks clarifying questions as comments, and moves items to Triaged — or to Blocked with `needs-human-decision` when it cannot proceed.

**Executor** is now a starter, not a builder. At its slot the schedule runs `npx tsx scripts/factory-jobs.ts start`, which claims the highest-priority-then-oldest `Approved` (or `auto:*`-class) item or adopts an orphaned branch, cuts a worktree off `dev`, and opens a _job_ in `.pi/factory/jobs/<item>.json`; the agent itself builds nothing and exits in seconds. The stages then run one per process, advanced by the tick's drainer and enforced by the ledger: `build` (agent, 50 min) → `review` (fresh read-only agent, 20 min) → `fix` (agent, 30 min, skipped when the review is clean) → `deliver` (code: push, PR to `dev` with `Closes #n`, Status `In Review`) → `reconcile` (code: on merge, Status `Done` + closes the issue) → `done` (code: worktree removed, record archived, branch kept). 100 minutes cumulative per job; a second failure at one stage, or a spent budget, blocks the item and pages the owner. Full rationale in [[dark-factory-job-ledger]]. It never merges.

**Sweeper** is the gate's backstop: it flags any PR whose issue was never Approved and has no `auto:*` label, re-checks CI on idle PRs, runs the branch pruner (`factory-jobs.ts housekeeping`) and lists the stale branches it left for the owner, resets stalled `In Progress` items back to `Approved`, marks merged items `Done`, and posts a digest. Its two board-hygiene rules stand down for items that carry a job record: `In Progress` with a job is a run in flight rather than a stalled card, and `In Review` with a job is the ledger's transition to make, because the ledger also closes the linked issue. It keeps both rules for items with no job, which is every item that predates the ledger.

**Scrumo** is the unblocker: it reads the board, milestones, PRs and checks, the roadmap, `CHANGELOG.md` and `VERSION`, and DMs the owner a digest of what changed, what is blocked or at risk, and exactly three recommended actions phrased as decisions. The digest is one Discord message — rich markdown, every item linked to its issue or PR — budgeted under 1800 characters so it cannot be rejected at the API's 2000 limit, and each item appears in exactly one section. It never changes Status, Priority or labels; its only board writes are comments on items it flags as blocked or at risk, and it needs `DISCORD_TOKEN` + `ADMIN_USER_ID` in the repo `.env` for the DM.

**Escalator** is not scheduled: the executor spawns it as a one-shot child (`z-ai/glm-5.3` at `max` thinking) when a slice needs real reasoning: a schema change, an unexplained verification failure, a risky live path. It reads the spec and the exact commit, reproduces the problem, and returns a binding verdict with a concrete plan; the executor lands the work itself and re-verifies.

**Meta-oil** (`deepseek/deepseek-flash` at `max`: the direct DeepSeek V4.1 Flash, whose ceiling is `max` because the direct provider has no `xhigh` tier) is the only loop whose subject is the factory rather than the game. It runs twice a week, Friday and Saturday evening: a _survey_ pass that measures and proposes, then a _confirm_ pass that re-measures and deepens the top offender only, sending no DM unless a decision is pending. It works from the session transcripts under `~/.pi/agent/sessions/`, where every tool call, error flag and token count is recorded, rather than from anyone's impression of the run.

**Its digest is one message of cards.** A plain body has a single 2000-character budget for everything, and there every proposal competes with every other proposal for room, so the digest is embeds only: an index card carrying the signals, the window, the spend, what is still open and the reaction legend, then one goldenrod card per proposal carrying its six labelled lines, so each proposal can be read, quoted and answered on its own. Every issue, PR and file it names is an absolute link, and a link lives in a card's body rather than its title, because Discord renders a masked link in a description or a field value and prints it literally in a title (verified against a live DM). `.pi/factory/memory/` is never linked: it is gitignored, so the link would 404. The six labels are `signal`, `why`, `files`, `diff`, `verify`, `blast` (`.pi/agents/meta-oil.md` is the shape, and `scripts/send-dm.ts` refuses an over-long card part by name and count the way it refuses an over-long body). Scrumo stays on plain content on purpose: three decisions need no cards.

"Perplexity" is not measurable, so meta-oil does not claim to measure it. `scripts/factory-friction.ts` computes proxies over a window and ranks them by the tokens burned in the sessions where they fire: failed tool calls, the same bash command run 3+ times, the same file edited 4+ times, sessions that edited files and never committed, owner corrections, aborted turns. A ranking only says where to look; meta-oil then sends read-only children to read the offending transcripts and name the cause. Up to five fixes come back as numbered proposals in a DM, and each fixes a piece of the machinery: a prompt, an agent definition, verbosity, a model tier, an epic's shape, a schedule, a gate rule.

**Cache economy** is the second axis, and the one where intuition is worst. The same script reads the `pi-cache-optimizer` shards (per-process, atomically written, split by provider and model) and reports each route's request and token hit rates, its full-price input tokens, and an effective cost per million tokens that weights cached tokens at the cache-read rate. Headline prices mislead badly here: a route with the cheap headline can cost more per useful token than an expensive route that caches better, and `miss $` is the amount actually recoverable. Every model tiering proposal is therefore priced on the effective column. Three limits are reported with the numbers rather than glossed over: the shards are estate-wide rather than repo-scoped, prefix churn is not visible in them at all (every epoch reads `initial:*`, so a cold prefix cannot be told from a warm one), and `cacheWrite` is zero everywhere because caching is provider-side and implicit.

Applying one needs an explicit token from the owner. The digest carries numbered proposals and arrives **already loaded with the vote reactions**, seeded by the same script that watches it, so answering is one click rather than a trip through the emoji picker: the owner taps `1️⃣`…`5️⃣` to approve that proposal, `✅` to approve every pending one, `❌` to reject the rest, `🔁` to re-run, `⏸` to hold, or replies in text. `❌` means _the rest_ rather than _all_ precisely so that a digest can be answered one proposal at a time: `1️⃣` `2️⃣` `❌` is approve 1 and 2, reject 3, and an explicit approval always outranks the `❌`. The drain resolves those taps into **one verdict per proposal** (`## Verdict` in the brief, `--json` for machines) rather than handing the agent a reaction list to interpret, so a combination has one meaning that lives in code, and a proposal the owner never touched reads `no answer` rather than being quietly rejected or approved. The bot's own seeded reactions are excluded from the tally, so a digest with no answer reads as no answer rather than as a wall of votes, and only reactions fresh in this drain count, so a digest drained twice cannot be applied twice. Meta-oil's next run drains the answer with `scripts/factory-inbox.ts` before doing anything else. **Reactions rather than buttons, deliberately:** a button click is an interaction event that is lost forever unless a gateway listener is connected at that instant, while a reaction is plain REST data on a message the bot sent, readable retroactively by the same one-shot script. Approval is per proposal and per message; silence is not consent, and nothing carries to the next run. An approved proposal is applied in a worktree off `dev` on `chore/meta-oil-<n>`, as a PR to `dev` — never merged, and only ever touching the files that proposal listed.

The intake has three tiers, in order of how little they need: inbox files under `.pi/factory/inbox/` (always work, no Discord), DM reactions (no listener, no privileged intent), and DM message text. Text needs no privileged intent either: `MessageContent` gates _guild_ messages, and Discord delivers DM content to a bot holding only `DirectMessages`, verified against this repo's own bot. `MessageContent` would only become relevant if the intake moved into a channel. A button or modal intake inside the running bot is real work in `src/` behind a flag, and is therefore exactly the kind of change that has to go through the gate like any other.

## The gate

Enforced twice, belt and braces:

1. **Instruction-level** — the executor's role definition refuses anything not Approved/`auto:*`.
2. **Mechanical** — the sweeper audits open PRs against issue approval state and flags violations.

Standing-approval classes (the only work that can run without per-item approval): `auto:docs` (docs/ and comments only), `auto:changelog` (CHANGELOG.md upkeep), `auto:tests` (test-only, no `src/`). Anything else always needs Status=`Approved`.

## Running it (manual, while trust builds)

Schedules live under `.pi/subagents/schedules/` and are enabled; a schedule flipped back to `paused` runs only when fired by hand. From a pi session in this repo:

- Fire one triage pass: `subagent({ action: "schedule.run", id: "factory-triage" })`
- Fire one executor pass: `subagent({ action: "schedule.run", id: "factory-executor" })`
- Fire a scrumo digest: `subagent({ action: "schedule.run", id: "factory-scrumo" })` (Tuesday), `id: "factory-scrumo-thu"` (Thursday) or `id: "factory-scrumo-sun"` (Sunday afternoon)
- Fire a sweep: `subagent({ action: "schedule.run", id: "factory-sweeper" })`
- Fire a meta-oil survey: `subagent({ action: "schedule.run", id: "meta-oil-fri" })`
- Fire a meta-oil confirm: `subagent({ action: "schedule.run", id: "meta-oil-sat" })`

To answer a meta-oil digest, react on the DM it sent. If the run could not record its own message id (see `scripts/factory-inbox.ts --record <id>`), the watcher says so instead of quietly reporting no decisions. The digest is one message of embeds: `npx tsx scripts/send-dm.ts --embed embeds.json` (`--embed` takes one embed object or an array, and a body is optional when there is at least one).

A job is driven by its own CLI, not by a schedule:

- Start a job now: `npx tsx scripts/factory-jobs.ts start` (the executor's daily schedule runs exactly this)
- Advance one stage: `npx tsx scripts/factory-jobs.ts drain`
- Unblock what triage or the ledger blocked: `npx tsx scripts/factory-jobs.ts retry <item>`
- Read the ledger: `list`, `show <item>`, `stale`
- Dry-run any of the above: `FACTORY_DRY_RUN=1`, against a scratch ledger with `FACTORY_JOBS_DIR=DIR`

Inspect runs with `schedule.history` and the usual `status`/`fleet` views, and stages with `scripts/factory-jobs.ts show <item>` plus the session transcripts the stage children leave under `~/.pi/agent/sessions/`.

## Promoting to unattended

The cadences are already tuned to clock times and the launcher already exists, so what is left here is the trust decision rather than the wiring:

1. Resume the schedules: `schedule.resume` per loop. Nothing fires on its own while a loop is paused, because `run-due` only ever picks unpaused and overdue schedules; `FACTORY_FIRE=<schedule-id>` is the way to run a paused one on demand.
2. The launcher (`scripts/factory-run-due.{sh,service,timer}`, installed as a system timer that ticks every 5 min) is the lights-out path for a closed laptop. It owns the memory preflight, refusing to start below `FACTORY_MIN_AVAIL_MB` (default 1000MB) because a second pi stacked on a live session twice ended in an `oom-kill`, and a non-blocking lock, so ticks cannot stack. Every tick then drains the job ledger (`factory-jobs.ts drain`) after any due schedules, which is what advances a job's stages; a tick with nothing due still drains, and `TimeoutStartSec` is 5400 so a 50-minute `build` cannot be cut off by the launcher. A record it cannot parse counts as due, so a schedule-format change costs extra ticks rather than parking the factory silently.
3. The watchdog (opt-in adversarial diff review at `agent_end`) is a natural extra review layer once running unattended; see `/subagents-watchdog`.

## Turning it off

**The factory is off unless something switches it on.** That is the default because the factory writes to GitHub and spends tokens: enabling it is a deliberate act, and forgetting it exists costs nothing.

Three sources can do that, and any one of them is enough:

- the process environment — `FACTORY_ENABLED=1` in the launcher's systemd unit, or a drop-in (`systemctl edit factory-run-due`);
- the repo `.env` — `FACTORY_ENABLED=1`, read one key at a time rather than sourced (this box opts in here);
- a pause file — `.pi/factory/PAUSED`, whose **presence** stops the factory even when something enabled it, and whose first line becomes the reason the journal shows. It is the "stop now, with a note" lever, not the switch: `rm` alone does not start the factory again, because absence still means off.

Values are read generously (`1`, `true`, `yes`, `on` enable; `0`, `false`, `no`, `off` disable, quoted or not, with a trailing comment), and **an explicit off always beats an explicit on**, whichever source it comes from.

Off means the tick does nothing at all: no schedules fire, the job drain does not advance a stage, and the branch pruner does not run. It is a gate on autonomous action, not a lock on yours:

- **`FACTORY_FIRE=<id>` still runs**, because that is you asking for one schedule by name — but it does not drag the drain and the pruner along behind it, so a job you deliberately froze stays frozen.
- **`factory-jobs.ts start|drain|retry` still work** when you run them yourself; they are your tools, not the schedule's.
- **An in-flight stage finishes.** A tick already inside a 50-minute `build` cannot be interrupted safely, and killing it mid-write is exactly what loses work; the next tick is the one that sees the switch. Nothing new starts meanwhile.

Per-loop control stays separate: a schedule's own `paused` flag (see § Running it) turns one loop off while the rest keep ticking, which is what the individual switches are for.

## Non-goals

- The factory never merges PRs, never pushes to `dev`/`main`, never tags releases. Those stay human per the `releasing` skill.
- The board is for _work items_. Narrative handover, cautions, and design context stay in the docs vault, not on cards.

---

_Board seeded 2026-08-03 from `TODO.md` (71 items); the loop machinery (agents, schedules, memory) was built 2026-09-07 to 09-10, with scrumo, the escalator and the model tiering landing 09-10 per [[dark-factory-requirements]]. The meta-oil improvement loop, its friction and cache metrics and its owner intake landed the same day. The job ledger landed 2026-09-11 ([[dark-factory-job-ledger]]), after the executor's first headless run was killed at 30:00 and left #34 `In Progress` with no PR. Only `.pi/agents/`, `.pi/factory/project.json` and `scripts/factory-jobs.ts` are tracked: the seeding payloads, the runbook, the job records and the memory contents stay local. `TODO.md`'s actionable items live on the board; its narrative layer stays in the repo._
