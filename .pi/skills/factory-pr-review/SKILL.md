---
name: factory-pr-review
description: The human-side loop for a Dark Factory PR, from finding the owner's change request to landing or returning the branch. Covers reading the request off the review objects rather than the comment threads, cutting a detached worktree at the PR head, rerunning typecheck and the suite there, diffing against the PR's own `baseRefName`, merging with `--squash`, and the blocked-stage diagnosis that precedes a rescue. Use when asked to review, verify, land, implement the requested changes on, or rescue a factory PR, or when a dead stage is blocking the pipeline.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# Factory PR review

A factory PR arrives with three assertions already attached: the card says the work is approved, the body says how it was verified, and CI is green. All three are claims written by the process being reviewed. The repository is the only primary evidence, and the owner's request lives in a review object that two separate empty comment lists will happily tell you does not exist.

The move is the same every time: recover what was actually asked, cut a worktree that can run the suite at the exact head, rerun the gates, judge the diff against the spec, then land it with `--squash` or hand it back with a review. The factory never merges; that is the owner's step, and this loop is where a human takes it.

## The review loop

### 1. Find what was actually asked

```bash
gh pr view <n> --json state,isDraft,baseRefName,headRefName,headRefOid,reviewDecision,mergeable,commits
gh api 'repos/{owner}/{repo}/pulls/<n>/reviews' --jq '[.[] | select(.state=="CHANGES_REQUESTED") | {id, login: .user.login, at: .submitted_at, body}]'
gh api 'repos/{owner}/{repo}/pulls/<n>/comments' --jq 'length'    # inline diff comments
gh api 'repos/{owner}/{repo}/issues/<n>/comments' --jq 'length'   # conversation comments
```

`gh api` resolves the `{owner}/{repo}` placeholders from the current repository, so no slug is baked into this page.

**The change request is a review, never a comment.** On #214 both `pulls/214/comments` and `issues/214/comments` came back empty while the spec sat in a `CHANGES_REQUESTED` review, so an empty comment list is not "nothing to do". Read all three, and read the review body as the spec: it is the owner's own words about this branch, which beats anything the PR body claims about itself.

`reviewDecision` is a cheap gate, not the content: it stays `CHANGES_REQUESTED` after a push until GitHub clears it, so a decision whose review id the ledger already consumed can read as a standing request that has been answered. Compare the review ids and timestamps against the branch's last push (`gh pr view <n> --json commits --jq '.commits[-1].committedDate'`) before believing the state.

An `APPROVED` review from the owner is the answer to "may this land". Nothing else on the PR is, including a green check.

### 2. Cut a worktree at the head

The primary checkout is a read surface: it is usually on another branch, often dirty, and its suite proves `dev` is green rather than this PR. Verify in a worktree, always.

```bash
git fetch origin 'refs/pull/<n>/head:refs/remotes/origin/pr-<n>'
git rev-parse origin/pr-<n>                    # must equal headRefOid from step 1
WT="${TMPDIR:-/tmp}/pr-<n>"
git worktree add --detach "$WT" origin/pr-<n>
```

**Fetch the refspec and use `--detach`, not `gh pr checkout`.** A branch a factory job worktree still holds refuses a second checkout outright (`fatal: '<branch>' is already used by worktree at ...`), and those leftovers do not clear themselves. `--detach` sidesteps the branch entirely, and `refs/pull/<n>/head` is the one ref that survives both closing a PR and deleting its branch, so the recipe still works on a head that never reached `dev`.

Then install dependencies in the worktree, because a fresh worktree has none:

```bash
cd "$WT" && npm ci
```

**`npm ci` in the worktree, never a symlink to the primary install.** A symlink resolves the primary's `node_modules`, so the run proves the primary's lockfile: on 2026-10-16 that exact shortcut put `js-yaml` 4 against the PR's `dev`-based 5 and turned four asset tests red for a defect the PR did not have. The `cp -al` hardlink copy the ledger uses for job worktrees is not available either once the worktree is off the same filesystem (`Invalid cross-device link`).

### 3. Rerun the gates at the head

```bash
cd "$WT"
BASE="origin/$(gh pr view <n> --json baseRefName --jq .baseRefName)"
npm run typecheck      # tsc --noEmit, then tsc -p tsconfig.test.json
npm test               # vitest run
```

Both are the contract: a typecheck pass alone says nothing about behaviour, and a suite pass alone says nothing about `tests/` type coverage, which is the second `tsc` invocation.

**A green CI check on a stale branch is not verification, and the PR body's "how it was verified" is a claim.** PR #227 was assessed on CI plus a reading of the machine text and no suite was run at all; nothing about that reading distinguished a passing head from a broken one. Read the counts off the run, and confirm the PR's own new test file appears in them:

```bash
git diff --name-only "$BASE"...HEAD -- tests/
```

