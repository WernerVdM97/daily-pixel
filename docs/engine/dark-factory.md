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

Two loops point the other way, and both are the factory's sleep. **`meta-oil`** studies the factory itself — its transcripts, token spend, retry loops, and gate history — and proposes fixes to the machinery. It is subject to the same rule, applied to its own proposals: it edits a factory file only when that exact numbered proposal has been approved. **`rem`** runs the weekly consolidation pass over the loops' shared memory that purges what is no longer true and abstracts what is, and **`muscle-memory`** follows it an hour later, mining the repo's session transcripts for task families that recur and are hard to follow and encoding them as one-line notes where a reader would look (see § The loops). A fourth loop bridges the two sides: **`librarian`** tends `docs/` — the shared map between the owner and the factory — enforcing the vault conventions, keeping statuses honest, archiving shipped work and distilling milestone-shaped noise back into thematic docs (see § The loops).

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

**Issues are how work arrives.** An agent that needs to record a todo, a finding, a follow-up or a handover note files **one issue per item**, labelled from `.github/labels.yml` (`area:*` / `type:*`) with a milestone only where it is obvious, and leaves it in `Inbox` for triage to enrich. `TODO.md` is not a queue: it is a human's notes file, and an agent that writes its work there has lost it.

## Where the factory lives

| Path | What it is |
| --- | --- |
| `.pi/agents/factory-{triage,executor,sweeper,scrumo,escalator,rem,muscle-memory,librarian}.md` | Loop role definitions: authority, gate, memory scope, report shape |
| `.pi/agents/meta-oil.md` | The improvement loop's role definition |
| `.pi/subagents/schedules/` | The durable schedules (`factory-*` plus `meta-oil-{fri,sat}`); paused runtime state, not tracked |
| `.pi/factory/project.json` | The board's field and option ids, so agents don't hardcode them |
| [[dark-factory-requirements]] (in `docs/`) | The decisions behind scrumo, the escalator and the model tiering; implemented 2026-09-10 |
| `.pi/factory/memory/` | The loops' topic-scoped memory |
| `.pi/factory/inbox/` | The owner's answers to a digest (files + drain state); runtime only, gitignored |
| `scripts/factory-jobs.ts` | The job ledger: claims or adopts an item, drains one stage per tick, and prunes merged branches ([spec](./dark-factory-job-ledger.md)) |
| `.pi/factory/jobs/` | Runtime job records, artifacts and the drain lock; gitignored |
| `scripts/factory-friction.ts` | Ranks friction signals out of the session transcripts, attributed per factory loop, with probe exits split out of `tool-error`; also summarises the job ledger's executor outcomes and, with `--board`, Blocked items carrying an unprocessed owner answer |
| `scripts/factory-inbox.ts` | Drains the owner's answers: inbox files, DM reactions, DM text |

The loops run with `context: "fresh"`, so `.pi/factory/memory/` is the only thing they remember between runs: a tracked skeleton of topic folders (taxonomy reviewable in a PR) with gitignored `memory.md` contents, per the `factory-memory` skill. One dated fact per line; a stale line is deleted, never contradicted.

## The loops

Each loop is a project-scoped agent in `.pi/agents/` plus a durable schedule (`schedule.list`); the escalator is the exception, a child the executor spawns rather than a scheduled loop. All eleven schedules are **enabled**, so they fire themselves through the headless launcher; a schedule flipped back to `paused` runs only when the owner fires it by hand with `schedule.run`.

