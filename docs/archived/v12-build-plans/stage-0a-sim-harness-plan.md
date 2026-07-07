---
title: "Stage 0a — Sim Harness (implementation plan)"
status: shipped
domain: engine
superseded_by: "implemented in code"
phase: poc
tags:
  - engine
  - simulation
  - testing
  - balance
  - pipeline
related:
  - "[[prompt-separation-of-concerns]]"
  - "[[action-engine-framework]]"
  - "[[prompt-v12-combat]]"
  - "[[prompt-v12-world-scaling]]"
  - "[[mvp-llm-prompt-architecture]]"
---
_Handoff-ready build plan for Stage 0a of the v12 critical path: an offline, deterministic replay harness that drives a character through many actions (and weeks) using the real `WorldEngineImpl` spine with a mocked LLM and a scripted/seeded d20, emitting balance-tuning curves. Every anchor, type contract, and gotcha is inlined so a lesser agent can execute it end-to-end. Grounded in the current code; the T3 daily-tick unknown is resolved below._

---

# Stage 0a — Sim Harness

## Overview

Stage 0a is the **real first deliverable** of the `0.3.0` v12 effort ([[prompt-separation-of-concerns]]): tuning Thread C (combat severity bands) and Thread B (the world-scaling curve) blind would brick the game into trivial-or-impossible, so we build the harness that makes those numbers observable first. This is an **offline replay tool**, not a game sim: captured/mocked LLM output + scripted button presses + a character walked through N weeks, emitting win-rate / resource / reward curves. It lives in `src/sim/`, runs via `npm run sim`, and is verified with vitest (`npm test`).

The key enabling fact, confirmed by reading the code: the engine is already built for this. `WorldEngineImpl` injects a mockable `llm`, a seedable `rollD20`, and accepts an in-memory SQLite DB, and `tests/e2e/happy-path.test.ts` already performs the full setup in ~15 lines. Stage 0a is therefore **composition + fixtures + metrics**, not engine surgery — the spine, roll math, and mutation zones are untouched (the payoff the [[action-engine-framework]] zone-separation promised).

## Architecture decisions

- [I] **Drive the full `WorldEngineImpl` with `:memory:` SQLite — not the bare `ActionStateMachine`.** The mutation *applier* that writes deltas to character state (`applyResolution`, `WorldEngineImpl.ts:470`) lives in the engine, not the machine. Reward/resource curves are only real if mutations actually apply and the roll economy actually drains. `better-sqlite3` `:memory:` is synchronous and cheap. Template to copy: `tests/e2e/happy-path.test.ts:70-91`.
- [I] **Two LLM modes, sequenced — synthetic first, captured-replay deferred.** The purpose (tuning bands + curve) lives in deterministic engine math that barely depends on LLM prose, so a hand-authored `ScriptedLlmGateway` is what actually serves the goal and ships first (T1). Captured `llm_calls` replay is a realism/regression extension (T5, deferrable).
- [I] **Metrics defined against today's mechanics.** `win-rate` = roll success rate; `reward` = applied wealth + items gained; resource curves = health/stamina/wealth/rolls over turns. **`death-rate` is N/A until the death track lands** (deferred by design — see `TODO.md` "make wealth/stamina/health spendable, define death / 0 HP"). The `SimSummary.death` field is `null` with a documented hook rather than inventing a mechanic.
- [I] **No charting dependency.** Output is a console summary table plus a machine-readable JSON/CSV file. A plotting lib would breach the "offline replay, not a framework" scope fence.

## Scope fence (hold the line)

Minimum viable is mocked/captured LLM output + scripted button presses + a character walked through N weeks, emitting the curves that tune B and C. It is **not** a live-model soak test, a headless Discord client, or a general simulation framework. Build exactly enough to stop tuning blind.

## Grounding — code anchors a builder needs

