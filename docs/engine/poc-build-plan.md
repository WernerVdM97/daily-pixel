---
title: POC Build Plan
status: decided
domain: engine
phase: poc
tags:
- poc
- build-plan
related:
- '[[the-poc]]'
- '[[poc-tech-stack]]'
---

# POC Build Plan

> *Root doc. Each section links to its own build doc where subtasks are tracked.*

---

## Sections

| Doc                         | Covers                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [[poc-build-scaffold]]      | Project init, bot registration, DB setup, deterministic commands (`/hi`, `/look`, `/journal`, `/help`, `/backpack`, `/stats`, `/feedback`, `/bug`) |
| [[poc-build-probabilistic]] | Probabilistic action flow: `/action <type>`, LLM decisions, DC adjustment, roll/skip, outcomes, persistence                    |
| [[poc-build-scenes]]        | ASCII fragment library, scene composition, mobile testing                                                                      |
| [[poc-build-polish]]        | Error handling, LLM fallback, flavor text, help text, pre-deploy final pass                                                       |
| [[poc-world-tick]]              | `/sleep` daily tick: day advance, roll reset, stamina recovery. Extracted from polish.                                              |
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