| Loop | Agent | Cadence | Writes code? |
| --- | --- | --- | --- |
| Triage | `factory-triage` | 12h, phase-anchored to 07:30 local (so 07:30 and 19:30) | No — `Inbox` → `Triaged`/`Blocked`, comments, labels |
| Executor | `factory-executor` (starter only) | 24h, anchored 06:00 local | Yes — via the ledger's `build` stage, and only behind the gate |
| Sweeper | `factory-sweeper` | 48h, anchored 21:00 local (so 21:00 on alternating days) | No — gate audit, CI re-check, board hygiene, digest |
| Scrumo | `factory-scrumo` | 7d × 3: 19:00 local Tue and Thu, 14:00 local Sun | No — DM digest (linked, one message), three recommended actions, blocker comments |
| Meta-oil | `meta-oil` | Fri + Sat 18:00Z (20:00 local) | No — friction analysis and numbered proposals as one digest of cards: an index card, then one card per proposal; edits a factory file only once that exact proposal is approved |
| REM | `factory-rem` | 7d, anchored Sunday 20:00Z (22:00 local) | No — memory consolidation: purges, merges and genericises `.pi/factory/memory/` (verified against the live repo and board, never on age), escalates to Inbox issues for triage and `meta/rem-findings/` notes for meta-oil |
| Muscle-memory | `factory-muscle-memory` | 7d, anchored Sunday 21:00Z (23:00 local), one hour after REM | No — encodes recurring hard task families from session transcripts: one-line notes appended to the reference topics (repetition-gated), skill proposals as Inbox issues; never creates a skill |
| Librarian | `factory-librarian` | 14d, anchored Thursday 09:00Z (11:00 local) | Docs only, as PRs to `dev` under the `auto:docs` standing approval: convention fixes, status flips, archival, distillation; new docs are `Doc proposal:` Inbox issues first, written only once the card is Approved |

**Clock times are approximate, and pi has no calendar trigger.** The scheduler knows one-shot `at` triggers and fixed intervals only (`on` and `timezone` are refused outright), so "07:30" is not a slot: it is a phase. A 12h interval anchored at 07:30 does fire at 07:30 and 19:30 forever, because the next run is plain arithmetic off the anchor and catch-up preserves that phase rather than resetting it, but the _actual_ start is quantised by the systemd tick (5 min, plus up to 30s of jitter), so a pass lands in the 07:30 to 07:35 window rather than on the minute. Tuesday plus Thursday is not expressible as one interval at all, since the gap alternates between 2d and 5d, which is why scrumo is a set of weekly schedules (`factory-scrumo` on Tuesday, `factory-scrumo-thu` on Thursday, `factory-scrumo-sun` at 14:00 on Sunday) exactly as meta-oil is (`meta-oil-fri`, `meta-oil-sat`). Changing a cadence means editing `schedule.json` directly: the API exposes create/list/show/history/pause/resume/run/delete, and deliberately no update.

**Triage** reads Inbox items, dedupes, resolves the doc links it carries, drafts acceptance criteria, asks clarifying questions as comments, and moves items to Triaged — or to Blocked with `needs-human-decision` when it cannot proceed.

**Executor** is now a starter, not a builder. At its slot the schedule runs `npx tsx scripts/factory-jobs.ts start`, which claims the highest-priority-then-oldest runnable item (see § The gate for the two questions behind "runnable") or adopts an orphaned branch, cuts a worktree off `dev`, and opens a _job_ in `.pi/factory/jobs/<item>.json`; the agent itself builds nothing and exits in seconds. The stages then run one per process, advanced by the tick's drainer and enforced by the ledger: `build` (agent, 50 min) → `review` (fresh read-only agent, 20 min) → `fix` (agent, 30 min, skipped when the review is clean) → `deliver` (code: push, PR to `dev` with `Closes #n`, Status `In Review`) → `reconcile` (code: on merge, Status `Done` + closes the issue) → `done` (code: worktree removed, record archived, branch kept). A change-requested review by the owner re-enters the pipeline at `revise` → re-push, capped at three cycles; a branch that conflicts with `dev` enters at `resolve` first (agent, 20 min), one bounded attempt to land the merge with both intents kept, and only a second failure (including on an `unresolved` verdict) reaches the owner. 100 minutes cumulative per job; a second failure at one stage, or a spent budget, blocks the item and pages the owner. Full rationale in [[dark-factory-job-ledger]]. It never merges.

**Sweeper** is the gate's backstop: it flags any PR whose issue was never Approved and has no `auto:*` label, re-checks CI on idle PRs, runs the branch pruner (`factory-jobs.ts housekeeping`) and lists the stale branches it left for the owner, resets stalled `In Progress` items back to `Approved`, marks merged items `Done`, and posts a digest. Its two board-hygiene rules stand down for items that carry a job record: `In Progress` with a job is a run in flight rather than a stalled card, and `In Review` with a job is the ledger's transition to make, because the ledger also closes the linked issue. It keeps both rules for items with no job, which is every item that predates the ledger.

