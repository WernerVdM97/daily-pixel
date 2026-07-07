---
title: "Decide-stage scene narration, action-options & stat icons (v12 follow-up)"
status: decided
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
_Restore the LLM's scene-setting to the v12 action screen: the game master narrates the consequence of each choice, options become concrete actions with visible stat icons and risk hints, combat rounds offer real trade-offs with visible progress, and combat continue-rounds can no longer dead-end into a flee-only screen._

> Follow-up to the v12 pipeline cutover ([[prompt-separation-of-concerns]]). This amends one v12 decision (DECIDE authors no prose) and hardens the combat continue-path.

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
- **Combat options are real trade-offs.** Each combat round's options span at least two different stats and at least one carries a non-zero `dcModifier`, so there is a safe play and a risky play: the stat icons mark a genuine decision, not decoration.
- **Risk and progress are visible.** Live options show a difficulty hint next to the stat icon, and combat continue-screens show a compact engine-composed status line (enemy condition plus HP movement) under the narration. In async play there is no rapid retry loop to learn difficulty by feel, so blind risk reads as frustration rather than tension, and without a mechanical readout each round is prose with no sense of progress toward winning. The enemy side of the status line is banded only (pips plus a wound word, from the engine's existing severity bands), never an exact HP number: hidden exact HP keeps tension. The player's own HP movement shows exactly; it is the player's own information.

## Data contract

- `PipelineDecideResult` (`src/llm/pipeline/types.ts`): add `narration?: string`. Present on CONTINUE beats, absent on NEW_ACTION and on empty-decision (resolve-now) results. The decide payload is parsed manually, not by schema: the `parse` callback in `ProdPipelineGateway.decide()` hand-builds the result object and conditionally attaches `sceneLocation`/`combatEnemy`, so `narration` needs the same conditional copy there or the field is silently dropped.
- `ActionDecision` and `ActionDecisionRecord` (`src/engine/WorldEngine.ts`): add `narration?: string`, threaded so a screen can show it and the story-thread can render it per beat. `ActionDecision` also gains `combatStatus?: string`, the engine-composed status line for combat continue-screens (screen-only; records do not carry it).
- `ActionOption` is unchanged: it already carries `stat` and `dcModifier`, which is all the icon and difficulty-hint render needs.
- `CombatBeatLog` (`src/engine/action/combat-dc.ts`): add `emptyDecisionFallback?: boolean`, set on the beat where the combat backstop fires (telemetry).
- `LlmContext` (`src/llm/LlmGateway.ts`): add `combatRoundSummary?`, an optional structured summary of the just-resolved combat round (band, player/enemy HP deltas, and the chosen option's label and stat, so narration can acknowledge the approach the player took), consumed only by the combat CONTINUE user message. It must not be the `rollOutcome` field, which would switch the phase to RESOLVE_ROLL; it is a distinct field so the phase stays CONTINUE.
- No DB migration: `decisions_json` and `last_action_state` persist these structures as JSON text, so the new optional fields (`narration`, `combatStatus`, `emptyDecisionFallback`) ride along transparently.

The framing line (`prompt`) changes from `"<Type> — choose your approach:"` to a call-to-action, `"<Type> — what do you do?"`, which now sits under the narrated scene.

## Prompt templates (v12 set)

All edits go through the `prompt-versioning` skill. The set is amended **in place within `v12/`**: v12 is pre-cutover and its only rows live in a dev DB that Stage 5 wipes at the flip, so nothing attributable-forever breaks, and `v13/` stays reserved for the post-cutover roadmap ([[prompt-v13-roadmap]]). After each edit, re-sync the `assets/prompts/decision-prompts/current_source/` directory mirror so it stays byte-identical to `v12/` (the set-based generalisation of the single-file `current_source.md` rule, now documented in the `prompt-versioning` skill). No `PROMPT_SET_VERSION` bump.

- **`decide/BASE.md`** — rewrite Rule 4 (Scene Framing). Options are concrete actions the player takes: verb-first, concrete, tactically differentiated from each other, roughly 6 to 12 words, with an example pair (bad: "Attack"; good: "Drive him back against the fallen oak"). Light sensory flavour in a label is the floor, not the ceiling; the failure mode on the far side of this rewrite is sterile `Attack / Defend / Flee` menus, and the scene itself is no longer carried by the labels either way. Add the `narration` field to the JSON contract and the field reference, documented as CONTINUE-only scene-framing prose that never states a roll verdict or a mutation. Also soften the intro's *"the decision frame ... and nothing else"* statement (line 3), which otherwise contradicts the new field.
- **`phases/CONTINUE.md`** — rewrite. (1) Author `narration`: one to three sentences, game-master voice, second person, present tense, describing the situation the player now faces as a consequence of the last choice, never a success/failure verdict; the final sentence lands on the immediate threat or the opponent's next move so the CTA has pressure behind it, and its drama scales with the round's band where one is in context (a crushing success reads differently from a scrape). Distinguish it explicitly from `outcome_text`: narration frames the beat before anything is settled, resolve prose settles it. (2) Options are actions in response to that scene. (3) Scope the *"committed action to empty decision / prefer 2-3 beats"* guidance to non-combat only; empty decision remains the legitimate resolve-now signal for search/skill/travel/rest, and combat continues until the engine ends it.
- **`decide/combat.md`** — amend. On continue rounds, narrate the just-resolved round's exchange (from the round summary handed in) in `narration`, acknowledging the approach the player chose, then offer the next round's action-options. Each round's options span at least two different stats and at least one carries a non-zero `dcModifier`, so every round has a safe play and a risky play. Existing Rule 3 (non-empty while the fight lives) stands, now without the CONTINUE contradiction.
- **`phases/NEW_ACTION.md`** — reconcile with the lean first beat: its *"frame the opening scene"* instruction (which BASE Rule 4 currently routes into the labels) is cut back; it opens with crisp action-options and authors no `narration`.

## Engine threading (`src/engine/action/PipelineActionStateMachine.ts`)

- `toActionDecision`: emit `prompt` as the CTA and pass `narration: result.narration` through. On NEW_ACTION `narration` is absent, so the first beat stays lean.
- `narration` threads into `nextDecision` in both continue paths, but the `ActionDecisionRecord`s are built earlier, in `step()` itself: the bail record and the normal record both copy `state.pendingDecision.prompt` before combat dispatch, and those two sites must also copy `narration` (the bail record included, so bailed beats keep their scene in the story thread). `handleCombatStep` never builds a record.
- Combat continue: enrich the decide call's context with the just-resolved round summary (via the new `combatRoundSummary` field, including the chosen option) so the narration is faithful to the dice, and compose `combatStatus` from the same engine truth onto `nextDecision` (banded enemy condition plus exact player HP movement, e.g. `Wolf: ▓▓▓░░ Bloodied · You: −2 HP`; never exact enemy HP, by decision above).
- Mechanical-diversity check: when a combat continue-decide returns options that all roll the same stat with identical `dcModifier`s, `console.warn` in the `validateSingleOption` style (telemetry-only, no retry). Icons over a non-choice is this spec's quiet failure mode, so make it measurable.
- Housekeeping: update the D5b comment in `src/llm/pipeline/pipeline-messages.ts` (*"DECIDE never authors prose"*) to record the amendment, and reconcile `reconstructDecisionPrompt`'s synthesised framing line with the new CTA wording.

### Combat empty-decision backstop (issue 2, belt and braces)

Independent of the prompt fix, the engine must never present a flee-only screen mid-fight. In `handleCombatStep`'s continue branch, if the fresh decide yields zero real (non-bail) options, inject two deterministic options before the flee append: `{ label: 'Press the attack', dcModifier: 0, stat: state.rollStat }` and `{ label: 'Fight defensively', dcModifier: -1, stat: state.rollStat }`. A single fallback option would be a screen with no decision, the same failure mode in miniature, so even the degraded path contains a real choice; note the stat lives on `state.rollStat`, there is no local `rollStat` in that scope. When the backstop fires: `console.warn` in the style of `validateSingleOption` (which skips combat by design, so single-option combat is otherwise sanctioned), and set `emptyDecisionFallback: true` on the `CombatBeatLog` via `buildCombatBeat`'s opts bag (the `floorSave` spread pattern), so residual prompt-compliance misses are measurable in combat telemetry.

## Display (`src/discord/commands/action.ts`)

- `buildDecisionMessage`: render `decision.narration` as a quoted block above the CTA and options when present, with `decision.combatStatus` as a single plain line between narration and CTA on combat screens; on the first beat (no narration) the screen is just the quest line, CTA, and options.
- Options: prefix each lettered option with its stat emoji from `STAT_LABELS` (`src/engine/stat-format.ts`, already maps all four stats; `OutcomeRenderer` already uses the lookup-with-fallback pattern) and suffix it with a difficulty hint derived from the option's `dcModifier` (the existing `dcArrow` glyphs, today shown only in the story thread after the fact): `**A.** 💪 Shoulder-charge the brute ↑`. The 🟢 favoured marker stays. An option with a missing or unknown `stat` degrades gracefully to no icon; the emoji and arrow are render-only and never persisted into `chosen` or pending labels.
- `buildStoryThread`: render each historic beat as its `narration` (the consequence) plus the chosen option, replacing today's repeated generic prompt. The first beat has no narration (quest line plus choice only). The collapsed/overflow degradation form still fits the embed cap. `buildOutcomeEmbed` (the private compact reply and the public recap broadcast) consumes `buildStoryThread` too, so the recap surface picks this up transitively; its extra degradation step (drop the decorative scene) is unaffected.
- Prompt-only surfaces: the unfinished-action panel (`src/discord/commands/hi.ts`), the stale-action embed, and the divine-intervention embed (`action.ts`) all render `decision.prompt` alone today; once the prompt is the bare CTA they must render `narration` above it when present, or they show a contentless "what do you do?". The embed footer's separate hardcoded `'Choose your approach'` label (`action.ts`) updates to match the new CTA.

## Execution order

1. **Contract** — types (`PipelineDecideResult`, `ActionDecision`/`ActionDecisionRecord`, `ActionOption` untouched, `CombatBeatLog`, `LlmContext.combatRoundSummary`) plus the `ProdPipelineGateway.decide()` parse copy.
2. **Engine** — `toActionDecision` CTA + pass-through, the two `step()` record sites, combat-continue enrichment + `combatStatus`, the two-option backstop, the mechanical-diversity warn, housekeeping comments.
3. **Prompts** — the four v12 template edits via the `prompt-versioning` skill, re-syncing `current_source/` after each.
4. **Display** — `buildDecisionMessage`, option emoji/hint, `buildStoryThread`, the three prompt-only surfaces, the footer.
5. **Tests, docs, changelog** — including the two conscious test amendments.

Steps 2 and 3 are independent of each other and can run in parallel after step 1; step 4 needs step 2's types threaded.

## Testing

- Contract: `narration` parses on the decide result (including the manual `ProdPipelineGateway.decide()` parse copy, without which the field is dropped) and threads through `ActionDecision` and `ActionDecisionRecord`.
- Non-combat CONTINUE threads narration onto the next screen and the record (both `step()` record sites, bail included); NEW_ACTION stays narration-free.
- Combat CONTINUE: the round summary (band, HP deltas, chosen option) is present in the decide context; narration and `combatStatus` thread through.
- Combat backstop: an empty combat continue-decide injects "Press the attack" and "Fight defensively", never a flee-only screen, and sets `emptyDecisionFallback` on the beat log.
- Mechanical diversity: a combat decide whose options all share one stat and one `dcModifier` triggers the diversity warn.
- Display: narration renders quoted above the CTA (absent on beat 1); `combatStatus` renders on combat continue-screens only; each option carries its stat emoji and difficulty hint; a missing stat does not crash; the raw label (no emoji/arrow) is what echoes on click and persists as `chosen`; `buildStoryThread` renders per-beat narration plus choice and the collapsed form still fits the cap.
- Regression: the existing pipeline and combat suites stay green, with conscious amendments rather than silent breakage: the exact option-string assertions in `tests/discord/action-decision.test.ts` gain the new stat-emoji prefix and dcArrow suffix.
- Acceptance (end-to-end): a multi-round fight, via a sim combat scenario or dev Discord, reproducing the dev-DB actions 34/35 pattern (a decide that returns `"decision": []` mid-fight). Every round narrates the previous exchange with the status line, offers at least two mechanically distinct options plus flee, and a flee-only screen never appears; the original dead-end is demonstrably gone, not just unit-covered.

## Docs and changelog

- [x] Amend [[prompt-v12-pipeline]] and cross-note [[prompt-separation-of-concerns]] to record the amendment (DECIDE authors scene-framing narration on CONTINUE), with the rationale that scene-framing is not outcome-authoring and combat narration only dresses engine-resolved round truth. Note that per-round combat narration is now a faithfulness surface the parked prose critic ([[prompt-v12-pipeline]] D7) would later cover.
- [x] Add a `CHANGELOG.md` `[Unreleased]` entry.

## Out of scope

- The prose-critic trigger stays parked (unchanged).
- No free-text conversation or puzzle work (D3/D4).
- No world-scaling (Thread B).
- No first-beat opening narration (consequence beats only, by decision above).
- The legacy `machine.ts` path is untouched, deliberately: it has its own `toActionDecision` with the old framing line and its own record construction, and gets neither narration nor the backstop. This spec touches the pipeline state machine only; the legacy path lives only until the Stage 5 flip.
- Flee costs (flee is currently a free exit, which caps combat tension), round-over-round escalation tuning, and fun telemetry beyond `emptyDecisionFallback` (rounds-per-fight, flee-rate) are follow-ups, not this spec.

## Execution state (orchestrated delegation)

Branch `feat/scene-state-prod-host`. Reconcile this section against `git log` before resuming: verify the commits below exist and `npm run typecheck && npm test` is green (baseline was 1224 passing at last checkpoint) before building on top.

**Landed (committed, verified by lead):**
- `cbffe6a` — spec finalised (this doc, status decided) + README registration.
- `c804706` — Batch 3 prompts: the four v12 decide-set edits + byte-identical `current_source/` mirror. Lead-reviewed for spec conformance (prose, no code review subagent).
- `de4a9f1` — Batch 1 contract + engine threading + 7 unit tests. Independently verified (typecheck + tests + read of `handleCombatStep`/`toActionDecision`/`ensureBail`). Adversarially reviewed; findings resolved by `c3236e7`.
- `a92c0df` — Batch 4 display: `buildDecisionMessage`/`buildStoryThread`/option icons + hint, the three prompt-only surfaces, footer, +6 tests / 2 conscious amendments. Lead-verified + adversarially reviewed (no findings).

**Resolved — findings fixed, verified (typecheck + 1226 tests), committed:**
- `c3236e7` — fix(engine): harden combat backstop order + wire combatRoundSummary into prompt. (1) Moved the flee-label dedup to a standalone filter step before the emptiness check, with a test for a wayward same-label-real-option input. (2) Wired `combatRoundSummary` (band, HP deltas, chosen option) into `buildUserMessage` so DECIDE narrates the resolved round faithfully; `ProdPipelineGateway.decide()` already calls `buildUserMessage`, so both v9 and v12 paths are covered. +2 tests (the rendered message string, not just the context object).

**Remaining work:**
- Acceptance (end-to-end): a multi-round fight via a sim combat scenario or dev Discord reproducing the dev-DB 34/35 `"decision": []` mid-fight pattern — every round narrates the prior exchange with the status line, offers ≥2 mechanically distinct options plus flee, and a flee-only screen never appears. **Unit-level acceptance done (`c2e7ccd`): two consecutive empty continue-decides fire the backstop each round with all spec criteria verified.** Multi-round HP persistence (HP accumulation across rounds) is an integration concern needing a DB-backed resolver or sim scenario; left to a future session.
