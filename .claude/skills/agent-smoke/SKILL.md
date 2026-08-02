---
name: agent-smoke
description: Spawn live AI-player smoke runs of the agent-player harness via Sonnet subagents. Use when asked to smoke-test the game with real LLM players, run live playthroughs, QA the agent-player end-to-end, or "spawn AI players". Each subagent runs `npm run agent:play` against live DeepSeek and reports findings.
allowed-tools: Agent, Bash, Read
---

# Agent smoke runs

The agent-player harness (`src/agent/`, milestone M4) plays the whole game with a real DeepSeek brain over a prod-faithful in-memory engine, then a critic LLM reviews the run. `npm test` only ever uses stubs — the **real** path is opt-in via `npm run agent:play`. This skill fans that live path out across Sonnet subagents for QA + playtest feedback.

## When to use

- Confirm the live LLM path works end-to-end (e.g. before a `dev` merge).
- Hunt for bugs a stub can't surface (real brain picks weird moves; real pipeline authors odd content).
- Gather qualitative playtest feedback (the critic's pacing/clarity/fun/difficulty report).

## Prereqs

- `DEEPSEEK_API_KEY` in `.env`. It is **not** auto-loaded — subagents must source it: `set -a && . ./.env && set +a && <command>`.
- Each run costs real DeepSeek tokens (every brain move + pipeline stage + the critique). Keep the fleet small.

## How to spawn

Spawn each run as a **background** `Agent` with `model: "sonnet"`, `subagent_type: "general-purpose"` (needs Bash + Read). Vary the fleet: a couple of independent 1-day runs (the brain is non-deterministic, so each hits different paths) plus one 2-day run to exercise the nightly tick / roll refill / `endDay` branches. Give each a unique `AGENT_OUT` path in the scratchpad dir. Keep `AGENT_DAYS` small (1–2) — the critic feeds the whole transcript to one call, so long runs approach the context window.

Per-subagent command (Bash, timeout **600000** ms — live calls take minutes; a 2-day run longer):

```
set -a && . ./.env && set +a && AGENT_OUT=<scratchpad>/smoke-<id>.json AGENT_DAYS=<N> npm run agent:play > <scratchpad>/smoke-<id>.stdout 2> <scratchpad>/smoke-<id>.log; echo "EXIT=$?"
```

Output split: the **transcript** is clean JSON in `AGENT_OUT`; **stderr** (`.log`) has the transcript path + day summaries + run scoreboard + critic report; **stdout** is engine/gateway/npm log noise (ignore). Env knobs: `AGENT_DAYS` (default 1), `DEEPSEEK_MODEL` (optional), `AGENT_OUT` (transcript path).

## Subagent prompt template

> Run a LIVE smoke test of the agent-player harness in `/Users/werner/projects/daily-pixel`. `npm run agent:play` plays N game days with a real DeepSeek brain, then a critic reviews the run; it captures exceptions, dead-ends, illegal moves, and invariant breaches (negative HP/stamina/wealth, roll underflow) as transcript `finding`s. The key is in `.env` (not auto-loaded — source with `set -a && . ./.env && set +a`). Run exactly the command above (with your `AGENT_OUT`/`AGENT_DAYS`), timeout 600000 ms. Then Read the `.log`; parse the `AGENT_OUT` JSON if you need finding detail. **READ-ONLY QA** — do not modify source, commit, or touch `.env`; if the Bash call times out, note it and do NOT re-run (it costs tokens). Report tight: (1) completed? exit code + did it produce a critic report; (2) the run scoreboard line verbatim; (3) every `finding`/`dead-end`, and any day that ended `crashed`/`stalled`, verbatim — error findings are real bugs, flag them; (4) sanity read (moves sensible, rolls/HP/stamina/wealth changing correctly); (5) the critic's verdict, trimmed; (6) suspected harness/engine bugs. For a multi-day run, also confirm the day boundary: day_number advances, rolls refill, overnight regen + income, rest-to-Oak only when rolls were spent.

## Consolidate

When all runs report, roll them into one table (run / days / exit / turns·outcomes / findings) and a short bug list. **Triage carefully:** a `finding` (error/invariant breach/crash) is a harness/engine bug; engine anomaly *logs* on stderr (`[category-telemetry]`, `[travel-gate]`) are self-recovered content/tuning notes, not harness bugs — route those to `TODO.md`, not the blocker list. A clean run = exit 0, 0 error findings, coherent gameplay, a critic report.
