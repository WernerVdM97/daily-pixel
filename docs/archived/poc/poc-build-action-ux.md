---
title: 'POC Build — Action UX Refinements (Spec)'
status: shipped
domain: archived
phase: poc
superseded_by: "implemented in code"
tags:
- poc
- ui
- engine
- spec
related:
- '[[poc-action-ux-refinements]]'
- '[[poc-build-probabilistic]]'
- '[[poc-build-polish]]'
---

# POC Build — Action UX Refinements (Spec)

> Implementation spec for the decision record [[poc-action-ux-refinements]] + the [[poc-build-polish]] §7 bug fixes. The decision record is the *what/why*; this is the *how*. Status `exploring` until reviewed → flip to `decided`.

## Objective

Make the `/action` flow read cleanly on mobile and stop mislabelling outcomes, so the POC week collects coherent play and uncorrupted data. Two tracks:

- **A. Bug fixes** (state-corrupting / mislabelling — do first):
  1. Bail resolves as green **Success** instead of neutral.
  2. Stamina exceeds max (`11/10`).
  3. Carriage returns (`␍`) leak into rendered text.
  4. Trading 1 of N stacked items deletes the whole stack.
- **B. UX refinements**:
  1. Option text in the message body; buttons become `A`/`B`/`C`.
  2. Three terminal states — **Bail · Skip · Finish** — + auto-finish for choice-less, non-required outcomes.
  3. Standardised outcome footer + separator.
  4. Generic premade daily actions, 3 surfaced at random.

## Tech stack

Existing: TypeScript (ESM), `better-sqlite3`, `discord.js` v14, `vitest`. No new deps.

## Commands

```
Typecheck: npx tsc --noEmit
Test:      npx vitest run
Dev:       npm run dev        # needs DISCORD_TOKEN + DEEPSEEK_API_KEY
Query DB:  node scripts/query.mjs <shorthand|SQL>
```

## Touch map (grounded in current code)

| Concern | File · symbol | Current behaviour | Change |
|---|---|---|---|
| Green bail | `engine/action/machine.ts:127` | `preResolvedMutations ? 'success' : 'skipped'` | Split into `bailed` (skip-like) vs `done` (finish); never `success` |
| Stamina ceiling | `engine/action/mutations.ts:163` `applyMutations` | `Math.max(0, …)` only | Clamp to `STAMINA_MAX` (10), mirroring `modify_health` |
| Carriage returns | `llm/DeepseekLlmGateway.ts` parse | `\r` passed through | Strip `\r` from `outcome_text` + `prompt` on parse |
| Trade stack loss | `db/repositories/item.ts:34` `deleteByName` + `mutations.ts` `remove_item` | Deletes whole row; no qty | `remove_item` carries `quantity` (default 1); decrement, delete only at 0 |
| Buttons A/B/C | `discord/commands/action.ts` `buildDecisionMessage` | Button label = full option text (trunc 80) | Body lists `A) …`; buttons show letters |
| Terminal states | `machine.ts` step/resolve + `engine/WorldEngine.ts` `ActionOutcome.outcome` | union: `success\|failure\|skipped\|timed_out` | add `bailed`, `done` (auto-finish) |
| Auto-finish | `action.ts:217` (`firstDecision.options.length === 0`) | grey "Action" embed, no resolution | resolve immediately, apply mutations, render `✓ Done` |
| Footer / glyphs | `engine/OutcomeRenderer.ts` `formatOutcome` + `OUTCOME_LABELS` | footer exists; no emoji stat glyphs | standardise `→ loc ┃ ❤️ ┃ ⚡ ┃ 🎲`, add `bailed`/`done` labels, separator |
| Outcome colour | `action.ts` `outcomeColor` | success green, skipped orange | `bailed`/`done` neutral |
| Daily actions | `discord/commands/hi.ts` `getDayJobActions` + `assets/char-creation/day-jobs.yml` | fixed 3 per day-job | larger pool → pick 3 at random |

## Code style

Match surrounding code: 2-space indent, named factory functions, pure renderers (`OutcomeRenderer` takes data, returns string — no Discord types). Constants over magic numbers, e.g.:

```ts
// engine/action/mutations.ts
export const STAMINA_MAX = 10;
case 'modify_stamina':
  state.stamina = Math.max(0, Math.min(STAMINA_MAX, state.stamina + Number(m.amount ?? 0)));
  break;
```

