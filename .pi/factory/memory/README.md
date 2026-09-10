# Factory memory

Durable, topic-scoped notes the factory loops write for their future selves. The **tree is tracked** (a `.gitkeep` per leaf topic, so the taxonomy is reviewable in a PR); the **`memory.md` contents are not** (`.gitignore` ignores them).

Full conventions: [`.claude/skills/factory-memory/SKILL.md`](../../../.claude/skills/factory-memory/SKILL.md).

## Topics

| Topic | Holds |
| --- | --- |
| `board/` | status flow, project and field ids, labels, milestones and due dates, blockers |
| `gate/` | approval rules, `auto:*` classes, violations found |
| `loops/` | one folder per loop: what it learned, what it got wrong |
| `repo/` | build and test commands, branch and worktree paths, known failures, conventions |
| `delivery/` | Discord plumbing, PR and review mechanics, CI behaviour |
| `models/` | which model for which role, escalation routes, failures seen |
| `owner/` | the owner's stated preferences and priorities |
| `meta/` | the factory's own improvement record: `proposals`, `metrics`, `sessions` |
| `incidents/` | one dated bullet per incident; split into `incidents/YYYY-MM/` when it outgrows a page |

## Rules

- One fact per line, `- YYYY-MM-DD: fact`, so each grep hit is a whole fact and `grep "^- 2026-09"` reads as a timeline.
- Keep a `memory.md` under 25 lines. Over that, split into a new topic folder or prune.
- Facts only: identifiers, paths, commands, decisions, gotchas. Never narration of a run, never an issue body.
- Delete lines that are no longer true. A stale line is worse than no line.
- No secrets. Name the env var, never the value.
- One writer per topic, except the shared logs (`gate/violations/`, `incidents/`): any loop may append a dated line there; never rewrite another loop's line. Topics with no loop writer are owner-seeded reference facts — read-only for loops.

## Reading it

```bash
grep -rn "approval" .pi/factory/memory/gate
grep -rn "^- 2026-09" .pi/factory/memory/incidents
rg --no-ignore -l "flaky|retry" .pi/factory/memory
```

Use `grep` (or `rg --no-ignore`). The contents are gitignored, so plain `rg` skips every `memory.md` and silently returns nothing.
