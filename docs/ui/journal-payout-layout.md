---
title: Journal Payout Layout
status: exploring
domain: ui
phase: poc
tags:
  - discord
  - layout
  - mobile
  - journal
  - payouts
related:
  - "[[poc-discord-ux]]"
  - "[[visual-craft]]"
  - "[[poc-action-ux-refinements]]"
  - "[[discord-window-size]]"
---
_Three candidate layouts for putting a day-job's payout on the outcome view, mocked at 30 columns so the shape is picked before the number is built._

---

# Journal Payout Layout

> *The payout exists. It is one unlabelled segment at the end of a receipt-shaped footer, and nothing that ranks verbs can see it. This doc is the shape decision, not the build.*

## The gap the layout has to close

- **The number is there, unlabelled.** `formatOutcome` (`src/engine/OutcomeRenderer.ts`) derives the deltas from `outcome.mutations` and prints the coin as the last segment of one run-on inline-code line: `⚡ 9/10  ┃  🎲 2 (-1)  ┃  💰 43 (+3)` — and only when the purse actually changed. Read at a glance it is a receipt, not a result.
- **The agent's text inherits the same footer.** `outcomeToText` (`src/agent/viewToText.ts`) appends `view.outcomeBlock`, so the copper reaches the transcript — inside that footer, beside stamina and rolls, where nothing distinguishes pay from cost.
- **The day log drops it entirely.** `summarizeOutcome` (`src/agent/turnContext.ts`) keeps the first content line of the rendered text, which is the title `{emoji} {title.text}`. A day's log is therefore a list of verbs, and the Grinder's own quit trigger — is the reward curve flattening? — has nothing to measure.
- **`/journal` has no slot for it at all.** The chronicle (`composeJournalScreen`, `src/controller/journalScreen.ts`) prints place, narrative and a verdict per action, and `JournalAction` (`src/engine/WorldEngine.ts`) carries no payout field; its only derived facts are `discoveries`.
- **There is no XP in the engine yet.** No `modify_xp` mutation and no experience field on `CharacterData`: the owner's "money and xp values" is one value today, and the layout should leave the slot without spending cells on it.

## The sample action

All three mocks render **the same action**, at 30 columns or narrower ([[discord-window-size]]), so only the layout differs.

`Stand the gate` — Town Guard day job, `income: 3` in `assets/char-creation/day-jobs.yml`, paid in full on a success by `SessionController.runWork`. The roll resolves `16 vs 14` → success; the purse goes `40 → 43`; stamina is `9/10` and unchanged; rolls go `3 → 2`, since a resolved roll always costs one.

Each mock shows the message title — the line the day log picks up — and the outcome block beneath it, monochrome and SGR-free, because colour is enhancement and never signal ([[visual-craft]]). The chrome around it (location line, breadcrumb, story thread) is identical in all three and dropped here. Glyphs are illustrative; the title's comes from `distilledActionEmoji(outcome.distilledType)`, so a work action may well land on the `✴️` fallback.

## Option A — right-aligned table rows

The owner's first proposal, the footer turned into a table: one labelled row per fact, every value right-aligned to column 30, the payout owning its own row so it can never be read as part of a run-on line. It stays where the footer already is, at the bottom of the block, under the separator [[poc-action-ux-refinements]] already puts above the stats.

```
✅ Stand The Gate

You hold the gate, marking
who comes and goes.

──────────────────────────────
  roll             16 vs 14 ✅
  stamina                 9/10
  rolls                 2 (-1)
  💰 purse             43 (+3)
```

| Aspect | Reading |
| --- | --- |
| Mobile legibility | `[p]` one fact per line, nothing has to wrap inside a 30-col block. `[c]` the label column spends 9 of 30 cells, and the row that carries 💰 gives up two more to the emoji, so the value column is the narrowest of the three options. |
| Scan-ability | `[p]` the payout is a *named* row with a fixed column, so a week of outcomes lines up number-under-number once the chronicle reuses the shape. `[c]` four rows of chrome on every outcome, including the fights and recons that paid nothing. |
| Rendering cost | `OutcomeRenderer`: a new per-row composer with a target width constant and `padStart` alignment; `deriveFromMutations` and `formatDelta` are reused unchanged, so there is still one derivation of the delta. `outcomeToText`: none — it appends the block, so the table rides along for free. The day log still sees the title first, so the coin needs its own path there (see below). |

