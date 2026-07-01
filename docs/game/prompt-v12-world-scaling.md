---
title: "Prompt v12 — Thread B: The World Scales Around the Player"
status: decided
domain: game
phase: poc
tags:
  - scaling
  - engine
  - prompt
  - immersion
related:
  - "[[prompt-separation-of-concerns]]"
  - "[[prompt-v12-combat]]"
  - "[[prompt-v12-pipeline]]"
  - "[[prompt-v12-scene-state]]"
  - "[[roll-economy-timeouts-and-world-growth]]"
  - "[[per-player-map-exploration]]"
  - "[[mvp-core-loop]]"
  - "[[mvp-progression]]"
---
_Thread B of the v12 spark: the world sizes itself to whoever faces it (stronger player → tougher foes → bigger rewards, climbing week by week) — without ever buffing the player-side dice._

> **Part of the [[prompt-separation-of-concerns]] spark** (Thread B). Siblings: [[prompt-v12-combat]] (C) · [[prompt-v12-pipeline]] (D) · [[prompt-v12-scene-state]] (D1/D2/D6).

---

The roll math is **unchanged**: `d20 + stat + itemBonus ≥ DC` (`resolveRoll`, `dc.ts:72`), with **no player-side buff** — a player's power *is* their stats + gear (`effectiveStats`, `dc.ts:45`); we never inflate the dice. What changes is the **world**, sized by two inputs:

1. The player's **effective strength** (`effectiveStats`).
2. A **World Tier** `T` climbing over the year (weekly cadence exists — `weeklyThreatIndex`, `afternoon.ts:82`; game time is `day_number` meta).

- [I] **Stronger player → stronger foes.** A week-20 ranger meets tougher beasts, higher DCs, and deadlier brigands than a week-2 recruit in the *same* clearing — steepest in unsafe locations (`is_safe = 0`, including the off-map wilds from [[roll-economy-timeouts-and-world-growth]]).
- [I] **Daunting challenge → bigger reward.** Beating a tougher foe pays proportionally more (rarer loot, `modify_wealth`, `modify_max_stamina`, unlocks). Thread C ([[prompt-v12-combat]]) scales reward to the *encounter's own* difficulty; Thread B adds the **cross-session World Tier** on top (a week-20 kill worth more than an identical week-2 one).
- [I] **World Tier raises the floor for everyone.** As weeks pass even baseline encounters drift up — the east darkens regardless of who walks it. Player-scaling sits on top of that rising floor.
- [I] **Pull players toward the danger with rumours.** Scaling only matters if players *go* to unsafe, uncharted places. Surface global hints of treasure that nudge them there — on the map side a `reveal_location` "rumoured, uncharted" leaf ([[per-player-map-exploration]]); the world-growth side authors the rumour and ties it to a tier-scaled reward. A global beat on a cadence, not per-action spam.
- [p] **Engine math barely moves.** `resolveRoll` / `dc.ts` are untouched; what changes is how the target DC band and foe strength are *chosen* — computed from (player strength, tier) and handed to the LLM to author a matching scene. This is where Thread C's `combatState` gets its two tier-scaled numbers (`enemyMaxHp`, band→damage). Reuse the `scalingHint` plumbing + the new `## World State` block.

The tension to resolve:

- [!] **Don't build a treadmill.** If the world tracks the player exactly, win-rate is flat forever and every stat/gear investment is silently eaten (the *Oblivion* level-scaling problem). Growing strong must pay off.
- [I] **Resolution:** the world **lags** the player slightly — getting stronger still wins you *more* fights, just against worthier foes — and the **reward curve** is where investment cashes out.
- [?] How tight is the tracking (lag + reward coefficients)? This is the entire game-feel — **must** be tuned on the sim harness, not guessed.
- [?] How does `T` advance — real-calendar weeks, or gated on collective progress / Threat events? Calendar is simplest; event-gating couples to the climax model ([[mvp-progression]]).
- [?] Does foe-scaling read the *individual* player or the *party* (co-op, [[mvp-core-loop]])? Solo is simplest; party-scaling needs the foe sized carefully for mixed-strength scenes.
