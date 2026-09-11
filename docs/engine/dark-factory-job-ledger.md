---
title: Dark Factory job ledger
status: decided
domain: engine
phase: poc
tags: [process, automation, agents, github, worktrees]
related:
  - "[[dark-factory]]"
  - "[[dark-factory-requirements]]"
  - "[[TODO]]"
---
_A board item becomes a tracked job whose stages run one per process, with state in `.pi/factory/jobs/<item>.json` instead of a single long-lived session. Fixes the failure where one process holds the whole build, the deadline comes from systemd's tick, and a killed run leaves the item `In Progress`, invisible and unowned._

---

## Why

The executor's first headless run (2026-09-11, item #34) died at exactly 30:00 because the launcher's `TimeoutStartSec` was the only deadline in the chain. It had committed its work at 20 minutes, was killed during its final verify, opened no PR, left the item `In Progress`, and lost its post-review fixes with the cleaned-up worktree. Its failure was recorded two hours later, in the same millisecond the next tick happened to poll. The full record is in `.pi/factory/memory/incidents/`.

Three properties of the old shape caused that, and none of them is a prompt problem:

- A chain of stages inside one process tree has a total budget of `min(stage budgets)`, and the parent's timeout becomes the task's deadline.
- State lives in the process, so a crash loses every stage downstream of the crash.
- The two steps that get lost first, opening the PR and moving the board item, are the two with no model in them. They are prose in a prompt rather than code.

## The unit of work: a job

One board item being built, tracked in `.pi/factory/jobs/<item>.json` (runtime, gitignored, schema-versioned). Machine-readable state written by code, never prose written by an agent.

```json
{
  "schemaVersion": 1,
  "item": 34,
  "title": "Last stand buttons/captions: emojis + combat scene frame",
  "priority": "P2 - normal",
  "milestone": "v0.3.x polish",
  "branch": "feat/34-last-stand-emojis-combat-frame",
  "worktree": "/home/werner/projects/worktrees/daily-pixel/feat-34-...",
  "baseRef": "dev",
  "stage": "review",
  "stageState": "running",
  "attempts": { "build": 0, "review": 1, "fix": 0 },
  "spentMs": 1200000,
  "claim": { "pid": 50839, "pidStart": "8123" },
  "artifacts": {},
  "pr": null,
  "adoptedFrom": { "branch": "feat/34-last-stand-emojis-combat-frame", "commit": "31eb9e3" },
  "history": [
    { "stage": "review", "startedAt": "…", "endedAt": "…", "result": "timeout", "exit": null }
  ]
}
```

That record is #34 mid-flight: adopted at `review` per the decision below, its first review attempt timed out at the 20-minute budget and was silently requeued, and its second attempt is running. `attempts` counts failed attempts (the guard blocks the third), `spentMs` carries the timed-out attempt's full 20 minutes, and `pidStart` is explained under liveness. `pr` is null until `deliver` records the PR it opened, and it is what `reconcile` reads after the merge.

The board stays the human surface: Status, priority, comments and the bulletin are unchanged. The ledger is the machine surface that makes `In Progress` mean something after a crash.

## Stages

One stage per process. The three model stages are each a spawned `pi -p` wrapper whose child agent is named in the prompt, owned by the drainer, with its own timeout and its own budget; they write to the default session root (one session file per spawn, which is what keeps `scripts/factory-friction.ts` and meta-oil able to read the transcripts). `deliver`, `reconcile` and `done` are plain code the drainer runs itself, no child at all.

`start` is a command, not a stage. The daily schedule's agent runs `npx tsx scripts/factory-jobs.ts start`, which does its work inline in seconds (worktree, branch, ledger record, Status `In Progress`, claim comment) and leaves the job at `build`/`ready`; the drainer's stages begin at `build`.

