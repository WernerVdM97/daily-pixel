This repo is the source code for **The Warden's Oak** — an async, turn-based, text/ASCII Discord RPG.

## Always-on guardrails

These hold on every change, regardless of which skill is active:

- **Never commit directly to `main`** (and never push or checkout `main`/`master`/`dev`). All work lands on `dev` first. *(Emergency hotfixes may land on `main` directly — if so, merge `main` back into `dev` immediately; see the `releasing` skill, Rule 3.)*
- **Keep the changelog current.** Every merge into `dev` adds to `[Unreleased]` (or promotes it on a release).
- **No manual line wrapping in docs prose** — one paragraph = one line; let the editor soft-wrap.

## Verification

**A green suite is not evidence that a prompt rule is reachable.** Prose that keys off an engine signal (`D20:`, `PHASE:`, `needs_roll`, a category flag, any number a prompt names) must be checked against the message the engine actually builds, not merely read for sense. Two real bugs came of skipping that check: an inspiration grant gated on a natural 20 in a category that never rolls, and a reward instruction keyed to a DC that RESOLVE is never sent.

## Code comments

Code is the source of truth for **what** it does. Source should read as art: intuitive, self-explanatory, unnarrated. A comment earns its place only by saying what the code cannot, in **1 or 2 lines at most**. If it wants three, the rest belongs in the commit body, the PR or a doc.

**Never:**

- Issue or board references (`#97`, "fixed in #123", decision dates). Git blame, the PR and `CHANGELOG.md` own that history, and it rots the moment the code is read out of context.
- The same rationale stolen across layers. Say it once, where a reader would look. Copying it into the type, the producer, the validator, the prompt builder and the test is bloat, not defence in depth.
- Echo comments restating the next line, or line-number citations into other files (`combat-state.ts:118`), which go stale silently.

**Worth a line:**

- A non-obvious constant or threshold, and where the number came from.
- A broken convention, or a deliberate exception to a pattern.
- An ordering, idempotency or persistence caveat that bites if missed.
- A silent edge case the code handles without saying so.

**Carve-outs**, warranted but still brief: the usage doc on an exported helper, and a test or fixture note describing the scenario it builds (dice, HP, what authors what).

Worked examples, good and bad: the `code-comments` skill.

## Skills

Task- and tool-specific conventions live as auto-discovered skills in [`.pi/skills/`](./.pi/skills/)

| Skill               | Use when                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `releasing`         | committing/branching,<br>merging (feat->dev or dev->main)                                                                        |
| `changelog`         | editing `CHANGELOG.md`                                                                                                           |
| `code-comments`     | writing or reviewing any comment/JSDoc in `src/` or `tests/`                                                                      |
| `prompt-versioning` | editing any LLM prompt under `assets/prompts/` (decision, critic, …) or a `*_VERSION` constant                                   |
| `docs-authoring`    | creating/editing anything under `docs/`<br>(wraps [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md))                                |
| `game-development`  | building game systems: orchestrator routing to `game-design`, `multiplayer`, `game-art-static`, `game-art-dynamic`, `game-audio` |
| `ansi-frames`       | authoring ANSI/ASCII art frames for Discord (combat frames, event moments, splashes) from a prompt                               |
| `agent-smoke`       | spawning live AI-player smoke runs (`npm run agent:play`) via Sonnet subagents for QA + playtest feedback                         |
| `factory-memory`    | reading/writing the Dark Factory's topic-scoped memory under `.pi/factory/memory/` (triage, executor, sweeper, scrumo, escalator)  |
| `factory-control`   | stopping/starting/pausing the factory: the switch sources, per-loop schedules, firing one tick or loop by hand                     |
| `orchestrated-delegation` | the executor's build loop: tier table pinning repo-local `delegate-*` agents behind the Dark Factory gate, worktrees off `dev` |

## Other Key files

| File                                             | What it is                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [`TODO.md`](./TODO.md)                           | Human notes only — agents file issues on the Dark Factory board.                           |
| [`docs/README.md`](./docs/README.md)             | Map of content for the design vault — index of every design doc.                           |
| [`db-backups/README.md`](./db-backups/README.md) | Read-only tooling for pulling & inspecting a prod DB snapshot (snapshots never committed). |
