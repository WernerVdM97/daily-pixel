---
title: Combat Framework
status: decided
domain: game
phase: poc
tags:
  - combat
  - mechanics
  - stances
  - bosses
  - encounters
  - design
related:
  - "[[combat-system-v12]]"
  - "[[combat-length-and-tempo]]"
  - "[[mvp-combat]]"
  - "[[poc-plus-roadmap]]"
  - "[[threat-encounter-system]]"
  - "[[resolve-difficulty-signal]]"
  - "[[visual-craft]]"
  - "[[poc-discord-ux]]"
---
_The target shape of a fight: a quick, consequential daily decision rather than a tabletop action economy. Written to drive implementation tickets, not to restate the engine._

---

# Combat Framework

Owner decisions and locked constraints use `[!]`. Research and design inferences use `[I]`. Unresolved and verification questions use `[?]`. Provisional values are named inline and repeated as open questions, not treated as settled tuning. External evidence is local to the design session, not presented as vault research.

Nothing here has been playtested. The executing spine is [[combat-system-v12]]; that doc owns the DMAs, band table and state machine, and this one cites it rather than repeating it.

## Design goals

- [!] **A quick, engaging Discord day.** A fight is one of several things a player does with their rolls, not a session. It must not crowd out questing, talking or travelling.
- [!] **Consequential choices, not action economy.** The player picks between outcomes that matter, not between rules terms. Reproducing a tabletop turn (move, bonus action, reaction) is explicitly out of scope.
- [!] **Freeform actions stay supported.** Prose input remains first-class; structured stance and profile selection is a scaffold over the same d20 spine, never a replacement for it.
- [!] Roll-resolution only, never twitch (locked constraint carried from [[mvp-combat]]).
- [!] One evolving Discord message, mobile-first, inside the 30-column safe portrait width and 60 × 32 ceiling ([[discord-window-size]], [[poc-discord-ux]]).
- [!] The engine owns enemy HP and the `in_combat` edge; the LLM narrates and authors ancillary loot ([[combat-system-v12]]).
- [!] Danger is geographic and dynamic, so safe places host non-lethal scuffles and combat is never gated on location.
- [!] Bounded resolution, a once-per-day no-one-shot floor and a round cap, with world tier scaling magnitude rather than variance.
- [!] One worded danger scale shared by the card and RESOLVE ([[resolve-difficulty-signal]]). Boss Resolve and Phase 2 are combat facts, never a second difficulty vocabulary.
- [!] Monochrome is the asset, colour is enhancement, data-card hierarchy carries the read ([[visual-craft]]).

## Enemy classes and cadence

Three encounter classes. These describe **how a fight is built and resolved**; they are not the threat-pool tiers in [[threat-encounter-system]] (T1 grunts / T2 champions / T3 herald), which describe *what spawns*. The default mapping is settled: T1 grunts use ordinary resolution, T2 champions use miniboss resolution and T3 heralds use boss resolution. Minions, single enemies and mobs are composition variants within those classes rather than additional threat tiers.

| Class | Fight length | Player decisions | Second currency | Role in the day |
| --- | --- | --- | --- | --- |
| **Ordinary** | 1–2 rounds, provisional | One opening plan | None; simple temporary tags instead | The bread-and-butter fight, repeatable |
| **Miniboss** | At most 4 rounds, provisional | One tactical choice per round | Resolve track plus simplified Phase 2 | A named step up, worth a scar |
| **Boss** | At most 4 rounds, provisional | One tactical choice per round | Resolve track plus Phase 2 | A story beat, not a grind |

- [!] **Provisional cadence:** minibosses during the week and a boss event at the weekend. Exact spawn rates and the relationship to the Saturday shared-boss hunt in [[poc-plus-roadmap]] stage 4 remain open.
- [!] **Minibosses reuse the boss rules** with one simple Phase 2 trigger and archetype and a smaller Resolve track. Phase 2 is required for auto-resolved victory; early kills remain valid.

## Ordinary fight flow