A test file that exists in the diff but not in the run means the suite is not picking it up, or the head is not the commit you think it is.

### 4. Judge the change against the spec

The spec is the `CHANGES_REQUESTED` body plus the item's acceptance criteria (`gh issue view <item>`), not the diff's own narrative. Diff against the PR's **own base**:

```bash
BASE="origin/$(gh pr view <n> --json baseRefName --jq .baseRefName)"
git diff --stat "$BASE"...HEAD
git diff "$BASE"...HEAD -- <path>
```

**A stacked PR's base is its own `baseRefName`, not `dev`.** `dev..head` on a stacked PR carries the whole parent branch as well, so it overstates the change, misattributes defects, and makes the suite run against commits this PR did not write. When the base is itself an unmerged branch, fetch it first (`git fetch origin <baseRefName>`) so the local ref is the one GitHub merged against.

Then check the load-bearing claim rather than the shape of the diff. On PR #224 the decisive fact lived in pi's own source and in the live transcript corpus, and no amount of reading the diff would have surfaced it. A guessed module path is worth one `find` or `git ls-files` before it becomes a finding.

### 5. Land it or hand it back

The repository allows squash merges only, which is checkable rather than remembered:

```bash
gh api 'repos/{owner}/{repo}' --jq '{merge: .allow_merge_commit, squash: .allow_squash_merge, rebase: .allow_rebase_merge}'
gh pr merge <n> --squash          # the only form that works
gh auth switch --user WernerVdM97
gh pr review <n> --request-changes --body-file <file>   # or hand it back
```

`gh pr merge <n> --merge` fails with merge commits disabled, and a rebase merge is disabled too, so `--squash` is not a style preference.

**A change request has to come from the reviewer's account, not the PR's.** Factory PRs are authored by the agent account that runs these commands here, and GitHub refuses approve and request-changes on your own PR: `gh pr review <n> --request-changes` exits non-zero with `Can not request changes on your own pull request`. The ledger also reads `CHANGES_REQUESTED` only from `FACTORY_REVIEWER_LOGINS` (default `WernerVdM97`), so a review left by the PR's own account would open no revise cycle. Switch first, or have the owner submit it. `gh pr review <n> --comment` is the one form that does work on your own PR, and it is advisory: it carries the spec for the next reader but opens no revise cycle.

**A squash merge leaves the PR head unreachable from `dev`.** `git branch -d` and `git branch --merged` therefore never see a merged branch: prove merged from the PR's own state (`gh pr list --head <branch> --state all`), delete local branches with `-D`, and read pre-merge content off `refs/pull/<n>/head` when the branch itself is gone.

When handing back, the review body is the next reader's spec, so it names the file and the line and the failure, not a general concern. Then clean up: `git worktree remove --force "$WT"`, since the report and `--body-file` draft you wrote there are untracked and a plain remove refuses them.

## A blocked stage: diagnose before rescuing

A dead stage leaves a board card, a job record and a stage child. The card and the job's prose are the least reliable of the three; the record is machine-written and the child left its own account.

```bash
npx tsx scripts/factory-jobs.ts show <item>    # the raw record, as JSON
npx tsx scripts/factory-jobs.ts list
npx tsx scripts/factory-jobs.ts stale
ls -t .pi/factory/jobs/artifacts/<item>/       # what each stage actually wrote
```

Read the record's own fields:

| Field | What it tells you |
| --- | --- |
| `stage`, `stageState` | where it stopped: `ready`, `running`, `waiting`, `blocked` |
| `attempts` | failed attempts per stage; two is the block threshold |
| `spentMs` | the job's cumulative burn against the 100-minute cap |
| `history[].result` | per attempt: `ok`, `nochange`, `waiting`, `skipped`, `retried`, `failed`, `timeout`, `reaped` |
| `claim` | `pid` plus `pidStart`, the pair that makes a liveness probe safe |
| `stageStartedAt` | when the attempt you are looking at began |

**`attempts` plus `spentMs` separates a crash from a budget overrun.** A stage that died in milliseconds has a failed attempt and almost no burn; one that burned its full budget has a `timeout` in `history` and that whole budget in `spentMs`; one whose drainer was killed shows `reaped`. A `stageState: running` whose `claim.pid` is gone is an orphaned record, and the next drain reaps it and charges an attempt, so a rescue that starts by "just retrying" pays for the same wall twice.

The stage child's own account is the other half, and it holds the exit code and how far it got:

```bash
ls -t ~/.pi/agent/sessions/*/subagent-artifacts/*_delegate-*_meta.json | head -3
```

That directory pairs `<runId>_<agent>_<taskIndex>_meta.json` (with a `_transcript.jsonl` beside it) and the meta file carries `exitCode`, `durationMs`, `usage.turns`, `toolCount` and `attemptedModels`. On job #97 the real cause was in that file, and the memory tree's own "probable infrastructure failure, just retry" line sent the next attempt straight back into the identical 37 ms failure.

