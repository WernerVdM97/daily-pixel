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

All three mocks render **the same action**, at 30 columns or narrower ([[discord-window-size]]), and show the same four facts — title, verdict, prose, resource counts — so only the layout differs.

`Stand the gate` — Town Guard day job, `income: 3` in `assets/char-creation/day-jobs.yml`, paid in full on a success by `SessionController.runWork`. The roll resolves `16 vs 14` → success; the purse goes `40 → 43`; stamina is `9/10` and unchanged; rolls go `3 → 2`, since a resolved roll always costs one.

Each mock shows the message title — the line the day log picks up — and the outcome block beneath it, monochrome and SGR-free, because colour is enhancement and never signal ([[visual-craft]]). The chrome around it (location line, breadcrumb, story thread) is identical in all three and dropped here.

Two of those lines are not free-form:

- **The title is the distilled verb, not the action's label.** It is `{ emoji: distilledActionEmoji(distilledType), text: capitalize(distilledType) }` (`src/view/actionViewState.ts`), and DECIDE defines `distilledType` as a single lowercase word (`assets/prompts/decision-prompts/v14/decide/BASE.md`). `Stand the gate` is the job's option label; what renders — and what the day log picks up — is `✴️ Labour`, on the fallback glyph because no keyword matches "labour".
- **The verdict line survives in all three, in the renderer's own words.** `formatOutcome` (`src/engine/OutcomeRenderer.ts`) opens the block with `🎲 16  vs  14  →  ✅ **SUCCESS**`, above the prose, and the `SUCCESS` word is all that carries the verdict once the colour strip is gone ([[visual-craft]]). Folding the roll into a table row drops that word, so no option does: A builds only the footer into a table, B and C leave the verdict where it is.

## Option A — right-aligned table rows

The owner's first proposal, the footer turned into a table: one labelled row per footer fact, every value right-aligned to column 30, the payout owning its own row so it can never be read as part of a run-on line. It stays at the bottom of the block, where the footer is now, under a rule the block does not draw today: a literal 30-cell `─` run, added with the table and costing one line. [[poc-action-ux-refinements]] §3 calls for such a separator between narrative and footer and `formatOutcome` has never emitted it; the house `SEPARATOR` cannot be it either, because `src/discord/format.ts` turns that into a components divider, which cannot live inside a code span.

```
✴️ Labour

🎲 16  vs  14  →  ✅ SUCCESS

You hold the gate, marking
who comes and goes.

──────────────────────────────
  stamina                 9/10
  rolls                 2 (-1)
  💰 purse             43 (+3)
```

| Aspect | Reading |
| --- | --- |
| Mobile legibility | ✓ one fact per line, nothing has to wrap inside a 30-col block. ✗ the label column spends 9 of 30 cells, and the row that carries 💰 gives up two more to the emoji, so the value column is the narrowest of the three options. |
| Scan-ability | ✓ the payout is a *named* row with a fixed column, so a week of outcomes lines up number-under-number once the chronicle reuses the shape. ✗ three rows of chrome plus a rule on every outcome, including the fights and recons that paid nothing. |
| Rendering cost | `OutcomeRenderer`: a new per-row composer with a target width constant and `padStart` alignment, plus the rule as a 30-cell constant; `deriveFromMutations` and `formatDelta` are reused unchanged, so there is still one derivation of the delta. Each row is its own inline code span — today's footer is one span, and padding survives only inside one, because Discord collapses runs of spaces outside it — so the alignment costs a span per row; an `ansi` fence around the table would hold the same alignment in one block instead. `outcomeToText`: none — it appends the block, so the table rides along for free. The day log still sees the title first, so the coin needs its own path there (see below). |

## Option B — indented subline

The owner's second proposal, a subline under the journal entry: the payout leaves the footer and becomes one indented line under the outcome prose, as an aside reads under a chronicle entry, while the footer keeps the resource counts it already reports.

```
✴️ Labour

🎲 16  vs  14  →  ✅ SUCCESS

You hold the gate, marking
who comes and goes.
  💰 purse 43 (+3) copper

⚡ 9/10  ┃  🎲 2 (-1)
```

