---
title: "Decide-stage scene narration, action-options & stat icons (v12 follow-up)"
status: exploring
domain: engine
phase: poc
tags:
  - llm
  - prompt
  - pipeline
  - immersion
  - combat
  - discord
related:
  - "[[prompt-v12-pipeline]]"
  - "[[prompt-separation-of-concerns]]"
  - "[[prompt-v12-scene-state]]"
  - "[[prompt-v12-combat]]"
  - "[[action-engine-framework]]"
  - "[[stage-5-live-cutover-plan]]"
---
_Restore the LLM's scene-setting to the v12 action screen: the game master narrates the consequence of each choice, options become concrete actions in response, every option shows its stat icon, and combat continue-rounds can no longer dead-end into a flee-only screen._

> Follow-up to the v12 pipeline cutover ([[prompt-separation-of-concerns]]). This amends one v12 decision (DECIDE authors no prose) and hardens the combat continue-path. Baseline copies of the prompt set as it stands before this change live in [`./current_source/`](./current_source/).

---

## Problem

The v12 pipeline split the old mega-call into classify to decide to resolve, and made DECIDE author options only, no prose ([[prompt-v12-pipeline]] Stage 2). Two things broke on the live action screen as a result.

**1. The LLM stopped setting the scene.** With no prose field, `decide/BASE.md` Rule 4 tells the model *"the decision options ARE the scene; each `label` is a story beat"*, so the model crams narration into the option labels. The engine then discards any framing and shows a hardcoded `"<Type> — choose your approach:"` line above those labels. The result inverts the interaction: instead of being told what happens and acting on it, the player is asked to pick which observation to make. A live example (Scout the treeline, beat 2):

```
Scout — choose your approach:
A. Spot a pack of wolves tracking south — watch their path and gauge their intent
B. Glimpse a dark figure fleeing deeper into the pines — climb down and follow
C. Notice a disturbance in the undergrowth near the camp — call down to Bram and Kara
```

The historic-beat "story so far" thread is hit the same way: `buildStoryThread` renders each past beat's `prompt`, which is now the generic line repeated, not the scene prose.

**2. Combat rounds dead-end into flee-only.** On a continuing combat round the model returns an empty `decision` array, and `handleCombatStep` builds the next screen from it plus the engine's guaranteed flee option, leaving flee as the only choice. Two dev-DB actions (34, 35) both died this way (llm_calls 115, 119 returned `"decision": []`). Root cause: the combat continue prompt assembles `BASE + phases/CONTINUE.md + decide/combat.md`, and CONTINUE.md's *"once the player commits to an irreversible action, return an empty `decision`; prefer resolving in 2-3 beats"* directly contradicts combat.md Rule 3 *"keep `decision` non-empty for as long as the fight continues"*. A combat attack is an irreversible committed action, so CONTINUE wins, deterministically, every fight.

## Decisions (approved)

