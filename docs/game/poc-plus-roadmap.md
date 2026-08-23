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
---
_The player-facing engagement arc for the `0.3.x` line, the final POC round before MVP. Where [[prompt-v13-roadmap]] makes the game coherent (prompt/engine plumbing), this arc makes it sticky. Decided 2026-07-09. Items 0–2 (v12 closeout tail, welcome tag, combat maths reveal) and the inserted Release A shipped as `0.3.1`–`0.3.3` — their build plans and the per-item specs are archived under `archived/poc-plus/`. What remains live is the shared-world half: stages 2–4 below._

---

# POC+ Roadmap — the Shared World arc (remaining stages)

## North star

**Persisted-state multiplayer — shared mutations on shared world state.** Actions leave marks others can feel: a public event everyone sees, a buff one player lays on another, a boss whose wounds persist across every hunter and every day. The POC proved the solo daily ritual works; this arc proves the world is _shared_, not just co-located. It is deliberately buttons-first and scale-neutral, same as the `0.3.0` flip.

## How the arc runs (for the lead)

This doc is the durable memory across sessions; one build plan per stage, authored by the lead when the stage is reached, grounded in the per-item sections below. Run per the `orchestrated-delegation` skill; branching, release cuts, and the changelog go through the `releasing` and `changelog` skills. Stage numbering here is the arc's own; it is unrelated to the v12/v13 prompt-stage numbering (v13's "Stage 4" is world scaling, not this arc's stage 4).

Remaining:

- [ ] **Stage 2 (re-scoped solo-first)** — nat 1/20 as a solo crit reward, public broadcast as the bonus layer (plan authored by the lead at stage start)
- [ ] **Stage 3** — cross-player buffs (build + agent-QA; fun-payoff parked to later user testing)
- [ ] **Stage 4** — Saturday shared-boss hunt (build + agent-QA; fun-payoff parked to later user testing)

## Why this order — prod-data review (2026-07-23)

A read-only snapshot of the whole POC+ period (`warden-20260723-201953`; 07-07 → 07-23, game day 17, builds `0.3.0`–`0.3.2`: 98 actions, 796 LLM calls, 4 characters, 1 external tester) forced the re-sequencing: the live Oak peaked at 2–3 concurrent players and every feedback/bug row came from a single tester, so cross-player buffs and the shared boss cannot be _fun_-validated at that size. The remaining stages therefore front-load solo fundamentals (stage 2's nat 1/20 reward), and the two genuinely-multiplayer stages are built-and-QA'd by agents with their fun-payoff explicitly deferred to a later human user-testing round. Reproduce the numbers with the `db-backups/` tooling against that snapshot.

**Release B — Stage 2, re-scoped solo-first.** The nat 1/20 work leads with the _solo reward_ — a natural 20 grants extra loot or rolls (answers F#9), a natural 1 gets a story beat — and the public broadcast becomes the bonus layer that switches on once there is an audience. It lands at N=1 and still builds the broadcast plumbing stages 3–4 reuse. Frame authorship stays deterministic as settled below.

**Stages 3–4 — build + agent-QA, fun-payoff deferred.** Validated against the agent-player harness (extend it to co-located multi-agent runs first) rather than live players. Agent QA proves they _work_ (buffs land, boss HP persists across turns and days); whether they _feel_ shared stays unproven until the human round — do not close the acceptance checks below on agent QA alone.

## The remaining arc, ordered

| # | Item | Code | Reward | Release cut |
| --- | --- | --- | --- | --- |
| 3 | Nat 1/20 global broadcast | S | Viral show-off; builds the broadcast plumbing | own `0.3.x` |
| 4 | Cross-player buffs | S–M | First mutation that lands on _another_ player | own `0.3.x` |
| 5 | Saturday shared-boss hunt | M | Flagship of the north star; a weekly ritual | own `0.3.x` |

(Items 0–2 shipped in `0.3.1`–`0.3.3`, including the shared `AnsiRenderer` the remaining items reuse.) Version numbers are deliberately unpinned: each cut takes the next `0.3.x` at the time it lands, per the `releasing` skill. The ordering is a dependency chain: #3 builds the public-broadcast plumbing #4 and #5 reuse; #4 builds the "nearby players" + player-targeting-mutation plumbing #5 reuses. Each item is shippable alone, but built in this order almost nothing is thrown away.

---

## 3 · Nat 1/20 global broadcast

On any natural 1 or 20, post a short public shout-out to the shared channel, rendered as a fun **ANSI re-enactment frame** of the moment (the crit that felled the boar, the fumble into the ravine). The first genuinely _shared_ event: everyone sees it happen.

- [>] Extends the `TODO.md` "global broadcast on a natural 1 or 20" item and the deferred "richer community feedback — let players show off" MVP item.
- [p] Crit/fumble detection already exists (`dc.ts:71`, `combat-dc.ts:134`, `OutcomeRenderer.ts:153`); this hooks that signal to a public post. The 0.2.8 public-outcome path (thread posts, `Hi` button) is the posting precedent; what is new is the trigger and the frame.
- [p] Reuses the `AnsiRenderer` (built in `0.3.1`) for the re-enactment frame; the sprite/floater slots ([[mvp+ansi-art]] §3) are exactly the "one dramatic beat" shape.
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
- [ ] B#11 closed.

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

Independent of the v13 prompt threads, so it can run in parallel or interleaved. Stage 2 changes no prompt templates; stages 3 and 4 **do** (the buff action must be recognised; the boss injects a `## Threat presence`-shaped block into decide context), so they must go through the `prompt-versioning` skill and land as, or alongside, the next prompt-set bump — natural pairing with the v13 carried cleanups (enforced `allowedMutations`).
