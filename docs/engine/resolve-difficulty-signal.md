---
title: "RESOLVE difficulty signal — pay the player for the gamble they took"
status: decided
domain: engine
phase: poc
tags:
  - llm
  - prompt
  - pipeline
  - combat
  - rewards
related:
  - "[[prompt-v13-roadmap]]"
  - "[[combat-system-v12]]"
---
_Landed in the `0.3.3` cut (P3). Why the difficulty a player gambled on reaches RESOLVE as two different facts rather than one number, and what the two balance residuals it exposed taught._

---

# RESOLVE difficulty signal

## The defect it fixed

RA-1 has two halves: raise the stakes, and pay for them. The stakes half landed and P1 made the top of the ladder reachable. **The paying half was instructed but unactionable.** `resolve/BASE.md` said "Reward scales with the DC actually attempted" and `resolve/combat/success.md` promised a harder fight ("higher `baseDc`") a better item or more coin, but neither number was in the message: `buildResolveUserMessage` (`src/llm/pipeline/pipeline-messages.ts`) sent `TASK`, `VERDICT`, `D20`, the action type, the chosen option's label and stat, the optional `fatal blow` token and the scene body. No DC, no `dcModifier`, no final DC, nothing about the foe's strength. The model could only infer ambition from the chosen label's prose, and the recipe named a field it could not read.

That is the defect class stage 4's review named: **prompt prose that keys off an engine signal must be checked against the message the engine actually builds**, not merely read for sense.

## Two paths need two different signals

The obvious design, one `finalDc` field, is **wrong for combat**, and shipping it would recreate the same defect one layer down. The engine now emits `- final dc: <n>` or `- foe danger: <tier>` under `### What was decided`, and never both.

- **A DC-checked attempt carries `final dc`.** `PipelineActionStateMachine` computes `verdict = resolveRoll(d20Roll, rollBonus, newDc)`, so `newDc` is exactly "the DC actually attempted" that `resolve/BASE.md` asks for. It is sent only when a roll happened: the rest/travel branch sets `verdict = 'success'` with no roll, so the token is gated on the same condition that branch uses, not on a truthiness check of `d20Roll`.
- **A fight carries `foe danger`.** Combat is a contested roll, not a DC check: `resolveCombatRound` (`src/engine/action/combat-dc.ts`) bands on `margin = (playerD20 + playerBonus) - (enemyD20 + enemyBonus)`, so there is no threshold to pass and a `final dc` token would name a number the round was never resolved against. What carries the fight's difficulty is `baseDc`, indirectly but genuinely (`enemyBonus = clamp(baseDc - 10, 0, ENEMY_BONUS_MAX)` and `deriveEnemyMaxHp` scales with it), and the engine already words that as the tier the player sees on the combat card (`dangerTier()`). The card and the narration therefore agree on one word for the whole fight.
- **Auto-resolved actions get neither.** `d20Roll` is 0 for the no-roll types (rest, travel), so nothing was tested against any threshold and a DC would invite the model to scale a reward by a number the player never faced. The existing `D20: 0` continues to say "no attempt was rolled".
- **Send the number, not a pre-computed band, on the non-combat path.** The routine/hard/daunting ladder lives in the prompt set; computing that band in TypeScript would duplicate the ladder in engine code, where it would drift from the prose. The engine sends facts (`D20:`, `fatal blow:`), the prompt interprets them. Combat's tier is the exception only because that ladder already exists in code and is already on screen.

## What the residuals taught

Two balance residuals this signal exposed are closed, and each left a caveat worth keeping.

**The bands are drawn against a soft contract.** #96 re-cut `dangerTier`'s thresholds against v13's anchor (`easy ≤11, medium 12-15, hard 16-19, risky 20-23, fatal ≥24`, from `≤9 / ≤13 / ≤17 / ≤21 / >21`) because the old cut had been drawn against the pre-v13 ladder: a legal `baseDc` is 10-24, so `easy` was unreachable for a contract-honouring fight and the ladder had no bottom. But `baseDc` is a **soft** contract: `validateDcModifier` bounds only the ±5 modifier and nothing clamps an authored `baseDc` at all, so a model that authors 8 still reaches `easy` on the card rather than an error. The distribution is still unmeasured, because the tier's input is model-authored; banding live actions is the persona-panel probe's job, and `Transcript.difficultyBands()` now does it, with one 2026-10-20 soldier arm reaching 21 and 24 (see `docs/engine/agent-player-personas.md` § The daunting-band reading).

**The tier is the fight's, not the round's.** The card/narration match held per round until #97: the state machine replaced `state.lastDecideResult` with each CONTINUE round's fresh decide result, including a newly authored `baseDc`, so in a multi-round fight whose later round authored a different `baseDc` the tier RESOLVE received reflected the final round rather than the tier the card showed. The opening round still authors `baseDc`, and the engine now persists it as a `baseDc` prop on the `in_combat` edge, which every CONTINUE round reads back, so `enemyBonus`, the card's `dangerTier` and the `foeDanger` RESOLVE is handed are one number for the whole fight. The decide message says so too: a combat CONTINUE carries `- Fight DC: <n> (the fight's own DC, fixed when it opened; any baseDc you author this round is ignored)`, so the model is told the number rather than invited to move it, and the wording does not contradict `decide/BASE.md`'s requirement that every beat still author a legal `baseDc`.
