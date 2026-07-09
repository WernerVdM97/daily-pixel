---
title: "POC+ Roadmap (0.3.x) — the Shared World arc"
status: decided
domain: game
phase: poc
tags:
  - roadmap
  - retention
  - multiplayer
  - combat
  - ansi
  - social
related:
  - "[[prompt-v13-roadmap]]"
  - "[[threat-encounter-system]]"
  - "[[mvp+ansi-art]]"
  - "[[improved-item-features]]"
  - "[[pitch-and-pillars]]"
  - "[[stage-5-live-cutover-plan]]"
  - "[[poc-plus-stage-1-plan]]"
---
_The player-facing engagement arc for the `0.3.x` line, the final POC round before MVP. Where [[prompt-v13-roadmap]] makes the game coherent (prompt/engine plumbing), this arc makes it sticky. Five small-code, high-delight items plus the v12 closeout tail, ordered as a dependency chain so each one makes the next cheaper, all pulling toward one north star: a world whose state is genuinely shared. Decided 2026-07-09; this is the parent tracking doc for an orchestrated-delegation lead, with per-stage build plans below it (first: [[poc-plus-stage-1-plan]])._

---

# POC+ Roadmap — the Shared World arc

## North star

**Persisted-state multiplayer — shared mutations on shared world state.** Actions leave marks others can feel: a public event everyone sees, a buff one player lays on another, a boss whose wounds persist across every hunter and every day. The POC proved the solo daily ritual works; this arc proves the world is _shared_, not just co-located. It is deliberately buttons-first and scale-neutral, same as the `0.3.0` flip.

## How the arc runs (for the lead)

This doc is the durable memory across sessions; the stage plans are the executor-grade contracts. Run per the `orchestrated-delegation` skill: the lead owns scouting, the final handoff, triage, verification, and commits; executors, reviewers, and fixers do the mechanical work. Branching, release cuts, and the changelog go through the `releasing` and `changelog` skills.

- One build plan per stage. Stage 1's plan exists ([[poc-plus-stage-1-plan]]); the lead authors each later plan when its stage is reached, same template, grounded in the per-item sections below.
- Stage numbering here is the arc's own; it is unrelated to the v12/v13 prompt-stage numbering (v13's "Stage 4" is world scaling, not this arc's stage 4).
- Each verified task is an atomic commit; recommend `/clear` at stage boundaries and resume with the one-liner in the active plan (this doc + the plan + branch/last commit + reconcile-first).
- Doc loop before a stage is declared done: tick the plan's boxes, update the tracking list below, settle any `[?]` in the doc that asked it, keep the map of content current.

Tracking:

- [x] **Stage 1** — v12 tail + welcome tag + combat maths reveal ([[poc-plus-stage-1-plan]]) _Done 2026-07-09; branch `poc-plus/stage-1-t2`, commit `94ecbee`. Live check pending (bot smoke-tests OK; needs human operator)._
- [ ] **Stage 2** — nat 1/20 global broadcast (plan authored by the lead at stage start)
- [ ] **Stage 3** — cross-player buffs (plan authored by the lead at stage start)
- [ ] **Stage 4** — Saturday shared-boss hunt (plan authored by the lead at stage start)

## Shared enabler — a small `AnsiRenderer`

Two of the five items want coloured frames, and [[mvp+ansi-art]] already mocked and live-tested them (2026-07-08). Build the small `AnsiRenderer` it recommends (§5) once: keep `.ascii` fragments colour-free, apply colour by role (chrome / bar / sprite / floater) at render time so mobile falls back to clean monochrome and the 30-char width validation still runs on the source. Item 2 builds it; item 3 reuses it. Scope stays at combat + broadcast frames; the splash showpiece stays deferred in [[mvp+ansi-art]].

## The arc, ordered by efficiency × reward

