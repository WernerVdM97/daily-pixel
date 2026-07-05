---
title: "Prompt v12 — Thread C: Combat as a First-Class Mode"
status: decided
domain: game
phase: poc
tags:
  - combat
  - engine
  - immersion
  - prompt
related:
  - "[[prompt-separation-of-concerns]]"
  - "[[prompt-v12-world-scaling]]"
  - "[[prompt-v12-pipeline]]"
  - "[[prompt-v12-scene-state]]"
  - "[[mvp-combat]]"
  - "[[per-option-stat-and-ability-checks]]"
  - "[[roll-economy-timeouts-and-world-growth]]"
---
_Thread C of the v12 spark: make combat a frequent, long, richly-rewarded wilds mode backed by an engine-owned combat spine (contested rolls, severity bands, no-one-shot floor)._

> **Part of the [[prompt-separation-of-concerns]] spark** (Thread C). Siblings: [[prompt-v12-world-scaling]] (B) · [[prompt-v12-pipeline]] (D) · [[prompt-v12-scene-state]] (D1/D2/D6).

---

Combat today is a generic `/action` roll the prompt pushes to *end fast* (`decision-v11.md:44` — "prefer resolving in two or three beats"). For a survival game with a rising Threat that's backwards — combat should be **frequent in the wilds, long, and richly rewarded** (see [[mvp-combat]] for the locked constraint: roll-resolution, never twitch).

**Why v12, not v9:** the rich version — bounded severity bands, a no-one-shot floor, "a boar near death *stays* near death" — can't be done with prompt rules alone. The engine has no enemy: `InternalActionState` (`machine.ts:32`) tracks only `accumulatedDc` + `decisions`, and `modify_health` only hits the *player*. Real combat needs engine scene-state — itself a slice of Thread D1 ([[prompt-v12-scene-state]]) — so it lives here, not in the LLM-only v9.

## C-a. Prompt-level rules (the combat template)

- [!] **Combat frequency *and* lethality scale with location danger.** Replace the current fixed danger cadence ("roughly every 3rd or 4th decision encounter should raise real danger", `decision-v11.md:54`) with danger keyed to *where the player is*: in an `is_safe = 0` location an encounter is the *expectation*; in safe places (Oak, town) it's rare and, when it happens (a tavern scuffle), **non-lethal**. You can throw a punch anywhere — only dangerous places host *lethal* fights, so combat is never *blocked* by location (there's no safety precondition gate). Danger is geographic, so *where you go* is a real choice — and **location safety is dynamic scene-state that can evolve** (a safe road can turn perilous), see [[prompt-v12-scene-state]].
- [I] **Physical, item-anchored decisions.** Each round offers approaches tied to gear and stats — *how* you fight is a build choice ([[per-option-stat-and-ability-checks]]).
- [I] **Bigger reward for the harder fight.** Reward scales with the encounter's difficulty (DC band / enemy HP, and via Thread B the World Tier) — more loot, `modify_wealth`, `modify_max_stamina`, narrative unlocks.
- [I] **Combat overrides "resolve in 2–3 beats."** Several rounds, each a real exchange. `required: true` throughout — no clean Skip, only Bail (flee, at a cost) per the existing terminal-state model.

## C-b. Engine changes (the combat spine)

_Shipped in [[stage-3-combat-spine-plan]] (sim-proven, 2026-07-05)._

- [x] **Lift the decision cap for combat.** `machine.ts:241` caps an action at the 2nd choice (`isLastDecision = decisions.length >= 1`). Gate a higher cap on the combat sub-mode so non-combat actions keep the tight cap. **Cap: 4 rounds after the initiating decision (≤6 total when another action leads in); at the cap, derive the winner from remaining HP/stamina.** Hard-capped so one fight can't eat a session.
- [x] **A `combatState` scene object** across rounds — `enemyName`, `enemyHp`, `enemyMaxHp`, `round`. The engine owns `enemyHp`; the LLM only *narrates* it. Modelled as graph-shaped persistent state (D1/D2, [[prompt-v12-scene-state]]) so a fled enemy is remembered and co-op is just multiple edges.
- [x] **Contested roll + severity bands** (extend `dc.ts`). Each round the player rolls `d20 + stat + item` (unchanged, `dc.ts:72`) **and the enemy rolls an engine-side d20**. The margin maps to a band — `clean hit · trade · glanced · heavy` — each mapping to a bounded, tier-scaled HP delta on `enemyHp` (and player health on bad bands). Crits/nat-1s still swing the round; the *consequence* stays bounded. The enemy d20 is engine-side, so "contested" adds no LLM randomness.
- [!] **No one-shot floor.** A blow that would drop the player to ≤0 HP instead leaves them at **1 HP + a forced desperate choice** (bail bloodied, losing position/loot — or last stand, now genuinely lethal). **Once per day** (`savedToday` — shipped as a `pc → combat_save{savedDay} → pc` self-edge in scene-state, per [[stage-3-combat-spine-plan]] decisions) — bad luck can corner a player, not kill them from full HP.
- [I] **Sub-mode signalling:** the `combat` `ActionType` (the Stage-1 classification, which supersedes today's `distilled_type` per [[action-engine-framework]]) + `required: true` + presence of `combatState` (lighter than a dedicated flag).
- [p] **Fits the existing roll-first split.** The engine already rolls *then* narrates (`resolveWithRoll`, `machine.ts:300`). Combat rolls two dice + picks the band first, then narration dresses that band (the boar *reels* / *gores you*).
- [p] **Scale magnitude, not variance.** The distribution shape (bounded bands, no one-shot, the floor) is a global constant; Thread B's World Tier only reaches `enemyMaxHp` and the band→damage numbers.

- [x] **Log per-round combat beats for the prose-critic trigger decision.** Each round records `round` index, `material_mutation_fired` + ops, `enemyHp` before/after, and a **combat-round beat marker** (distinct from generic `CONTINUE`), alongside the already-logged `reasoning_chars` + validator warnings. This is the data that later settles the prose-critic trigger ([[prompt-v12-pipeline]] §D7, currently parked). Depends on this `combatState` + the D6 attributability fix ([[prompt-v12-scene-state]]). Shipped as `CombatBeatLog` in [[stage-3-combat-spine-plan]] T5 ([[T5-combat-telemetry-spec]]).

## Open question (Thread C)

- [c] Multi-round `required` combat spends more LLM calls per encounter (each round is a call), stacking with the v9 critic and D's stages. Bounded by the round cap — but **measure the tail** (latency, see [[prompt-v12-pipeline]] §D5).
