---
title: Polish Pass — v0.2.7
status: shipped
domain: spark
phase: poc
tags:
  - polish
  - ui
  - feedback
  - roll-economy
  - map
  - discord
  - validation
related:
  - "[[per-player-map-exploration]]"
  - "[[roll-economy-timeouts-and-world-growth]]"
  - "[[prod-data-review-v0.2.3]]"
  - "[[prompt-seperation-of-concerns]]"
  - "[[discord-interaction-layer]]"
---

---

A POC-beta polish bump (`0.2.6 → 0.2.7`) — small, high-confidence wins drawn straight from the tester's `feedback`/`bug_reports` rows in the dev DB (John kdoe, 2026-06-26 → 06-28, builds `0.2.4`/`0.2.5`). Triaged against what `0.2.5`/`0.2.6` already shipped. **Bugs locked first; feedback Q&A'd into the tasks below.** A recurring theme surfaced: several "bugs" are really one missing **deterministic guard over LLM resolution output** — catch the degenerate result and flag / bail / retry, rather than trusting the prompt.

---

## Already handled (don't re-litigate)

Verified against `CHANGELOG.md` + current code — closed:

- [x] **Bug — no-op refund invisible in footer** → shipped `0.2.5` (*Player-reported*; footer prints `🎲 N (refunded)`).
- [x] **Bug — pinned-message cap** → shipped `0.2.5` (header pins bounded to newest 12; announcements unpin older).

---

## Tasks

### 🐛 Bugs (first)

- [x] **Bug #4 — `/hi` header location emoji is hardcoded `🏠`** *(shipped)* — mirrored the `0.2.6` `/look` fix at `src/discord/commands/hi.ts`: resolves the place's map glyph (`📍` fallback) + safety glyph instead of the literal `🏠`.
- [x] **Bug #2 — a decision beat reached the player with only ONE option** *(shipped, retry-then-bail)* — a **universal (category-agnostic) shape guard**: a beat that would present ≤1 real option is **retried once → then resolves as a refundable no-op** (the roll is free, no grace consumed; required reactions present the lone option since they can't bail). The degenerate first call is always logged to `llm_calls.validation_warnings` (telemetry lives at the gateway; the action lives in `ActionStateMachine`). Shipped standalone ahead of the v11 per-category framework in [[mutation-vocabulary-refinement]] §5a.
- [x] **`/hi` with no character reroutes to `/join`** *(shipped)* — running `/hi` (or any character-gated surface — `/look`, `/stats`, `/map`, `/backpack`, `/journal`, `/action`, `/sleep`) before joining now reroutes to the join wizard at the dispatcher, instead of a "type /join" dead-end.

### 🛡️ Deterministic resolution guards (framework lives in the engine doc)

