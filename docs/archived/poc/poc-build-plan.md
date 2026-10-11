---
title: POC Build Plan
status: superseded
domain: archived
phase: poc
tags:
  - poc
  - build-plan
  - engine
superseded_by: "[[poc-build-poa]]"
related:
  - "[[poc-build-poa]]"
  - "[[poc-tech-stack]]"
  - "[[poc-spec-reconciliation]]"
---

# POC Build Plan

> **Superseded by [[poc-build-poa]].** The build root + ordered session plan now lives there; the slices are self-standing docs ([[poc-build-scaffold]] → [[poc-build-deploy]]); the success criteria moved to [[poc-build-deploy]] §6. Kept below for history.

---

## Sections

| Doc                         | Covers                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [[poc-build-scaffold]]      | Project init, bot registration, DB setup, deterministic commands (`/hi`, `/look`, `/journal`, `/help`, `/backpack`, `/stats`, `/feedback`, `/bug`) |
| [[poc-build-probabilistic]] | Probabilistic action flow: `/action <description>`, LLM decisions, DC adjustment, roll/skip, outcomes, persistence              |
| [[poc-build-scenes]]        | ASCII fragment library, scene composition, mobile testing                                                                      |
| [[poc-build-polish]]        | Error handling, LLM fallback, flavor text, help text, pre-deploy final pass                                                       |
| [[poc-build-world-tick]]              | `/sleep` daily tick: day advance, roll reset, stamina recovery. Extracted from polish.                                              |
| [[poc-build-deploy]]        | LXC provisioning, deploy, invite testers, observe                                                                              |

---

## Success Criteria

| Criterion | Threshold |
|---|---|
| At least 4/8 testers complete an action | Pass |
| At least 2/8 return the next day without prompting | Pass |
| At least one tester asks a question about the world | Bonus |
| Zero testers say "I don't get it" | Bonus |
| Full action flow works on mobile Discord | Must-pass |
| LLM decision generation feels coherent, not random | Must-pass |

If we hit the first two → green light for MVP.
