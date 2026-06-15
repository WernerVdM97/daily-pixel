# POC Build — Session Kickoff Reference

> Reference asset for [[poc-build-poa]]. How to start a fresh build session: what to load
> into context first, and the paste-ready kickoff prompt. Not a vault doc — a working aid.

---

## Load order (first → last) and why

A fresh session has no prior context. Load the **stable framing first**, the **task spec in the middle**, and put the **one concrete first action + exit gate last** — recency makes it the highest-salience instruction in the window.

| Order | Load | Why here |
|---|---|---|
| 1 | `docs/engine/poc-build-poa.md` | The map: the seam, the session plan, where the session starts/stops, the handover habit. Frame before detail. |
| 2 | `docs/engine/poc-tech-stack.md` | Hard constraints (TS + tsx, better-sqlite3, discord.js, monolith, LXC). Bounds the solution space early. |
| 3 | The session's build doc (e.g. `poc-build-scaffold.md`) | The detailed spec for *this* session. |
| 4 | `docs/decisions/poc-spec-reconciliation.md` | The resolved decisions it must honor (the `meta` table, fail-fast, DC sign, etc.). |
| 5 | `docs/CONVENTIONS.md` + `AGENTS.md` | Only needed at session end, for the handover block + repo rules (2-space indent). Load last so it doesn't crowd build context. |

**Point it at last:** not "go build everything." The seam is the load-bearing, expensive-to-retrofit decision, so the final instruction makes the session produce the *interfaces + schema for sign-off before any implementation*. That is the POA's "doubt-driven on the seam" cashed out.

---

## Kickoff prompt — Session S0 (Foundation & seam)

```
You're a senior TypeScript engineer starting the build of "The Warden's Oak" —
a Discord MUD POC. We build in single-threaded, test-gated sessions per the
plan of attack. This is SESSION S0: Foundation & seam.

Read these docs in this order before doing anything:
  1. docs/engine/poc-build-poa.md        — the session plan, the seam, handover
  2. docs/engine/poc-tech-stack.md       — stack + constraints
  3. docs/engine/poc-build-scaffold.md   — the S0 spec (schema, loaders, registry)
  4. docs/CONVENTIONS.md + AGENTS.md     — only when you write the handover at the end

THE ONE RULE THAT MATTERS MOST (the seam): the codebase has a hard boundary
between the Discord frontend (src/discord, src/scenes) and the world engine
(src/engine, src/db). Only plain serializable data crosses it via the
WorldEngine interface — never a discord.js object, never an ASCII string,
never a raw SQLite row. The replaceability test: swapping the in-process
WorldEngine for an HTTP client must change zero frontend code.

START NOW: read the docs, then POST FOR MY APPROVAL — before writing any
implementation — See the spec at `[>] Next...` last handoff in `poc-build-scaffold`
```

---

## Adapting for S1+

Same skeleton, three swaps:

- Change the **session line** (e.g. "SESSION S3: action end-to-end").
- Point read-step 3 at that session's build doc (e.g. `poc-build-probabilistic.md`).
- Set **style** from the POA session table (e.g. S3 = TDD-hard + doubt-driven + source-driven;
  S7 = ci-cd + shipping). Every session runs on `deepseek-v4-pro`.

And the very first read instruction becomes **"read the handover block at the bottom of the previous session's doc"** — that's the point of the handover: the new context resumes from one place instead of re-deriving state.

> **Caveat:** this assumes the build happens in *this* repo. It's currently a docs-only vault, so S0's real first micro-step is deciding whether `src/` lives here or in a sibling repo.