The general mechanism — **per-`category` deterministic guards that always log to the DB when tripped and optionally act (clamp / flag / bail / retry)** — is now owned by [[mutation-vocabulary-refinement]] §5a, since it keys off the closed `category` enum that doc introduces (ships with **v11**). The type "flip-flop" within a turn (action #24: `investigate` → `social`) is **correct, not a bug** — a turn can start as a search and become a conversation — which is exactly why guards must key off the per-step `category`, not one flattened label.

Of those guards, **only the single-option shape check is category-agnostic and shipped in `0.2.7`** standalone (ahead of the v11 framework). The stamina clamp was **pulled** — see below.

- [<] **Feedback #1 — cap & de-stack stamina cost → DEFERRED to v11.** Action #24 "Study the key" applied `−1` *and* `−2` stamina in one resolution (−3 on a *failed* turn). A blunt universal per-turn cap would only be torn out: stamina caps are going to be **per-action-type** (`rest` vs `combat` cost differently), which keys off the closed `category` enum the mutation refactor introduces. So the clamp rides v11 with the rest of the per-category guard set, not this polish bump. *(Decided 2026-06-30 — moved to the parked list.)*
- [x] **Bug #2 — degenerate decision shape** *(shipped)* — the universal shape guard (≤1 real option → retry-then-bail). Tracked above under Bugs; design lives in [[mutation-vocabulary-refinement]] §5a.

### 🎨 UI / emoji polish (the headline bump — all verified still open)

- [x] **`/look` Paths** *(shipped)* — each charted path line now carries the destination's location emoji + safety glyph (`src/discord/commands/look.ts`). *Feedback #7.*
- [x] **`/map` drill-in roads** *(shipped)* — `/map <place>` road lines reach full-map node parity (`emoji · safe/wild · effort`) by resolving each destination node (`src/discord/map-render.ts`). *Feedback #6 (partial).*
- [x] **`/join` options** *(shipped)* — class/background/race options and starting kits show stat-bonus emojis (💪/🧠/📖/💬 + signed amount), computed from the YAML `modifiers`/item `stat`+`modifier` (`src/discord/commands/join.ts`). *Feedback #5.*
- [x] **`/backpack`** *(shipped)* — the item list hangs off each stat group with box-drawing rails (`├─ │ └─`) like `/map` (`src/discord/commands/backpack.ts`). *Feedback #8.*

### 🎲 Roll economy

- [x] **Feedback #2 — one free bail per day** *(shipped)* — the first **bail** per character per day refunds the roll (own `last_bail_refund_day` column + migration `202606300000`, so the bail grace never burns the no-op/timeout graces); later bails that day spend it, and bailing always costs stamina. Consistent with the `0.2.4`/`0.2.5` "made whole" patterns.

### 📣 Comms

- [x] **Feedback #4 — announce the Saturday threat earlier** *(shipped)* — a `buildThreatHeadsUp` teaser (place + hint, deterministic per week so it matches the noon reveal) folds into the 05:30 morning message; the full announcement + NPC spawn still fire at the 12:00 afternoon beat (the spawn stays the single irreversible side effect).

---

## Deferred / parked

- [<] **Feedback #1 — stamina cap & de-stack → v11.** Deferred from this bump (decided 2026-06-30): per-turn stamina caps will be **per-action-type**, keyed off the `category` enum the mutation refactor introduces, so a blunt universal clamp now would only be torn out. Rides v11 with the per-category guard set in [[mutation-vocabulary-refinement]] §5a.
- [<] **Feedback #10 — weekly feedback/bug poll** *(locked: own spark)* — scrapes recent `feedback`/`bug_reports` + Discord poll + vote tally. Bigger than a polish bump → new spark, out of `0.2.7`.
- [<] **Feedback #3 / Bug #3 — travel cost & one-hop movement** — parked this cycle (your call). Multi-hop fast-travel is deferred to [[per-player-map-exploration]] §9.
- [<] **Feedback #9 — "was I supposed to have 4 rolls today?"** — ignored for now (your call); revisit as a possible Saturday-bonus reset bug later.

---

## Decided

- [x] **Guard framework** — per-`category` deterministic guards, always-log + optionally-act, folded into [[mutation-vocabulary-refinement]] §5a (rides v11). Type flip-flop confirmed as intended behaviour.
- [x] **Feedback #1 (stamina clamp)** — **deferred to v11.** Caps will be per-action-type (key off the `category` enum), so no universal clamp ships in `0.2.7`. Moved to parked.
- [x] **Bug #2** — shipped as **retry-then-bail** at the **≤1 real option** threshold (0 real options is the existing resolve-now signal; exactly 1 = no real choice = degenerate). Telemetry logs the degenerate first call to `validation_warnings`; the refundable no-op never consumes a per-day grace.
- [x] **0.2.7 cut line** — shipped: all UI/emoji (`/look`, `/map`, `/join`, `/backpack`) + bail mulligan + Bug #4 + `/hi` reroute + the **single-option shape guard** (the one category-agnostic guard). Stamina clamp and the full per-category guard set wait for v11.

## Outcome

Shipped on branch `feat/polish-v0.2.7` (off `dev`); changes logged under `CHANGELOG.md` `[Unreleased]` and player notes staged at `assets/release-notes/v0.2.7.yml` for the eventual `v0.2.7` tag. `npm run typecheck` + full suite (766 tests) green. The release cut itself (VERSION bump, `dev`→`main` merge, tag) is left to a separate step.

---

footer
