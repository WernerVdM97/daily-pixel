---
title: Dark Factory requirements (scrumo + model tiering)
status: shipped
domain: engine
phase: poc
tags: [process, automation, agents, models]
related:
  - "[[dark-factory]]"
---
_The decisions behind the factory's fourth loop, its escalator child and the per-loop model tiering. Implemented 2026-09-10: the agents, schedules and memory under `.pi/` are the living artifact._

Status: owner go-ahead given and implemented 2026-09-10. Gathered 2026-09-10.

Scope: pin models on the three existing factory loops, add `factory-scrumo` (the unblocker) and a heavy escalation child, copy the orchestrated-delegation skill into the repo, and bring the factory definitions into git.

---

## A note on this being a requirements record

The "Decisions locked" table below is what shipped. Where the body below still reads as a plan ("Today none of the three agents pins a model…", the "Files in scope" list), it is the state of the world at drafting time, kept for the reasoning; the shipped form is the agents themselves plus `[[dark-factory]]`.

## Decisions locked

| Agent | Model | Thinking | Role |
| --- | --- | --- | --- |
| `factory-triage` | `deepseek/deepseek-v4-flash-vision-exp` | `xhigh` | image ingestion + triage, `Inbox` -> `Triaged`/`Blocked` |
| `factory-executor` | `z-ai/glm-5.3-flash` | `high` | lead on one gated item, opens the PR |
| `factory-escalator` (new) | `z-ai/glm-5.3` | `max` | heavy child the executor spawns for hard slices |
| `factory-sweeper` | `z-ai/glm-5.3-flash` | `low` | gate audit, CI re-check, board hygiene |
| `factory-scrumo` (new) | `deepseek/deepseek-v4-flash` | `high` | DM digest, three next actions |

Today none of the three agents pins a model, and `~/.pi/agent/settings.json` has no `subagents` key at all, so all three run on the session default (`moonshotai/kimi-k3` via `openrouter`). Pinning needs explicit `model:` frontmatter.

## Model facts (verified against `~/.pi/agent/models-store.json`)

| Model id | Input | Thinking tiers | Cost in/out per M |
| --- | --- | --- | --- |
| `deepseek/deepseek-v4-flash` | text | off, high, xhigh | $0.089 / $0.177 |
| `deepseek/deepseek-v4.1-flash` | text + image | off, high, xhigh | $0.15 / $0.60 |
| `deepseek/deepseek-v4-flash-vision-exp` | text + image | off, high, xhigh | $0.22 / $0.66 |
| `z-ai/glm-5.3-flash` | text + image | low, high, max | $0.15 / $0.50 |
| `z-ai/glm-5.3` | text | low, high, max | $1.40 / $4.40 |

- **No DeepSeek model exposes `max`.** Its `thinkingLevelMap` maps off/high/xhigh only; `max`, `medium`, `low` and `minimal` are null. Triage therefore uses `xhigh`, the DeepSeek ceiling. The original ask was max; this was the accepted compromise.
- **DeepSeek 4.1 Flash is already released** and is the only DeepSeek model taking images. Plain `deepseek-v4-flash` is text-only.
- `deepseek/deepseek-v4.1-flash` was the intended triage model but is not in the active Pi registry (owner rule: direct DeepSeek only, never via OpenRouter), so triage runs on `deepseek/deepseek-v4-flash-vision-exp` — same direct provider, same image input, same `xhigh` ceiling.
- `fallbackModels` fires only on provider/model failure (quota, auth, provider timeout, unavailable model). A run-deadline expiry explicitly does not trigger it, and ordinary task failure never does. It cannot express "escalate when the work is hard", so escalation is a spawned agent instead.
- A schedule's `workflowScript` `runs.run(...)` supports `agent`, `task`, `skill`, `resume`, `gate`, `baseRef`. There is no per-run `model` override, so pinning lives in agent frontmatter or in settings `agentOverrides`.

## Triage: image ingestion

Not just a model flag. GitHub issue bodies carry attachment URLs, and private `user-attachments` links need auth to fetch.

1. `gh issue view <n> --json body` and detect image URLs.
2. Fetch to a temp path with the token (`gh api` or an authenticated curl).
3. `read` the image, then triage as today (dedupe, resolve `[[doc-links]]`, draft acceptance criteria as an issue comment, label, `Inbox` -> `Triaged` or `Blocked` + `needs-human-decision`).

The existing tools (`read, grep, find, ls, bash`) already cover this, so only the instructions and the model change.

## Escalation