## Option B — indented subline

The owner's second proposal, a subline under the journal entry: the payout leaves the footer and becomes one indented line under the outcome prose, as an aside reads under a chronicle entry, while the footer keeps the resource counts it already reports.

```
✅ Stand The Gate

You hold the gate, marking
who comes and goes.
  💰 purse 43 (+3) copper

⚡ 9/10  ┃  🎲 2 (-1)
```

| Aspect | Reading |
| --- | --- |
| Mobile legibility | `[p]` one short line with no padding to break when Discord wraps it, so it survives any width and any font. `[c]` a two-cell indent is a weak separator: on a full message the line reads as the last sentence of the prose, and the footer below it still competes for the eye. |
| Scan-ability | `[p]` it reads as a sentence-level aside, in the position a reader already is after the narration. `[c]` no column, so numbers start wherever the prose stopped — ranking verbs by eye means reading every line, and the shape gives the chronicle nothing to align to. |
| Rendering cost | `OutcomeRenderer`: the cheapest — one appended line after `outcome.outcomeText` and the `💰` segment removed from the stats line; no width arithmetic, no new helper. `outcomeToText`: none. Cost is carried elsewhere: a second payout-shaped convention now exists beside the footer, so anything that later wants the coin in the stats line has two places to look. |

## Option C — ledger line under the headline

The third option, triage's proposal: a fixed-width ledger line sits directly under the outcome headline, above the prose — costs left, gains right-aligned to the 30-col safe width, the payout ending the line. It replaces the `┃` footer rather than adding to it, and it borrows the combat round ledger's rule that the number that matters floats right ([[visual-craft]], *float for clarity*).

```
✅ Stand The Gate
──────────────────────────────
⚡ 9/10  🎲 2       💰 43 (+3)

You hold the gate, marking
who comes and goes.
```

| Aspect | Reading |
| --- | --- |
| Mobile legibility | `[p]` the payout sits at the right edge, where a 30-col reader's eye already lands, and costs never share a word with it. `[c]` the line is full at 30 with two costs and a payout, so an item, a second currency or a future XP row needs a second ledger line; below 30 columns it wraps mid-group and the alignment collapses. |
| Scan-ability | `[p]` costs left, gain right — the shape is read in one fixation, and it is the first thing under the headline rather than the last thing in the block. `[c]` one dense line at the top of the message can read as chrome unless the rule above it is always drawn, including on outcomes that paid nothing. |
| Rendering cost | `OutcomeRenderer`: the existing stats line is rewritten in place (alignment composer plus the width constant) instead of added to, so the footer's current tests change with it; `deriveFromMutations` and `formatDelta` are reused. `outcomeToText`: none. The day log still needs the coin plumbed in, as in A and B. |

## The surfaces the pick also settles

The outcome block is only one of the three places the coin has to appear; the choice above is the convention the other two follow.

- **The harness day log** (`summarizeOutcome` + `buildDayLog`, `src/agent/turnContext.ts`) reads the first content line, so a layout that leaves the payout below the title does not reach it. Either the title line carries the coin (`✅ Stand The Gate · 💰 +3`) — which is the cheapest place, and what the parallel implementation card asserts — or `summarizeOutcome` learns to append it.
- **The `/journal` chronicle** has no payout to render: `JournalAction` would need one plumbed through `getJournal`, derived the way `discoveries` already is from the action's mutations. Its existing `└─` rail under the entry is the natural home, whichever layout wins.

## Open questions

- [?] Delta first or total first? The rest of the game prints `💰 <total> (+<delta>)` (`formatDelta`), but a Grinder ranks verbs on the delta, and `43 (+3)` buries it.
- [?] Does the purse belong on the outcome at all, or only the delta? The purse is the number a player checks anyway on `/stats`.
- [?] What does an outcome that paid nothing draw — the rule with an empty ledger, the unchanged footer, or nothing at all?
- [?] When the game grows XP, does it take a row (A), a subline (B) or a second ledger line (C)?
- [<] The owner's pick lands as a comment on #136 and decides the shape the implementation card builds.

---

Further reading: [[poc-discord-ux]] (mobile constraints and emoji discipline), [[discord-window-size]] (the 60 × 32 measured budget and the 30-col safe width), [[visual-craft]] (float for clarity, monochrome is the asset), [[poc-action-ux-refinements]] (the standardised footer this doc revises).
