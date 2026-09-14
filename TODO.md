# TODO

**This file is for human notes only. Agents do not write here.**

If you are an agent and you want to record a todo, a finding, a follow-up, a deferred idea or a handover note, **file an issue** on the [Dark Factory board](https://github.com/users/WernerVdM97/projects/6). One issue per item, labelled from [`.github/labels.yml`](./.github/labels.yml) (`area:*` and `type:*`), with a milestone only where it is obvious; the triage loop enriches, re-milestones and questions it from there. Cross-session handover goes in the issue you are working, or in the PR body. An agent that writes a todo into this file has lost it.

## Why the file is fenced off

It spent a year absorbing agent scratch and drifted into a stale duplicate of the board. It held "resume here" handovers for work that had already shipped, and by August 2026 its actionable items had to be hand-migrated to the board in bulk. The board has the gate, the labels, the milestones and the loops; this file has none of that, so anything actionable written here is quietly lost the moment nobody re-reads it.

The rule is not "prefer issues". It is that this file is not a queue at all: it is a place for a human to think on paper.

## Migrated out (2026-09-14)

Everything actionable that was still here became an issue, so nothing was dropped silently:

- The agent-panel live-panel findings: #134 to #146.
- Older dev-line findings still awaiting migration: combat length #147, combat state desync #148, retention #149, the LLM watchdog #150, the transcript-on-signal-death gap #151, the favoured-option risk mismatch #152.
- The failed-search reward leak was merged into #138 as a comment rather than filed twice.

Dropped as superseded, with the reason rather than silently:

- **"The multi-day live path remains unverified"** (2026-08-06): verified by the four five-day arc runs of 2026-09-15, recorded in `docs/engine/agent-player-personas.md` § Panel evidence.
- **"The realism arm didn't fix move variety"** (marked `[>]`): superseded by the persona layer. The panel now shows the histogram differing by persona exactly as the priors predict, from 0% free-text for the Grinder to 32% for the Explorer, which is the reading that item asked for.
- **"Decide-stage timeouts spike under concurrent live runs"**: moved into `.pi/skills/agent-smoke/SKILL.md` as fleet guidance, since it is operational advice rather than a defect to fix.
- **The Release A residual reasoning** (RA-1, RA-2, P3): the questions were already tracked as #94, #95, #96 and #97, and the reasoning is now commented onto those issues, which is where a reader of the decision needs it rather than in a separate file. The archived Release A plan's § Follow-up logged carries the fuller write-ups those items came from.
- **The verification lesson from the orchestrated-delegation discipline paragraph**: moved to `AGENTS.md`, since it is agent guidance and this file is not where an agent looks. The paragraph's other rules (one loop per task, an atomic commit per task, the changelog current per task, the scope fence) already live in the `orchestrated-delegation` and `releasing` skills, so they were dropped here rather than duplicated.

## Human notes

### Invisible PRs: every PR authored by `agent97eth` is withheld (noted 2026-09-14)

Nothing authored by the agent account is visible to anyone but the account itself. This is not about one PR: **all 22 PRs it has opened are withheld**, including the 18 that are already merged, so it is author-scoped and retroactive.

| PR | state | what it carries | visible |
| --- | --- | --- | --- |
| #126 | open | layer 1: recon move, working memory, v2 prompts + handbook, ten personas, friction and the day note | no |
| #127 | open | layer 2: the per-persona review and `npm run agent:panel` | no |
| #128 | open | layer 3: pinned advancing clock, the arc panel, the docs close-out | no |
| #154 | open | the `TODO.md` deprecation and the issue migration | no |
| #101, #102, #107 to #118, #122 to #125 | merged | earlier agent work, already in `dev`, listed only for provenance | no |

The four open ones are the live problem: the stack cannot be reviewed or merged from the web UI.

**How to see it is real, in one glance:** the Pull requests tab badge reads **9**, the list header reads **Open 5**, and only the five dependabot PRs render. The API agrees there are 9 open PRs and that 4 of them are authored by `agent97eth`. Fetching any of the 22 by URL returns 404 while a dependabot PR in the same repo returns 200, and `github.com/agent97eth` itself 404s while `github.com/WernerVdM97` does not.

**What is *not* affected.** Branches and commits are public and fine: `feat/agent-panel-1-surface`, `feat/agent-panel-2-feedback`, `feat/agent-panel-3-panels`, `chore/todo-human-only` and every commit SHA resolve for anyone. Nothing about the code, the tests or the history is at risk, and the four open PRs' bodies are exported so they can be recreated in minutes.

**What the author's view shows, and why it misleads.** Logged in as `agent97eth` the PRs look normal and there is no warning banner, because a withheld item stays visible to its own author. The account also still authenticates and still writes. So "it looks fine to me" is expected and is not evidence that the PRs are published. Check the account's email inbox for a notice from GitHub instead, since that is the usual channel rather than a banner.

**No self-serve fix.** Support is the only remedy that keeps the same identity, at `support.github.com/contact` filed while logged in as `agent97eth`, describing the author-scoped withholding and the date it began (between 2026-09-10 and 2026-09-11). If that stalls or fails, the durable replacement is a GitHub App rather than another user account: it opens PRs as `<app>[bot]`, is built for automation, and is not subject to the new-account heuristics a fresh user account would be.

**Two things to stop doing meanwhile**, because they are the likely triggers and would repeat on any replacement account: writing in bursts (20 issues, 4 PRs and 13 comments inside half an hour from a four-day-old account), and leaving the leaked `gh` OAuth token live, which the handover notes have flagged since it was printed into a session transcript.

This note lives here because you asked for it here and because filing yet more items from the affected account is part of the problem. The actionable follow-up, the appeal or the migration, belongs as an issue once either the account is restored or a replacement identity exists.

---

Human notes go here. If a note becomes work, file an issue and delete the line.