| Stage | Kind | Agent | Budget | Ends with |
| --- | --- | --- | --- | --- |
| `build` | model | `factory-builder` | 50 min | commit on the branch plus a build report |
| `review` | model | `factory-reviewer` | 20 min | `findings.md`; read-only, fresh context |
| `fix` | model | `factory-fixer` | 30 min | committed fixes, or a recorded skip when the review reports none |
| `deliver` | code | none | seconds | pushed branch, PR to `dev`, Status `In Review`, PR-link comment, PR number recorded |
| `reconcile` | code | none | seconds | merged: Status `Done` and the issue closed. Still open: stays waiting, costing nothing |
| `done` | code | none | seconds | worktree removed, record moved to `.pi/factory/jobs/archive/<item>.json` |

The reviewer is the one stage that must not be able to write to the worktree: it runs with a read-only toolset (no edit, write or bash), returns its findings as its final output, and the drainer persists that output as the job's `findings` artifact. The fixer then reads the artifact, so findings cross a stage boundary as a file written by code, not by an agent.

**Total: 100 minutes.** The budgets are split build 50 / review 20 / fix 30, and 100 is also a hard **cumulative cap** on a job: `spentMs` accumulates across every stage and every attempt and is never refunded, and a job that reaches 100 minutes is blocked rather than allowed to keep retrying. Without the cumulative cap, two attempts at each of three stages could quietly spend 200.

A requeue does not refresh `spentMs`; what it refreshes is the stage. Each attempt runs with a timeout of `min(stage budget, remaining)`, so a failed attempt is charged only for the time it actually used, the retry of a single failed stage gets its full stage budget back in every realistic case, and the job total still never crosses 100. A build that burns all 50 minutes twice has spent the cap and blocks as not converging; a build that fails at 20 and passes on retry at 25 has spent 45 and leaves 55 for review, fix, deliver and done. Only the owner can reset the meter, with `factory-jobs.ts retry` (see Failure policy), for the same reason an adopted job starts at zero: a human looked at it and decided it gets another 100.

Budgets are enforced by the drainer, which owns the child process. The tick ceiling exists only to bound the schedule step plus the longest stage: the schedule step was already bounded by the old 1800 and in practice runs minutes (triage measures ~6), the longest stage is 50, so `TimeoutStartSec` goes to 5400 (90 min) against a worst case of 30 + 50 = 80, with margin rather than headroom to grow into.

## Adoption

A job can enter the ledger without a fresh `build`. `start` prefers **adopting an orphan** before it picks a new item from the board, because a crashed run leaves committed work behind and a rebuild wastes it.

An item is adoptable when it is `In Progress`, has no job record, and carries a factory claim comment or a local branch matching `**/<item>-*`. The claim comment is authoritative because it names the branch (`factory: claimed (branch feat/34-…)`); the branch glob is the fallback for items claimed before that convention existed. Anything else `In Progress` is left alone for the owner or the sweeper, so an item a human set by hand is never silently taken over.

Adoption creates the worktree from the existing branch rather than off `dev`, merges `dev` into that branch, records `adoptedFrom` in the ledger, and enters at the stage the branch has actually reached. The merge is not cosmetic: pi discovers a stage agent from the child's working directory, which is the job worktree, so a branch cut before the ledger existed would run the pre-ledger agent contracts (including "do not commit"). A conflict aborts the adoption, comments the reason on the item and charges the job nothing, so the fix stays the owner's.

- Branch exists with commits ahead of `dev` → enter at **`review`**. The build already happened; re-reviewing re-finds anything the lost fix pass would have landed.
- Branch exists with no commits → enter at **`build`**.

An adopted job starts with `spentMs: 0`, so it gets its full 100 minutes. The prior run's cost is recorded in `adoptedFrom` for the record, not charged against the new budget: the stage shape is different, and charging a crashed run's wall clock against the new one would block a job before it had a chance to converge.

## Triggers

A schedule fires once, and a job needs several sequential steps, so the daily executor schedule cannot advance stages. Making the drainer run all stages back to back would rebuild the problem being fixed here: one long-lived process under one deadline.

