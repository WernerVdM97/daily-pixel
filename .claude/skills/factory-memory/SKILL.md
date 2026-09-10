---
name: factory-memory
description: Durable topic-scoped memory for the Dark Factory loops: where to read facts, what to write, and how to keep the tree greppable. Use whenever a factory agent (triage, executor, sweeper, scrumo, escalator) reads or writes .pi/factory/memory/.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
paths:
  - .pi/factory/memory/**
---

# Factory memory

The loops forget everything at the end of a run (`context: "fresh"`). This is where they leave facts for the next run: a nested topic tree under `.pi/factory/memory/`, one brief `memory.md` per leaf topic.

The **tree is tracked** (a `.gitkeep` per leaf), the **contents are not**. So the taxonomy is reviewable in a PR and the notes stay local. The ignore rules live in `.gitignore` under the "Factory memory tree" comment; the topic index is [`README.md`](../../../.pi/factory/memory/README.md).

## Topics

One folder per subject, so an agent can aim a search at a branch of the tree instead of grepping everything.

| Topic | Holds |
| --- | --- |
| `board/` | `status-flow`, `fields-and-ids`, `labels`, `milestones`, `blockers` |
| `gate/` | `approval-rules`, `auto-classes`, `violations` |
| `loops/` | `triage`, `executor`, `sweeper`, `scrumo`, `escalator` |
| `repo/` | `build-and-test`, `branches-and-worktrees`, `known-failures`, `conventions` |
| `delivery/` | `discord`, `pr-and-review`, `ci` |
| `models/` | `tiers`, `escalations` |
| `owner/` | `preferences` |
| `incidents/` | one dated bullet per incident; split into `incidents/YYYY-MM/` once it outgrows a page |

Nest deeper only when a topic genuinely splits. Depth is cheap for grepping, but a folder holding one line is a worse index than a line in the parent.

## Write scope

Read anything; write only inside your own scope. One writer per topic, except the two shared logs (`gate/violations/`, `incidents/`), which any listed loop may append a dated line to — append-only, never rewrite another loop's line. Topics with no loop in the table below are owner-seeded reference facts: read them, flag staleness in your report, but only the owner updates them.

| Loop | May write |
| --- | --- |
| triage | `loops/triage/`, `board/blockers/`, `incidents/` |
| executor | `loops/executor/`, `repo/`, `gate/violations/`, `incidents/` |
| sweeper | `loops/sweeper/`, `gate/violations/`, `delivery/ci/`, `incidents/` |
| scrumo | `loops/scrumo/`, `board/milestones/`, `owner/preferences/`, `incidents/` |
| escalator | `loops/escalator/`, `models/escalations/`, `incidents/` |

Which model ran, what a gate rule means, and which command verifies a change all belong to the topics above, not to the loop folders. `loops/<name>/` is only for that loop's own habits and mistakes.

## What goes in

- Identifiers and paths: field ids, label names, file paths, branch names, commands.
- Decisions and their reason, once: "milestones are the only machine-readable timeline, use due dates".
- Gotchas: flaky tests, a command that needs the token, an ordering caveat.
- Corrections: when a line turns out wrong, rewrite it rather than appending a contradiction.

## What stays out

- Anything already in the repo: the gate rules live in `docs/engine/dark-factory.md`, the agent's own contract in its prompt. Do not copy them here, record only what you learned that they do not say. Exception: topics the owner seeds at bootstrap (`gate/approval-rules`, the `board/*` and `models/*` facts) deliberately restate repo rules so a fresh run has them at hand; loops keep those seeds current but do not grow them into copies.
- Run narration, narratives, transcripts, issue bodies, PR text.
- Secrets. Name the env var (`DISCORD_TOKEN`), never a value, and never an id that is not already public in the repo.

## Format

```markdown
# gate/approval-rules

- 2026-09-10: an item needs Status=Approved or an auto:* label inside that class; nothing else executes.
- 2026-09-10: the sweeper flags violations, it never approves. Only the owner sets Approved.
```

One fact per line, `- YYYY-MM-DD: fact`. Each grep hit is then a whole fact, and `grep "^- 2026-09"` reads as a timeline.

## Hygiene

- Under 25 lines per `memory.md`. Over that, promote a subject to its own topic folder or prune.
- Prune on every write: delete lines that are now false, merge duplicates, drop what the repo or the prompt already states.
- Adding a topic folder: create it with a `.gitkeep` so the skeleton stays tracked, and a `memory.md` beside it. Add a row to the memory `README.md` table in the same change.

## Reading

`grep -rn` works as-is. `rg` does not: the contents are gitignored, so plain `rg` skips every `memory.md` and returns nothing. Pass `--no-ignore`.

```bash
grep -rn "approval" .pi/factory/memory/gate
grep -rn "^- 2026-09" .pi/factory/memory/incidents
rg --no-ignore -l "flaky|retry" .pi/factory/memory
rg --no-ignore -l "xhigh" .pi/factory/memory
```

Blind spot to know about: a fact that only ever gets written into an ignored file is invisible to repo-wide `rg` searches and to review. If it is durable enough that the repo should know it, it belongs in `docs/engine/dark-factory.md` instead.