- **Engine class + config:** `WorldEngineImpl` (`src/engine/WorldEngineImpl.ts:260`); config surface `WorldEngineConfig` (`WorldEngineImpl.ts:225-258`) — injects `db`, `llm`, `userRepo`, `charRepo`, `itemRepo`, `actionRepo`, `npcRepo`, optional `rollD20`, `dayJobIncome`, `classDefs?`, `itemSets?`, optional `cartographer`/`critic`.
- **Public drive methods:** `startAction(characterId, rawInput, opts?): Promise<ActionStartResult>` (`WorldEngineImpl.ts:948`), `stepAction(characterId, choice): Promise<ActionStepResult>` (`:1086`), `resumeAction(characterId): ActionResumeResult` (`:1211`). Return types in `src/engine/WorldEngine.ts:89-137`. `createCharacter` and `getCharacter`/`getItems` read state back.
- **Roll injection:** `rollD20` is a `WorldEngineConfig` field (`WorldEngineImpl.ts:233`), passed to the machine (`:371`), called once per resolution at `machine.ts:307`. Existing tests inject `rollD20: () => 15` (`happy-path.test.ts:87`).
- **LLM injection:** `MockLlmGateway` (`src/llm/MockLlmGateway.ts:7`) implements `LlmGateway` with `setDecision()` and a `static defaultDecision(overrides?)` fixture (`:24`). NOTE: the engine re-wraps `config.llm` in `FallbackLlmGateway` (`WorldEngineImpl.ts:313`) — a mock that *throws* triggers the two-tier retry → divine-intervention fallback; a mock that *returns* a valid decision flows through. Leaving `critic` unset skips the `CritiquedLlmGateway` wrap.
- **The machine calls `decide()` twice on a resolving beat** (decision beat at `machine.ts:87`/`:244`, then narration at `:315`). A single canned decision serves both in existing tests.
- **DB init:** `initDb(':memory:')` (`src/db/connection.ts:17`) → `migrate(getDb())` (`src/db/migrate.ts`). Repos live in `src/db/repositories/`; row shapes in `src/db/repositories/types.ts`.
- **Type contracts to reuse:** `LlmContext`, `LlmDecision`, `LlmDecisionOption` (`src/llm/LlmGateway.ts:1-87`); `CharacterData` (`WorldEngine.ts:13-34`); `ActionOutcome` (`WorldEngine.ts:101-135`).
- **Test runner:** vitest (`npm test` → `vitest run`; single file `npm test -- tests/sim/<file>`). Typecheck `npm run typecheck`. Global setup `tests/setup.ts` seeds the emoji registry only. Templates: `tests/e2e/happy-path.test.ts` (full flow), `tests/engine/decision-pipeline.test.ts:40-65` (tightest reusable engine construction), `tests/engine/action-machine.test.ts` (bare machine).

## Dependency graph

```
T1 harness skeleton + scenario driver   (the spine)
 ├── T2 metrics collector + output
 ├── T3 time advancement (days → weeks)
 │      └──┐
 └─────────┴── T4 CLI entry + scenario files
T5 captured-call replay mode   (optional, depends on T1 only)
```

Order: **T1 → T2 → T3 → T4**, with T5 deferred. High-risk-first: T1 is the invasive integration and comes first.

---

## Task list

### Task 1 — Harness skeleton + single-scenario driver

**Description.** Create `src/sim/` with (a) a `buildSimEngine()` factory mirroring `happy-path.test.ts:70-91` (in-memory DB, `migrate`, the five repos, `WorldEngineImpl` with injected mock + `rollD20`); (b) a `ScriptedLlmGateway implements LlmGateway` returning canned `LlmDecision`s from a per-turn script; (c) a `runScenario(scenario)` driver that creates the character then loops `startAction`/`stepAction`, applying a choice policy, until each turn resolves — returning a per-turn trace.

**Concrete contracts** — author these in `src/sim/types.ts`:

```ts
type RollSource =
  | { kind: 'fixed'; value: number }
  | { kind: 'sequence'; values: number[] }   // consumed per resolveWithRoll call
  | { kind: 'seeded'; seed: number };         // mulberry32, mapped to 1..20
type ChoicePolicy = 'first-real' | 'highest-dc' | 'lowest-dc' | 'bail' | { index: number };
type DecisionScript = (ctx: LlmContext, callNo: number) => LlmDecision; // callNo: 0-based decide() count
interface CharacterSeed {
  class: string;
  stats: { physical: number; wisdom: number; intelligence: number; charisma: number };
  health: number; maxHealth: number; stamina: number; maxStamina: number;
  wealth: number; location: string; alignment: string; dayJob: string;
}
interface TurnScript { input: string; choicePolicy: ChoicePolicy; }
type DayScript = TurnScript[];           // one day's turns; [] = a rest day
interface Scenario {
  name: string; character: CharacterSeed; rollSource: RollSource;
  llm: { kind: 'scripted'; script: DecisionScript };
  week: DayScript[]; weeks?: number;     // week = 1..7 distinct days; weeks (T3) repeats it
}
interface TurnTrace {
  index: number; input: string; distilledType: string; finalDc: number | null;
  playerRolled: number | null; rollBonus: number | null; outcome: string;
  health: number; stamina: number; wealth: number; rollsRemaining: number;
  itemCount: number; mutationsApplied: number; day?: number;   // game day_number (T3)
}
interface SimResult { scenario: string; turns: TurnTrace[]; }
async function runScenario(s: Scenario): Promise<SimResult>;
```

