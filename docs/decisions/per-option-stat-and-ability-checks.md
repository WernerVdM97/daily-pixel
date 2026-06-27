---
title: 'Per-Option Stat & Ability-Check Rolls'
status: decided
domain: engine
phase: poc
tags:
- poc
- decision
- engine
- llm
- combat
related:
- '[[poc-action-ux-refinements]]'
- '[[mvp-llm-prompt-architecture]]'
---

# Per-Option Stat & Ability-Check Rolls

> Resolves a contradiction between the `/action` decision prompt (Rule 5 — "mix clever / direct / social options") and the roll engine (a single global `stat`, locked before the player chooses, that taps **only** item bonuses and never the character's own ability). Surfaced while diagnosing LLM reasoning digressions via `scripts/llm-thinking-analysis.mjs` — see [[SPEC-action-prompt-optimization]].

---

## Context

Two findings from the thinking-analysis pass collided:

- [!] **The prompt promises approach-diversity the engine can't honour.** Rule 5 tells the
  model to author "one clever (wisdom), one direct (physical), one social (charisma)"
  option. But the JSON contract has a single top-level `stat`, and that stat is locked at
  `start()` (`machine.ts` `rollStat`) and never updated. The player's *choice between
  approaches* shifts only the DC — the dice always test the stat the model picked before
  the player chose. The LLM noticed and burned tokens on it (call ID 58, verbatim):
  > "if I make a wisdom-based option, it would still roll against physical … the model doesn't support per-option stats."

- [!] **The roll has no ability check.** The resolution is `d20 + computeItemBonus(items, stat) ≥ dc`
  (`dc.ts:44`). The character's own ability score (`char.stats[stat]`) is **not in the
  formula**. A Warrior with `physical 3` rolls identically to one with `physical 0` holding
  the same gear. `stat` today is really an *item-category selector*, not an ability check —
  yet the model already *assumes* it's an ability check (call ID 86 reasoned "wisdom 2 + item +2").
  Prompt and engine disagree about what a roll even is.

These interact: per-option stat is cosmetic while `stat` only toggles item bonuses (most characters carry few items, so most options resolve identically). It becomes meaningful only once the ability score enters the roll — then "haggle" leans on your charisma and "inspect" on your wisdom, and your build genuinely shapes which approach is strong for you.

## Options considered

- [I] **A — keep single stat, forbid stat-mixing in prose.** One prompt sentence: all
  options test the one stat; vary fiction + `dc_modifier` only.
  - [p] Zero engine change; kills the digression immediately.
  - [c] Abandons Rule 5's whole premise — options become "same stat, different difficulty".
    Approach choice carries no mechanical identity. Narrows the game.
- [I] **B — per-option `stat`; engine derives the roll stat from the chosen option.**
  - [p] Approach choice becomes a real mechanical axis; Rule 5 becomes coherent.
  - [c] Touches the contract, validator, machine, and context hint.
- [I] **C — optional per-option `stat` override falling back to a global default.**
  - [p] Smaller migration than pure-B; LLM needn't repeat the stat when options share one.
  - [c] Two code paths; the model must decide *when* to override (a smaller spiral).
- [?] **Q2 — should the roll include `char.stats[stat]`?** Orthogonal to A/B/C but, per the
  analysis, the lever that makes any of them matter.

## Decision

**Adopt B, bundled with Q2.** Concretely:

- [x] **Ability-check roll.** The roll bonus becomes `char.stats[stat] + computeItemBonus(items, stat)`.
  `resolveRoll` / `computeItemBonus` are unchanged; a new `computeRollBonus(stats, items, stat)`
  composes them and is used at resolution. The displayed `rollBonus` now includes the ability
  score (the `OutcomeRenderer` footer already renders whatever `rollBonus` it's given).
- [x] **Per-option stat.** `decision[].stat` is added to the contract and `ActionOption`.
  The engine sets the action's roll stat from the **chosen** option at `step()` time; on a
  multi-step action the **last** chosen option's stat wins.
- [x] **Pragmatic fallback (a touch of C, for robustness).** The top-level `stat` stays
  **required** — it is the action's primary/default and the stat used by the auto-finish
  (`done:true`, no options) path, which never reaches a player choice. A per-option `stat`,
  when present, overrides it for that branch; when absent, the option inherits the
  top-level stat. This delivers B's gameplay while staying safe if the LLM omits a per-option
  stat. The B-vs-C line that mattered — *does per-option stat exist at all* — is answered yes.
- [x] **Context hint surfaces all four stats.** `buildContext`'s scaling hint lists item
  bonuses per stat (not just the action's one), so the model can balance options against the
  character's actual gear and ability scores (already shown in the `CHARACTER` line).
- [x] Shipped behind a new prompt version (`decision-v6`); `v5` retained for history per the
  `PROMPT_VERSION` protocol in `prompt-builder.ts`.

## Consequences

- [p] The four stats finally express a character build: approach selection taps the
  character's strongest attribute, so "which option" is a real decision, not just a DC dial.
  This is the design the prompt was already reaching for.
- [p] Removes a recurring multi-thousand-char LLM digression (the stat-vs-schema spiral),
  cutting completion tokens and latency on first-call decisions.
- [c] The roll gets easier on average — ability scores are mostly ≥ 0, so `base_dc` values
  authored for an item-only roll now clear more often. **DCs may need a small upward
  re-tune** once observed in play; tracked as an open item below, not blocking.
- [c] Adds a field to the response contract + validator and shifts where `rollStat` is
  determined (start → chosen option). Persisted `last_action_state` from `v5` still carries a
  valid `rollStat`, so in-flight actions survive the deploy.
- [?] Open: should `base_dc` guidance in the prompt rise (e.g. 10–20) to offset the added
  ability bonus? Default: leave `8–18`, watch the success-rate in the audit log, re-tune if
  skewed. Re-run `scripts/llm-thinking-analysis.mjs` + the cohort aggregate to confirm the
  digression is gone.
- [>] Implementation lands in `decision-v6.md`, `dc.ts`, `machine.ts`, `prompt-builder.ts`,
  `LlmGateway.ts`, `WorldEngine.ts`, `DeepseekLlmGateway.ts` — see [[SPEC-action-prompt-optimization]].
