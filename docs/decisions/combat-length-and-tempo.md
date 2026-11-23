---
title: 'Combat Length & Tempo'
status: decided
domain: game
phase: poc
tags:
  - combat
  - decision
  - tempo
  - pacing
related:
  - "[[combat-framework]]"
  - "[[prompt-v12-combat]]"
  - "[[combat-system-v12]]"
  - "[[mvp-combat]]"
  - "[[resolve-difficulty-signal]]"
---
_Combat is short and capped by design. This reverses the shipped v12 tempo claim ("frequent in the wilds, long, and richly rewarded") while keeping every bounded-resolution rule that claim came with._

---

# Combat Length & Tempo

## Context

[[prompt-v12-combat]] shipped combat as a first-class mode on the premise that a survival game with a rising Threat wants combat to be **frequent in the wilds, long, and richly rewarded**. That premise produced the right engine and the wrong pacing: the contested roll, bounded bands, the once-per-day no-one-shot floor and the round cap all exist because of it, but "long" was never measured against how much of a player's day one fight may take.

Two facts then arrived together. Multi-round `required` combat costs one decide call per round, so a long fight is the most expensive shape in the system. And a daily Discord ritual cannot afford a fight that eats a session, because a player with three rolls has other things they meant to do. The engine cap (`MAX_COMBAT_ROUNDS = 4`, fifth round resolves) already pulled against "long" in practice, but the thread never resolved which reading wins: it asked for several rounds and a cap in the same breath, and only the cap was ever tested.

## Options

- **Keep it long**: several rounds, each a real exchange, fight as the headline mode.
  - [p] The most tactical surface, and the shape the band table was tuned against.
  - [c] Costs one LLM call per round; crowds out quests, conversation and travel in a three-roll day; makes a missed beat expensive for an async player.
- **Cut it to a single exchange**: one roll decides the fight.
  - [p] Cheapest and fastest.
  - [c] Stance, profile and role all collapse into one number; control and tanking lose their point; a single bad roll is the whole encounter.
- **Short and bounded, with a decision point after it**: the chosen direction.
  - [p] Keeps a real choice (stance and profile) inside a bounded cost, and gives adaptation to the player rather than to a script.
  - [p] Bounded per-encounter spend, which is what the daily ritual needs.
  - [c] Leaves less room for slow-building boss drama; bosses need Phase 2 and Resolve to carry what extra rounds used to.

## Choice

**Combat is short.** Ordinary fights resolve in 1–2 rounds after one opening plan; minibosses and bosses give at most four player decisions, one per round. Reward comes from winning, not from duration.

The 1–2 and 4 figures are **provisional** working values in [[combat-framework]], to be confirmed by the beat-log measurement of round counts rather than treated as settled tuning.

## What this does not change

Everything below stays in force exactly as shipped; this is a tempo decision, not a re-tune of resolution:

- The **d20 spine** and contested roll, with fresh dice rolled in code.
- **Bounded bands** and the **once-per-day no-one-shot floor**.
- **Geographic danger**, with safe places hosting non-lethal scuffles and combat never gated on location.
- The **round cap**, so one fight cannot eat a session.
- **Scale magnitude, not variance**: world tier moves enemy HP and damage numbers, never the distribution shape.
- **Engine-owned HP** and the `in_combat` edge; the LLM narrates and authors ancillary loot.
- The one **worded danger scale** shared by the combat card and RESOLVE ([[resolve-difficulty-signal]]).

## Consequences

- Phase A replaces the single global combat cap with per-class caps so the 1–2 round ordinary target is enforced rather than left as prompt guidance.
- Boss drama has to come from Phase structure, Resolve and announced beats rather than from extra rounds.
- Any A/B measurement of round counts must treat 1–2 and 4 as hypotheses under test, not as the answer the measurement is meant to produce.
