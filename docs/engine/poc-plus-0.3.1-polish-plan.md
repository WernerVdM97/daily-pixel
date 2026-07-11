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

Scope was chosen with the user 2026-07-10: **ANSI frame polish block + prod bug batch (B#1-B#4) + small UX polish**. NPC coherency (F#1) stays out for the next round. At plan review (same day) ANSI-F was expanded from delivery-only to full opening-frame scope: all seven classified types, placeholder scenes for fragment-gated slots.

## How to run

One loop per task, per the `orchestrated-delegation` skill: lead scouts and finalises the executor handoff, executor builds, lead verifies (baseline below plus the task's acceptance), commit, reviewer critiques adversarially, lead triages, fixer lands accepted findings, verify, commit. Branch `poc-plus/0.3.1-polish` off `dev`; atomic commit per task; defer merge to `dev` but keep the changelog current per task; merge at the end; changelog per the `changelog` skill.

**Verification baseline (every task):** `npm run typecheck` clean, `npm test` green. Player-facing tasks additionally get one live check on the dev bot.

**Live-check batching:** several tasks need a human operator on Discord (the renderer/frame tasks especially, and ANSI-A which cannot be settled any other way). Build everything code-doable, then hand the operator one consolidated live-check script covering all pending visual verifications in a single session.

**Existing preview piping:** two scripts pipe output to the admin DM for a self-serve visual check, rather than authoring a bespoke harness. `scripts/send-ansi.ts` batch-DMs every `.ansi` file in `docs/assets/ansi/test/colour/` as `ansi`-fenced blocks (drop probe/frame files in that dir, run it, eyeball the DM on desktop and mobile) — use it as the bulk delivery for ANSI-A's probe frame and for batching the renderer/frame checks. (Parameterised to repo-relative paths and given a single-width validation gate in `e4125cf`, so it runs on the dev Mac and the host unchanged.) `scripts/send-dm.ts` (`npm run send-dm`) is the general-purpose complement: it DMs one arbitrary message from a CLI arg, a file, or piped stdin (with optional `--fence ansi`/`--title`), and exports `sendToAdmin(payload)` so a throwaway tsx script can import a real `src/` builder (`AnsiRenderer.renderFrame`, `buildDecisionMessage`, an embed) and post its actual rendered output for manual validation. It resolves `.env` relative to the repo, so it runs on the dev Mac and the host unchanged — reach for it whenever a task needs one structured/rendered artefact checked rather than a directory of static `.ansi` files.

## Ordering & dependencies

The ANSI block is a chain; the bug and UX batches are independent and interleave freely (good candidates for parallel executors).

- **ANSI-A → ANSI-B → ANSI-C → {ANSI-D, ANSI-F}.** A settles the facts B needs (SGR ranges, palette hex, box-drawing on mobile); C decouples render from engine so D and F compose their frames presentation-side.
- ANSI-A is human-gated (live SGR + glyph test). B builds against the safe default (standard `ansi` 30-37 render; `chrome` moved off black to a readable role) and reconciles once A returns, so B is not hard-blocked; only B's border step waits on A's box-drawing verdict.
- Bugs (B#1-B#4) and UX polish depend on nothing here.
- Release cut is last, gated on everything.

---

## Part 1 — ANSI frame polish (finishes the combat-readability arc)

Source of truth for the block is the `ANSI frame polish — T2 live-check follow-up (2026-07-10)` section in `TODO.md`; this plan tasks it. The block's doc-loop step (its item E) folds into each task's close, not a standalone task: every settled fact goes back into the `ansi-frames` skill and [[mvp+ansi-art]] as its task lands.

### ANSI-A — settle bright-SGR + palette + glyph facts (block item A)

**Description.** Three live-only questions block the renderer work. (1) The `ansi-frames` skill mandates `chrome=90` (bright), but [[mvp+ansi-art]] line 27 (live-tested) says only fg 30-37 render in a Discord `ansi` block. (2) [[mvp+ansi-art]] line 35's palette `[?]` (Solarized-ish vs standard ANSI hex) is unsettled. (3) [[mvp+ansi-art]] line 33's `[?]` — do box-drawing/half-block glyphs stay single-width on mobile fonts — gates ANSI-B's border step. All three settle in one live session in a real Discord `ansi` code block.

**Probe contract.** The probe frame(s) exercise, each as a labelled row: fg `30-37`; bright `90-97`; bg `40-47`; a glyph row (`═ ║ ─ │ █ ▀ ▄ ▌ ▐ ░ ▒ ▓` plus box corners) against a width ruler so single-width holds can be read off directly; and a labelled colour-comparison row to settle Solarized-ish vs standard ANSI hex.

**Deliverables:**

- Probe `.ansi` file(s) per the contract above, dropped in `docs/assets/ansi/test/colour/` so `scripts/send-ansi.ts` delivers them to the admin DM (see "Existing preview piping" above), plus a written operator checklist mirroring the probe rows ("does row X render in colour? on mobile? do the glyphs align with the ruler?").
- After the verdict: correct the losing document (skill vs [[mvp+ansi-art]]), resolve the line 33 and line 35 `[?]` markers, and record the settled palette hex in the palette module's doc comment (the renderer reads roles→SGR; hex exists for colour-matching embeds and docs, never read at render).

**Acceptance:**

- [ ] Operator confirms which SGR ranges render on desktop and mobile; the contradiction is resolved and the losing doc corrected.
- [ ] The palette `[?]` is settled and recorded.
- [ ] The box-drawing/half-block mobile verdict is recorded (un-gates ANSI-B's border step).

**Scope fence:** investigation + doc correction only; the renderer change is ANSI-B.

### ANSI-B — renderer standardisation (block item B)

**Files:** `src/render/AnsiRenderer.ts` (`SGR` map at `:62-69`, `chrome: 30` at `:63`), new `src/render/palette.ts`.

**Contract.** `src/render/palette.ts` owns the colour vocabulary: `Role` moves there from `AnsiRenderer.ts`, alongside

```ts
export interface Palette { name: string; sgr: Record<Role, number>; }
export const PALETTES: Record<string, Palette>; // 'house' default + mood variants (e.g. ember, gloom)
```

`renderFrame(spec, palette = PALETTES.house)`: the renderer takes a palette, each frame declares which it uses (skill §1 "palette first"), and the settled hex from ANSI-A lives in the module's doc comment.

**Deliverables:**

- Move `chrome` off `30` (black is unreadable on Discord's dark code-block background, seen live 2026-07-10) to whatever ANSI-A proves readable; default target is a mid-grey/white role until A returns.
- Extract the role→SGR map into the palette module per the contract above.
- Prettier borders per the skill's border vocabulary (§2 chrome, ornamental rim, crest interrupt for special frames), gated on ANSI-A's box-drawing mobile verdict.

**Acceptance:**

- [ ] `chrome` renders readably on Discord dark bg (live).
- [ ] Palette lives in its own module; the renderer is palette-driven; the existing combat frame's output is byte-identical except the chrome colour.
- [ ] Border prettification landed (or explicitly deferred on a negative box-drawing verdict), with its output changes live-checked.
- [ ] Width (≤30 pre-colour) and char-budget (<2000 incl. fences) tests still green.

### ANSI-C — decouple render from engine (block item C)

**Files:** `src/engine/action/PipelineActionStateMachine.ts` (`composeCombatStatus` ~`:1196`, call site ~`:661`), `src/engine/OutcomeRenderer.ts`, the Discord presentation layer.

**Description.** The engine currently composes a rendered ANSI string and persists it in state JSON (`pendingDecision.combatStatus`). Move composition to the presentation side: the engine emits structured combat status on `ActionDecision` per the contract below; the Discord layer composes the frame. In-flight actions carry the old string, so the read must tolerate both shapes. Rehome the `OutcomeRenderer` → `AnsiRenderer` dependency on the same principle, so `src/render/` is imported only from the presentation side.

**Contract.**

```ts
export interface CombatStatusData {
  enemyName: string;
  woundWord: string;              // banded, never exact HP
  pips: { filled: number; total: number };
  playerHp: number;               // clamped >= 0
  playerMaxHp: number;
  playerHpDelta: number;
}
// ActionDecision.combatStatus?: CombatStatusData | string
// string = legacy in-flight shape; the presentation layer renders either (tolerant read)
```

The engine keeps the banding maths (`enemyConditionBand` yields `woundWord` + `pips.filled`) and emits `CombatStatusData`; `composeCombatStatus`'s frame assembly (glyphs, `renderFrame`) moves beside its consumer, `buildDecisionMessage` in `src/discord/commands/action.ts` (~`:522`).

**Acceptance:**

- [x] `ActionDecision` carries structured combat status; no rendered ANSI string is persisted in state going forward. → **Done** (`62cc332`): `CombatStatusData` on the WorldEngine seam.
- [x] A pre-existing in-flight state (old string) still renders without throwing (tolerant read, covered by a test). → **Done** (`62cc332`).
- [x] `src/render/` has no engine-side importer. → **Done** (`62cc332`, grep-proven; OutcomeRenderer takes an injected frame renderer).

### ANSI-D — combat visibility, per-round maths (block item D)

**Description.** Every roll should be visible when it happens. Today the continue frame renders HP bands only (no dice line), the first beat has no frame, and a fight that resolves on its first choice shows only the terminal frame, so rolls are only ever visible at the end. Track every round per the contract below, surface the round's maths between decisions, and de-noise the terminal frame per the data-card hierarchy (skill §2 "data cards", following [[mvp+ansi-art]] §12's roll-card reference: dim label, focal number, calc line, colour-coded outcome, flavour), dropping what the embed's stats footer already shows.

**Contract.** The round log extends the existing per-beat telemetry rather than minting a parallel type: `CombatBeatLog` (`src/engine/action/combat-dc.ts:29`, emitted on the outcome at `WorldEngine.ts:172`) gains the maths fields it lacks (`playerD20`, `playerBonus`, `dc`, `enemyD20`, `enemyBonus`, `margin` — lifted from the transient `CombatRoundOutcome` instead of discarding it), and the accumulated per-fight list persists on the pending-decision record, NOT on the `in_combat` edge props (those stay lean and clamp-validated, see `combat-state.ts`).

**Mocks first.** Continue-card and terminal-card wireframes (`combat-continue.slots.ascii` beside a filled `combat-continue.ascii`, the same pair for `combat-terminal`) land in `assets/ansi/wireframes/` before the frame code, width-validated (extend `tests/render/opening-wireframes.test.ts` or sibling it) and indexed in the wireframes README — closing the TODO wireframe row's "still to mock" list bar the stage-2 broadcast frame.

**Acceptance:**

- [ ] A per-round log persists each round's maths; nothing is discarded.
- [ ] The dice line is visible on the continue frame and the first beat, not only at the end (live).
- [ ] The terminal frame stops duplicating the embed stats footer.
- [ ] Continue + terminal card mocks exist, width-tested and indexed; the frame code follows them.
- [ ] Closes the `TODO.md` "combat still isn't shown good, list each dice roll/outcome per decision" item.

**Depends on:** ANSI-C (composes frames from structured status).

### ANSI-F — opening frame + art-post delivery (block item F, full scope)

**Description.** The opening frame (post-`classify`, pre-first-decision scene-setter) and the universal art-post + reply-body delivery convention, both specced in [[ansi-art-classification-framework]] §2b/§2c/§3.0, with wireframes for all seven types in `assets/ansi/wireframes/`.

**Scope decision (settled 2026-07-10, plan review):** ship the full scope — the opening frame for all seven classified types plus the delivery convention (frame as its own message, narration/options/speech as a reply beneath). The `fragments` catalogue (§9) stays mvp+/deferred, so fragment-gated sprite/scene slots render as placeholder scenes (PC sprite only) per the wireframes until it exists; placeholders must read as deliberate, not broken.

**Depends on:** ANSI-B (palette + readable chrome) and ANSI-C (frames composed presentation-side; the two-message delivery is a presentation change, not an engine one).

**Acceptance:**

- [ ] The opening frame posts post-`classify` as its own message with the narration/options as a reply, for all seven classified types; live-checked.
- [ ] Fragment-gated slots render placeholder scenes per the wireframes; the fragments catalogue remains deferred, logged in `TODO.md` and [[ansi-art-classification-framework]].

---

## Part 2 — prod bug batch (2026-07-08 QA)

Independent of Part 1; each its own commit; snapshot `warden-20260708-201456`, character BendiusOver.

### B#2 — persist `max_stamina` (repo allow-list)

`CharacterRepository.update`'s field allow-list omits `max_stamina`, so a `+N` max-stamina gain never persists (player saw `+2`, `/stats` still showed base). This is also the MVP allow-list item surfacing in prod. Add `max_stamina` to the allow-list, audit the list against the schema for other gaps, and drop the `src/sim/driver.ts` raw-SQL workaround that routes around it.

- [x] `max_stamina` persists through the repo; sim harness no longer needs raw SQL; allow-list audited. → **Done** (`7513181`): allow-list gains `max_stamina`, schema audit found no other gap, raw-SQL workaround dropped.

### B#1 — action-count footer mismatch

Footer showed `-1` but total 4 actions when the player was on 3 previously. Reconcile the remaining-actions delta vs the total display.

- [x] The footer's delta and total agree with the actual remaining-actions count across a multi-action day. → **Resolved by B#3** (`807bb13`, recorded `c491f94`): the mismatch was the auto-resolve rolls-grant clobbering the start drain, not a display bug; impossible on every resolved path now.

### B#3 — verify inspiration accounting

Player suspected inspiration never decrements / is unbounded. Verify the spend/grant accounting end to end; fix a leak if one exists, otherwise record why it is correct so the report can be closed.

- [x] Inspiration spend and grant are accounted correctly, proven by a test or a written trace. → **Leak found and fixed** (`807bb13`): the auto-resolve branch applied a `modify_rolls_remaining` grant off the stale pre-drain value, so the start drain was clobbered (3 rolls → 4). Drain now applied to the in-memory row before the outcome, mirroring the step path; regression-tested.

### B#4 — make item loss read as a loss

A dropped/consumed item just appears listed, not visibly removed or subtracted. Make item-loss mutations read as a loss in the outcome. Overlaps [[improved-item-features]].

- [x] A remove/consume-item mutation renders as a visible loss in the outcome. → **Done** (`d660b19`, tests `4cddda3`): losses render with a real minus glyph (`−`), mirroring the gain format (emoji, `×N`), never a Discord list bullet.

---

## Part 3 — small UX polish

Independent; each its own commit. Sourced from the `TODO.md` TBD list and the 2026-07-08 feedback rows.

### F#3 — trim decision emojis

Too many emojis after decisions. The good/bad DC emojis should show only the arrows that convey stakes (drop the green/red); a spotted passive call should just colour the button green (as it already does) without also listing the emoji. Relates to the distilled-type-emoji TODO item.

- [x] Decision options show only the stakes arrows; spotted passive is button-colour only; no redundant green/red emoji. → **Done** (`4815832`); live check batched.

### F#8 — give the rest button weight

The rest button feels underwhelming and its formatting is off; give it some interaction/weight when pressed. Verify the linked bug: an autoresolved rest showed refunded but no inspiration text.

- [x] Rest reads with weight and correct formatting; inspiration text shows when granted. → **Done** (`e426bc4`): nav:sleep gets an immediate "Bedding down…" beat, the rest body splits into sections, and the inspired line's `!rollRefunded` gate is dropped (refund and grant render together, regression-tested). Live check batched.

### F#6 — declutter the journal

Whitespace/formatting to distinguish parts and emphasise successes vs failures, plus a little more info on quests / investigated / gathered intel.

- [x] Journal sections are visually distinct; successes vs failures are emphasised; quest/intel info added. → **Done** (`3114411`): separator-bound Chronicle/NPCs sections, bold outcome tags, intel rails parsed from the already-stored `applied_mutations` (no new tracking). Live check batched.

### Join-screen formatting

Improve formatting around the inline skills next to class/race/upbringing (more line feeds and bold), and show the emojis of the chosen class/upbringing/race in the selected crossed-out list.

- [x] Inline skills are readable; chosen options show their emoji in the selected list. → **Done** (`311369f`): label / blockquoted bonuses / description on their own lines; ledger emoji looked up on the raw persisted value with a graceful miss. Live check batched.

### Morning/evening prose

Morning and evening messages get custom prose or an interesting message (maybe art).

- [x] Morning/evening messages carry custom prose. → **Done** (`4570bf6`): shared pure builders in `src/discord/announcements.ts`, flavour rotated deterministically by day; cron posts and the admin `/sleep` tick can no longer drift. Live check batched.

### `/action` hints

The initial `/action` message gains hints (one action remaining, low stamina, unsafe location).

- [x] `/action` shows relevant hints. → **Done** (`e6bd651`): shared `buildActionHints` on both the slash and nav paths (last action / low stamina ≤25% floored at 2 / unsafe location). Live check batched.

### Custom-action thinking screen

Custom (free-text) actions get a real "thinking" screen (three dots + "thinking…") as its own page, matching the preset day-job loading envelope (`action.ts:204`); today the custom-modal path shows nothing before `engine.startAction`.

- [x] The custom-action path shows a thinking screen before `engine.startAction`. → **Done** (`f5069ec`): player's clipped text + ⏳ Thinking beat; errors clear the thinking page. Live check batched.

---

## Release cut (0.3.1)

Once the bundle is all user accpeted and the changelog is current:

- [ ] Bump `VERSION` `0.3.0` → `0.3.1`; sync `package.json` `"version"`.
- [ ] Promote `[Unreleased]` → `[0.3.1]` with today's date.
- [ ] Add `assets/release-notes/v0.3.1.yml` (player-facing highlights: combat maths now clearer, the bug fixes, the UX wins; non-technical).
- [ ] Tag `v0.3.1`, push the tag.
- [ ] prompt user to cmplete the merge

## Scope fences

- [>] No stage-2 broadcast plumbing (nat 1/20 global broadcast is the next release).
- [>] No splash or block-letter fonts ([[mvp+ansi-art]] §4 stays deferred).
- [>] No prompt-template changes.
- [>] NPC coherency (F#1, mint-on-first-sight) is deferred to the next round.
- [>] The `fragments` catalogue stays mvp+; ANSI-F's fragment-gated slots ship as placeholder scenes (PC sprite only) per the wireframes.
- [>] The stage-2 broadcast-frame mock stays out; ANSI-D mocks the continue and terminal cards only.
- [>] Non-combat outcomes keep their scene art (unchanged from stage 1).

## Doc loop (stage exit)

- [ ] All task acceptance boxes green; typecheck + suite green; live-check batch run.
- [ ] `TODO.md`: the ANSI polish block, the B#1-B#4 rows, and the UX rows struck.
- [ ] Settled ANSI facts folded into the `ansi-frames` skill and [[mvp+ansi-art]]; the stage-1 plan's T2 live-check box ticked with the border defect logged.
- [ ] [[poc-plus-roadmap]] tracking updated (this polish release recorded before stage 2); map of content current.
- [ ] Recommend `/clear`, then resume with the stage-2 one-liner.