The `DecisionScript`'s `callNo` lets one script serve both the decision and narration `decide()` calls; simple scripts ignore it.

**Acceptance criteria.**
- [x] `runScenario` drives a ≥3-turn scenario to completion using `WorldEngineImpl` (real in-memory DB), with no network call.
- [x] `rollSource` fully determines `playerRolled` (no `Math.random` in the action path).
- [x] Each `TurnTrace` reflects post-resolution character state read back via `getCharacter`/`getItems`.

**Verification.**
- [x] `npm test -- tests/sim/driver.test.ts` — 7/7 pass (fixed-roll 20/1 → success/failure, bail policy, no-fallback assertion, multi-day week with a rest day).
- [x] `npm run typecheck` clean.
- [x] A test asserts the scripted mock never triggers the divine-intervention fallback (the real sentinel `DIVINE_INTERVENTION_TYPE` / `'__divine__'`, not the illustrative literal).

**Dependencies:** none. **Files:** `src/sim/types.ts`, `src/sim/engine-factory.ts`, `src/sim/ScriptedLlmGateway.ts`, `src/sim/driver.ts`, `tests/sim/driver.test.ts`. **Scope:** M.

### Task 2 — Metrics collector + output

**Description.** Consume `SimResult.turns` → compute a `SimSummary` and render (a) a console table and (b) a JSON + CSV file. Metrics per architecture decision 3.

**Concrete contract** (`src/sim/metrics.ts`):

```ts
interface SimSummary {
  turnsRun: number; rollsResolved: number; rollSuccessRate: number;
  netHealth: number; netStamina: number; netWealth: number; itemsGained: number;
  avgFinalDc: number; death: null;   // hook: death-rate N/A until the death track lands
}
function summarize(r: SimResult): SimSummary;
function toCsv(r: SimResult): string;         // header + one row per turn
function renderTable(s: SimSummary): string;  // console summary
```

**Acceptance criteria.**
- [x] `rollSuccessRate` is computed over turns where `playerRolled !== null` (skips/bails excluded).
- [x] `toCsv` emits a header plus one row per turn with every `TurnTrace` scalar column.
- [x] `death` is explicitly `null` with a comment linking the deferred death track.

**Verification.**
- [x] `npm test -- tests/sim/metrics.test.ts` — 9/9 pass.

**Dependencies:** T1. **Files:** `src/sim/metrics.ts`, `tests/sim/metrics.test.ts`. **Scope:** S.

### Task 3 — Time advancement (days → weeks)

**Description.** Add `advanceDays(engine, n)` so a scenario can span N weeks and exercise the roll economy. **Resolved mechanism (no research needed):** the day-advance is the public method `tick(isAdmin: boolean): TickResult` (`WorldEngineImpl.ts:1543`). Each call advances `meta.day_number` +1, refills `rolls_remaining` to `DAILY_ROLL_ALLOWANCE` (3, `WorldEngineImpl.ts:76`) plus the Saturday bonus, regens stamina/health in safe locations (`+5`/`+3`, capped) or drains `-1` stamina in unsafe ones, and pays day-job income. `advanceDays(engine, n)` = call `tick` n times; a week = 7 ticks. Wire `Scenario.weeks` into the driver loop and tag each `TurnTrace` with its game day.

