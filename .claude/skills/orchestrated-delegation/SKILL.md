---
name: orchestrated-delegation
description: A lead owns analysis, spec, triage, verification, and commits. Lower-reasoning subagents execute, review, and fix; a coordinator steers the session; a higher-reasoning judge gates risky changes. Commits between iterations. Use when a task is large enough to decompose across agents.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent
---

# Orchestrated Delegation

## Overview

Boilerplate takes the same effort on any tier, so paying a stronger model to type it is pure waste. The lead's scarce capacities are **judgment** — understanding a system, settling a design, triaging what matters, deciding when something is actually done — and **context budget**. This skill runs mechanical work on the lower-reasoning tier, spends the lead only on those capacities, and lets a single coordinator host keep the whole run aimed at the goal.

**Default shape is a loop; parallelise only when work is genuinely independent.** A loop runs one stream: spec → execute → verify → commit → review → triage → fix → verify → commit. A graph runs several independent streams at once, each in its own git worktree and branch, and burns far more tokens, so fan-out is a deliberate choice at decomposition time, never the default, capped at 3 streams.

This is a meta-workflow. It orchestrates other skills (`spec-driven-development`, `planning-and-task-breakdown`, `code-review-and-quality`, `doubt-driven-development`, `git-workflow-and-versioning`) rather than replacing them.

## Dark Factory gate

This repo runs the skill as the Dark Factory's build loop, which puts one hard gate on top of everything below:

- **Execute only gated items.** An agent works a board item only when its Status is `Approved`, or it carries a matching standing-approval label (`auto:docs`, `auto:changelog`, `auto:tests`) and the change stays inside that class. Anything else is read-only. Only the owner approves.
- **Worktrees fork off `dev`.** Every stream builds in an isolated worktree cut from `dev` (`baseRef: 'dev'`), never on `dev` or `main` directly.
- **Agents never merge or push.** The executor opens a PR targeting `dev`. Merging, releases, and pushes to `dev`/`main` stay with the owner.

The role definitions live in `.pi/agents/`: `factory-executor` leads the loop, the `delegate-*` agents are its children. Board, gate, and loops are specified in [docs/engine/dark-factory.md](../../../docs/engine/dark-factory.md).

## Roles and tiers

| Role | Agent (`.pi/agents/`) | Model (thinking) | Runs | Owns |
| ------ | ------- | ------- | ------ | ------ |
| Lead | main session; `factory-executor` in the factory | session default; the factory pins `z-ai/glm-5.3-flash` at `high` | every iteration | analysis, spec, triage, verification, commits, human contact |
| Coordinator | `delegate-coordinator` | `deepseek/deepseek-v4-flash` at `high`, read-only | session checkpoints | steering: direction, drift, blockers, next move |
| Executor | `delegate-executor` | `deepseek/deepseek-v4-flash` at `high` | per stream | implement exactly to spec, return evidence |
| Reviewer | `delegate-reviewer` | `deepseek/deepseek-v4-flash` at `high`, read-only | per stream | adversarial critique, ranked findings |
| Fixer | `delegate-fixer` | `deepseek/deepseek-v4-flash` at `high` | accepted findings | implement only accepted changes |
| Judge | `delegate-judge`; `factory-escalator` for the factory's hard slices | `z-ai/glm-5.3` at `max`, read-only | risky changes only | second opinion; verdict gates acceptance |

**Model budget is the point.** The lower-reasoning tier proposes work and findings; the higher-reasoning tier accepts. Quality comes from process, not tier: fresh-context review, barrier verification, and lead triage gate what lands. Concrete models are pinned in each agent's `model:` and `thinking:` frontmatter under `.pi/agents/`: the four mechanical roles ride `deepseek/deepseek-v4-flash` at `high`, and only the judge pays for `z-ai/glm-5.3` at `max`. All DeepSeek ids route direct on the `deepseek` provider, never via OpenRouter (owner rule); `deepseek/deepseek-v4.1-flash` is not in the active registry, so triage's image ingestion uses `deepseek/deepseek-v4-flash-vision-exp` instead. The coordinator's value is position, not tier: a separate, read-only context that holds only the goal, the plan, and repo state. It is consulted at checkpoints, never per subtask.