- [!] **One opening plan:** a single action, a shared stance and a target. The exchange resolves without asking again.
- [!] **1–2 rounds, then a decision point.** Short enough that a missed day costs little, long enough that stance and profile matter. The count is provisional pending the measurement in [[#Open questions]].
- [!] After an unfavourable result the player is offered **flee**, **stand your ground**, or **call** for help from a nearby PC or NPC.
- [!] **No response means stand your ground**, resolved at the day tick. Standing can cost HP but can never directly cause permanent death.
- [!] At the round cap with both sides alive, standing triggers **one fresh HP-weighted final exchange**. The roll weighs relative HP percentage, items, stats, stance, profile and whether the player attacked. A win defeats or routs the enemy and pays loot; a loss pays no combat loot and carries severe consequences.
- [?] Does the post-round flee/stand/call prompt provide enough adaptation, or is one conditional branch on the first telegraph needed later? Phase A uses the flat opening plan.

## Boss and miniboss flow

- [!] **At most four player decisions**, one per round.
- [I] Four announced beats could follow teach, combine, change a rule and collapse; this is a research inference, not a required script.
- [!] **Phase 1 is shared vocabulary:** a small set of basic and extra actions reused across most bosses. Boss identity comes from the Phase 2 trigger and behaviour, not from a bespoke move list.
- [!] **Phase 2 archetypes:** healing and extra damage to begin with, later mixed and matched.
- [!] A **phase transition grants no invulnerability**. An outright kill may end the fight early, at any point.
- [I] Boss beats should key to the round or an HP threshold and be announced, never to a reactive window that needs immediate player input; an async game has nobody at the keyboard mid-beat (research recommendation).
- [?] Provisional: the four-decision ceiling and per-archetype Phase 2 numbers.

## Stances

Stances are shared across classes and **modify how an action resolves**. They never hard-counter each other; no stance triangle, because a three-beat wheel is a false choice inside a two-round fight.

| Stance | Buys | Costs |
| --- | --- | --- |
| **Aggressive** | Greater impact | Greater exposure and reduced defence |
| **Guarded** | Temporary guard against the incoming beat | Reduced tempo |
| **Poised** | Accuracy, setup or control | Lower immediate impact |

- [!] Guard from a stance is **temporary and non-stacking**; it expires rather than compounding.
- [?] Exact modifiers for each stance are not settled. No formula is fixed here.

## Action cards and profiles

Class, spell and item **action cards supply the valid combinations** of stance, profile and effect. Invalid combinations are never shown. Whether the remaining options are competitively meaningful remains a playtesting question.

- [!] Representative actions: fighter **Intercept** (redirect a named threat to yourself), rogue **Sneak Attack** (setup into payoff), wizard **split** damage, and **focused or split healing**.
- [I] Candidate rule, not owner-settled: **one maintained effect per caster**. Cap stacking at the source rather than tuning durations, which is the blunt and effective version of the idea.
- [?] Whether a card may be usable in only some stances, or every card offers one variant per stance.

## Action profiles

Profiles describe the **shape** of an action, independent of stance. The starting vocabulary:

| Profile | Damage shape | Non-damage shape |
| --- | --- | --- |
| **Focused** | One target, concentrated | One target, deepest effect (mark, grapple, single ward) |
| **Split** | Spread across multiple targets | Spread debuff or split healing |
| **Area** | Every foe present, smaller per target | Group guard or group exposure |
| **Sustained** | Smaller ticks over rounds | Effect that lasts while maintained |

### Role and action matrix

Small and representative on purpose. There is no spell list here, and each cell names the *job* rather than a finished card.

| Role | Job in 1–2 rounds | Job in 4 rounds | Representative action |
| --- | --- | --- | --- |
| **Damage** | Remove the threat quickly | Pressure HP and exploit openings | Focused strike, split damage |
| **Tank** | Redirect one named threat onto yourself | Hold the line while others set up | Intercept |
| **Assassin** | Setup and payoff inside one plan | Punish the announced opening | Sneak Attack |
| **Control** | Deny the enemy its best beat | Reduce boss Resolve and create an Exhausted window | Grapple, mark, stagger |
| **Support** | Prevent the bad beat | Sustain the party across four rounds | Guard or ward, focused healing |

- [?] Does focus fire make the other roles irrelevant?
- [?] Whether damage types carry leverage (bonus against a revealed profile) or remain flavour, and at what magnitude.

## Dice and presentation

- [!] **Fresh dice rolled in code** on every exchange. Daily pre-roll allocation stays roadmap milestone C and does not touch combat.
- [!] Show the **raw roll plus its modifiers**: item, stat, stance and damage-type. The player sees why the number landed where it did.
- [?] No exact modifier values or formulas are settled here; the band table in [[combat-system-v12]] remains the live maths.

## HP, clocks, Resolve and Exhausted

- [!] **Enemy HP is always visible, at variable granularity.** Player HP stays separately visible.
- [!] Clocks are **linear racing bars**. Linked clocks may represent a large boss's stages; other mission clocks are deferred.
- [!] Minibosses and bosses carry a **Resolve track** as their second tactical currency. Control, grapples and setup reduce it; at zero the boss is **Exhausted**. This is not D&D 5e's six-level exhaustion.
- [!] **Exhausted** cancels the boss's next legendary or double action and increases damage taken until its following turn. The basic action still happens.
- [!] Ordinary enemies use **simple temporary tags** instead of a second track.
- [?] Track size and how much control reduces it in a four-round budget.

### Passive information

| Skill | Reveals |
| --- | --- |
| **Survival** | Finer HP granularity for the party |
| **Investigation** | The enemy's damage profile |
| **Perception** | Enemy stance or intent |
| **Insight** | Boss Resolve |

- [!] **Survival uses the highest passive value in the party.** **Insight is party-wide:** one successful member reveals boss Resolve to everyone. This party-sharing rule does not automatically apply to Investigation or Perception.
- [I] Published intents are the research recommendation behind this ladder: the incoming threat is visible, the answer never is.

## Boss persistence and auto-resolution

Settled exactly, because it decides whether a partial attempt is wasted:

| Outcome | Boss state afterwards |
| --- | --- |
| Assault ends without reaching Phase 2 | No auto-kill is possible. Boss returns to **full HP**. |
| Phase 2 reached | Boss returns to the **HP value that triggered Phase 2**, and Phase 2 stays unlocked. It can be finished later. |
| Either way | Boss Resolve and temporary combat tags reset. Surviving PCs keep their injuries and their survival rewards. |

- [!] Reaching Phase 2 unlocks **boss auto-resolution** as a possible victory. Without it, a capped assault cannot auto-kill the boss.
- [!] The persisted `in_combat` edge already remembers a surviving or fled foe, so both "stand by default" and "boss resets to full HP" must build on that existing state.
- [?] Whether a boss's shared HP across players (the Saturday hunt shape) composes with per-player Phase 2 gating, and how.

## Rewards, defeat and death

- [!] **Surviving a fight grants XP.** Phase A persists and displays XP as a cumulative metric only: no levels, spending, unlocks or balance effect. Eligible quest credit is added through the accelerated #74 dependency when that system lands. Amounts are unquantified.
- [!] **Loot requires a win**, including a win produced by auto-resolution.
- [!] **Ordinary defeat** causes unrest, a bad injury and possibly stolen coins. Miniboss and boss defeat carry the same base consequences.
- [!] **Permanent death is restricted** to a clearly telegraphed lethal outcome or an opted-in deadly encounter. A missed prompt can leave the player standing their ground; it can never directly cause permanent death.
- [?] Whether survival XP and quest credit create a low-risk farming loop (verification question). Combat XP is a metric, not the pre-roll budget's XP; the [[xp-unification]] candidate belongs to milestone C.

## Cooperation (deferred)

Calling for help is in Phase A as a state; **cooperative resolution and reward sharing get their own specification**.

- [>] Build on the existing PC/NPC/active-fight graph and the Saturday event behaviour in [[poc-plus-roadmap]] rather than inventing a parallel model.
- [>] Join windows, eligibility and reward-sharing rules are deferred, deliberately unspecified here.

## Phasing

**Phase A, the vertical slice:**

- [<] Ordinary fights end to end.
- [<] One four-round miniboss.
- [<] The three stances and a small profile set.
- [<] Fresh code-rolled dice with the raw roll and modifiers shown.
- [<] Passive information.
- [<] Win-gated loot, cumulative XP tracking, quest hints through #74, and the flee/stand/call state.
- [<] Representative damage, tank and control/support actions.

**Later phases:**

- [>] Full help and call resolution.
- [>] Additional class and item kits.
- [>] Large bosses.
- [>] Mission clocks beyond HP and boss stages.
- [>] Daily pre-roll allocation (roadmap milestone C).

## Verification questions

Carried from the design Q&A. Each one is a check against live play, not a design assertion.

- [?] Do tanks and controllers have meaningful jobs in both a 2-round and a 4-round fight?
- [?] Does focus fire make the other profiles irrelevant?
- [?] Do telegraphs create decisions rather than a solved script?
- [?] Can control matter within four rounds without producing lockout chains?
- [?] Does healing create stalemates or mandatory support?
- [?] Is standing by default fair across timezones and missed sessions?
- [?] Does the combat UI stay readable on one mobile Discord screen?
- [?] Do survival XP and quest credit create a low-risk farming strategy?

## Open questions

- [?] **Encounter cadence.** Weekday minibosses and a weekend boss event are provisional; exact spawn rates and Saturday event integration are open.
- [?] **Round counts.** Ordinary 1–2 and bosses 4 are provisional. The engine cap is `MAX_COMBAT_ROUNDS = 4` with a fifth round resolving, so an ordinary fight reaching 2 rounds is a design target the current spine does not enforce.
- [?] **Stance and profile numbers.** Modifiers, guard values, Resolve track size, control-to-Exhausted ratio.
- [?] **Maintained effect.** Whether one maintained effect per caster is adopted as a rule.
- [?] **Boss auto-resolution and shared HP.** How per-player Phase 2 gating composes with a boss whose HP is shared across players.
- [?] **Damage-type leverage.** Flavour only, or a bounded bonus against a revealed profile.