- [!] **Call `tick(true)`, not `tick(false)`.** With `isAdmin=false` the tick has cron idempotency — it no-ops when `meta.last_cron_date === today` (real calendar date, `WorldEngineImpl.ts:1551-1563`). Driving multiple ticks in one process on the same wall-clock day would silently no-op every tick after the first. `isAdmin=true` bypasses the guard.
- [!] **Real-clock leak (document, don't fight).** The Saturday bonus and 5-day absence nudge read `new Date()` (`:1544`). In vitest, pin it with `vi.useFakeTimers()` + `vi.setSystemTime(...)` (as `happy-path.test.ts:131-132` does). From the standalone CLI it tracks the real weekday — a documented minor variance (a `+1` roll on Saturdays), not a blocker; game-day mechanics are otherwise deterministic. NPC movement seeds off game day, not real time, so it stays reproducible.

**Acceptance criteria.**
- [x] `advanceDays(engine, 7)` moves `day_number` +7 and `rolls_remaining` refills per the real daily reset.
- [x] A `weeks`-spanning scenario walks turns across the span; each `TurnTrace` carries its day/week.

**Verification.**
- [x] `npm test -- tests/sim/time.test.ts` — 3/3 pass (`tick(true)` throughout; `vi.setSystemTime` pinned to a Monday for a stable allowance).

> Implementation note: `scenario.week` is an **explicit sequence of day routines** (`DayScript[]`, 1..7 entries — a `[]` day is a rest day, clock ticks but no turn runs). The driver walks each day in order, ticking (`tick(true)`) between days, then repeats the whole week `weeks` times. This replaced an earlier one-day-repeated reading so a week can mix distinct days (grind days, a market day, a rest day) rather than the same day 7×.

**Dependencies:** T1. **Files:** `src/sim/time.ts`, `src/sim/types.ts` (add `weeks`), `src/sim/driver.ts` (loop integration), `tests/sim/time.test.ts`. **Scope:** M.

### Checkpoint: after T1–T3

- [x] `npm test` green (837/837); `npm run typecheck` clean.
- [x] A multi-turn, multi-week scenario runs end-to-end and produces a summary + CSV. Machinery proven before adding the CLI/scenario surface.
- [ ] Review with a human (pending).

### Task 4 — CLI entry + scenario files

**Description.** `src/sim/run.ts` reads a scenario JSON (path from argv), runs it, prints the table, and writes `<name>.result.json` + `<name>.csv`. Add `"sim": "tsx src/sim/run.ts"` to `package.json` scripts. Ship two example scenarios: a safe "grind week" and a "risky wilds" run. Because a JSON file can't carry a `DecisionScript` function, the CLI scenario format inlines a **canned decision list** (array of `LlmDecision`) consumed in order; the loader adapts it into a `DecisionScript`.

**Acceptance criteria.**
- [x] `npm run sim -- src/sim/scenarios/grind-week.json` prints a summary table and writes the two output files.
- [x] Malformed scenario JSON fails loudly (validated against the T1 types), never silently.

**Verification.**
- [x] Manual: `npm run sim -- src/sim/scenarios/{grind-week,risky-wilds}.json` both exit 0 and produce `<name>.result.json` + `<name>.csv` (gitignored).
- [x] `npm test -- tests/sim/scenario-load.test.ts` — 8/8 pass (incl. the `week` >7-day cap and non-positive/fractional `weeks` rejection).

**Dependencies:** T2, T3. **Files:** `src/sim/run.ts`, `src/sim/scenario-load.ts`, `src/sim/scenarios/grind-week.json`, `src/sim/scenarios/risky-wilds.json`, `package.json`, `tests/sim/scenario-load.test.ts`. **Scope:** S–M.

### Task 5 — Captured-call replay mode (optional, deferred)

**Description.** A `CapturedLlmGateway` loading `llm_calls.response_json` rows from a snapshot DB (`db-backups/`) and replaying them in order (or matched by `player_input` / `prompt_version`), for realism/regression rather than tuning. Add an `llm: { kind: 'captured'; dbPath; ... }` arm to the `Scenario` union.

- [ ] Replays a captured session deterministically; missing/malformed rows fail loudly.

**Dependencies:** T1. **Scope:** M. **Explicitly deferrable** — synthetic mode (T1) already satisfies the Stage 0a exit criterion. Only build if realism is wanted before Stage 3.

---

## Risks

| Risk | Impact | Mitigation |
| ---- | ------ | ---------- |
| Engine re-wraps `llm` in `FallbackLlmGateway`; a throwing mock silently triggers divine-intervention | Med | Scripts return valid decisions; a T1 test asserts no fallback fires. |
| `ScriptedLlmGateway` multi-`decide()` sequencing surprises (2 calls per resolving beat) | Low | `callNo` param + a driver test asserting call count per beat. |
| Real-`Date` leak in `tick` perturbs Saturday roll count | Low | Pin with `vi.setSystemTime` in tests; document the CLI variance (T3). |
| Scope creep toward a real game sim | Med | Scope fence above; T5 deferred; no charting dependency. |

## Exit criterion (Stage 0a graduates)

Can replay a scripted character through simulated weeks against mocked LLM output and emit win-rate / resource / reward curves offline, deterministically, via `npm run sim`. This unblocks tuning Thread C (combat bands, [[prompt-v12-combat]]) and Thread B (world-scaling curve, [[prompt-v12-world-scaling]]).

---

_Status: **T1–T4 built and verified** (837/837 tests green, typecheck clean) — pending human review. T5 (captured replay) and the death-rate metric remain deferred until the death track lands. Once reviewed and merged, `git mv` this plan to `archived/` with `status: shipped`, `superseded_by: "implemented in code"`._
