---
title: "T1 — combat calibration: scale-neutral balance baseline"
status: decided
domain: engine
phase: poc
tags: [combat, engine, sim, balance, stage-5, calibration]
related: ["[[stage-5-live-cutover-plan]]", "[[prompt-v12-combat]]"]
---
The balance-defensibility record for the v11→v12 cutover — a reproducible seeded multi-fight harness (`src/sim/calibrate-combat.ts`, `npm run calibrate`) sweeping player `physical` × encounter `baseDc` and recording real win/loss/floor-save/rounds/reward curves against the current combat constants, `scale = 1` throughout (Thread B/World Tier out of scope). This note records the constants and the observed curves; it does NOT tune anything — the tuning verdict is the lead's call (see `## Verdict` below).

---

## Current constants (`src/engine/action/combat-dc.ts`, verbatim, untouched by this task)

**`COMBAT_BAND_TABLE`** — ordered highest-margin-first, `resolveCombatRound` picks the first band whose `minMargin` the signed margin clears:

| band | minMargin | enemyHpDelta | playerHpDelta |
|---|---|---|---|
| clean | 8 | -6 | 0 |
| glanced | 2 | -3 | 0 |
| trade | -2 | -2 | -2 |
| heavy | -Infinity (catch-all) | -1 | -3 |

Crit overrides (do not shift the margin thresholds themselves):
- player nat-20 → forces `clean`, `enemyHpDelta` amplified by another `-CRIT_AMPLIFY_BONUS`.
- player nat-1 → forces `heavy`, `playerHpDelta` amplified by another `-CRIT_AMPLIFY_BONUS`.
- enemy nat-20 → forces `heavy` (no extra amplification).
- enemy nat-1 → forces `clean` (no extra amplification).
- Precedence when both dice crit and disagree: the player's own die always wins the band.

`scale` (default 1) multiplies the final deltas only — including crit amplification — never which band is chosen.

**`deriveEnemyMaxHp(baseDc, scale = 1)`** — `clamp(Math.round(baseDc * scale), ENEMY_HP_MIN, ENEMY_HP_MAX)`.

**Bounds and other constants:**

| constant | value |
|---|---|
| `ENEMY_BONUS_MAX` | 10 (enemy `d20` bonus ceiling: `clamp(baseDc - 10, 0, ENEMY_BONUS_MAX)`) |
| `ENEMY_HP_MIN` | 6 |
| `ENEMY_HP_MAX` | 20 |
| `CRIT_AMPLIFY_BONUS` | 2 |
| `MAX_COMBAT_ROUNDS` | 4 (a fight at the cap derives its winner from HP fraction instead of another roll) |

---

## Harness

`src/sim/calibrate-combat.ts` (`npm run calibrate`) sweeps player `physical` ∈ {2, 5, 8} (weak / baseline / strong warrior) × encounter `baseDc` ∈ {8, 12, 16} (easy / standard / hard), `scale` fixed at 1 — 9 configs. Each config runs **N = 300** independent fights (`N` is a top-level const in the script, trivially bumped for a tighter curve); each fight is a fresh full-HP `Warrior` (10/10 HP, the config's `physical` stat, all other stats 0) run through the same `combatScript(baseDc)` shape T5's proven scenarios use (`combatEnemy` on the opening `decide()`, a single `'Press the attack'` option, `first-real` choice policy, a flat `modify_wealth amount:1` loot mutation on resolve). Every fight's roll source is `{ kind: 'seeded', seed: fightIndex + 1 }` (mulberry32 → 1..20) — deterministic and reproducible, never `Math.random`. One fight = one scenario run (HP carries across turns with no regen in the pipeline-sim path, so N separate scenario runs, never N fights packed into one scenario's week). Per config, the harness aggregates from each run's `SimResult.combatMetrics` (`{ roundsFought, floorSaves, wins, losses }`): win rate, loss rate (= death rate, `losses / N`), floor-save rate (fraction of fights where the once-per-day survive-at-1 floor fired at least once), mean rounds fought, and mean reward (final turn's `wealth`, starting from 0). Results print as a table and are also written to `src/sim/combat-calibration.json` for re-inspection.

## Curves (N = 300 fights/config, seeded, scale = 1)