`factory-executor` keeps one item per run on flash. When it hits a slice needing real reasoning (schema change, an unexplained verification failure, a risky live path), it spawns `factory-escalator` on `z-ai/glm-5.3` with the spec and exact commit, treats the verdict as binding, lands the work itself, and re-verifies. Not `fallbackModels`.

## Scrumo (the unblocker)

Read-only on code and on the board. Sources: `gh project item-list 6`, GitHub milestones (due dates, the only machine-readable timeline in the repo), open PRs and `gh pr checks`, `docs/game/poc-plus-roadmap.md`, `CHANGELOG.md`, `VERSION`.

Delivery: DM via `scripts/send-dm.ts` (`DISCORD_TOKEN` + `ADMIN_USER_ID` from the repo `.env`), so it needs `bash`. No channel-poster or webhook exists.

Notify on: important gates, milestones, timelines, blockers, alerts. Cadence: daily digest plus change-only alerts, `overlap: skip`, `catchUp: latest`.

Digest shape: what changed, what is blocked or at risk, then exactly three recommended actions, each phrased as a decision the owner accepts or rejects.

## orchestrated-delegation copy

Copied whole into `.claude/skills/orchestrated-delegation/` (including `game-feature-example.md`), then refactored factory-side: the tier table pins repo agents instead of the user-scope `delegate-*` names, the gate and worktree-off-`dev` rules are stated in the skill, and the model column is repriced to the cheapest viable tier.

Proposed repricing, since all five `delegate-*` currently sit on `deepseek-v4-flash` at `high`: mechanical roles (executor, fixer, reviewer, coordinator) stay on `deepseek-v4-flash`; only the judge moves up to `z-ai/glm-5.3` at `max`. DeepSeek flash is the cheaper of the two, so four of five roles get cheaper or stay level.

Today that skill lives only at `~/dotVault/agent/skills/orchestrated-delegation/SKILL.md` and its agents at `~/.pi/agent/agents/`, so the factory depends on this machine's user scope. It is also missing from the `AGENTS.md` skill table.

## Tracking

Un-ignore `.pi/agents/` and `.pi/factory/` in `.gitignore` (line 3 ignores all of `.pi/`), keeping `.pi/subagents/` ignored as runtime state. That brings the factory agents, `project.json`, the runbook and the seeds into git for the first time.

## Files in scope

`.gitignore`, `.pi/agents/factory-{triage,executor,sweeper}.md`, new `.pi/agents/factory-{scrumo,escalator}.md`, five `delegate-*.md` copies, a fourth `schedule.json` under `.pi/subagents/schedules/`, `.claude/skills/orchestrated-delegation/`, `docs/engine/dark-factory.md`, the `AGENTS.md` skill table, `CHANGELOG.md`.

## Assumptions

1. Scrumo's schedule ships paused, like the other three, so it is fired manually until trusted.
2. Scrumo and the escalator point at `WernerVdM97/daily-pixel` and the repo `.env`, same as the existing loops.
3. Sweeper "flash" means `z-ai/glm-5.3-flash`, not DeepSeek flash, to keep the code loops on one GLM family.

## Already landed (memory convention, 2026-09-10)

`.gitignore` now tracks the factory memory skeleton and ignores its contents; the topic tree lives at `.pi/factory/memory/` with a `.gitkeep` per leaf and a tracked `README.md`; the convention is the `.claude/skills/factory-memory/SKILL.md` skill, listed in the `AGENTS.md` skill table. The three existing agents got a `## Memory` section with their read/write scope. Blind spot to remember: `grep -rn` sees the contents, plain `rg` does not (use `rg --no-ignore`).

When `factory-scrumo` and `factory-escalator` are written, both need the same `## Memory` section, with scrumo's write scope `loops/scrumo/`, `board/milestones/`, `owner/preferences/`, `incidents/`, and the escalator's `loops/escalator/`, `models/escalations/`, `incidents/` (both skeletons already created).

## Resolved item

Scrumo may comment when it flags a blocker (owner decision, 2026-09-10): read-only on Status, Priority and labels, with comments allowed on blocked or at-risk items naming the decision that would unblock them.

## Rejected options

- Triage on `glm-5.3-flash` at max: real max tier plus vision, but drops DeepSeek from the triage loop.
- Two-stage triage (vision transcribe, then a max-tier model triages): highest quality, two calls, more moving parts.
- `fallbackModels` for escalation: does not fire on task difficulty.
- Channel post or webhook for scrumo: no script or env var exists; DM reuses working plumbing.
