# POC Build — Session Kickoff Reference

> Reference asset for [[poc-build-poa]]. How to start a fresh build session: what to load into context first, and the paste-ready kickoff prompt. Not a vault doc — a working aid.

---

## Load order (first → last) and why

A fresh session has no prior context. Load the **stable framing first**, the **task spec in the middle**, and put the **one concrete first action + exit gate last** — recency makes it the highest-salience instruction in the window.

| Order | Load | Why here |
|---|---|---|
| 1 | `docs/archived/poc/poc-build-poa.md` | The map: the seam, the session plan, where the session starts/stops, the handover habit. Frame before detail. |
| 2 | `docs/engine/poc-tech-stack.md` | Hard constraints (TS + tsx, better-sqlite3, discord.js, monolith, LXC). Bounds the solution space early. |
| 3 | The session's build doc (e.g. `poc-build-scaffold.md`) | The detailed spec for *this* session. |
| 4 | `docs/archived/poc/poc-spec-reconciliation.md` | The resolved decisions it must honor (the `meta` table, fail-fast, DC sign, etc.). |
| 5 | `docs/CONVENTIONS.md` + `AGENTS.md` | Only needed at session end, for the handover block + repo rules (2-space indent). Load last so it doesn't crowd build context. |

**Point it at last:** not "go build everything." The seam is the load-bearing, expensive-to-retrofit decision, so the final instruction makes the session produce the *interfaces + schema for sign-off before any implementation*. That is the POA's "doubt-driven on the seam" cashed out.

---

## Reusable kickoff prompt

Replace the `{…}` placeholders using the parameter table below before pasting.

```
You're a senior TypeScript engineer building "The Warden's Oak" —
a Discord MUD POC. This is session {SESSION_ID}: {SESSION_NAME}.
We build in single-threaded, test-gated sessions per the plan of attack.
{IF_NOT_S0}
FIRST: read the handover block at the bottom of {PREV_HANDOVER_DOC}.
That one block tells you what shipped, what's frozen, and where to start.
{END_IF}

Read these docs in this order before doing anything:
  1. docs/archived/poc/poc-build-poa.md              — the session plan, the seam, handover
  2. docs/engine/poc-tech-stack.md             — stack + constraints
  3. docs/engine/{BUILD_DOC}                   — the spec for this session
  4. docs/archived/poc/poc-spec-reconciliation.md  — resolved decisions to honour
  5. docs/CONVENTIONS.md + AGENTS.md            — only when you write the handover at end

THE ONE RULE THAT MATTERS MOST (the seam): the codebase has a hard boundary
between the Discord frontend (src/discord, src/scenes) and the world engine
(src/engine, src/db). Only plain serializable data crosses it via the
WorldEngine interface — never a discord.js object, never an ASCII string,
never a raw SQLite row. The replaceability test: swapping the in-process
WorldEngine for an HTTP client must change zero frontend code.

Coding style for this session: {CODING_STYLE}.

START NOW BY LOADING THE SKILLS. Thenread the docs (handover first, then the load order above).
Your first task: implement the `[>] Next...` from the handover.
Stop when the exit gate tests are green — then POST FOR APPROVAL.

Checkout a new feature branch and push a PR through GH CLI when finished.
```

| Placeholder | S0 | S1 | S2 | S3 | S4 | S5 | S6 | S7 |
|---|---|---|---|---|---|---|---|---|
| `{SESSION_ID}` | S0 | S1 | S2 | S3 | S4 | S5 | S6 | S7 |
| `{SESSION_NAME}` | Foundation & seam | Join wizard, stats, backpack | Deterministic commands + scenes | Action end-to-end | Action polish | World tick | Polish + pre-deploy | Deploy |
| `{BUILD_DOC}` | `poc-build-scaffold.md` | `poc-build-scaffold.md` | `poc-build-scaffold.md`, `poc-build-scenes.md` | `poc-build-probabilistic.md` | `poc-build-polish.md` | `poc-build-world-tick.md` | `poc-build-polish.md` | `poc-build-deploy.md` |
| `{PREV_HANDOVER_DOC}` | *(none — first session)* | `poc-build-scaffold.md` (S0) | `poc-build-scaffold.md` (S1) | `poc-build-scaffold.md` (S2 — commands), `poc-build-scenes.md` (S2 — scenes) | `poc-build-probabilistic.md` (S3) | `poc-build-polish.md` (S4) | `poc-build-world-tick.md` (S5) | `poc-build-polish.md` (S6) |
| `{CODING_STYLE}` | spec-driven + incremental; **doubt-driven on the seam** | TDD + frontend-ui-engineering | TDD (pure resolver) + incremental | **TDD (hard)** + **doubt-driven** + source-driven (API client) | TDD (inject failing mock) + doubt-driven | TDD (seeded determinism) + incremental | verify + code-review-and-quality + code-simplification | ci-cd-and-automation + shipping-and-launch |
| `{IF_NOT_S0}…{END_IF}` | Omitted | Included | Included | Included | Included | Included | Included | Included |

> **Caveat:** this assumes the build happens in *this* repo. It's currently a docs-only vault, so S0's real first micro-step is deciding whether `src/` lives here or in a sibling repo.