## Coordinator

The coordinator steers the session; it never touches the work.

- **Does:** hold the goal, the plan, and repo state (branch, last commit, phase). Reports where the run stands against the goal, what is drifting, what is blocking, and the single highest-value next move.
- **Does not:** write the spec, draft handoffs or prompts, review code, or see subtask outputs. It works from the goal statement, the plan doc, and repo state, never transcripts.
- **Checkpoints:** pre-flight, before decomposition ("what is missing from this plan, what risks should we design around"); then once per stage boundary, after each verified commit ("still on track, next do X" / "pause, this drifted"). At most once per stage; the steer is a few lines, not a report.
- **Record its steer** in the tracking doc: it is the durable memory that survives `/clear`, and the next coordinator consult builds on it.

## Flow

### Loop (default)

spec → executor → **barrier**: lead verifies (re-run verification, read riskiest files) → commit → reviewer (fresh, read-only) → lead triage → fixer → lead verify → commit → coordinator checkpoint → `/clear`

### Graph (only when decomposition finds ≥2 independent streams)

```text
LEAD: analyse → spec → decompose
        │ each stream gets its own scope fence; clean tree required
        ▼
  ┌─ worktree A · branch feat/a · executor ─────┐
  ├─ worktree B · branch feat/b · executor ─────┤  parallel, embedded verification
  └─ worktree C · branch feat/c · executor ─────┘
        ▼
  BARRIER: lead verifies each stream independently;
           failing stream quarantined + fixed in place, never merged broken
        ▼
  MERGE: each verified stream → atomic commit on the integration branch
        ▼
  REVIEW FAN-OUT (fresh, read-only): conformance | security | performance
           + judge if risky
        ▼
  BARRIER: nothing moves forward until all reviewers report
        ▼
  LEAD TRIAGE: accept / drop with reasons → fixer(s) → verify → commit → coordinator checkpoint
```

## Principles

1. **The spec is the contract.** Exact files, signatures, a scope fence, and verification commands. In a graph, every stream handoff carries its own fence: no fence, no fan-out. If you find yourself hoping the executor "figures it out", the spec is not done.
2. **Verify, don't trust the report.** The executor's summary is a claim, not evidence. Re-run the verification yourself, read the one or two riskiest files, confirm counts. Especially anything on a live/production path.
3. **Barrier verification.** In a graph, verify each stream independently before anything merges. A broken node must not contaminate the merge: quarantine it, fix it in place, re-verify.
4. **Review with fresh, adversarial context.** Reviewer and judge are separate, read-only agents. Never reuse an executor's context for review: the builder is the worst reviewer of its own work.
5. **Judgment gates acceptance.** The lead accepts; a judge it summons on risky changes is a second pair of eyes with fresh context, not a replacement for lead judgment. Reviewers produce noise by design; triage is the filter, and 8 findings → 3 accepted is healthy.
6. **Second opinion for risky changes.** Changes on live paths, changes that failed a prior review, or changes where the lead suspects blind spots get a judge: fresh, read-only context; its verdict gates acceptance.
7. **Triage is the lead's job.** Accept what is real and matters; drop nitpicks and self-mitigated concerns; state why for each.
8. **Atomic commits per verified stage or stream.** Each verified stream is one mergeable commit; history stays bisectable. Worktrees isolate streams; the lead merges.
9. **Fan out only when independent; cap at 3.** Parallelism multiplies token burn. ≥2 streams with no cross-dependencies, cap 3 (4 only in exceptional cases). On metered/API budgets, stay loop-shaped. When in doubt, loop.
10. **Protect the lead's context; compact at boundaries.** A completed, committed stage's transcript is dead weight; the docs and commits are the durable memory. Recommend `/clear` after a stage loop completes, after closing the doc loop (Principle 11).
11. **Close the doc loop before declaring a stage done.** Flip checkboxes, update tracking lists, settle open questions in the doc that asked them, record the coordinator steer. If the docs don't match repo reality, the next session inherits a lie.

