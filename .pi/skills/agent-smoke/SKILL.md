---
name: agent-smoke
description: Spawn live AI-player panel runs of the agent-player harness via Sonnet subagents — the three-persona breadth smoke, the five-day arc panel, and the interrupted shape — then aggregate them with `npm run agent:panel`. Use when asked to smoke-test the game with real LLM players, run live playthroughs, QA the agent-player end-to-end, or "spawn AI players".
allowed-tools: Agent, Bash, Read
---

# Agent panels

The agent-player harness (`src/agent/`, milestone M4) plays the whole game with a real DeepSeek brain over a prod-faithful in-memory engine, then a critic LLM reviews the run. Since the persona rework it also takes a persona (`AGENT_PERSONA`), captures friction and a day note in the same reply, and pays one extra call for a persona-voiced review. `npm test` only ever uses stubs — the **real** path is opt-in via `npm run agent:play`. This skill fans that live path out across Sonnet subagents as a **panel**: N runs, one directory, one aggregate.

A single run is the degenerate panel, not the default. Pick a shape, run the fleet, aggregate the directory.

## Two channels, never conflated

A transcript **`finding`** is a harness or engine bug (an error finding is a real bug; flag it). A persona **`friction`** is a design signal, tagged `once` / `periodic` / `ritual`; route it to `TODO.md`, never to the blocker list. Engine anomaly *logs* on stderr (`[category-telemetry]`, `[travel-gate]`, `set_location`) are self-recovered content/tuning notes, also `TODO.md`. Same split the skill has always carried.

## The three shapes

| Shape | Fleet | Answers | Cost | Order |
| --- | --- | --- | --- | --- |
| **Breadth smoke** | 3 personas × 1 day, plus the unset control | The machinery gate: aggregation, review parsing, the anti-theatre histograms. A JSON contract that does not parse is the failure every other shape would hit at full price | ~0.6M tokens (measured on the 2026-09-14 smoke) | **First, always** |
| **Arc panel** | 4 personas × 5 days | The retention instrument, and the **only** shape that answers the core goal: the engagement/fulfilment series, the day the `arcNote` stops growing, content exhaustion, `aliveness`/`memory` coverage | ~3M tokens | After the smoke |
| **Interrupted panel** | 1 persona (`lapsed-returner`) with `AGENT_SKIP_DAYS` | The absence consequence: the five-day absence nudge, re-entry, whether coming back is worth it | ~0.3M tokens (two paid days) | Last, or when the absence path is the question |

Never pay for the arc panel before the three-persona smoke has passed. The smoke costs a tenth of an arc and catches the contract failures.

## Always include the unset control

Every panel shape includes **one run on the same commit with `AGENT_PERSONA` unset**, in the same directory. Without it the persona signal is confounded with the wider move and information surface: a free-text share that rose because the menu widened reads exactly like one that rose because a persona wanted it, and the panel has nothing to compare against. The control arm also writes no review, so it appears in the histogram and day-note tables but not the persona matrices. This is not optional advice — it is the arm the whole reading is relative to.

## Pin every start to noon UTC

Every run's `AGENT_START_DATE` must be a **noon-UTC instant** (`2026-09-15T12:00:00Z`), not a bare date and not a local-time stamp. The day-start greeting reads the **local** weekday (`hiScreen.isWeekend()` is `new Date().getDay()`) while the nightly tick reads **UTC** (`getUTCDay() === 6`), so a start a few hours either side of UTC midnight can greet the player with the weekend copy on a day whose tick grants the weekday roll allowance, and which side you land on depends on the host's timezone. Noon UTC leaves eleven hours of slack either way, so the two weekdays agree in any plausible host timezone and across a multi-day run's one-day steps.

## Env knobs

`DEEPSEEK_API_KEY` must be in `.env` and is **not** auto-loaded: `set -a && . ./.env && set +a && <command>`.

| Knob | Meaning |
| --- | --- |
| `AGENT_DAYS` | Game days played in one process (default 1). An arc is one process with `AGENT_DAYS=n` — no cross-process continuation. |
| `AGENT_PERSONA` | One of `explorer`, `socialite`, `soldier`, `homesteader`, `grinder`, `collector`, `storyteller`, `tourist`, `casual`, `lapsed-returner`. **Unset = no persona fragment = the baseline arm, and no review is written.** A typo exits 1 before any call. |
| `AGENT_START_DATE` | The run's start instant (ISO date or timestamp, default real now). Pins the process clock and **advances it one calendar day per nightly tick**, so a multi-day run crosses real weekdays. **Every panel must pin it to a noon-UTC instant** (e.g. `2026-09-15T12:00:00Z`) — never a bare date, never a local-time stamp. See the rule above. |
| `AGENT_SKIP_DAYS` | `<n>` = play day 1, advance the world `n` days with no play at all (the absence), then play the remaining `AGENT_DAYS-1` days. The interrupted shape. Only reached when day 1 ends cleanly. |
| `AGENT_OUT` | Transcript path, one per run. The review lands at `<AGENT_OUT>.reviews.json`. |
| `AGENT_PROTOCOL_OUT` | Protocol-log path (default `<AGENT_OUT>.protocol.json`); the replayable instrument. |
| `AGENT_FORCE_FREE_ACTIONS` | Diagnostic, not the way: `1` withholds each day's day-job buttons until a free-text action completes. Use only when a question needs the quest loop (e.g. RA-2 inspiration), and note in the report that the arm was forced. |
| `AGENT_PROTOCOL_BEATS`, `AGENT_BRAIN_CHOOSES_CHAR`, `AGENT_USER_ID`, `AGENT_INHERIT`, `DEEPSEEK_MODEL` | Unchanged. `AGENT_BRAIN_CHOOSES_CHAR=1` is the token-heavy realism arm; `AGENT_INHERIT=1` needs `AGENT_USER_ID` and exits 1 when no character is found. |

