---
title: LLM Prompt & Resolution Architecture
status: spark
domain: spark
tags:
- llm
- prompt
- engine
related:
- '[[poc-build-probabilistic]]'
- '[[poc-action-ux-refinements]]'
- '[[mvp-core-loop]]'
phase: mvp
---

# LLM Prompt & Resolution Architecture

> *POC proved the ritual with one big JSON call per decision. MVP rethinks how the dice and the LLM share authority. Raw — needs a lot of refinement.*

The POC pattern: one LLM call per decision, JSON in/out, the LLM picks the stat, DC, options, mutations, and narration all at once. It works, but the LLM is doing the DM's *and* the dice's job in a single breath. This spark collects the directions for splitting those responsibilities.

> **Update (POC):** the "roll before flavour" shift below shipped early in the POC — the engine rolls, then makes a second narration call with the verdict (`machine.resolveWithRoll`, prompt `decision-v4.md` §4b). See [[poc-action-ux-refinements]]. The deeper items here (layered rolls, multi-agent, markdown prompts, sim harness) remain MVP.

## The core shift — roll before flavour

- [I] **Bot rolls as DM first; LLM narrates the result it's handed.** Decide the outcome (success/failure, severity) with dice *before* asking the LLM for prose, then pass the verdict + a target sentiment into the prompt. The narration stops contradicting the mechanics (today the flavour and the footer can disagree).
- [I] **Layered rolls within one action.** Player intent → LLM offers choices → player picks + rolls → *bot* rolls a secondary table → LLM generates the specific result.
  - e.g. player hunts → choices → success → bot rolls item rarity → LLM generates the item.
  - e.g. player trains → choices → failure → bot rolls severity → LLM narrates the cost.
- [!] This needs a lot of refinement — or it may just be sharper system prompts. Resolve before building.

## Prompt format & cost

- [I] Send the prompt to the LLM as **markdown**, not JSON (friendlier to the model); responses stay JSON.
- [?] **Thinking on vs off** — A/B test. POC left thinking enabled; measure whether it changes coherence enough to justify the latency/tokens (the `llm_calls` table now records `reasoning_chars`, latency, and tokens to compare).
- [I] Trim the request to what's actually used — see the wasted-token audit in [[poc-build-polish]] §7.

## Structure & tooling

- [I] **Multiple short agent calls / a chain** instead of one big chat per action — distinct steps (distil intent → offer choices → resolve → narrate) may each be cheaper and more reliable than one mega-prompt.
- [I] **Prompt simulation harness** — run scripted player inputs through the prompt to find where the LLM digresses, before testers do.
- [p] **Captured calls as test fixtures** — the `llm_calls` rows (real prompts + responses, incl. failures) become mocks for dev and unit tests; no live API needed to reproduce a bad outcome.

## Open questions

- [?] How much authority does the LLM keep over DC/stat once the bot rolls first?
- [?] Does chaining agents help coherence enough to justify the orchestration cost?
- [?] Markdown prompt — measurable quality gain, or just nicer to read?