- **Consequence beats only.** The first beat stays lean (no LLM prose, framed by the player's own input); scene narration appears from the second beat onward as the consequence of the previous choice.
- **Combat narrates each round.** Because a combat round's contested roll resolves the moment the player picks an option, every combat continue-screen already sits on a fresh, engine-computed result. Each ongoing round narrates that resolved exchange, then offers the next round's options.
- **Narration is authored by DECIDE (Approach A).** A new optional `narration` field on the decide result, authored on CONTINUE beats only. No extra LLM calls: combat latency stays flat. This amends the v12 "DECIDE authors no prose" decision. It is a deliberate, bounded amendment: scene-framing before a choice is not outcome-authoring, and for combat the round's mechanical truth is engine-owned and passed into DECIDE, which only dresses it. RESOLVE still owns final mutations and the terminal outcome.
- **Options are actions, each with a stat icon.** Option labels become crisp actions taken in response to the narrated scene, never "choose what you perceive". Each option renders with the emoji for the stat it tests.

## Data contract

- `PipelineDecideResult` (`src/llm/pipeline/types.ts`): add `narration?: string`. Present on CONTINUE beats, absent on NEW_ACTION and on empty-decision (resolve-now) results.
- `ActionDecision` and `ActionDecisionRecord` (`src/engine/WorldEngine.ts`): add `narration?: string`, threaded so a screen can show it and the story-thread can render it per beat.
- `ActionOption` is unchanged: it already carries `stat`, which is all the icon render needs.
- `CombatBeatLog` (`src/engine/action/combat-dc.ts`): add `emptyDecisionFallback?: boolean`, set on the beat where the combat backstop fires (telemetry).
- `LlmContext` (`src/llm/LlmGateway.ts`): add an optional structured summary of the just-resolved combat round (band plus player/enemy HP deltas), consumed only by the combat CONTINUE user message. It must not be the `rollOutcome` field, which would switch the phase to RESOLVE_ROLL; it is a distinct field so the phase stays CONTINUE.

The framing line (`prompt`) changes from `"<Type> — choose your approach:"` to a call-to-action, `"<Type> — what do you do?"`, which now sits under the narrated scene.

## Prompt templates (v12 set)

All edits go through the `prompt-versioning` skill. The set is amended in place within v12 (v12 is mid-cutover and has not shipped a release; v13 is reserved for the post-cutover roadmap). The `current_source/` mirror is the pre-change baseline to diff against.

- **`decide/BASE.md`** — rewrite Rule 4 (Scene Framing). Options are concrete actions the player takes, stated crisply; light sensory flavour in a label is fine, but the scene itself is no longer carried by the labels. Add the `narration` field to the JSON contract and the field reference, documented as CONTINUE-only scene-framing prose that never states a roll verdict or a mutation.
- **`phases/CONTINUE.md`** — rewrite. (1) Author `narration`: one to three sentences, game-master voice, describing the situation the player now faces as a consequence of the last choice, never a success/failure verdict. (2) Options are actions in response to that scene. (3) Scope the *"committed action to empty decision / prefer 2-3 beats"* guidance to non-combat only; empty decision remains the legitimate resolve-now signal for search/skill/travel/rest, and combat continues until the engine ends it.
- **`decide/combat.md`** — amend. On continue rounds, narrate the just-resolved round's exchange (from the round summary handed in) in `narration`, then offer the next round's action-options. Existing Rule 3 (non-empty while the fight lives) stands, now without the CONTINUE contradiction.
- **`phases/NEW_ACTION.md`** — reconcile with the lean first beat: it no longer instructs the model to carry a full opening scene in the labels; it opens with crisp action-options and authors no `narration`.

## Engine threading (`src/engine/action/PipelineActionStateMachine.ts`)

- `toActionDecision`: emit `prompt` as the CTA and pass `narration: result.narration` through. On NEW_ACTION `narration` is absent, so the first beat stays lean.
- Non-combat continue (`step` continue branch) and combat continue (`handleCombatStep` continue branch): thread `narration` into `nextDecision` and store it on the `ActionDecisionRecord` (records currently copy `prompt`; they must also copy `narration`).
- Combat continue: enrich the decide call's context with the just-resolved round summary (via the new `LlmContext` field) so the narration is faithful to the dice.

### Combat empty-decision backstop (issue 2, belt and braces)

Independent of the prompt fix, the engine must never present a flee-only screen mid-fight. In `handleCombatStep`'s continue branch, if the fresh decide yields zero real (non-bail) options, inject a deterministic `{ label: 'Press the attack', dcModifier: 0, stat: rollStat }` before appending flee, so the fight always continues. Single-option combat is already sanctioned (`validateSingleOption` skips combat by design). When the backstop fires: `console.warn` in the style of `validateSingleOption`, and set `emptyDecisionFallback: true` on the `CombatBeatLog` via `buildCombatBeat`, so residual prompt-compliance misses are measurable in combat telemetry.

## Display (`src/discord/commands/action.ts`)

- `buildDecisionMessage`: render `decision.narration` as a quoted block above the CTA and options when present; on the first beat (no narration) the screen is just the quest line, CTA, and options.
- Options: prefix each lettered option with its stat emoji from `STAT_LABELS` (`src/engine/stat-format.ts`, already maps all four stats). An option with a missing or unknown `stat` degrades gracefully to no icon.
- `buildStoryThread`: render each historic beat as its `narration` (the consequence) plus the chosen option, replacing today's repeated generic prompt. The first beat has no narration (quest line plus choice only). The collapsed/overflow degradation form still fits the embed cap.

## Testing

- Contract: `narration` parses on the decide result and threads through `ActionDecision` and `ActionDecisionRecord`.
- Non-combat CONTINUE threads narration onto the next screen and the record; NEW_ACTION stays narration-free.
- Combat CONTINUE: the round summary is present in the decide context; narration threads through.
- Combat backstop: an empty combat continue-decide injects "Press the attack", never a flee-only screen, and sets `emptyDecisionFallback` on the beat log.
- Display: narration renders quoted above the CTA (absent on beat 1); each option is prefixed with its stat emoji; a missing stat does not crash; `buildStoryThread` renders per-beat narration plus choice and the collapsed form still fits the cap.
- Regression: the existing pipeline and combat suites stay green.

## Docs and changelog

- Amend [[prompt-v12-pipeline]] and cross-note [[prompt-separation-of-concerns]] to record the amendment (DECIDE authors scene-framing narration on CONTINUE), with the rationale that scene-framing is not outcome-authoring and combat narration only dresses engine-resolved round truth. Note that per-round combat narration is now a faithfulness surface the parked prose critic ([[prompt-v12-pipeline]] D7) would later cover. Via the `docs-authoring` skill.
- Add a `CHANGELOG.md` `[Unreleased]` entry via the `changelog` skill.

## Out of scope

- The prose-critic trigger stays parked (unchanged).
- No free-text conversation or puzzle work (D3/D4).
- No world-scaling (Thread B).
- No first-beat opening narration (consequence beats only, by decision above).