**Dependabot PRs are assessed, never merged.** The gate governs agent work on a board item, so a PR from `app/dependabot` with no linked issue is not a violation — but out of scope is not out of sight. Triage opens every pass with a dependency check over the open automation PRs: it posts one assessment comment per PR (verdict plus the failing check), requests `@dependabot rebase` when a stale base is what is red, and files a migration card for a failing or breaking major — one issue per dependency, labelled `dependencies`, scoped like any card so the migration itself goes through the gate instead of being merged silently. The sweeper's audit then checks coverage rather than repeating triage: CI status, age, and whether every failing major has its migration card. Green grouped minor/patch bumps are report-only, and no factory agent merges, pushes to, or approves anything on these PRs: merging a dependency stays an owner step, the same as every other merge.

**Scrumo** is the unblocker: it reads the board, milestones, PRs and checks, the roadmap, `CHANGELOG.md` and `VERSION`, and DMs the owner a digest of what changed, what is blocked or at risk, and exactly three recommended actions phrased as decisions. The bulletin regen runs at the top of every pass (`factory-bulletin.ts --post`), so the `[bulletin]` link in each digest reflects this pass rather than the last sweeper run; the sweeper's own bulletin job stays as backstop. The digest is one Discord message — rich markdown, every item linked to its issue or PR — budgeted under 1800 characters so it cannot be rejected at the API's 2000 limit, and each item appears in exactly one section. It never changes Status, Priority or labels; its only board writes are comments on items it flags as blocked or at risk, plus the sanctioned bulletin regen, and it needs `DISCORD_TOKEN` + `ADMIN_USER_ID` in the repo `.env` for the DM.

**The bulletin is windowed to the sprint's neighbourhood.** The board as a whole is 79 items and most of it is work for a milestone that is not being built, so the queue tables show only the focus milestone and the one after it, ordered by milestone and then by priority and age, with the counts of everything else parked in a `not listed:` line. One deliberate exception: a `P1 - high` item anywhere stays on the page, because a genuine emergency outside the sprint is exactly what someone should not have to go looking for, and it sorts last so the milestone order above it is not disturbed. Two things the window never hides: an urgent item, and an item with no milestone at all, since a card with nowhere to live is a defect to see rather than a card to lose. No dated open milestone means no window and the whole board is shown, the same fallback the focus filter uses.

**Escalator** is not scheduled: the executor spawns it as a one-shot child (`z-ai/glm-5.3` at `max` thinking) when a slice needs real reasoning: a schema change, an unexplained verification failure, a risky live path. It reads the spec and the exact commit, reproduces the problem, and returns a binding verdict with a concrete plan; the executor lands the work itself and re-verifies.

**Meta-oil** (`openrouter/deepseek/deepseek-v4.1-flash` at `xhigh`: DeepSeek V4.1 Flash served through OpenRouter, held to the DeepSeek first-party host so the prompt cache keeps its prefix) is the only loop whose subject is the factory rather than the game. It runs twice a week, Friday and Saturday evening: a _survey_ pass that measures and proposes, then a _confirm_ pass that re-measures and deepens the top offender only, sending no DM unless a decision is pending. It works from the session transcripts under `~/.pi/agent/sessions/`, where every tool call, error flag and token count is recorded, rather than from anyone's impression of the run.

**Its digest is one message of cards.** A plain body has a single 2000-character budget for everything, and there every proposal competes with every other proposal for room, so the digest is embeds only: an index card carrying the signals, the window, the spend, what is still open and the reaction legend, then one goldenrod card per proposal carrying its six labelled lines, so each proposal can be read, quoted and answered on its own. Every issue, PR and file it names is an absolute link, and a link lives in a card's body rather than its title, because Discord renders a masked link in a description or a field value and prints it literally in a title (verified against a live DM). `.pi/factory/memory/` is never linked: it is gitignored, so the link would 404. The six labels are `signal`, `why`, `files`, `diff`, `verify`, `blast` (`.pi/agents/meta-oil.md` is the shape, and `scripts/send-dm.ts` refuses an over-long card part by name and count the way it refuses an over-long body). Scrumo stays on plain content on purpose: three decisions need no cards.