## Running one run

```bash
set -a && . ./.env && set +a && AGENT_OUT=<dir>/<persona>.json AGENT_DAYS=<N> AGENT_PERSONA=<name> AGENT_START_DATE=<iso> npm run agent:play > <dir>/<persona>.stdout 2> <dir>/<persona>.log; echo "EXIT=$?"
```

**Make a fresh directory per panel shape** — the panel reads *every* `<AGENT_OUT>.reviews.json` in the directory, and a directory holding two runs of the same persona is read as one persona with doubled days. One review file per persona per directory.

Output split: the **transcript** is clean JSON at `AGENT_OUT`; the **persona review** is at `<AGENT_OUT>.reviews.json` (written only when a persona played); **stderr** (`.log`) carries the transcript path, day summaries, run scoreboard, critic report, persona review in readable form, and the cost summary; **stdout** is engine/gateway/npm noise (ignore). `panel.md` and `panel.json` are written beside the reviews by the aggregator, and the rendered panel also prints to stderr.

## Aggregating

```bash
npm run agent:panel -- <dir>
```

It reads the review files in `<dir>`, writes `panel.md` + `panel.json` beside them, and prints the report to stderr: score and rubric matrices with per-criterion **coverage**, the engagement/fulfilment series as a sparkline, friction ranked by projected exposure with the `ritual`-tagged items separated, the fulfilment-signal count, per-persona verb histograms, and the `arcNote`/`quitTrigger` distinctiveness check. A panel is N processes, so the aggregate is always this offline reader.

## Read the exit code

A run whose day ended `crashed` or `stalled` now **exits 1** and stderr says `run ended early — day N crashed|stalled`. A five-day arc that died on day 3 is a truncated run, not a finished one: do not read its missing days as quiet ones, and do not aggregate it into a panel headline without saying so. A clean run = exit 0, 0 error findings, coherent play, a day note for every day, and a critic report (plus a persona review when `AGENT_PERSONA` was set).

## Cost

Real DeepSeek tokens on every brain move, pipeline stage, critique and review. A five-day arc is roughly **150k tokens per run-day, ~750k per persona**, and a four-persona arc panel is ~3M. Keep the fleet small and shape it deliberately: smoke first, arc second, breadth only when onboarding is the question. Give the whole panel one budget line before you spawn anything.

## Subagent prompt template

> Run a LIVE panel run of the agent-player harness in `/home/werner/projects/daily-pixel`. `npm run agent:play` plays N game days with a real DeepSeek brain, then a critic reviews the run; with `AGENT_PERSONA` set a persona-voiced review is added. It captures exceptions, dead-ends, illegal moves, and invariant breaches (negative HP/stamina/wealth, roll underflow) as transcript `finding`s, and the persona's own `friction` lines are kept separate from those. The key is in `.env` (not auto-loaded — source with `set -a && . ./.env && set +a`). Run exactly the command in the handoff (with your `AGENT_OUT`/`AGENT_DAYS`/`AGENT_PERSONA`/`AGENT_START_DATE`), timeout 600000 ms for a one-day run and more for a multi-day one. Then Read the `.log`; parse the `AGENT_OUT` JSON if you need finding detail. **READ-ONLY QA** — do not modify source, commit, or touch `.env`; if the Bash call times out, note it and do NOT re-run (it costs tokens). Report tight: (1) exit code, and whether it produced a critic report and a `<AGENT_OUT>.reviews.json`; (2) the run scoreboard line verbatim; (3) every `finding`/`dead-end`, and any day that ended `crashed`/`stalled`, verbatim — error findings are real bugs, flag them; (4) the move-kind counts from the transcript's `turn` events and the free-text share; (5) each day's note (engagement, fulfilment, one line, `arcNote`) and the persona's `friction` lines with their recurrence tags; (6) sanity read (moves sensible, rolls/HP/stamina/wealth changing correctly, the calendar advancing one day per night); (7) the critic's verdict and the persona review, trimmed; (8) suspected harness/engine bugs, kept apart from friction and design notes.

## Consolidate

When all runs report, write the reviews into one directory and run `npm run agent:panel -- <dir>`, then roll the per-run table (run / persona / days / exit / turns·outcomes / findings / move-kind histogram / day notes) and a short bug list on top of the panel's own report. **Triage carefully:** a `finding` (error/invariant breach/crash) is a harness/engine bug; engine anomaly *logs* on stderr are self-recovered notes; persona friction is a design signal ranked by exposure. The arc panel's flat lines and the breadth smoke's histogram are the readings the panel exists for — quote the panel, do not re-derive it.
