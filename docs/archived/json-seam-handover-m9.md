---
title: JSON Seam — M9 Handover Briefing (lead prompt)
status: shipped
superseded_by: "implemented in code"
domain: engine
phase: mvp
tags: [architecture, layering, engine, controller, json, seam, protocol, discord, adapter, handover, orchestrated-delegation]
related:
  - "[[json-seam-protocol]]"
  - "[[json-seam-handover-m7-m8]]"
  - "[[layer-boundaries-and-json-seam]]"
---
Handover prompt for the implementing lead taking the JSON seam arc through **M9 (the Discord adapter rebuilt onto the protocol)**. Paste in full to a fresh lead agent. Carries only what the plan and the git log do not: the delegate cast, the three run-specific rules, and the one decision reserved for the owner.

---

## Role

Implementing lead for **M9**, on branch `feat/json-seam-protocol`, running the **`orchestrated-delegation` skill**. You own analysis, spec, triage, verification and commits. `delegate-executor` builds, `delegate-reviewer` critiques in fresh read-only context, `delegate-fixer` applies what you accept, `delegate-coordinator` steers at slice boundaries, `delegate-judge` gates M9.3. The build plan is settled; you execute it, you do not rewrite it.

## Read first, fully, in this order

1. `docs/engine/json-seam-protocol.md` **§ M9 build plan** (recon, DC-M9.1 to DC-M9.10, slices M9.0 to M9.4) and § Execution state. This is the contract.
2. `docs/engine/json-seam-handover-m7-m8.md`. The law, the gates and the execution rules it states are still binding; they are not restated here.
3. `docs/decisions/wizard-session-ownership.md`, because DC-M9.9 moves the module it governs.

## State

Branch `feat/json-seam-protocol` at `8a9bf7a`, clean. **99 files / 2019 tests green, typecheck clean.** Reconcile before building: verify the docs against the repo and fix drift first. If the suite starts red, check the day of the week before debugging anything else (`1fc4502` is why).

## Run-specific rules

1. **Loop, not graph.** Every M9 slice touches `dispatchInteraction.ts`, the command files and the contract suite, so two streams would be one stream. No worktrees.
2. **Verify, do not trust the report.** Re-run the gates yourself and diff the snapshots yourself against DC-M9.10's declared churn classes. This gate is byte-identical: "tests pass" is not evidence that nothing churned. A snapshot change nobody predicted means the port drifted, so fix the port, never re-bless.
3. **`delegate-judge` is mandatory on M9.3** and only M9.3: 927 lines on the live interaction path behind a byte gate. M9.2 at your call. M9.0, M9.1 and M9.4 do not need one.

Otherwise the M7/M8 rules stand unchanged: atomic commit per slice, build and review-fix in separate commits, changelog per slice, never commit/push/checkout `dev` or `main`, record the coordinator's steer plus build hashes and test counts in the spec doc's execution state, and close the doc loop (slice checkbox, `TODO.md` RESUME HERE, any question the doc asked) before calling a slice done.

## The decision that is not yours

**DC-M9.7** moves the profanity guard behind the seam. The plan settles it as "move it", but it is a behaviour change on the slash path and **the owner signs it off before M9.3 lands**. Without sign-off, build M9.3 leaving the guard where it is and flag it. Do not block the slice, do not smuggle the change.

**Discharged — the owner approved DC-M9.7 on 2026-08-08.** M9.3 builds the move: `checkProfanity` runs inside the router's `action.custom` branch, so both text entry points are filtered by one rule in one place, and free text typed into `/action <description>` — unfiltered today — is rejected after M9. The scope fence still binds: the guard *moves*, its word list and its verdict do not change. Record the resulting behaviour change in M9.3's execution-state entry the way M7.1's rule move was recorded.

## Done

Zero runtime engine/controller imports on the Discord interaction path; the DC-M9.1 structural check green and proven non-vacuous; every action surface crossing the seam; the contract suite covering every addition; all four oracles byte-green with only the declared churn; the M8.5 replay gate green; typecheck + full suite green; changelog current; execution state recording all five slices; `TODO.md` reflecting M10 as next. Note anything that blocked, drifted or changed scope at the bottom of this doc, the way the M7/M8 briefing does. The owner reads it before writing the M10 handover.
