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

Nothing yet. If you are a human with a thought to park, put it here; if it becomes work, file an issue and delete the line.