"Perplexity" is not measurable, so meta-oil does not claim to measure it. `scripts/factory-friction.ts` computes proxies over a window and ranks them by the tokens burned in the sessions where they fire: failed tool calls, the same bash command run 3+ times, the same file edited 4+ times, sessions that edited files and never committed, owner corrections, aborted turns. Failed bash calls used as deliberate boolean checks (a grep for absence, a diff-as-check, an existence test) are counted separately as probe exits rather than as friction, since deliberate behaviour is not confusion. Every session is labelled with the loop that ran it, so a ranking names a loop rather than a bare session id and a model tier change is priced on the loop that actually burns the tokens. Two outcome sections complete the picture, because transcripts only say how a run felt: the job ledger's stage record (first-try pass rate, retries, budget burn) says whether the executor delivered, and `--board` lists Blocked items whose latest comment is the owner's — an answer sitting unprocessed while triage passes over it, which is exactly how the #54/#55 answers once sat a full pass unprocessed. A ranking only says where to look; meta-oil then sends read-only children to read the offending transcripts and name the cause. Up to five fixes come back as numbered proposals in a DM, and each fixes a piece of the machinery: a prompt, an agent definition, verbosity, a model tier, an epic's shape, a schedule, a gate rule.

**Cache economy** is the second axis, and the one where intuition is worst. The same script reads the `pi-cache-optimizer` shards (per-process, atomically written, split by provider and model) and reports each route's request and token hit rates, its full-price input tokens, and an effective cost per million tokens that weights cached tokens at the cache-read rate. Headline prices mislead badly here: a route with the cheap headline can cost more per useful token than an expensive route that caches better, and `miss $` is the amount actually recoverable. Every model tiering proposal is therefore priced on the effective column. Three limits are reported with the numbers rather than glossed over: the shards are estate-wide rather than repo-scoped, prefix churn is not visible in them at all (every epoch reads `initial:*`, so a cold prefix cannot be told from a warm one), and `cacheWrite` is zero everywhere because caching is provider-side and implicit.

Applying one needs an explicit token from the owner. The digest carries numbered proposals and arrives **already loaded with the vote reactions**, seeded by the same script that watches it, so answering is one click rather than a trip through the emoji picker: the owner taps `1️⃣`…`5️⃣` to approve that proposal, `✅` to approve every pending one, `❌` to reject the rest, `🔁` to re-run, `⏸` to hold, or replies in text. `❌` means _the rest_ rather than _all_ precisely so that a digest can be answered one proposal at a time: `1️⃣` `2️⃣` `❌` is approve 1 and 2, reject 3, and an explicit approval always outranks the `❌`. The drain resolves those taps into **one verdict per proposal** (`## Verdict` in the brief, `--json` for machines) rather than handing the agent a reaction list to interpret, so a combination has one meaning that lives in code, and a proposal the owner never touched reads `no answer` rather than being quietly rejected or approved. A `⏸` or a `🔁` supersedes the resolution entirely and prints as `apply nothing`, since it is the one tap that would otherwise sit beside an approval the agent might apply. The bot's own seeded reactions are excluded from the tally, so a digest with no answer reads as no answer rather than as a wall of votes, and only reactions fresh in this drain count, so a digest drained twice cannot be applied twice. Recording a **different** message clears the previous one's baseline and its proposal count with it, which matters because every loop shares the one state file: scrumo arming its own digest must not leave meta-oil's count behind to name proposals it never sent, nor lose its own. Meta-oil's next run drains the answer with `scripts/factory-inbox.ts` before doing anything else. **Reactions rather than buttons, deliberately:** a button click is an interaction event that is lost forever unless a gateway listener is connected at that instant, while a reaction is plain REST data on a message the bot sent, readable retroactively by the same one-shot script. Approval is per proposal and per message; silence is not consent, and nothing carries to the next run. An approved proposal is applied in a worktree off `dev` on `chore/meta-oil-<n>`, as a PR to `dev` — never merged, and only ever touching the files that proposal listed. Each applied proposal also files one board card and posts the ledger's claim comment on it, so the PR is adopted at `review` and gets the review, fix and change-request re-entry it would otherwise never have (see § The gate).

