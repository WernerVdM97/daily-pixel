---
title: "POC+ 0.3.1 — combat-readability polish & hardening release (build plan)"
status: decided
domain: engine
phase: poc
tags:
  - build-plan
  - ansi
  - combat
  - discord
  - bugfix
related:
  - "[[poc-plus-roadmap]]"
  - "[[poc-plus-stage-1-plan]]"
  - "[[mvp+ansi-art]]"
  - "[[ansi-art-classification-framework]]"
  - "[[prompt-v12-combat]]"
---
_Build plan for the `0.3.1` polish/hardening release: the interstitial cut between stage 1 (combat maths reveal, shipped) and stage 2 (nat 1/20 broadcast). It finishes the combat-readability arc by paying down the debt the T2 live check surfaced (the `ANSI frame polish` block in `TODO.md`), and folds in the 2026-07-08 prod bug batch plus a run of small UX wins. Deliberately bundled large so stage 2 opens against a clean, standardised renderer. Executor-grade contract for an orchestrated-delegation lead; anchors verified 2026-07-10 and will drift, so the lead re-verifies each while scouting before delegating._

---

# POC+ 0.3.1 — build plan

## Why this release exists

The T2 live check (2026-07-10) passed on content (colour good on desktop, clean monochrome on mobile) but surfaced styling and architecture debt in the very `AnsiRenderer` that stage 2's broadcast frames will reuse. Building broadcast frames on the current renderer (black `chrome`, no palette module, engine-composed frame strings) would mean throwing that work away twice. So this release standardises the renderer first, then ships it alongside a batch of cheap prod fixes and UX polish that were already queued. Stage 2 begins a fresh `0.3.x` on top.