- **`factory-executor`'s daily schedule starts a job**, and nothing else. At its slot the tick fires the schedule, whose target is unchanged: the same `factory-executor` agent, its definition rewritten to run one bash command, `npx tsx scripts/factory-jobs.ts start`, and stop. The name stays put because the schedule's target is a runtime file the PR cannot carry; a rename would open a window in which the schedule fires an agent that no longer exists. The definition changes underneath the name instead, so no merge order can break a tick.
- **The existing 5-minute systemd tick advances stages.** Every tick also runs `npx tsx scripts/factory-jobs.ts drain`, which takes the oldest job record needing action and does one thing: reaps an orphan, blocks a spent or twice-failed job, or runs one ready stage. Schedules fire before the drain in the same tick, so a job started at 06:00 can have its build running by 06:01.

A stage that finishes at 06:31 waits for the 06:35 tick. Irrelevant for a daily loop, and it buys per-stage isolation and crash safety for free. The `factory-executor` slot also moves off DeepSeek's peak window, which is orthogonal but convenient.

## What the drainer decides each tick

```text
guards: mem floor, global flock                       (existing, unchanged)
if a schedule is due:  pi -p … schedule.run-due       (existing path)
then:                  drain                          (new)
  take the drain lock (non-blocking; held for the whole run, stage included)
  for each job record, oldest first:
    running + pid live + start time matches -> orphan: kill its process group,
                                               count one failed attempt, requeue
    running + anything else                 -> died with its drainer: count one
                                               failed attempt, requeue
    blocked                                 -> skip (already paged)
    ready + attempts[stage] >= 2            -> block, page, skip
    ready + spentMs >= cap                  -> block, page, skip
    ready                                   -> run the stage (timeout
                                               min(stage budget, remaining)),
                                               record the result, exit
                                               (a reconcile that finds the PR
                                               still open records `waiting`:
                                               no attempt, no budget spent)
```

Every command that writes a job record (`start`, `drain`, `retry`) takes the drain lock first: a non-blocking flock on `.pi/factory/jobs/.drain.lock`, held for the whole command, the running stage included. The lock lives in the jobs dir, so a dry run against a scratch dir takes a scratch lock and never fights the real one. The lock is what makes liveness simple: a drain that is executing has already proven no other drainer is alive, because a live one would be holding the lock. A record that still says `running` was therefore left behind by a dead drainer, and the only open question is whether its child survived it. A `start` or `retry` that finds the lock held fails soft and reports rather than waiting; worst case a start colliding with a by-hand drain slips a day, which beats a schedule step blocked on a lock it cannot see.

`claim` carries `pid` plus `pidStart`, the kernel's process start time from `/proc/<pid>/stat`. The start time is what makes the pid probe safe: a recycled pid has a different start time, so the reaper kills only a process it can prove is the orphan, never an innocent process that reused the number. Stage children run in their own process group (`setsid`), and reaping kills the group (`kill(-pid, SIGKILL)`), because a `pi` child leaves grandchildren behind it (bash tool runs, spawned subagents); the same group-kill runs after a normal wait, so nothing outlives its stage. A live pid with a mismatched start time is just a recycled number: count the attempt and never kill. A reboot reads the same way, which is the right answer, because the stage died with the box.

There is no heartbeat. The first sketch had one, refreshed every 30 s by the drainer, but under the drain lock a heartbeat could only ever confirm what the lock already proves, and it left a refresher loop and a staleness threshold to get wrong. The lock plus a start-time-verified pid does the same job with no moving parts, and a wedged child needs no liveness signal at all: its own budget kills it, and the drainer that owns it records the timeout.

## Failure policy