**REM** (`openrouter/deepseek/deepseek-v4.1-flash` at `xhigh`, the same pin as triage and meta-oil) is the consolidation pass the memory tree otherwise never gets: every loop only ever adds lines, so a tree that only grows becomes a log, and a log nobody re-reads is where knowledge goes to hide. It runs once a week, Sunday night, and walks every `memory.md` under `.pi/factory/memory/`, classifying each line as keep, purge, merge, genericise, fix or escalate. It is the one sanctioned exception to one-writer-per-topic, and only in the destructive direction: it may delete, merge, genericise and correct lines in any topic, but never add a fact to a topic it does not own — its own additions go to `loops/rem/` and `meta/rem-findings/`. A line dies only on evidence verified against the live repo and board in the same pass (the file it names is gone, the issue is closed, the repo now states the rule), never on age, because a wrong deletion is unrecoverable while a stale line is merely noise; what cannot be verified is escalated rather than purged. Genericisation is the other half of the job: a line describing one resolved incident whose lesson recurs is rewritten to its general form and kept, so the memory keeps the lesson and loses the one-off identifiers. The append-only logs (`gate/violations/`, `incidents/`) and the pending-proposal index stay untouchable, and a topic over its 25-line cap with nothing prunable is itself a finding. Escalation has two channels, chosen by what the finding is: an `Inbox` issue for triage when it is work (a writer loop's prompt that teaches bad memory habits, a fact the repo should own permanently so the memory copy can die), one dated line in `meta/rem-findings/` when it is signal for meta-oil's next survey (which drains that file first). It never DMs; its only board write is Status `Inbox` on the issues it files, and its report lives in the run transcript.

**Muscle-memory** (same DeepSeek flash `xhigh` pin) follows an hour after REM every Sunday night, and it is the additive mirror of REM's exception: where REM may delete anywhere but never add, muscle-memory appends but never rewrites. Its raw material is the session transcripts — interactive chats and factory sessions weighted equally, because the executor re-deriving what the owner already explained once is exactly the waste it exists to remove — indexed through `scripts/factory-friction.ts --since 28d` (project-scoped by default) and read by cheap read-only children, never in its own context. It hunts task families that are both **repeated** (two or more distinct sessions) and **hard** (red herrings, gotchas, recipes whose steps are easy to get wrong), and its outputs are three: a one-line note appended to the reference topic where a reader would look (`repo/`, `delivery/`, `models/`, `board/`), under the shared-log protocol and only past the promotion bar — the pattern seen in two or more distinct sessions or once plus live-repo verification, deduped against the skills, the docs and the tree first; a dated bookkeeping line in the `muscle/patterns/` ledger carrying the evidence and the state (candidate, promoted, skill-proposed, covered), so any inline note can be checked against what was actually observed; and, when one task family accumulates three or more gotchas, a skill proposal as an `Inbox` issue for triage — it never creates the skill itself. Its subject is the work, not the machine: meta-oil fixes the factory, muscle-memory encodes how the game gets built. It never DMs either.

**The Librarian** (same DeepSeek flash `xhigh` pin) is the bridge between the two sides: `docs/` is the one place the owner and the machine read the same sentences, and the librarian keeps it true. It runs bi-weekly on Thursday midday, and its standard for every doc is _would a reader next quarter still be informed?_ — themes, goals, how-it-works and decisions always; delivery trackers, milestone checklists and per-release state never, because the changelog, the board and git own those. Its pass is a five-step sweep: conventions (frontmatter, statuses, filenames, markers, links, per `docs/CONVENTIONS.md`), status truth (a `decided` spec that shipped moves to `archived/` as `shipped`, evidence from the changelog and git rather than the doc's own claims), distillation (date-shaped docs become their thematic essence or get archived), the map of content, and gap analysis (children survey `src/` and recent history against the vault). Hygiene lands as **one PR per pass** under the `auto:docs` standing approval: a self-filed card labelled `area:docs-meta` + `auto:docs` + `auto:changelog`, worked in a worktree off `dev` on `chore/librarian-<n>`, touching `docs/` and `CHANGELOG.md` only, full suite and typecheck green before the PR, card through `Inbox` → `In Progress` (claim comment) → `In Review` — the only Status writes it ever makes, all on its own card or its own filings. A gap it cannot close inside that leash becomes a `Doc proposal:` Inbox issue, and a new doc is written only once that card is `Approved` (on a later pass, preferring its own proposals since it holds their context); a doc card carrying a job record belongs to the ledger. It never edits a spark's body — sparks are allowed to be messy — and a contradiction between mature docs is a `decisions/` record to propose, never an edit to make unilaterally. No DM; the PR is the artefact.

The intake has three tiers, in order of how little they need: inbox files under `.pi/factory/inbox/` (always work, no Discord), DM reactions (no listener, no privileged intent), and DM message text. Text needs no privileged intent either: `MessageContent` gates _guild_ messages, and Discord delivers DM content to a bot holding only `DirectMessages`, verified against this repo's own bot. `MessageContent` would only become relevant if the intake moved into a channel. A button or modal intake inside the running bot is real work in `src/` behind a flag, and is therefore exactly the kind of change that has to go through the gate like any other.

## The gate

Enforced twice, belt and braces:

1. **Instruction-level** — the executor's role definition refuses anything not Approved/`auto:*`.
2. **Mechanical** — the sweeper audits open PRs against issue approval state and flags violations.

Standing-approval classes (the only work that can run without per-item approval): `auto:docs` (docs/ and comments only), `auto:changelog` (CHANGELOG.md upkeep), `auto:tests` (test-only, no `src/`). Anything else always needs Status=`Approved`.

**Meta-oil's proposal cards are a third, narrower form of the same thing.** A proposal the owner reacted to on the digest is already decided: the drain resolves the reaction into one verdict per proposal, and meta-oil applies that proposal and files one card per applied proposal with Status `Approved` to _record_ that human decision, not to make one. It must never set `Approved` on work the owner has not voted for, and a proposal the owner did not answer gets no card and no PR — so every card in that column traces back to a tap on a digest the owner was sent. See § The loops.

### Approval is not readiness

Approval answers "may this ever run"; the ledger also asks "now", and an approved item is held back in three cases:

- **It carries `needs-human-decision`.** That label means a human decides first, and `Approved` does not outrank it. An approval set in bulk, or set before triage parked the card, would otherwise start work whose acceptance criteria are still a question for the owner.
- **One of its dependencies is open.** The ledger reads GitHub's own `blockedBy` relations for the items it is about to consider. Dependencies used to exist only as prose in the loops' memory, which the pick could not read, so a card could be approved while the design it waited on was still open.
- **It sits outside the focus milestone.** The factory builds one milestone at a time: the open milestone with the earliest due date, read from `gh` and cached at `.pi/factory/focus.json`. The cache is what lets triage order its passes by the sprint without its own API call, and it is the only writer's state, never hand-edited. A milestone with no due date never takes the focus while a dated one is open; when no open milestone is dated the filter switches off and priority order decides. Advancing the sprint is therefore a milestone change — close or re-date one — and not a config edit.

Every declined item is named with its reason, in the `start` log and on the pinned bulletin. A factory with nothing runnable is a normal state, since the sprint may be waiting on the owner; what matters is that the bulletin says which, so an idle machine is never indistinguishable from a broken one.

## Running it by hand

Schedules live under `.pi/subagents/schedules/` and are enabled; a schedule flipped back to `paused` runs only when fired by hand. From a pi session in this repo:

- Fire one triage pass: `subagent({ action: "schedule.run", id: "factory-triage" })`
- Fire one executor pass: `subagent({ action: "schedule.run", id: "factory-executor" })`
- Fire a scrumo digest: `subagent({ action: "schedule.run", id: "factory-scrumo" })` (Tuesday), `id: "factory-scrumo-thu"` (Thursday) or `id: "factory-scrumo-sun"` (Sunday afternoon)
- Fire a sweep: `subagent({ action: "schedule.run", id: "factory-sweeper" })`
- Fire a meta-oil survey: `subagent({ action: "schedule.run", id: "meta-oil-fri" })`
- Fire a meta-oil confirm: `subagent({ action: "schedule.run", id: "meta-oil-sat" })`
- Fire a REM pass: `subagent({ action: "schedule.run", id: "factory-rem" })`
- Fire a muscle-memory pass: `subagent({ action: "schedule.run", id: "factory-muscle-memory" })`
- Fire a librarian pass: `subagent({ action: "schedule.run", id: "factory-librarian" })`

To answer a meta-oil digest, react on the DM it sent. If the run could not record its own message id (see `scripts/factory-inbox.ts --record <id>`), the watcher says so instead of quietly reporting no decisions. The digest is one message of embeds: `npx tsx scripts/send-dm.ts --embed embeds.json` (`--embed` takes one embed object or an array, and a body is optional when there is at least one).

A job is driven by its own CLI, not by a schedule:

- Start a job now: `npx tsx scripts/factory-jobs.ts start` (the executor's daily schedule runs exactly this)
- Advance one stage: `npx tsx scripts/factory-jobs.ts drain`
- Unblock what triage or the ledger blocked: `npx tsx scripts/factory-jobs.ts retry <item>`
- Read the ledger: `list`, `show <item>`, `stale`
- Dry-run any of the above: `FACTORY_DRY_RUN=1`, against a scratch ledger with `FACTORY_JOBS_DIR=DIR`

Inspect runs with `schedule.history` and the usual `status`/`fleet` views, and stages with `scripts/factory-jobs.ts show <item>` plus the session transcripts the stage children leave under `~/.pi/agent/sessions/`.

## Unattended (the lights-out path)

The cadences are tuned to clock times and the launcher is installed, so what matters here is what each part does rather than how to wire it up. The pieces:

- **The schedules.** A loop fires while it is enabled; `schedule.pause` and `schedule.resume` move one loop either way. Nothing fires on its own while a loop is paused, because `run-due` only ever picks unpaused and overdue schedules; `FACTORY_FIRE=<schedule-id>` is the way to run a paused one on demand.
- **The launcher** (`scripts/factory-run-due.{sh,service,timer}`, installed as a system timer that ticks every 5 min) is the lights-out path for a closed laptop. It owns the memory preflight, refusing to start below `FACTORY_MIN_AVAIL_MB` (default 1000MB) because a second pi stacked on a live session twice ended in an `oom-kill`, and a non-blocking lock, so ticks cannot stack. Every tick then drains the job ledger (`factory-jobs.ts drain`) after any due schedules, which is what advances a job's stages; a tick with nothing due still drains, and `TimeoutStartSec` is 5400 so a 50-minute `build` cannot be cut off by the launcher. A record it cannot parse counts as due, so a schedule-format change costs extra ticks rather than parking the factory silently. Its `User=`, `HOME=`, `PATH=` and `FACTORY_PROJECT_DIR=` are per-machine, so they live in a drop-in rather than the tracked unit (`sudo systemctl edit factory-run-due`): a system unit has no specifier for the `User=` account's home, and `%h` is `/root` under the system manager.
- **The factory's own key** (`FACTORY_OPENROUTER_API_KEY`) in the repo `.env` (or in the unit's environment, which wins). Every factory-launched `pi` gets it as `--api-key` on a pinned model (`--model openrouter/deepseek/deepseek-v4.1-flash`, the same pin the stage wrapper carries), because an unpinned fire resolves the model from settings and installs `--api-key` against that provider instead, so the loops' spend is separable from the shared `~/.pi/agent/auth.json` credential that interactive sessions use. It matters more than it looks, because pi resolves `auth.json` **before** the environment: exporting the key without `--api-key` would leave the factory on the shared credential while looking configured. `--api-key` reaches only the `pi` it is passed to, so each fired loop and each stage also runs under a shadow agent dir holding the same key, which is what its children resolve (`$HOME/.pi/factory-agent`; see [OpenRouter keys and cache observability](./openrouter-keys-and-cache-observability.md)). Leave it empty and the launcher says so on the tick it falls back. Cap it in the dashboard too (it currently carries `$5` a day, resetting daily): the launcher reads that key's `limit_remaining` before it fires and skips a spent tick with a line saying so, so a runaway loop costs a lost day rather than an open tab. The read is live, so raising or removing the cap needs no change here, and it fails open on anything it cannot read: a timeout or a 5xx cannot stop the factory, only a definite answer can — a spent cap, or an HTTP 401/403 saying the key itself is wrong — and each of those is one skipped tick with a line saying why.
- **The watchdog** (opt-in adversarial diff review at `agent_end`) is a natural extra review layer once running unattended; see `/subagents-watchdog`.

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

_Board seeded 2026-08-03 from `TODO.md` (71 items); the loop machinery (agents, schedules, memory) was built 2026-09-07 to 09-10, with scrumo, the escalator and the model tiering landing 09-10 per [[dark-factory-requirements]]. The meta-oil improvement loop, its friction and cache metrics and its owner intake landed the same day. The job ledger landed 2026-09-11 ([[dark-factory-job-ledger]]), after the executor's first headless run was killed at 30:00 and left #34 `In Progress` with no PR. Only `.pi/agents/`, `.pi/factory/project.json` and `scripts/factory-jobs.ts` are tracked: the seeding payloads, the runbook, the job records and the memory contents stay local. `TODO.md` is human notes only; an agent's todo, finding or handover is a board issue, and the file's remaining actionable items were migrated to the board._
