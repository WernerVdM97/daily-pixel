---
title: Combat — Core Mechanic
status: spark
domain: spark
tags:
- combat
- mechanics
- engine
related:
- '[[mvp-core-loop]]'
- '[[mvp-character-drivers]]'
- '[[hazard-map]]'
- '[[poc-build-probabilistic]]'
phase: mvp
---

# Combat — Core Mechanic

> *The POC has no combat. A survival game about a rising Threat needs one. Roll-resolution,
> never twitch — per [[hazard-map]] ("Real-time combat: Discord latency + mobile = terrible UX").*

The core loop already says players "scout, fight, talk" ([[mvp-core-loop]]), but there is
no fighting mechanic — encounters resolve as generic `/action` rolls. Combat should be a
first-class, recognisable mode, not a reskinned skill check.

## Constraints (locked by vision)

- [!] **Roll-resolution only.** No real-time, no twitch. Resolves through the same d20 + modifiers spine as actions.
- [p] Must work as one evolving Discord message on mobile — same channel as the action flow.
- [I] Reuse the existing decision/roll loop where possible; combat is a *flavour and stakes* layer over it, not a parallel engine.

## Open shape

- [?] **Turn structure** — single contested roll, or a short multi-round exchange (player roll vs enemy roll until one side breaks)?
- [?] **Stats & items** — which stat drives attack/defence; how do weapon items modify (the `add_item` stat/modifier model already exists)?
- [?] **Stakes** — combat is `required: true` (no skip); losing costs health, possibly capture/death. Ties to [[mvp-progression]] lifecycle.
- [?] **Enemies** — are foes NPC nodes (so they persist, flee, remember), or ephemeral encounter rolls? Leans on world-state.
- [I] **Severity table** — bot rolls hit severity *before* the LLM narrates the blow (see [[mvp-llm-prompt-architecture]] "roll before flavour").
- [?] **Flee / retreat** — maps onto the Bail terminal state from [[poc-action-ux-refinements]] (costs stamina/position), not a clean Skip.

## Why MVP, not POC

- [c] Death/health stakes need the progression + world-state model to mean anything; in the POC there's nothing to lose. Defer until the core ritual is validated.