## Git worktrees

Each parallel stream runs in its own worktree so agents never fight over one checkout. Requires a clean tree.

```js
subagent({
  tasks: [
    { agent: "delegate-executor", task: "<stream A handoff: spec, files, fence, verify cmds>" },
    { agent: "delegate-executor", task: "<stream B handoff>" },
    { agent: "delegate-executor", task: "<stream C handoff>" }
  ],
  concurrency: 3,
  worktree: true,
  baseRef: "dev"
})
```

In the factory the base is always `dev` (`baseRef: "dev"`), so the streams and the integration branch both start from `dev`. `worktree: true` isolates each task in its own git worktree and branch. Capture each stream's worktree path and branch name from the subagent results; the lead needs them at the barrier. Executors never commit (their contract): after all streams return, the lead verifies each at the barrier, commits the verified work in each worktree, merges each branch (`git merge --no-ff`) into the integration branch, and prunes. Worktrees are throwaway isolation, not long-lived branches; the integration branch stays the single source of truth.

## Handoff templates

The `delegate-*` definitions encode each role's durable contract (don't-commit, report format, read-only stance). Your per-task handoff supplies only what the definition cannot know:

**Executor** — pointer to the spec doc ("read this first — it is the contract") + grounding files; exact deliverables; the scope fence; verification commands + pass baseline.

**Reviewer** — the spec doc as the conformance baseline; the exact branch/commit in scope (`git show <sha>`); a ranked checklist of what matters most for this change; adversarial framing ("find a concrete input that breaks this"); whether to add a security or performance angle.

**Fixer** — only the accepted change requests, as concrete instructions; verification commands + baseline.

**Coordinator** — goal statement; plan doc pointer; repo state (branch, last commit, phase); explicit "steer, do not plan or write prompts".

**Judge** — the spec doc; the branch/commit in scope; why it was summoned (live path / prior failure / blind-spot suspicion); "pass or block".

**Resume one-liner** (crossing a `/clear`) — the parent/tracking doc *and* the active stage plan; branch + last commit hash(es); the last coordinator steer; the next task and open questions; reconcile-first (verify the docs' claimed state against the repo and fix drift before building).

## Red flags

- Delegating execution before the design is settled.
- Committing on the strength of a subagent's report without independent verification.
- A reviewer that shares the executor's context, or that can edit files.
- Build and review-fix changes landing in the same commit.
- The lead reading whole files it could have delegated.
- No scope fence in a handoff.
- Fanning out streams that actually share a dependency: they block on each other and burn tokens twice.
- Skipping barrier verification and merging unverified worktrees.
- Spawning the judge on routine changes, or the coordinator per subtask.
- More streams than the lead can verify attentively (over 3).
- Running many stages without `/clear`: the lead drifts onto a bloated, stale context.
- A resume handover that points at a leaf doc while the parent's tracking lists go stale.

## Verification

This skill is applied correctly when:

- [ ] A written spec/handoff doc existed before any executor was spawned.
- [ ] Every returned change was independently verified by the lead before commit (barrier verification per stream in a graph).
- [ ] Reviews ran in separate, read-only, fresh-context agents with adversarial framing.
- [ ] The judge was spawned exactly where warranted, and its verdict was honoured.
- [ ] Findings were triaged (accepted/dropped with reasons), not blanket-applied.
- [ ] Each verified stage or stream is its own atomic commit, on a non-protected branch, per project git rules.
- [ ] Graph streams ran in worktrees; verified work was committed in each worktree, branches merged with `--no-ff`, worktrees pruned.
- [ ] The coordinator was consulted at pre-flight and at stage boundaries; its steer is in the tracking doc.
- [ ] Tracking docs match repo reality before the stage was declared done.
- [ ] `/clear` recommended at significant stage boundaries.
- [ ] The resume one-liner names the parent tracking doc, the stage plan, branch + last commit, the last coordinator steer, and reconcile-first.

## Worked example

See `game-feature-example.md` in this folder for a mermaid walkthrough of this skill applied end to end: adding an XP and levelling system to a game, shown as both the default loop and the parallel graph.
