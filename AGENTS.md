This repo is the source code for **The Warden's Oak** — an async, turn-based, text/ASCII Discord RPG.

## Always-on guardrails

These hold on every change, regardless of which skill is active:

- **Never commit directly to `main`** (and never push or checkout `main`/`master`/`dev`). All work lands on `dev` first. *(Emergency hotfixes may land on `main` directly — if so, merge `main` back into `dev` immediately; see the `releasing` skill, Rule 3.)*
- **Keep the changelog current.** Every merge into `dev` adds to `[Unreleased]` (or promotes it on a release).
- **No manual line wrapping in docs prose** — one paragraph = one line; let the editor soft-wrap.

## Code comments

Comments explain **why**, NOT **what**! omit echo comments that just narrate the next line; keep genuine rationale (edge cases, gotchas, ordering/idempotency caveats).

## Skills

Task- and tool-specific conventions live as auto-discovered skills in [`.claude/skills/`](./.claude/skills/)

| Skill               | Use when                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `releasing`         | committing/branching,<br>merging (feat->dev or dev->main)                                                                        |
| `changelog`         | editing `CHANGELOG.md`                                                                                                           |
| `prompt-versioning` | editing any LLM prompt under `assets/prompts/` (decision, critic, …) or a `*_VERSION` constant                                   |
| `docs-authoring`    | creating/editing anything under `docs/`<br>(wraps [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md))                                |
| `game-development`  | building game systems: orchestrator routing to `game-design`, `multiplayer`, `game-art-static`, `game-art-dynamic`, `game-audio` |
| `ansi-frames`       | authoring ANSI/ASCII art frames for Discord (combat frames, event moments, splashes) from a prompt                               |
| `agent-smoke`       | spawning live AI-player smoke runs (`npm run agent:play`) via Sonnet subagents for QA + playtest feedback                         |

## Other Key files

| File                                             | What it is                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [`TODO.md`](./TODO.md)                           | Running scratchpad of pending work.                                                        |
| [`docs/README.md`](./docs/README.md)             | Map of content for the design vault — index of every design doc.                           |
| [`db-backups/README.md`](./db-backups/README.md) | Read-only tooling for pulling & inspecting a prod DB snapshot (snapshots never committed). |