Scope was chosen with the user 2026-07-10: **ANSI frame polish block + prod bug batch (B#1-B#4) + small UX polish**. NPC coherency (F#1) stays out for the next round.

## How to run

One loop per task, per the `orchestrated-delegation` skill: lead scouts and finalises the executor handoff, executor builds, lead verifies (baseline below plus the task's acceptance), commit, reviewer critiques adversarially, lead triages, fixer lands accepted findings, verify, commit. Branch `poc-plus/0.3.1-polish` off `dev`; atomic commit per task; merge to `dev` keeping the changelog current per merge; cut `0.3.1` at the end. Branching and release per the `releasing` skill; changelog per the `changelog` skill.

**Verification baseline (every task):** `npm run typecheck` clean, `npm test` green. Player-facing tasks additionally get one live check on the dev bot.

**Live-check batching:** several tasks need a human operator on Discord (the renderer/frame tasks especially, and ANSI-A which cannot be settled any other way). Build everything code-doable, then hand the operator one consolidated live-check script covering all pending visual verifications in a single session.

**Existing preview piping:** `scripts/send-ansi.ts` already DMs every `.ansi` file in `docs/assets/ansi/test/colour/` to the admin user as `ansi`-fenced blocks, so a visual check is self-serve: drop probe/frame `.ansi` files in that dir, run the script, eyeball the DM on desktop and mobile. Use it as the delivery for ANSI-A's probe frame and for batching the renderer/frame checks, rather than authoring a bespoke harness. Caveat: the script hardcodes the `/home/werner/...` Linux deploy-host paths (`.env` and the ANSI dir), so it runs on the host, not this dev Mac, until parameterised.

## Ordering & dependencies

The ANSI block is a chain; the bug and UX batches are independent and interleave freely (good candidates for parallel executors).

- **ANSI-A → ANSI-B → {ANSI-C → ANSI-D}, ANSI-F.** A settles the facts B needs; C decouples so D and F have a clean seam.
- ANSI-A is human-gated (live SGR test). B builds against the safe default (standard `ansi` 30-37 render; `chrome` moved off black to a readable role) and reconciles once A returns, so B is not hard-blocked.
- Bugs (B#1-B#4) and UX polish depend on nothing here.
- Release cut is last, gated on everything.

---

## Part 1 — ANSI frame polish (finishes the combat-readability arc)

Source of truth for the block is the `ANSI frame polish — T2 live-check follow-up (2026-07-10)` section in `TODO.md`; this plan tasks it. The block's doc-loop step (its item E) folds into each task's close, not a standalone task: every settled fact goes back into the `ansi-frames` skill and [[mvp+ansi-art]] as its task lands.

### ANSI-A — settle bright-SGR + palette facts (block item A)

**Description.** Two live-only questions block the renderer work. (1) The `ansi-frames` skill mandates `chrome=90` (bright), but [[mvp+ansi-art]] line 27 (live-tested) says only fg 30-37 render in a Discord `ansi` block. (2) [[mvp+ansi-art]] line 35's palette `[?]` (Solarized-ish vs standard ANSI hex) is unsettled. Both need one live session in a real Discord `ansi` code block.

**Deliverables:**

- A minimal probe frame exercising fg 30-37, bright 90-97, and the candidate bg codes, dropped as `.ansi` file(s) in `docs/assets/ansi/test/colour/` so `scripts/send-ansi.ts` delivers it to the admin DM (see "Existing preview piping" above), plus a written operator checklist ("does row X render in colour? on mobile?").
- After the verdict: correct the losing document (skill vs [[mvp+ansi-art]]), and record the settled palette hex in one place the renderer reads.

**Acceptance:**

- [ ] Operator confirms which SGR ranges render on desktop and mobile; the contradiction is resolved and the losing doc corrected.
- [ ] The palette `[?]` is settled and recorded.

**Scope fence:** investigation + doc correction only; the renderer change is ANSI-B.

### ANSI-B — renderer standardisation (block item B)

**Files:** `src/render/AnsiRenderer.ts` (`SGR` map at ~`:62`, `chrome: 30`).

**Deliverables:**

- Move `chrome` off `30` (black is unreadable on Discord's dark code-block background, seen live 2026-07-10) to whatever ANSI-A proves readable; default target is a mid-grey/white role until A returns.
- Extract the role→SGR map into a palette module: named universal palettes (a house default plus mood variants), the renderer takes a palette, and each frame declares which palette it uses (skill §1 "palette first").
- Prettier borders per the skill's border vocabulary (§2 chrome, ornamental rim, crest interrupt for special frames). Box-drawing needs a mobile render check first (flagged unverified in the skill §1), so gate any box-drawing borders on that check.

**Acceptance:**

- [ ] `chrome` renders readably on Discord dark bg (live).
- [ ] Palette lives in its own module; the renderer is palette-driven; existing combat frame unchanged in output except the chrome colour.
- [ ] Width (≤30 pre-colour) and char-budget (<2000 incl. fences) tests still green.

### ANSI-C — decouple render from engine (block item C)

**Files:** `src/engine/action/PipelineActionStateMachine.ts` (`composeCombatStatus` ~`:1196`, call site ~`:661`), `src/engine/OutcomeRenderer.ts`, the Discord presentation layer.

**Description.** The engine currently composes a rendered ANSI string and persists it in state JSON (`pendingDecision.combatStatus`). Move composition to the presentation side: the engine emits structured combat status (band word, pips fraction, player hp/max/delta) on `ActionDecision`; the Discord layer composes the frame. In-flight actions carry the old string, so the read must tolerate both shapes. Rehome the `OutcomeRenderer` → `AnsiRenderer` dependency on the same principle, so `src/render/` is imported only from the presentation side.

**Acceptance:**

- [ ] `ActionDecision` carries structured combat status; no rendered ANSI string is persisted in state going forward.
- [ ] A pre-existing in-flight state (old string) still renders without throwing (tolerant read, covered by a test).
- [ ] `src/render/` has no engine-side importer.

### ANSI-D — combat visibility, per-round maths (block item D)

**Description.** Every roll should be visible when it happens. Today the continue frame renders HP bands only (no dice line), the first beat has no frame, and a fight that resolves on its first choice shows only the terminal frame, so rolls are only ever visible at the end. Track every round (append `{roll, bonus, dc, margin, band, enemyHpDelta, playerHpDelta}` to a combat round log on `CombatState` or the decision record, instead of discarding the transient `roundResult`), surface the round's maths between decisions, and de-noise the terminal frame per the skill §12 data-card hierarchy (dim label, focal number, calc line, colour-coded outcome, flavour), dropping what the embed's stats footer already shows.

**Acceptance:**

- [ ] A per-round log persists each round's maths; nothing is discarded.
- [ ] The dice line is visible on the continue frame and the first beat, not only at the end (live).
- [ ] The terminal frame stops duplicating the embed stats footer.
- [ ] Closes the `TODO.md` "combat still isn't shown good, list each dice roll/outcome per decision" item.

**Depends on:** ANSI-C (composes frames from structured status).

### ANSI-F — opening frame + art-post delivery (block item F, scoped)

**Description.** The opening frame (post-`classify`, pre-first-decision scene-setter) and the universal art-post + reply-body delivery convention, both specced in [[ansi-art-classification-framework]] §2b/§2c/§3.0, with wireframes in `assets/ansi/wireframes/`.

**Scope decision (settle at task start):** the opening frame's sprite/scene slots need the `fragments` catalogue (§9), which is mvp+/deferred, so `skill`/`other`/`travel` openers can only be placeholder scenes for now. **Default for this release: ship the art-post + reply-body delivery change only** (frame as its own message, narration/options/speech as a reply beneath), and defer the per-type opening register until fragments exist. The lead confirms this reduction before building; if fragments are judged in-scope, expand then.

**Depends on:** ANSI-B (palette + readable chrome). Relates to ANSI-C (the two-message delivery is a presentation change, not an engine one).

**Acceptance:**

- [ ] (Reduced default) The frame posts as its own message with the narration/options as a reply, on the combat surface; live-checked.
- [ ] Any deferral is logged in `TODO.md` and [[ansi-art-classification-framework]].

---

## Part 2 — prod bug batch (2026-07-08 QA)

Independent of Part 1; each its own commit; snapshot `warden-20260708-201456`, character BendiusOver.

### B#2 — persist `max_stamina` (repo allow-list)

`CharacterRepository.update`'s field allow-list omits `max_stamina`, so a `+N` max-stamina gain never persists (player saw `+2`, `/stats` still showed base). This is also the MVP allow-list item surfacing in prod. Add `max_stamina` to the allow-list, audit the list against the schema for other gaps, and drop the `src/sim/driver.ts` raw-SQL workaround that routes around it.

- [ ] `max_stamina` persists through the repo; sim harness no longer needs raw SQL; allow-list audited.

### B#1 — action-count footer mismatch

Footer showed `-1` but total 4 actions when the player was on 3 previously. Reconcile the remaining-actions delta vs the total display.

- [ ] The footer's delta and total agree with the actual remaining-actions count across a multi-action day.

### B#3 — verify inspiration accounting

Player suspected inspiration never decrements / is unbounded. Verify the spend/grant accounting end to end; fix a leak if one exists, otherwise record why it is correct so the report can be closed.

- [ ] Inspiration spend and grant are accounted correctly, proven by a test or a written trace.

### B#4 — make item loss read as a loss

A dropped/consumed item just appears listed, not visibly removed or subtracted. Make item-loss mutations read as a loss in the outcome. Overlaps [[improved-item-features]].

- [ ] A remove/consume-item mutation renders as a visible loss in the outcome.

---

## Part 3 — small UX polish

Independent; each its own commit. Sourced from the `TODO.md` TBD list and the 2026-07-08 feedback rows.

### F#3 — trim decision emojis

Too many emojis after decisions. The good/bad DC emojis should show only the arrows that convey stakes (drop the green/red); a spotted passive call should just colour the button green (as it already does) without also listing the emoji. Relates to the distilled-type-emoji TODO item.

- [ ] Decision options show only the stakes arrows; spotted passive is button-colour only; no redundant green/red emoji.

### F#8 — give the rest button weight

The rest button feels underwhelming and its formatting is off; give it some interaction/weight when pressed. Verify the linked bug: an autoresolved rest showed refunded but no inspiration text.

- [ ] Rest reads with weight and correct formatting; inspiration text shows when granted.

### F#6 — declutter the journal

Whitespace/formatting to distinguish parts and emphasise successes vs failures, plus a little more info on quests / investigated / gathered intel.

- [ ] Journal sections are visually distinct; successes vs failures are emphasised; quest/intel info added.

### Join-screen formatting

Improve formatting around the inline skills next to class/race/upbringing (more line feeds and bold), and show the emojis of the chosen class/upbringing/race in the selected crossed-out list.

- [ ] Inline skills are readable; chosen options show their emoji in the selected list.

### Morning/evening prose + action hints + custom-action thinking screen

Morning and evening messages get custom prose or an interesting message (maybe art). The initial `/action` message gains hints (one action remaining, low stamina, unsafe location). Custom (free-text) actions get a real "thinking" screen (three dots + "thinking…") as its own page, matching the preset day-job loading envelope.

- [ ] Morning/evening messages carry custom prose; `/action` shows relevant hints; the custom-action path shows a thinking screen before `engine.startAction`.

---

## Release cut (0.3.1)

Once the bundle is on `dev` and the changelog is current, per the `releasing` skill:

- [ ] Merge `dev` → `main` (`--no-ff`).
- [ ] Bump `VERSION` `0.3.0` → `0.3.1`; sync `package.json` `"version"`.
- [ ] Promote `[Unreleased]` → `[0.3.1]` with today's date.
- [ ] Add `assets/release-notes/v0.3.1.yml` (player-facing highlights: combat maths now clearer, the bug fixes, the UX wins; non-technical).
- [ ] Tag `v0.3.1`, push the tag.

## Scope fences

- [>] No stage-2 broadcast plumbing (nat 1/20 global broadcast is the next release).
- [>] No splash or block-letter fonts ([[mvp+ansi-art]] §4 stays deferred).
- [>] No prompt-template changes.
- [>] NPC coherency (F#1, mint-on-first-sight) is deferred to the next round.
- [>] The `fragments` catalogue stays mvp+; ANSI-F ships the delivery change only unless the lead expands it.
- [>] Non-combat outcomes keep their scene art (unchanged from stage 1).

## Doc loop (stage exit)

- [ ] All task acceptance boxes green; typecheck + suite green; live-check batch run.
- [ ] `TODO.md`: the ANSI polish block, the B#1-B#4 rows, and the UX rows struck.
- [ ] Settled ANSI facts folded into the `ansi-frames` skill and [[mvp+ansi-art]]; the stage-1 plan's T2 live-check box ticked with the border defect logged.
- [ ] [[poc-plus-roadmap]] tracking updated (this polish release recorded before stage 2); map of content current.
- [ ] Recommend `/clear`, then resume with the stage-2 one-liner.
