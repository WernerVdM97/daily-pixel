---
title: Polish Pass — Follow-up (post-0.2.7)
status: shipped
superseded_by: "implemented in code"
domain: spark
phase: poc
tags:
  - polish
  - feedback
  - bugs
  - ui
  - map
  - economy
  - auto-resolve
related:
  - "[[polish-v0.2.7]]"
  - "[[prod-data-review-v0.2.3]]"
  - "[[roll-economy-timeouts-and-world-growth]]"
  - "[[per-player-map-exploration]]"
  - "[[prompt-separation-of-concerns]]"
  - "[[improved-item-features]]"
  - "[[edge-bearing-inversion-and-region-reconciliation]]"
---

---

What's **still unresolved** after `0.2.7`, read straight from the dev-DB snapshot (`db-backups/warden-2026-06-30.db` — 17 `feedback`, 13 `bug_reports`, builds blank→`0.2.6`, testers Apprentice / Flikker / UlrichTheShort / Oom, span 2026-06-18 → 06-29). Every row was triaged against three prior closures — [[prod-data-review-v0.2.3]] (C1/C2/G1/G2/G3), the [[roll-economy-timeouts-and-world-growth]] decision (refund no-op/timeout rolls, lazy-create world growth), and [[polish-v0.2.7]] (UI/emoji + bail mulligan + the ≤1-option shape guard) — plus the `CHANGELOG` and a few code spot-checks. The closed items are listed at the bottom so we don't re-litigate; everything above the fold is open.

`feedback`/`bug_reports` carry no status column, so "resolved" was decided by correlating `created_at` + the stamped `app_version` against the changelog and the code. **`#N` below is the DB row id**, not the prod-data-review numbering.

---

## Still open

Scope per the latest steer: **only genuine defects below** — roadmap-bound POC/MVP design asks (items, economy, party buffs, fast-travel, Discord `@mention`, auto-resolve *shaping*) are pulled out to the pointer list at the bottom so this stays a bug list.

### 🐛 Confirmed bugs

