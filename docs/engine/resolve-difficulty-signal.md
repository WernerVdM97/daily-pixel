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
  - "[[poc-plus-release-a-plan]]"
---

# RESOLVE difficulty signal

Folded into the 0.3.3 cut (P3), after P1's review found it. Branch `poc-plus/release-a-polish`.

## The defect

RA-1 has two halves: raise the stakes, and pay for them. The stakes half landed and P1 made the top of the ladder reachable. **The paying half is instructed but unactionable.** `resolve/BASE.md:45` says "**Reward scales with the DC actually attempted**" and `resolve/combat/success.md:12` says a harder fight ("higher `baseDc`") earns a better item or more coin. Neither number is in the message: `buildResolveUserMessage` (`src/llm/pipeline/pipeline-messages.ts:63-83`) sends `TASK`, `VERDICT`, `D20`, the action type, the chosen option's label and stat, the optional `fatal blow` token and the scene body. No DC, no `dcModifier`, no final DC, nothing about the foe's strength. So the model can only infer ambition from the chosen label's prose, and `combat/success.md` names a field it cannot read.

This is the defect class stage 4's review named: prompt prose that keys off an engine signal must be checked against the message the engine actually builds. It is worth fixing now rather than next set because v13 has produced no attributable rows yet (prod is still on 0.3.2/v12), so v13 is editable in place. Once 0.3.3 deploys, the same three-line prose change needs a v14 set copy, a `PROMPT_SET_VERSION` bump and the pinned-test retargeting that stage 4 steps 0/6/7 cost.

## Two paths need two different signals, and this is the load-bearing decision

The obvious design (one `finalDc` field) is **wrong for combat**, and shipping it would recreate the same defect one layer down.

- **The non-combat rolling path resolves against a DC.** `PipelineActionStateMachine.ts:1178` computes `verdict = resolveRoll(d20Roll, rollBonus, newDc)`, so `newDc` is exactly "the DC actually attempted" that `resolve/BASE.md:45` asks for. Send it.
- **Combat does not use a DC at all.** `resolveCombatRound` (`combat-dc.ts:143-149`) takes `playerD20, playerBonus, enemyD20, enemyBonus, scale` and bands on `margin = (playerD20 + playerBonus) - (enemyD20 + enemyBonus)`. There is no threshold to pass. A `final dc` token on this path would name a number the round was never resolved against. What *does* carry the fight's difficulty is `baseDc`, indirectly but genuinely: `enemyBonus = clamp(baseDc - 10, 0, ENEMY_BONUS_MAX)` and `deriveEnemyMaxHp` is `clamp(round(baseDc * scale), ENEMY_HP_MIN, ENEMY_HP_MAX)`, so `baseDc` sets both how hard the foe hits and how long it lasts. The engine already words that as a tier: `dangerTier(dc)` (`combat-dc.ts:230-236`), which the player **already sees on the combat card** (`actionViewState.ts:142`, rendered as `[hard]` by `CombatCardRenderer.ts:152-155`).

So combat gets the danger tier, not a DC. That choice has a second payoff beyond honesty: the narration and the card will use the same word for the same fight, instead of the prose and the UI describing difficulty on two unrelated scales.

**Auto-resolved actions get neither.** `d20Roll` is 0 for the no-roll types (rest, travel) per `types.ts:82-83`. Nothing was tested against any threshold, so sending a DC would invite the model to scale a reward by a number the player never faced. Omit both tokens there and let the existing `D20: 0` continue to say "no attempt was rolled".

**Send the number, not a pre-computed band, on the non-combat path.** The routine/hard/daunting ladder lives in the prompt set. Computing that band in TypeScript would duplicate the ladder in engine code, where it would drift from the prose exactly the way `critic-gate.ts`'s comment just did. The engine sends facts (`D20:`, `fatal blow:`), the prompt interprets them. Combat's tier is the exception only because that ladder already exists in code and is already on screen.

## Deliverables

**1. `src/llm/pipeline/types.ts`** — two optional fields on **both** `PipelineResolveMutateInput` and `PipelineResolveNarrateInput`, following the `fatalBlow` precedent (optional, so every existing caller, script and test stays valid untouched):

- `finalDc?: number` — the DC the roll was resolved against. Present only when a DC check decided the verdict.
- `foeDanger?: DangerTier` — the worded tier for a fight, from `dangerTier()`. Combat only.

Each needs a WHY comment in the house style: state that combat is contested rather than DC-checked, and that this is why the two fields are not one.