## Testing strategy

`vitest` (391 tests today, all green). Per change:

- **Bugs** → a regression test that fails before, passes after: stamina clamp (`mutations.test`), `remove_item` qty decrement (`item` repo + `action-mutations`), bail→neutral outcome (`machine`/`fallback`), `\r` stripped (gateway).
- **Terminal states** → `machine` step tests for bail / skip / auto-finish producing `bailed` / `skipped` / `done`.
- **Renderer** → `outcome-renderer.test` assertions for the new labels, glyphs, and footer.
- Discord wiring (`action.ts`) is integration-light; cover via existing handler tests where present, manual check otherwise.

## Boundaries

- **Always:** `tsc --noEmit` + `vitest run` green before done; add a regression test per bug; keep `OutcomeRenderer` pure.
- **Ask first:** changing the `ActionOutcome.outcome` union (ripples to renderer, colour map, persisted `actions.outcome` values); editing `assets/prompts/decision-prompts/decision-v3.md` (bumps `PROMPT_VERSION`); changing `day-jobs.yml` schema.
- **Never:** commit to main/develop; widen scope into the MVP prompt-refactor; remove tests to make them pass.

## Success criteria

> **Status: all criteria met — the [[poc-action-ux-refinements]] decision record is fully implemented** (commits `6d3e382`, `b6914dd`, `1a36fd3`, `bfc51eb`, `4929180`, + footer §3). Verified by tests + live Discord. Only the mermaid flow diagram below remains (deferred).

- [x] Bailing a non-required action renders a **neutral** banner (`↩ Bailed`), never green Success.
- [x] A choice-less, non-required `done:true` outcome (e.g. "nap in the woods") **auto-finishes** with `✓ Done` and no red "Step back" button.
- [x] Stamina never displays above `10/10`; a `+2` at `9/10` shows `10/10 (+1)` effective.
- [x] No `␍`/`\r` in any rendered message.
- [x] Trading 1 of 2 stacked items leaves 1 (`qty 2 → 1`), not 0.
- [x] Decision option text appears in the message body; buttons are `A`/`B`/`C` (+ a terminal button); nothing truncates on mobile.
- [x] Outcome footer is identical in shape across success/failure/bail/skip/finish.
- [x] `/action` (no description) surfaces 3 actions drawn from a larger pool; repeats across days are less likely.
- [x] `tsc` clean, full suite green.

> Beyond spec, also shipped from [[poc-build-polish]] §7: failed rolls now strip rewards + add a flat stamina penalty (the loss carried no weight before).

## Resolved decisions (review gate, 2026-06-16)

- [x] **Daily-action pool** — expand each per-job pool **and** mix in some hybrid (cross-job/generic) actions; **rewrite the existing actions to be more generic**. Keeps `income`/`depends_on`. Pick 3 at random.
- [x] **Bail stamina cost** — fixed **−1** for bail; **0** for skip.
- [x] **"Recently done" bias** — pure random for POC, no new tracking.
- [x] **Finish affordance** — auto-post the outcome, no button (per decision record).
- [x] **DC visibility** — keep showing `(DC +0)` per choice in the trail, as today.

## Follow-ups (later)

- [<] **Mermaid flow diagram** for the `/action` command — slash entry → start → decision loop → terminal states (Success / Failure / Bail / Skip / Finish / Divine / Timeout) → resolution + DB writes. Add to an engine doc once Track 2 lands so the diagram reflects the new terminal-state model.

## Assumptions

```
1. ActionOutcome.outcome gains 'bailed' and 'done'; persisted to actions.outcome
   (existing rows unaffected; no migration needed — TEXT column).
2. STAMINA_MAX = 10 is the single source for the stamina ceiling (renderer still
   prints /10).
3. remove_item gains an optional quantity (default 1); add_item already has it.
4. Buttons: non-terminal options are lettered A/B/C/D; the terminal button keeps
   a worded label (Bail / Skip / Done) so its intent is unambiguous.
5. No new dependencies; no prompt-version bump unless we change decision-v3.md
   for short labels (flagged under Ask-first).
→ Correct any of these now or I proceed with them into Plan/Tasks.
```