- [x] **Travel outcome never tells you that you moved** *(feedback #16, Apprentice, v0.2.6, action 129)*. Action 129 was a `done` `cross_frontier` to Eastvale: the player only learned they'd arrived by running `/look` afterwards — the outcome footer (`src/discord/commands/action.ts:547`, favoured-roll/DC only) carries no `set_location`/`cross_frontier` line, and the scene ASCII lagged (a plain grid in the outcome, a town once they re-looked). A footer location-delta line (`📍 → Eastvale`) + rendering the destination scene on the move would close it. Distinct from the degenerate-shape guard — this is *result surfacing*, not *no-choice*.
- [x] **Edge bearing isn't inverted from the far side, and region placement disagrees with paths** *(feedback #14 + bug #12, Apprentice, v0.2.6)*. The Old Watchtower shows as a **path on `/look`** from the eastern map but files under **"elsewhere" on `/map`**; separately, "looking at a location edge from the otherside should invert the angle" (an edge that leaves NE should read as arriving from SW at the other node). One underlying issue: edge bearings are stored one-directional and the region/`node_tier` assignment doesn't reconcile with what the exits imply. Affects `/map` grouping + `/look` paths.
- [x] **A net-zero buff is invisible** *(feedback #13, Apprentice, action 118)*. Action 118 granted `+1 stamina, +1 roll` (inspiration). The `0.2.5` roll-accounting nets a `+1` grant against the `−1` action cost, so the `🎲` count *stays put* and the footer shows nothing — the player asks "was I rewarded?". The refund/accounting is correct; the **reward is just unsurfaced**. Want an explicit `✨ inspired (+1 roll)` style line when a resolution *grants* (not just spends).
- [x] **Granted inspiration appears ignored on a later attempt** *(bug #1, Flikker)*. "Inspiration that was given seems to be ignored on my third attempt — showed Done without rolling, consuming the roll while doing nothing." The roll-consumption half is fixed (no-op refund), but whether the **inspiration bonus actually applied** to the later roll is unverified — needs a targeted check of how a carried buff feeds the next ability check. (Distinct from the v11 auto-resolve *shaping* work — this is a correctness question about an existing buff.)
- [x] **"Says 98 copper in my Stats page"** *(bug #9, Flikker)*. Ambiguous — either a wealth denomination/display quirk (copper vs gold units) or just a balance read. Needs a repro/clarification before it's actionable; flagged so it isn't lost.

### ✅ Handled this pass

- [x] **Backpack overflowed its cap — `12/10`** *(bug #13, Oom, v0.2.6)*. Short fix: `BACKPACK_CAPACITY` raised `10 → 40` and the emoji grid now wraps at 10 columns (a tidy 10×4 grid) in `src/discord/commands/backpack.ts`, so realistic packs no longer exceed the number shown. The cap is still *display/soft* — proper enforcement + the "loot is noise" depth question move to [[improved-item-features]].

---

## Already resolved (don't re-litigate)

Closed by the changelog / code — kept here so they're not re-reported off the same rows:

- [x] **Auto-resolve ate a roll for no choice** *(feedback #2, #4, #12; bug #4, #7, #10)* — refund-the-no-op ([[roll-economy-timeouts-and-world-growth]]) + the `0.2.7` ≤1-option degenerate-shape guard (retry-then-refundable-no-op). *(The "boring" UX half lives on as feedback #6 above.)*
- [x] **Timeout dropped travel, kept the roll, rendered a grey ghost** *(feedback #5; bug #2, #6)* — `0.2.5` timeout roll-refund + explicit render; visible `🎲 (refunded)` footer.
- [x] **Stranded "unknown" locations / going in circles / "add my location"** *(feedback #4 systemic, #10; bug #5)* — `0.2.6` geography: graph-validated `set_location`, `cross_frontier` world growth, `/map`, the async cartographer.
- [x] **Unsafe-rest HP loss was a surprise** *(feedback #7)* — the warning copy shipped (`src/discord/commands/sleep.ts:115`, "⚠️ Resting on unsafe ground costs 1 HP…" + the post-rest cause line). This was prod-data-review **G2**.
- [x] **"Only getting two rolls"** *(bug #3)* — `DAILY_ROLL_ALLOWANCE` raised 2→3 (`0.2.2`); footer denominator fixed in `0.2.4`.
- [x] **Feedback #15 self-retracted** — the Apprentice's "still not in Eastvale!" was withdrawn one minute later in feedback #16 (the move *had* happened; the footer just never said so → folded into the open bug above).
- [p] **Win, keep it** *(feedback #1)* — "the new actions read much easier." Don't regress the action-recap readability.

---

## Implementation plan (shipped)

The decided scope is the **bug list above**, sequenced below. Two cheap investigations gate real work (fail-fast — they may close as non-bugs); the high-confidence footer bump is one vertical slice on a single pure module; the map fix needs a one-line direction call first. Roadmap/own-spark items (next section) are explicitly **not** in this plan.

### Architecture decisions

- [x] **Both footer fixes land in the pure `src/engine/OutcomeRenderer.ts`** (+ `tests/engine/outcome-renderer.test.ts`) — no engine-state or Discord coupling, so they're testable in isolation and ship together. Root causes are already pinned (below), so these are XS.
- [x] **Investigations come first.** Bug #1 (does a carried buff actually apply?) and bug #9 (`98 copper`) are correctness/repro questions — resolve them before writing a fix, since either may be a non-bug. High-risk-unknown early.
- [x] **The map fix needs a direction first.** Edge-bearing inversion can be solved by storing **bidirectional edges** or by **inverting the bearing at render time** — record the choice in `decisions/` before coding (changing a `decided` plan otherwise needs its own record).

### Phase 1 — Verify (fail-fast)

#### Task 1: Confirm whether a granted buff applies to the next roll *(bug #1, Flikker)*

**Description:** Trace how `modify_rolls_remaining` (and any "inspiration" bonus) feeds a *later* ability check. Determine whether the bonus is silently dropped or correctly applied; the roll-consumption half is already fixed by the no-op refund.

**Acceptance criteria:**
- [x] A written verdict: applies correctly / is dropped, with the `path:line` that decides it.
- [x] If dropped → spawn a fix task; if correct → close bug #1 here, noting it was a *surfacing* confusion (see Task 4).

**Verification:** unit test asserting a granted roll is available to the subsequent action; or a documented repro showing it already works.
**Dependencies:** None. **Files likely touched:** `src/engine/action/machine.ts`, `src/engine/WorldEngineImpl.ts` (read), test. **Scope:** S.

#### Task 2: Reproduce the `98 copper` stats reading *(bug #9, Flikker)*

**Description:** Decide if `98 copper` is a denomination/display defect or just a balance read. Check how `/stats` formats wealth and whether any "copper" unit exists vs. the `💰` count used elsewhere.

**Acceptance criteria:**
- [x] A verdict: real display bug (with the offending formatter) or non-bug (close it).

**Verification:** a repro string from the stats formatter, or a note that wealth renders consistently with the outcome footer.
**Dependencies:** None. **Files likely touched:** `src/discord/commands/stats.ts` (read). **Scope:** XS.

### Checkpoint: Triage
- [x] Bug #1 and bug #9 each have a verdict (fix-task or closed). Tests still green.

### Phase 2 — Outcome footer surfacing (the high-confidence bump)

#### Task 3: Show the move on a frontier-crossing travel *(feedback #16)*

**Description:** `deriveFromMutations` maps `set_location → newLocation` but has no `cross_frontier` case (`OutcomeRenderer.ts:66`), so a `cross_frontier` travel never renders the `→ <place>` line (`:188`). Add the case so the destination shows in the outcome.

**Acceptance criteria:**
- [x] An outcome whose only move is `cross_frontier {name}` renders a `→ <name>` change line.
- [x] `set_location` behaviour is unchanged; a turn with both still shows one destination.

**Verification:** `npx vitest run tests/engine/outcome-renderer.test.ts` with a new `cross_frontier` case. **Scope:** XS (1 module + test).
**Dependencies:** None.

#### Task 4: Surface a net-zero roll grant *(feedback #13; folds in bug #1 if it was a surfacing issue)*

**Description:** A `+1` roll grant that nets the `−1` action cost gives `rollsDelta === 0`, so the `🎲` line shows a bare unchanged count and the reward is invisible (`OutcomeRenderer.ts:205-210`). When the mutations include a positive `modify_rolls_remaining` (or other inspiration-type grant) that nets flat, render an explicit marker (e.g. `✨ inspired (+1 roll)` or a `🎲 N (+1 / −1)` split) so a granted buff is never silently swallowed.

**Acceptance criteria:**
- [x] An outcome that grants `+1 roll` and spends `−1` shows a visible "you were inspired"-type signal, not a bare unchanged `🎲 N`.
- [x] A genuine no-op refund still reads `(refunded)`; a plain charged action is unchanged.

**Verification:** new `outcome-renderer.test.ts` cases for grant-nets-zero, refund, and plain charge. **Scope:** S (1 module + test).
**Dependencies:** Task 1 (confirms whether this also closes bug #1).

### Checkpoint: Footer bump
- [x] `npm run typecheck` clean; `tests/engine` + `tests/discord` green; a manual `cross_frontier` + an inspiration outcome eyeballed.
- [x] Changelog `[Unreleased] → Fixed` entries added; **review with human before Phase 3.**

### Phase 3 — Map direction (after a recorded decision)

#### Task 5: Decide edge-bearing representation *(feedback #14 / bug #12)*

**Description:** Pick how a reverse edge reads its bearing and how a place's region reconciles with the exits that reach it. Write a `decisions/` record: **bidirectional stored edges** vs. **render-time inversion** (and the region-assignment rule).

**Acceptance criteria:**
- [x] A `docs/decisions/` record stating context, options, choice, consequences; this doc's `related` updated.

**Verification:** decision record exists and is linked from the map docs. **Scope:** XS (doc).
**Dependencies:** None.

#### Task 6: Implement edge-bearing inversion + region reconciliation *(feedback #14 / bug #12)*

**Description:** Per Task 5: a reverse edge shows the inverted compass bearing, and a place reached as a path no longer files under "elsewhere" on `/map` when its region is implied by its exits.

**Acceptance criteria:**
- [x] An edge leaving NE reads as arriving from SW at the far node.
- [x] A node visible as a `/look` path is grouped consistently on `/map` (not orphaned to "elsewhere").

**Verification:** geography unit tests for inverted bearings + a `/map` render test; manual `/look`↔`/map` parity check. **Scope:** M (3-5 files).
**Dependencies:** Task 5. **Files likely touched:** `src/engine/geography.ts`, `src/discord/map-render.ts`, `src/discord/commands/look.ts`, tests.

### Checkpoint: Complete
- [x] All open bugs closed or explicitly deferred with a reason; full suite green; changelog updated; ready to fold into the next `0.2.x` cut.

### Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Bug #1 buff *is* dropped (engine, not just surfacing) | Med | Task 1 gates it; if real it becomes its own engine fix, kept out of the XS footer slice. |
| Net-zero marker clutters the footer | Low | Keep it one glyph + signed amount; reuse `formatDelta`; covered by a render test. |
| Edge-bearing fix wants a schema change (bidirectional edges) | Med | Task 5 decides before any code; render-time inversion is the no-migration fallback. |

### Open questions

- [x] Net-zero buff: shipped as a dedicated `✨ inspired (+N roll)` line in the changes section of `OutcomeRenderer.ts` — fires when a positive `modify_rolls_remaining` grant nets to zero after the action cost.
- [x] Bug #9 (`98 copper`): closed as non-bug — `stats.ts:48` hardcodes "copper" as a denomination label; the wealth figure itself is correct. No data defect.

## Off this list — on the POC/MVP roadmap or own spark

Not bugs; pulled out per the bug-only scope so they aren't re-triaged here:

- [>] **Items / loot / inventory depth** *(feedback #11; backpack enforcement)* → [[improved-item-features]] (new placeholder).
- [>] **Communal vs. personal currency** *(feedback #9, Ulrich)* → economy thread in [[improved-item-features]].
- [<] **Party / multi-target buffs** *(bug #11, "bless everyone")* — engine gap (mutations are single-character); MVP roadmap.
- [<] **Player-authored named landmarks** *(bug #8, Ulrich)* — beyond procedural world-growth; MVP roadmap.
- [<] **Fast-travel cost + rest-at-a-distant-settlement** *(feedback #17)* — multi-hop fast-travel parked to [[per-player-map-exploration]] §9; rest-anywhere-safe is a fresh design question.
- [<] **Discord `@mention` of the character's owner** *(feedback #3 + #8, Flikker)* — MVP-deferred in [[prod-data-review-v0.2.3]]; worth re-weighing but not a bug.
- [<] **Auto-resolve *shaping*** *(feedback #6, "boring, anti-climactic")* — refund + ≤1-option guard shipped; the LLM-classifies-a-paragraph-as-no-choice half rides the v11 [[prompt-separation-of-concerns]] classify→decide→resolve work.
