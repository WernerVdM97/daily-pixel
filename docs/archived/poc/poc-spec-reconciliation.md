---
title: 'POC Spec Reconciliation'
status: shipped
domain: archived
superseded_by: "implemented in code"
phase: poc
tags:
- poc
- decision
- engine
related:
- '[[poc-tech-stack]]'
- '[[poc-build-poa]]'
- '[[poc-build-probabilistic]]'
- '[[poc-build-polish]]'
- '[[poc-build-world-tick]]'
- '[[poc-build-scenes]]'
- '[[poc-build-scaffold]]'
- '[[poc-build-deploy]]'
---

# POC Spec Reconciliation

> *Resolves the contradictions found in a coherency review across [[poc-tech-stack]] and the [[poc-build-poa]] children. One record so the conflicts become a single decision, not rival docs that drift.*

---

## Context

A review of the POC specs surfaced direct contradictions — several between the `decided` [[poc-tech-stack]] and the `exploring` build docs, which per [[CONVENTIONS]] §5 must be resolved in a record like this rather than by silently editing the decided doc.

---

## Decisions

### D1 — Outcome narration: LLM sentence with template fallback

- [!] [[poc-build-probabilistic]] §4 said *"the LLM does not write outcomes — templates do"*; [[poc-build-polish]] §3 said the final LLM call returns an `outcome_text` sentence. Direct conflict.
- [x] **Chosen:** the final (`done: true`) LLM call returns `outcome_text` (one sentence). If that call fails, malforms, or times out, fall back to a template variant (3-5 per `distilled_type`) **and log the fallback**.
- [p] Same call that already returns `mutations` — richer narration at no extra LLM round-trip.
- [p] Template fallback keeps outcomes robust when the LLM is unavailable.
- [c] Two code paths to maintain (LLM + templates), but the templates are needed for fallback anyway.

### D2 — Day advance: keep admin `/sleep` + nightly cron

- [!] [[poc-tech-stack]] listed *"Cron / tick scheduler"* as a POC no-go (*"Manual `/sleep` triggers the tick. No automated daily pass"*); [[poc-build-world-tick]] implements a 3:30 UTC cron.
- [x] **Chosen:** keep both — admin `/sleep` for testing **and** the nightly cron. This **supersedes** the cron no-go row in [[poc-tech-stack]].
- [!] `/sleep` is available to everyone, but **only the admin triggers the world tick**. A non-admin `/sleep` returns a valid in-world rest response — making camp by the Oak — and changes nothing (no day advance, no roll reset, no stamina). Player-facing copy frames the day as turning at nightfall, never as a tick the player controls.
- [p] Night-owl-friendly: the world turns once a day without an admin awake; admin `/sleep` still advances on demand for testing; players get a sensible response instead of a permission error.

### D3 — ASCII scenes: 21 file-loaded fragments, not 4 hardcoded strings

- [!] [[poc-tech-stack]] described ASCII as *"Hardcoded string constants — 4 fragments — zero dependencies"*; [[poc-build-scenes]] defines 21 `.ascii` files with YAML frontmatter and a tag-matching resolver, and [[poc-build-scaffold]] adds `js-yaml`.
- [x] **Chosen:** [[poc-build-scenes]] is authoritative — 21 fragments loaded from `assets/scenes/*.ascii`, frontmatter parsed with `js-yaml`, deterministic tag matching. The [[poc-tech-stack]] ASCII row is updated to match.

### D4 — `dc_modifier` is literal and signed

- [!] [[poc-build-probabilistic]] §3 formula is `running_dc += dc_modifier`, but every worked example showed a `+2` *lowering* the DC.
- [x] **Chosen:** the formula is correct and stays. `dc_modifier` is applied literally and signed: **negative = a good decision that lowers difficulty (easier); positive = raises it (harder)**. The worked examples are corrected to match (helpful choices carry negative modifiers).

### D5 — Supporting fixes (no fork, just corrections)

- [x] **NPC movement keys on `class`**, not `day_job` — spawned NPCs only carry `name`/`class`/`description`, so [[poc-build-world-tick]] §3 reads the populated field.
- [x] **`meta` table added** to [[poc-build-scaffold]] (now nine tables) to hold `day_number` and `last_cron_date`, required by the tick and NPC-movement seed.
- [x] **Fallback-rate metric fixed** in [[poc-build-deploy]] — tracked via a `meta` counter (tier-2 inserts no `actions` row), separated from the timeout rate.
- [x] **`day-jobs.yml` gains an `actions` field** (3 entries) so `/hi`'s job-specific buttons have a source.
- [x] **Scene width hard cap set to 30** in [[poc-build-scenes]] to match the mobile no-scroll must-pass.
- [x] **`base_dc` 8-18** is the absolute bound; the daily scaling ranges (8-16, 9-17) nest inside it.
</content>
</invoke>