| Aspect | Reading |
| --- | --- |
| Mobile legibility | ✓ one short line with no padding to break when Discord wraps it, so it survives any width and any font. ✗ a two-cell indent is a weak separator: on a full message the line reads as the last sentence of the prose, and the footer below it still competes for the eye. |
| Scan-ability | ✓ it reads as a sentence-level aside, in the position a reader already is after the narration. ✗ no column, so numbers start wherever the prose stopped — ranking verbs by eye means reading every line, and the shape gives the chronicle nothing to align to. |
| Rendering cost | `OutcomeRenderer`: the cheapest — one appended line after `outcome.outcomeText` and the `💰` segment removed from the stats line; no width arithmetic, no new helper, no code span, because nothing here is padded and so nothing depends on Discord preserving spaces. `outcomeToText`: none. Cost is carried elsewhere: a second payout-shaped convention now exists beside the footer, so anything that later wants the coin in the stats line has two places to look. |

## Option C — ledger line under the headline

The third option, triage's proposal: a fixed-width ledger line sits directly under the outcome headline, above the prose — costs left, gains right-aligned to the 30-col safe width, the payout ending the line. It replaces the `┃` footer rather than adding to it, and it borrows the combat round ledger's rule that the number that matters floats right ([[visual-craft]], *float for clarity*). It draws the same newly added 30-cell `─` rule as A, and the verdict line stays where it is today, directly under the title, so the block opens on three chrome lines before it reaches a word of prose.

```
✴️ Labour
🎲 16  vs  14  →  ✅ SUCCESS
──────────────────────────────
⚡ 9/10  🎲 2       💰 43 (+3)

You hold the gate, marking
who comes and goes.
```

| Aspect | Reading |
| --- | --- |
| Mobile legibility | ✓ the payout sits at the right edge, where a 30-col reader's eye already lands, and costs never share a word with it. ✗ the line is full at 30 with two costs and a payout, so an item, a second currency or a future XP row needs a second ledger line; below 30 columns it wraps mid-group and the alignment collapses. |
| Scan-ability | ✓ costs left, gain right — the shape is read in one fixation, and it is the first thing under the headline rather than the last thing in the block. ✗ a third line of chrome before the prose, and the ledger can read as chrome unless the rule above it is always drawn, including on outcomes that paid nothing. |
| Rendering cost | `OutcomeRenderer`: the existing stats line is rewritten in place (alignment composer plus the width constant) instead of added to, so the footer's current tests change with it; the ledger reuses the footer's single inline code span, and the rule costs a second span of its own — one added line, since the ledger replaces rather than joins the footer. `deriveFromMutations` and `formatDelta` are reused. `outcomeToText`: none. The day log still needs the coin plumbed in, as in A and B. |

## The surfaces the pick also settles

The outcome block is only one of the three places the coin has to appear; the choice above is the convention the other two follow.

- **The harness day log** (`summarizeOutcome` + `buildDayLog`, `src/agent/turnContext.ts`) reads the first content line, so a layout that leaves the payout below the title does not reach it. Either the title line carries the coin (`✴️ Labour · 💰 +3`) — the cheapest place, and enough for the implementation card, whose criterion is that the day-log line contains the amount rather than how it got there — or `summarizeOutcome` learns to append it.
- **…but the title is also the embed header.** `view.title` is rendered twice: `outcomeToText`'s first line (`src/agent/viewToText.ts`) and the Discord embed's `setTitle` (`src/discord/viewToDiscord.ts`). So a coin on the title line is not a day-log-only change — it renames the mobile embed header of every outcome, including the fights and recons that paid nothing, and has to read as a caption there too.
- **The `/journal` chronicle** has no payout to render: `JournalAction` would need one plumbed through `getJournal`, derived the way `discoveries` already is from the action's mutations. Its existing `└─` rail under the entry is the natural home, whichever layout wins.

## Open questions

- [?] Delta first or total first? The rest of the game prints `💰 {total} (+{delta})` — the total from the render context, only the suffix from `formatDelta` (`src/engine/OutcomeRenderer.ts`) — but a Grinder ranks verbs on the delta, and `43 (+3)` buries it.
- [?] Does the purse belong on the outcome at all, or only the delta? The purse is the number a player checks anyway on `/stats`.
- [?] What does an outcome that paid nothing draw — the rule with an empty ledger, the unchanged footer, or nothing at all?
- [?] When the game grows XP, does it take a row (A), a subline (B) or a second ledger line (C)?
- [<] The owner's pick lands as a comment on #136 and decides the shape the implementation card builds.

---

Further reading: [[poc-discord-ux]] (mobile constraints and emoji discipline), [[discord-window-size]] (the 60 × 32 measured budget and the 30-col safe width), [[visual-craft]] (float for clarity, monochrome is the asset), [[poc-action-ux-refinements]] (the standardised footer this doc revises).