```
physical | baseDc | winRate | lossRate | floorSaveRate | meanRounds | meanReward
---------|--------|---------|----------|---------------|------------|------------
       2 |      8 |   97.0% |     3.0% |          8.7% |       3.08 |      1.000
       2 |     12 |   83.3% |    16.7% |         25.0% |       4.38 |      1.000
       2 |     16 |   35.7% |    64.3% |         61.0% |       5.21 |      1.000
       5 |      8 |   98.3% |     1.7% |          4.3% |       2.72 |      1.000
       5 |     12 |   90.7% |     9.3% |         15.0% |       3.96 |      1.000
       5 |     16 |   58.0% |    42.0% |         39.3% |       5.02 |      1.000
       8 |      8 |   99.0% |     1.0% |          2.7% |       2.41 |      1.000
       8 |     12 |   97.0% |     3.0% |          7.7% |       3.47 |      1.000
       8 |     16 |   74.7% |    25.3% |         22.7% |       4.83 |      1.000
```

## Reading

Win rate climbs monotonically with `physical` and falls monotonically with `baseDc`, in every row — the grid behaves in the expected direction with no inversions. The weak/hard corner (`physical: 2, baseDc: 16`) is the standout: win rate drops to 35.7% and the floor-save fires in 61.0% of fights — the once-per-day survive-at-1 floor is doing real, frequent work exactly where the underdog matchup says it should. The strong/easy corner (`physical: 8, baseDc: 8`) is a near-guaranteed 99.0% win with floor-saves rare (2.7%), which reads as intended for an "easy" encounter against a "strong" build. Mean rounds fought rises with `baseDc` in every `physical` row (from ~2.4–3.1 rounds at `baseDc: 8` up to ~4.8–5.2 rounds at `baseDc: 16`) — harder encounters grind longer, consistent with the enemy's larger `deriveEnemyMaxHp` and the band table's small per-round HP deltas. Loss rate mirrors win rate everywhere (`lossRate = 1 - winRate` in every row, as expected — the pipeline's cap-derive step always resolves a fight to a win or a loss, no draws). Floor-save rate tracks difficulty directly: it is lowest wherever win rate is highest and rises sharply as the matchup gets harder, peaking at 61.0% in the hardest matchup. Mean reward is flat at 1.000 in every one of the 9 configs — this is a known, deliberate limitation of the harness, not a balance signal: `combatScript`'s `resolveMutate` hard-codes `modify_wealth amount:1` regardless of fight outcome or difficulty, so real reward scaling by difficulty is Thread B (World Tier) territory and out of scope here.

---

## Verdict

**Accepted as the scale-neutral launch baseline — no constant changes.** (Lead review, 2026-07-05.)

The grid is directionally correct and monotonic with no inversions, and the case the launch actually targets reads well: a baseline warrior (`physical: 5`) against a standard encounter (`baseDc: 12`) wins ~90.7% of the time, is knocked out ~9.3%, and grinds ~4 rounds — a fight you usually win but that costs you, which is the intended feel. Nothing here reads broken enough to justify pre-launch tuning against the sim, and settled decision 4 ([[stage-5-live-cutover-plan]]) mandates a scale-neutral launch where "combat behaves exactly as sim-proven"; the scope fence defers real rebalancing to live data.

The alarming weak/hard corner (`physical: 2, baseDc: 16` → 64.3% loss) is deliberately **not** a blocker, for three reasons: (1) "loss" here is an HP-zero **knockout, not permadeath** — the POC keeps HP-0 observable-not-fatal (the `hpZero` marker; the real death mechanic is MVP scope, [[prompt-v13-roadmap]]), so a high loss rate is "you get downed a lot," not "you lose your character"; (2) the once-per-day survive-at-1 floor fires in 61% of those fights, so the *first* lethal blow is always absorbed; (3) it is a deliberately mismatched encounter, and danger is gated by **location** in the world design — a `physical: 2` character meeting a `baseDc: 16` foe is a world-authoring placement question, not a combat-math defect. Danger being real in the mismatched corner is the intended signal, not a bug.

Two items recorded as **post-launch watch-items** (live data, not pre-flip work, per the scope fence): the underdog-vs-hard death rate once real encounter `baseDc` distributions are observed (if the world routinely presents `baseDc: 16` to weak characters, that is a world-scaling/placement fix in Thread B, not a band-table fix); and reward scaling, which is flat by construction here (`combatScript` hard-codes loot) and is owned by Thread B / World Tier ([[prompt-v13-roadmap]]).
