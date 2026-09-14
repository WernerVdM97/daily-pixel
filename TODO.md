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

### Invisible PRs: every PR authored by `agent97eth` is missing from every list (noted 2026-09-14)

None of the agent account's PRs appear in a PR list, for anyone, including the account itself. This is not about one PR: **all 22 it has opened are absent**, including the 18 that are already merged, so it is author-scoped and retroactive.

| PR | state | what it carries | in a list |
| --- | --- | --- | --- |
| #126 | open | layer 1: recon move, working memory, v2 prompts + handbook, ten personas, friction and the day note | no |
| #127 | open | layer 2: the per-persona review and `npm run agent:panel` | no |
| #128 | open | layer 3: pinned advancing clock, the arc panel, the docs close-out | no |
| #154 | open | the `TODO.md` deprecation and the issue migration | no |
| #101, #102, #107 to #118, #122 to #125 | merged | earlier agent work, already in `dev`, listed only for provenance | no |

**What the state actually is, narrowed.** The content is excluded from GitHub's list and search index while the objects still exist and direct access mostly still works. The evidence, all checkable in a glance: logged in as `agent97eth`, the Pull requests tab badge reads **9** while the filtered list header reads **Open 5** and renders only the five dependabot PRs, so the account cannot find its own work in a list either. The same four open PRs are reachable **one at a time by direct URL**, which is what rules out deletion and points at list and search exclusion rather than withheld content. Anonymous fetches 404 for all 22 while a dependabot PR in the same repo returns 200, and `github.com/agent97eth` 404s while `github.com/WernerVdM97` returns 200.

**No warning banner.** GitHub does not banner this, so the account's email inbox is the place to look for a notice, under Settings then Emails to find which address is on it.

**The code is reviewable today, without any PR.** Nothing about the branches is affected, and every layer's full diff renders for anyone logged in or not:

- Layer 1: `https://github.com/WernerVdM97/daily-pixel/compare/dev...feat/agent-panel-1-surface`
- Layer 2, once layer 1 is in: the same URL with `feat/agent-panel-2-feedback`
- Layer 3: the same URL with `feat/agent-panel-3-panels`
- The notes branch: the same URL with `chore/todo-human-only`

Branch and commit views also resolve, so the work can be reviewed and merged locally without a PR object ever being visible. The PR objects are the only broken thing, not the code, the tests or the history.

**The one test that decides how much this matters, and its answer.** Open `https://github.com/WernerVdM97/daily-pixel/pull/126` logged in as the repo owner: it **404s**. So the content is visible to `agent97eth` and to nobody else, which is the withheld state, and the direct-URL access the author found is the author's privilege rather than evidence the objects are reachable more widely. Nothing here can be reviewed or merged through GitHub as it stands.

**The comments are hidden too, and that has a consequence.** The eight comments written onto #94 to #97 to carry the Release A reasoning are invisible as well: #94's page shows no trace of them and never renders `agent97eth`. So the reasoning relocated out of this file is unreadable on the issues it was meant to sit with.

**Nothing textual is lost, because commits are visible.** The pre-deprecation version of this file is reachable at `https://github.com/WernerVdM97/daily-pixel/blob/7dbf4e6/TODO.md`, which still carries both the Release A residuals (RA-1, RA-2, the two P3 decisions) and the dev-line carry-overs, and the deprecation diff itself is readable through the compare URL below. The twenty issue bodies are also exported to `/tmp/agent-panel/export`, though that is a temp directory.

**Do not merge #154 while the account is broken.** It removes the ticket list from this file and leaves it only in issues that nobody else can read, which would turn a visible record into an invisible one. Hold it until either the issues are readable or the findings have a visible home again. The three code layers have no such problem: their diffs are visible and their content is in the commits.

**No self-serve fix.** Support is the only remedy that keeps the same identity, at `support.github.com/contact` filed while logged in as `agent97eth`, describing the list and search exclusion and the date it began (between 2026-09-10 and 2026-09-11). If that stalls or fails, the durable replacement is a GitHub App rather than another user account: it opens PRs as `<app>[bot]`, is built for automation, and is not subject to the new-account heuristics a fresh user account would be.

**Two things to stop doing meanwhile**, because they are the likely triggers and would repeat on any replacement account: writing in bursts (20 issues, 4 PRs and 13 comments inside half an hour from a four-day-old account), and leaving the leaked `gh` OAuth token live, which the handover notes have flagged since it was printed into a session transcript.

This note lives here because you asked for it here and because filing yet more items from the affected account is part of the problem. The actionable follow-up, the appeal or the migration, belongs as an issue once either the account is restored or a replacement identity exists.

---

Human notes go here. If a note becomes work, file an issue and delete the line.
