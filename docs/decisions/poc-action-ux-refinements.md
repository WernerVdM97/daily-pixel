---
title: 'POC Action UX Refinements'
status: decided
domain: engine
phase: poc
tags:
- poc
- decision
- ui
- engine
related:
- '[[poc-build-probabilistic]]'
- '[[poc-build-polish]]'
- '[[poc-spec-reconciliation]]'
---

# POC Action UX Refinements

> Amends the decided action flow ([[poc-build-probabilistic]]) and outcome rendering ([[poc-build-polish]] §3) with refinements surfaced during live POC play. These do not supersede those docs — they extend three specific points. Pure bugs found in the same pass are tracked in [[poc-build-polish]] §7, not here.

---

## Context

Live play exposed three rough edges in the `/action` UX. None are new mechanics — each is a tightening of an already-`decided` behaviour:

- [!] Decision-option **button captions are full sentences** ("Decline — I'll use steel") and get truncated by Discord's button width on mobile — the must-pass platform.
- [!] The **bail/skip model only has one terminal state** (`skipped`). Three player intents collapse into it badly: bailing a *hunt* (costs stamina, a real retreat), *skipping* a dialogue (opt out, nothing happens), and *finishing* a travel/rest action that the LLM already resolved with no choices. The last case renders a red **"Step back"** button as the only option on an outcome that was positive — tone-mismatched.
- [I] Outcome footers and separators are **ad-hoc** across messages; longer messages are hard to scan and item/decision stats lack visual hierarchy.

## Decision

### 1. Option text in the body, buttons become A/B/C

- Render the full option label in the **message body** as a lettered list; buttons carry only `A` / `B` / `C` / `D` (+ the terminal button, below).
- Constrain option labels at **both** ends: prompt instructs the LLM to keep labels ≤ ~6 words, and the bot truncates defensively.
- Amends [[poc-build-probabilistic]] §3 (decision rendering); the `label` / `dc_modifier` response schema is unchanged.

### 2. Three terminal states: Bail · Skip · Finish

| State | When | Cost | Render |
|---|---|---|---|
| **Bail** | Player retreats from an in-progress, consequential action (hunt, fight) | −stamina (as today) | `↩ Bailed` (neutral yellow) |
| **Skip** | Player opts out of a low-stakes interaction (dialogue, optional encounter) | none | `↩ Skipped` (neutral) |
| **Finish** | LLM returns `done: true`, non-required, **no decision options** (travel/rest already resolved) | none | `✓ Done` (neutral, **auto-resolves** — no button, or a single neutral "Continue") |

- [!] **Auto-finish** is the key fix: when the LLM resolves an action with no choices, the bot finalises it directly instead of presenting a red "Step back". Removes the dead-end button and the tone mismatch.
- The green **success** banner is reserved for *rolled* successes only. Bail/Skip/Finish are all neutral. (The current green-on-bail behaviour is a bug — see [[poc-build-polish]] §7.)
- [?] Open: does "Finish" need its own outcome verb, or is reusing `✓ Done` enough? Default to `✓ Done` for POC.
- Amends [[poc-build-probabilistic]] §"Skip / Bail" and [[poc-build-polish]] §3 (adds the `Bailed` / `Done` render variants alongside `Skipped`).

### 3. Standardised outcome footer

- One footer format across every outcome, with a consistent leading status glyph:
  - `🎲 16 vs 14 ✓ Success` / `✗ Failure` for rolls; `↩ Bailed` / `↩ Skipped` / `✓ Done` for terminal states.
  - Stat line: `→ {location} ┃ ❤️ {hp} ┃ ⚡ {stamina} ┃ 🎲 {rolls}` — only show a field when it changed, except stamina/rolls which always show (per [[poc-build-polish]] §3).
  - Item deltas above the footer: `+ {emoji} {name}` / `− {name}`.
- A single horizontal separator between narrative and footer for scan-ability on long messages.
- Extends [[poc-build-polish]] §3; does not change which consequences are shown.

### 4. Daily premade actions — more generic, pick 3

- The day-job quick-action buttons are currently too specific/detailed, so repeats read oddly. Replace with a **pool of generic premade actions**; surface **3 at random** per `/hi`, biased toward ones the player hasn't recently done.
- [I] Keep them verb-first and world-generic ("Hunt the treeline", "Trade at the square", "Scout the road") so they compose with any location/day.
- Amends the day-job quick-action behaviour from [[poc-build-probabilistic]] / [[poc-build-scaffold]].

> *Folded in here rather than as a standalone `phase: poc` spark, to preserve the "no open POC sparks — all promoted to domain folders" invariant in `docs/README.md`. Split it out if it grows past a paragraph.*

## Consequences

- [p] Mobile captions stop truncating; the terminal-state tone matches the outcome; footers scan cleanly — directly serves the POC must-pass ("works on mobile", "feels coherent").
- [c] Adds a third terminal state to the action state machine — small surface-area change in resolution + rendering, plus a prompt tweak for short labels.
- [>] Bugs that block these (green-on-bail, stamina over max, `␍` carriage returns, lost trade items) are fixed first in [[poc-build-polish]] §7.