- Attempt 1 fails (non-zero exit, timeout, or a killed drainer) → **silent requeue**: stage back to `ready`, `attempts[stage]++`, history records the failure and charges the attempt's actual elapsed time to `spentMs` (from its `startedAt` to the exit or reap), so a killed drainer cannot hide its cost.
- Attempt 2 fails → **block and page**: Status `Blocked`, `stageState: blocked`, a comment stating what failed twice and what is needed, and a Discord DM via `scripts/send-dm.ts`. Both channels are the decision: the comment is the durable record the bulletin already sorts, and the DM is the page, so a second failure reaches the owner instead of waiting to be read. A failed DM is logged, never fatal, and never blocks the block.
- Cumulatively over budget → blocked and paged the same way, because a job that has spent 100 minutes is not converging.
- A PR closed without merging blocks the same way; see Reconciling the merge.

Only the owner unblocks, with `npx tsx scripts/factory-jobs.ts retry <item>`: `stageState` back to `ready`, attempts zeroed, `spentMs` refreshed to a full 100 minutes, Status `Blocked` back to `In Progress`, the old totals kept in `history` for the record. A retry is the same decision an adoption makes: a human looked at the job and decided it gets a fresh budget, which no automatic path is allowed to grant.

The bulletin already sorts `Blocked` items with a written question, so a blocked job surfaces there with no extra work.

## Deliver is code

`git push -u origin <branch>`, `gh pr create --base dev --head <branch>` with a body carrying what changed, why, how it was verified, and `Closes #<item>`, then board Status `In Review`, a comment with the PR link, and the PR number written to the record. No agent, no context, no tokens, and nothing to be killed at 29 minutes. This is the stage whose absence lost #34. The `Closes` keyword is for the day a release merge carries the commit into `main`; nothing here depends on it firing, because `reconcile` closes the issue itself.

## Reconciling the merge

Merging is the owner's step, so the stage that opened the PR cannot know the outcome. `reconcile` closes that gap. It runs as plain code on a tick, reads the recorded PR with `gh pr view <n> --json state,mergedAt`, and takes one of three paths:

- **Merged** → Status `Done`, then close the issue with a comment naming the PR, then `done`. This is the transition the sweeper used to own, now happening within a tick of the merge rather than within 48 hours of it.
- **Still open** → the job stays at `reconcile`/`ready` and the pass records `waiting`. Nothing is charged: a job waiting on the owner spends none of its 100 minutes, and a waiting pass is not a failed attempt, so it can wait as long as a review takes without edging toward the block thresholds.
- **Closed without merging** → block and page, treating a rejected PR as a decision rather than a failure. The branch, the worktree and the reviewer's findings all stay, so a redo resumes from the review instead of from `dev`.

This is why the sweeper has to stand down on ledger items: two writers on one transition would race, and the sweeper would move the card to `Done` without closing the issue, leaving the ledger holding a job it still believes is awaiting a merge. The sweeper keeps the rule for items with no job record, which is every item that predates the ledger.

`done` follows immediately in the same code path: worktree removed, record archived, branch kept. The branch outlives the job on purpose, because `done` means merged and those commits are the record of what was merged. It then survives only until the pruner runs: `factory-jobs.ts housekeeping` deletes local branches whose PR is merged, which a job's branch always is by the time `done` has run. The archived record keeps the branch name, and `origin`'s copy is left alone — deleting it is the owner's button on the PR page, and no `git fetch` can bring it back.

Waiting is visible rather than silent. `factory-jobs.ts stale` lists jobs whose PR has been open for more than a week, beside the orphaned records it already prints for humans, and the sweeper's own idle-PR check keeps nagging at 24 hours in the digest.

## Components

New:

- `scripts/factory-jobs.ts`: the ledger library and CLI. `start` picks or adopts and creates the record; `drain` takes the drain lock and does the oldest job's one action; `retry <item>` is the owner's unblock; `housekeeping` fetches, fast-forwards local `dev` when that is safe, and deletes local branches whose work is provably in `dev` — wholly contained, or a merged PR whose head was exactly that branch's tip (it is what the tick runs after the drain, and what the sweeper reports); `list`, `show`, `stale` are read-only (`stale` prints jobs whose records say `running` but whose pid is gone, and jobs waiting on a merge for more than a week, for humans).
- A test file beside the existing factory-script tests.
- `.pi/agents/factory-builder.md`, `factory-reviewer.md`, `factory-fixer.md`. **Not as written:** the stages reuse the repo's existing `delegate-executor`, `delegate-reviewer` and `delegate-fixer`, which gained a ledger-stage mode, so the build loop keeps one set of role definitions instead of two near-identical ones (see the closing note).

Changed:

- `scripts/factory-run-due.sh`: the due-schedules step no longer `exec`s (the shell has to survive to the next step); the nothing-due early exit becomes a drain-only tick, because a ready stage does not care whether any schedule was due; the drain step runs last, every tick.
- `scripts/factory-run-due.service`: `TimeoutStartSec` 1800 → 5400.
- `docs/engine/dark-factory.md`: the executor row and a pointer to this spec.
- `CHANGELOG.md`: one Unreleased bullet.
- `.pi/agents/factory-executor.md`: rewritten into the thin starter (one bash command, no build work); the name survives because the schedule targets it (see Triggers).
- `.pi/factory/memory/loops/executor/memory.md`: the new protocol's invariants.

## Rollout

The launcher runs scripts from the checked-out tree, so a half-installed state (new tick, old checkout) would have the tick calling a drainer that is not there. Order:

1. One PR to `dev` carrying the ledger, the three stage agent definitions and the rewritten executor, the launcher wiring, the docs, and the already-written model-pin and cadence retunes from the same session. Those retunes are independent of the ledger, so they ride as their own commits and can be reverted alone.
2. Owner merges.
3. `sudo cp scripts/factory-run-due.sh /usr/local/bin/factory-run-due`, copy the units, `daemon-reload`, restart the timer.

There is no runtime-file step: the schedule keeps targeting `factory-executor`, whose definition is already the thin starter by the time it merges, so nothing is repointed by hand and no merge order can break a tick.

Between the merge and step 3 the factory half-exists: the rewritten executor can start a job, but the installed tick has no drain step, so the job sits `ready` until the first post-install tick advances it. Harmless, but install promptly to avoid the confusion. The starter's task text also fails soft ("if `scripts/factory-jobs.ts` is absent, report that and stop") so a merge can never wedge the schedule.

## Interactions to reconcile

- **The sweeper's stalled-`In Progress` rule** currently resets those items to `Approved`, which would fight a ledger job that is legitimately `In Progress` across ticks. Narrow it to `In Progress` with no job record **and no adoptable branch**, so the two never both own the same item and the ledger gets first refusal on orphans. Its `In Review` → `Done` rule stands down the same way: for items with a job record the ledger owns that transition, because only the ledger also closes the linked issue (see Reconciling the merge).
- **#34 is adopted (decided).** It is `In Progress` with branch `feat/34-last-stand-emojis-combat-frame` at `31eb9e3` and no PR. The ledger adopts it at `review`, not `build`: the branch is a green pre-review checkpoint, so re-reviewing is the correct next step and it re-finds the fixes that were lost with the worktree. Its prior run's cost is not charged against the new budget.
- **#97 is `Approved` with zero acceptance criteria.** A `build` stage would read it, find nothing to implement, and burn an attempt. Write the criteria first, or take `needs-human-decision` off before the first job runs.

## Tests and verification

Unit tests only, no real `pi` spawn, with an injected clock and an injected runner:

- State machine: advance, skip `fix` when the review reports no findings, silent requeue on the first failure, block on the second, block on cumulative budget, and the adaptive attempt timeout `min(stage budget, remaining)`.
- Adoption: an orphan with a claim comment is taken over; one with only a matching branch is taken over; one with neither is left for the sweeper; a branch with commits enters at `review` and one without enters at `build`.
- Reconcile: an open PR leaves the job waiting with no attempt charged and nothing spent; a merged PR sets `Done` and closes the issue; a PR closed unmerged blocks; a waiting job survives many ticks without reaching the attempt or budget guards.
- Liveness and locking: a second drain exits on the drain lock; a genuine orphan (pid live, start time matches) is killed as a group and counted; a recycled pid (pid live, start time differs) is counted and never killed; a clean crash is counted; `retry` clears `blocked`, zeroes the attempts and refreshes the budget.
- The gate: only `Approved`, plus `auto:docs`/`auto:changelog`/`auto:tests` within their class; priority then oldest; `Inbox` and `Blocked` never picked.
- `deliver` command construction against an injected exec.
- A dry-run mode (`FACTORY_DRY_RUN=1`) so the drainer can be exercised by hand against a scratch jobs dir.

Then the repo's own gate: full suite and typecheck green before each commit, and one live stage run by hand before the PR to prove the spawn path with a real `pi` child.

## Not in scope

No structural changes to triage, sweeper, scrumo or meta-oil: they are single-stage loops that fit their budgets. The sweeper's two board-hygiene rules are narrowed so that the ledger owns `In Progress` and `In Review` for items with a job record; that is a scope reduction for the sweeper rather than new work for it. No change to the gate policy, the board taxonomy, or `src/`. The game-side `deepseek-v4-flash` default is its own board item (read the model from `.env`), not part of this work.

## Risks

- **Spawning `pi` from a script** needs the right PATH, HOME, approval flags, cwd and session dir. Mitigated by the dry-run mode, one live stage before the PR, and reusing the exact flags the launcher already proves.
- **More processes, more re-reads.** Each stage re-reads repo context; a whole executor pass measured $0.36, so this stays cheap. Worth re-measuring with the friction script.
- **Two writers.** Three serialisations close it: one tick at a time via the global flock, one ledger writer at a time via the drain lock, one stage at a time because a drain runs one stage and exits.
- **A long stage delays other schedules.** The drain runs inside the tick, so a 50-minute build holds the global flock and any schedule due meanwhile fires late, at the first tick after the build ends. The factory already tolerated 30-minute executor runs in the same shape, and `catchUp: latest` preserves each schedule's phase, so nothing is lost, only shifted.
- **More machinery than the current load needs.** Accepted: the failure was state management, not throughput.

---

## Next steps

[x] Recon first: the factory-script test layout, `tsconfig` scope for `scripts/`, the `pi` CLI flags for spawning a stage child, and the flag set that gives the reviewer a read-only toolset.
[x] Build the ledger and its tests, then the three stage agents and the rewritten executor, then the launcher wiring, then the docs and changelog.
[ ] Open the PR to `dev`; install the units only after the merge. Between the merge and the install the factory half-exists: the starter can open a job, but the installed tick has no drain step, so the job sits `ready` until the first post-install tick advances it.

---

_Built 2026-09-11. Four deviations from the sketch above, all recorded in the code: a stage child is spawned as `pi -p --approve --tools subagent`, because this pi build has no `--agent` flag, and the stage agent is named in the wrapper's `subagent({agent})` call instead; the reviewer keeps `bash` (read-only is enforced by the drainer failing the stage when the worktree is dirty, rather than by withholding the tool, so its findings can cross the stage boundary as a file written by the agent); `build`/`fix` report through a file the drainer reads, with a `VERDICT:` first line for the review (`clean` skips the fixer, `nochange` lets it accept without a commit); and **adoption merges `${baseRef}` into the adopted branch**, because pi discovers the stage agents from the child's cwd and that cwd is the job worktree, so a branch cut before the ledger existed would otherwise run the pre-ledger agent contracts. A conflict aborts the adoption, comments the reason and charges the job nothing. The stages reuse the repo's existing `delegate-executor`/`delegate-reviewer`/`delegate-fixer` agents, which gained a ledger-stage mode, rather than new `factory-{builder,reviewer,fixer}` files._