**`retry` is a budget grant, not a fix.** `npx tsx scripts/factory-jobs.ts retry <item>` resets `stageState` to `ready`, zeroes `attempts`, refills `spentMs`, moves `Blocked` back to `In Progress`, and clears `revisions` and `consumedReviews` with it. That last part matters when diagnosing: a still-standing `CHANGES_REQUESTED` review is no longer consumed, so the next tick can open a fresh revise cycle against the same request. It repairs nothing, so without a change to the cause the same failure recurs and the job blocks for a second time.

**An agent-definition fix needs the job branch to carry it.** A stage child discovers `.pi/agents/` from its own working directory, which is the job worktree, so a fix merged to `dev` changes nothing until that branch has it: `git merge origin/dev` onto the job branch (or a rebase) before the retry.

**One stage per tick.** `npx tsx scripts/factory-jobs.ts drain` does exactly one oldest-ready stage. `bash scripts/factory-run-due.sh` fires due schedules then drains, so it can start a loop and advance a job in the same tick, while `FACTORY_FIRE=<schedule-id>` skips the drain entirely and never advances a job. The pause switch and the loop levers belong to `factory-control`.

## After the merge: reinstall what the launcher runs

Everything the factory runs from TypeScript (`scripts/factory-jobs.ts`, `scripts/send-dm.ts`, `scripts/factory-bulletin.ts`) is executed straight out of the checkout, so those need nothing after a merge. The launcher itself is the exception: `scripts/factory-run-due.sh` and its units are **copies**, and a PR that changes them changes nothing until they are reinstalled.

```bash
cmp /usr/local/bin/factory-run-due scripts/factory-run-due.sh   # expect: silent; differs = drift
sudo cp scripts/factory-run-due.sh /usr/local/bin/factory-run-due
sudo cp scripts/factory-run-due.service scripts/factory-run-due.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl restart factory-run-due.timer
```

Check for it before merging rather than after forgetting:

```bash
BASE="origin/$(gh pr view <n> --json baseRefName --jq .baseRefName)"
git diff --name-only "$BASE"...HEAD -- scripts/factory-run-due.sh scripts/factory-run-due.service scripts/factory-run-due.timer
```

A half-installed state is survivable but idle: until the copies match, the installed tick runs the old drain step, and a job the new starter opens sits at `ready` until someone reinstalls. The `sudo systemctl edit factory-run-due` drop-in (`User=`, `HOME=`, `PATH=`, `FACTORY_PROJECT_DIR=`) is per-machine and survives the `cp`, so none of it belongs in the tracked unit. The switch sources and the tick test are in `factory-control`; the install order and why it can wedge a schedule are in `docs/engine/dark-factory-job-ledger.md` § Install.

## Red herrings

Each one is a conclusion that outlived the evidence which disproved it.

| Red herring | What disproved it |
| --- | --- |
| "Probable infrastructure failure, just retry" | the same stage failed identically in 37 ms, twice: identical `result` in `history`, no movement in `spentMs`, so deterministic rather than flaky |
| "The wrapper is hung" | the child had already exited and the output was simply static; the meta file's `exitCode` and `durationMs` said so, and the process was gone |
| `pgrep -f <agent>` proves it is still running | the pattern matched the agent's own polling command, so every probe read RUNNING; probe `claim.pid` against `claim.pidStart` instead |
| A model pin or an OOM killed the stage | the theory survived several calls after the evidence had stopped supporting it; `history[].result` and the exit code name the cause, the model pin is checkable in the meta file's `attemptedModels` |
| A green CI check proves the head | the check ran on the commit as pushed; rerun the gates at `headRefOid` or you have verified a branch, not this one |
| The PR body's "how it was verified" | written by the agent that did the work, in the same process that did the work |
| A hanging review whose comments are all empty | the request was a `CHANGES_REQUESTED` review; the comment endpoints were both empty by design |

## A declined question is not a delegated decision

When the owner parks a question or declines to answer it, the question stays theirs. Picking an answer, documenting the pick and proceeding is the failure, not the shortcut: on #214 the owner's correction was exactly this ("wait dont make the call, ask again"), after a declined question had been decided anyway. Ask again, and leave the work parked until the answer arrives. A one-line "nothing to do without your answer" beats a plausible guess that has to be unwound.

## Not this skill

- The branch model, `dev` → `main`, version bumps and release tags: `releasing`.
- The build loop, the tier table, worktrees for building streams: `orchestrated-delegation`.
- Live player-agent panels and `npm run agent:panel`: `agent-smoke`.
- The ledger's own machinery (stages, budgets, the gate, the revise cycle, `deliver`/`reconcile`/`done`) and the loop runbook: `docs/engine/dark-factory-job-ledger.md` and `docs/engine/dark-factory.md`. Stopping and starting the factory, firing a tick or a loop by hand: `factory-control`.