**2. `src/llm/pipeline/pipeline-messages.ts`** — emit each as a bare token under `### What was decided`, beside `- fatal blow:`, conditional on presence: `- final dc: <n>` and `- foe danger: <tier>`. Keep the existing comment's spirit: this code emits the token, the recipe prose explains what it means.

**3. `src/engine/action/PipelineActionStateMachine.ts`** — four call sites, and the value is already in scope at every one:

| Site | Call | Field to pass |
|---|---|---|
| `:954` | combat resolve-mutate | `foeDanger` |
| `:1067` | combat resolve-narrate | `foeDanger` |
| `:1178` | resolve-mutate | `finalDc` |
| `:1218` | resolve-narrate | `finalDc` |

For the two combat sites, derive the tier from **the same DC the combat card uses**, so the word matches what the player was shown. Read `:875` and `actionViewState.ts:142` and confirm that source for yourself before choosing what to pass; do not assume `resolveCombat`'s `newDc` parameter is it. Build the handoff as a spread object like the existing `fatalBlowHandoff` rather than passing an explicit `undefined`, so the field is genuinely absent when it does not apply.

For the two non-combat sites, pass `newDc` **only when a roll happened**. The rest/travel branch at `:1180-1183` sets `verdict = 'success'` with no roll, so gate on the same condition that branch does, not on a truthiness check of `d20Roll`.

**4. The v13 prompt set** (edited in place; re-sync `current_source/` after, `diff -r` must be empty):

- `resolve/BASE.md:45` — keep the rule, but point it at the token: name `final dc` as where the attempted difficulty comes from, and tie the reward size to the v13 bands (11-13 routine, 16-18 hard, 20-24 daunting) so the scaling is anchored to the same ladder DECIDE authors against. State that when no `final dc` token is present nothing was rolled, so a routine reward is correct.
- `resolve/BASE.md`'s `### What was decided` INPUT CONTEXT bullet — document both new tokens alongside `fatal blow`, including that `foe danger` appears on fights and `final dc` on DC-checked attempts, never both.
- `resolve/combat/success.md:12` — replace the unreadable `baseDc` reference with `foe danger`, and say the tier words the engine actually emits (`easy | medium | hard | risky | fatal`) rather than inventing a scale.

**5. Tests.** Cover the message builder both ways per token (present renders the token, absent renders no line at all, which is the assertion that catches a regression to an unconditional spread: use the `in` operator or a line-level check, not `toBeUndefined()`, per stage 2's review). Add a content assertion per edited recipe in the house style of `tests/llm/prompt-set-loader.test.ts` (locate the line, assert on it). At least one test must pin that an auto-resolved (no-roll) resolution carries neither token.

## Scope fence

No change to how any DC or tier is computed: `dangerTier`'s thresholds, `accumulateDc`, `resolveCombatRound`, `deriveEnemyMaxHp` and `ENEMY_BONUS_MAX` are all untouched. No new template file and no change to template selection (`loadPromptSet` selects on category plus verdict). No `PROMPT_SET_VERSION` bump: this lands in v13 in place, per the reasoning above. No golden snapshot should move, because no rendered surface is touched. Do not revisit P1's decide-side prose.

## Acceptance

- [ ] `finalDc` and `foeDanger` are optional on both resolve inputs; every pre-existing caller compiles unchanged.
- [ ] A combat resolution carries `foe danger` and no `final dc`; a DC-checked non-combat resolution carries `final dc` and no `foe danger`; an auto-resolved rest/travel carries neither.
- [ ] The combat tier is derived from the same DC the combat card renders, verified by reading both call sites rather than assumed.
- [ ] `resolve/BASE.md` documents both tokens and scales reward against the v13 bands; `resolve/combat/success.md` names the tier vocabulary and no longer references `baseDc`.
- [ ] `diff -r v13 current_source` empty; no `PROMPT_SET_VERSION` change.
- [ ] Typecheck clean; suite green with the new tests; no golden snapshot moves.

## Known residual, deliberately not fixed here

`dangerTier`'s thresholds (easy ≤9, medium ≤13, hard ≤17, risky ≤21, fatal >21) were anchored against the **pre-v13** ladder, with the comment at `combat-dc.ts:225-227` citing "the sim's baseline goblin (baseDc 12) reads medium". v13 re-anchored the bands (routine 11-13, hard 16-18, daunting 20-24), so the tier words and the ladder bands no longer line up exactly: a v13 "routine" 13 reads `medium`, and a v13 "daunting" 22 reads `fatal`. The words remain individually sensible and this change only makes an existing display ladder audible in prose, so re-tuning it is a balance decision with its own measurement, not part of wiring the signal. Logged for whoever tunes combat next.