| # | Item | Code | Reward | Release cut |
| --- | --- | --- | --- | --- |
| 0 | v12 closeout tail (F#21 + dead-code sweep) | S | Clean baseline; system failures stop costing rolls | with item 1 |
| 1 | Welcome tag | XS | Warm social onboarding | next `0.3.x` (with #0) |
| 2 | Combat maths reveal | S–M | Dopamine + highest info payoff; builds the renderer | own `0.3.x` |
| 3 | Nat 1/20 global broadcast | S | Viral show-off; builds the broadcast plumbing | own `0.3.x` |
| 4 | Cross-player buffs | S–M | First mutation that lands on _another_ player | own `0.3.x` |
| 5 | Saturday shared-boss hunt | M | Flagship of the north star; a weekly ritual | own `0.3.x` |

Version numbers are deliberately unpinned (settles this doc's old cadence question): each cut takes the next `0.3.x` at the time it lands, per the `releasing` skill. The tail rides item 1's release because F#21 is player-facing and the sweep is invisible.

The ordering is a dependency chain: #2 builds the renderer #3 reuses; #3 builds the public-broadcast plumbing #4 and #5 reuse; #4 builds the "nearby players" + player-targeting-mutation plumbing #5 reuses. Each item is shippable alone, but built in this order almost nothing is thrown away.

---

## 0 · v12 closeout tail

Spec by reference, not restated here: the F#21 divine-intervention rework is [[prompt-v13-roadmap]] §4; the dead-code sweep is [[stage-5-live-cutover-plan]] T7 (code sweep only; the DB wipe and `0.3.0` cut already happened). Both are tasked in [[poc-plus-stage-1-plan]].

## 1 · Welcome tag

Tag the new hero on the public "A new hero joins the Oak" broadcast and carry the 🌅 `Hi` re-entry button onto it, so the arrival reads as a person joining a shared place and the tagged player can jump straight into play.

- [>] Extends the `TODO.md` item "add /hi to 'A new hero joins the Oak' message"; tasked in [[poc-plus-stage-1-plan]] T1.
- [p] Trivial: `src/discord/commands/join.ts` already owns the broadcast; the `nav:hi` handler already spawns a fresh per-clicker ephemeral on public messages (the `0.2.8` `Hi`-on-outcomes work proved the pattern).
- [!] Suppress pings on the mention (match the owner-identity treatment shipped in `0.2.8`, F#3/F#8) so it reads as identity, not notification spam.
- [>] The `/join` wizard's inline-skills formatting polish stays a separate `TODO.md` item, out of this arc.

## 2 · Combat maths reveal

Show the fight's actual numbers in the combat outcome: the dice, the contested margin, HP bars, and damage floaters, rendered through the new `AnsiRenderer`. Drop the ASCII scene art from combat outcomes to make room.

- [>] Closes F#7 ("show the maths") and the combat half of the `TODO.md` "drop ascii from action outcomes" item; feeds [[mvp-combat]]. Tasked in [[poc-plus-stage-1-plan]] T2.
- [p] The data already exists: `combat-dc.ts` computes `playerRolled`, the signed margin, severity bands, and `enemyHpBefore/After` + signed HP deltas; `OutcomeRenderer.ts:153` already flags crits. This is a **rendering** job, not a maths job.
- [p] Directly fixes the B#5/B#6 combat-HP formatting bugs (`0 HP` cram, mid-resolution `-5 HP` reads weirdly): the frame gives each combatant its own HP-bar line with clamped values. Both bugs are acceptance criteria in the stage plan.
- [I] Per [[mvp+ansi-art]] §5's open question, combat frames are the "highest information payoff" landing spot for colour, which is why the renderer starts here.
- [c] Colour roughly doubles a frame's char cost; stay well under the 2 000-char limit (combat frames measured 820–1 250 chars incl. fences).

## 3 · Nat 1/20 global broadcast

On any natural 1 or 20, post a short public shout-out to the shared channel, rendered as a fun **ANSI re-enactment frame** of the moment (the crit that felled the boar, the fumble into the ravine). The first genuinely _shared_ event: everyone sees it happen.

- [>] Extends the `TODO.md` "global broadcast on a natural 1 or 20" item and the deferred "richer community feedback — let players show off" MVP item.
- [p] Crit/fumble detection already exists (`dc.ts:71`, `combat-dc.ts:134`, `OutcomeRenderer.ts:153`); this hooks that signal to a public post. The 0.2.8 public-outcome path (thread posts, `Hi` button) is the posting precedent; what is new is the trigger and the frame.
- [p] Reuses the `AnsiRenderer` from item 2 for the re-enactment frame; the sprite/floater slots ([[mvp+ansi-art]] §3) are exactly the "one dramatic beat" shape.
- [!] **Frame authorship (settled 2026-07-09): deterministic.** The frame is composed from fragment slots plus the action's real data (enemy name, roll, damage), and the flavour line is lifted from the already-generated resolve narration. Zero extra LLM calls, so the broadcast is instant and free.
- [!] **No opt-out at POC scale (settled 2026-07-09).** Fumbles are framed as legend-worthy, never humiliating; a per-player broadcast preference is MVP scope (see fences).
- [!] Rate/spam guard: cap broadcasts (per-player cooldown or a daily ceiling) so a grinding player does not flood the channel. Colour must not carry the meaning alone (mobile strips it) — the prose says crit vs fumble.

## 4 · Cross-player buffs

A "for everyone" action (pray, bless, rally) applies a real buff **mutation to the other players present**, instead of no-opping. The first mutation whose effect a player _feels_ from someone else's turn.

- [>] Lands B#11 (praying/blessing "for everyone" should actually buff nearby players); the purest small expression of the persisted-multiplayer north star ([[pitch-and-pillars]]).
- [>] Needs "nearby players" awareness — the same `## Threat presence` "Nearby in this area" block designed in [[threat-encounter-system]] §4, built minimally here (list co-located PCs) so item 5 inherits it.
- [!] Server-authoritative: the buff is an engine-applied mutation on the target PC nodes, not LLM-authored SQL — same seam as every v12 mutation ([[prompt-v12-scene-state]] D2).
- [!] **Buff vocabulary (settled 2026-07-09): exactly three engine-owned buffs** — `+1 next roll`, `+2 stamina`, `+2 HP` (clamped to max). One active buff per recipient; a new cast replaces, never stacks. Expires at the recipient's next daily tick. Buffs only, never net-negative for the recipient; no debuffs on other players this round.
- [c] Async timing: "present" means co-located in the same location at cast time; the recipient sees the buff on their next `/hi`. No real-time delivery.

## 5 · Saturday shared-boss hunt

A **minimal slice** of [[threat-encounter-system]]: one scripted weekly boss that appears Saturday with a hint, carrying **shared, persisted HP** in the `relations` table. Every hunter fights the _same_ foe; damage persists across players and days; the kill fires a global broadcast (item 3). The flagship of the arc — the world visibly bearing the marks of many hands.

- [>] Carves §7 (Saturday events) + §4 (shared threat pool) out of [[threat-encounter-system]], deferring the rest of that system (see fences below).
- [p] Reuses everything below it: live combat (`0.3.0`), the broadcast plumbing (item 3), the "nearby players" awareness (item 4), the shared-HP edge shape already designed in §4 (`threat_pending` / `in_combat` / `threat_defeated` on the `relations` table, SQLite-persistent by construction).
- [I] Cross-player buffs (item 4) shine here: a fellowship stacking blessings before the kill blow is the north star made playable.
- [!] **Kill credit (settled 2026-07-09): hybrid.** Damage per PC accumulates in a contribution ledger on the boss's shared edge props; when the boss dies, loot scales by contribution share, and the kill blow gets the global broadcast, the name, and a small trophy bonus. Whittling always pays; a Sunday snipe still feels great but cannot steal the pot.
- [!] Once-per-week scripted spawn only (fixed schedule, engine-owned, anchored to the daily tick's timezone) — a single named foe at one location, not a pool. HP is genuinely shared: a boss fought to 5 HP on Saturday is at 5 HP for the next hunter on Sunday.
- [!] Respect the combat floor (no one-shot, once-per-day per [[prompt-v12-combat]]); the boss is driven down over multiple players/days, not soloed in one beat.

---

## Acceptance & what we watch

The arc graduates when each is demonstrably true live:

- [ ] A public event fired by one player's action is seen by everyone (item 3 live).
- [ ] A buff cast by one player lands on another PC and visibly affects the recipient's next action (item 4 live).
- [ ] Boss HP persists across at least two players and two days, and the kill fires the broadcast with hybrid credit (item 5 live).
- [ ] B#5/B#6 irreproducible; F#7, F#21, and B#11 closed.

What we watch, from data that already lands in SQLite or the channel (no new telemetry build):

- Broadcasts per week, and reactions/replies on them (channel read).
- Buff casts per week (mutation rows).
- Distinct hunters per boss week (actions against the boss edge).
- Weekly active characters trend across the arc (actions table).

## Decision gates left for the lead

Each has a default; decide at that stage's plan time, against live data, and record it in the plan (or a `decisions/` record if it touches the mutation contract).

- [?] **Boss HP sizing** — derive from observed weekly actions-per-player when the stage 4 plan is written. Default shape: `maxHp ≈ active weekly hunters × expected damage per fight × 0.7`, so a motivated week kills it with margin and a quiet week comes close.
- [?] **Unkilled boss at week's end** — despawns, escalates, or persists? Default: despawn-with-a-rumour; revisit against live data.
- [?] **Broadcast channel model** — one shared channel until fellowships exist; revisit at [[mvp-progression]].

## Scope fences (what stays deferred)

- [>] **Threat system proper** — the stochastic encounter gate, three tiers, density curve, approach modifiers, and sim-harness tuning stay in the full [[threat-encounter-system]] and v13. Item 5 ships _one scripted boss with shared HP_, nothing more.
- [>] **ANSI splash showpiece** — the 40-wide title splash and block-letter fonts stay in [[mvp+ansi-art]] §4. This arc ships combat + broadcast frames only.
- [>] **Broadcast opt-out preference** — a per-player "don't broadcast me" flag is MVP scope; POC ships without it.
- [>] **Login streaks** — reads as MVP retention, not this arc ([[mvp+login-streaks]]).
- [>] **Trust restoration, death mechanic, real graph backend** — MVP scope, per [[prompt-v13-roadmap]].
- [>] **Full item usage / economy** — cross-player buffs (item 4) are the only new shared-mutation surface this round; item depth stays in [[improved-item-features]].

## Sequencing against v13

Independent of the v13 prompt threads, so it can run in parallel or interleaved. Stages 1–2 (tail + items 1–3) change no prompt templates, so they can run while the D3/D4 conversation/puzzle spec is being written. Items 4 and 5 **do** touch templates (the buff action must be recognised; the boss injects a `## Threat presence`-shaped block into decide context), so their stages must go through the `prompt-versioning` skill and land as, or alongside, the v13 prompt-set bump — natural pairing with the v13 carried cleanups (enforced `allowedMutations`).
