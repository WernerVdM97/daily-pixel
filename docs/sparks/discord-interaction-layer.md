---
title: Discord Interaction Layer — Standardising & Optimising the UX
status: spark
domain: spark
phase: mvp
tags: [discord, interactions, ack, defer, components, latency, reliability, standardisation, ui, engine]
related:
  - "[[mvp-discord-ux]]"
  - "[[poc-discord-ux]]"
  - "[[poc-build-action-ux]]"
---
---

start here

---

## What this is (and isn't)

This is about the **plumbing** every Discord interaction passes through — how we acknowledge, render loading, build components, handle latency, and recover from errors — and the case for **standardising it into one shared layer** instead of re-implementing it per button.

- [>] It is **not** about input *modalities* (reactions, free text, select menus, DM/batch strategy) — that's [[mvp-discord-ux]]. The two are orthogonal: that doc decides *what kinds of input exist*; this one decides *how any interaction is plumbed once it arrives*. They should stay separate docs and cross-reference; if they ever start overlapping, resolve in `decisions/`, don't fork.
- [!] The recurring `DiscordAPIError[10062]` is the **symptom that exposed the gap** — but the fix-the-crash slice is a separate, ASAP bug report (`scratchpad/BUG-10062-interactions.md`: the double-click in-flight guard + the dead-interaction error funnel). This doc is the **MVP-scale "make it impossible to regress, and make it feel good"** layer that sits underneath.

## The problem: every button reinvents the plumbing

Today there's one mega-listener (`src/index.ts:1335`) with a long `if/else` chain on `customId`, and **each branch hand-rolls the same five concerns**:

- [c] **Acknowledgement** — each branch decides for itself whether/when to `deferReply` vs `deferUpdate` vs `reply` vs `showModal`. No shared gate ⇒ each new button is a fresh chance to get the 3s window wrong.
- [c] **Loading UX** — the "blank the buttons, show ⏳ + a random idle line, then edit in the result" pattern is copy-pasted (e.g. day-job `src/index.ts:1857-1867`, action choice `action.ts:316`). `randomIdleMessage()` exists but the *envelope* around it is duplicated.
- [c] **Components** — nav buttons (`getNavButtons`), outcome service buttons (`getOutcomeServiceButtons`), embed colours, footers are assembled ad-hoc at each call site. A colour or footer tweak means hunting every call site.
- [c] **Stale-message cleanup** — the day-job menu is deleted via a raw `WebhookClient` + `consumeMenuMessage` dance, inline, in two places (`src/index.ts:1543-1550`, `1575-1582`).
- [c] **Error surfacing** — three near-identical swallow-and-log helpers (`safeErrorReply` `index.ts:310`, `safeNotify` `join.ts:261`, and the inline `code !== 10062` check at `1488`), each subtly different.

[p] Standardising these isn't just tidiness — it's the difference between "every interaction is correct and consistent by construction" and "every interaction is correct if the author remembered five things."

## The MVP target: a thin interaction layer

A small, shared layer that every route goes through. Sketchy shape, to be refined:

- [I] **Declarative routes + a central ack gate.** Each route declares an ack mode — `defer-reply` (ephemeral) / `defer-update` (edit source) / `modal` (must be first response, no prior await) / `manual` (bespoke, e.g. the join wizard) — and the dispatcher performs the ack *before* handler logic runs. The 3s rule is enforced once, not trusted to N authors.
  - [!] Hard constraint that kills the naive "defer everything": **`showModal()` must be the first response** — you cannot defer then open a modal. So the layer must be ack-*aware*, not ack-blind. This is the non-obvious thing the next person needs to know.
- [I] **One `respondLoading(interaction, {title?, idle?})` helper** that owns the blank-buttons + ⏳ + idle-line envelope, replacing the copy-paste. The day-job "merge commute into the loading page" trick (`src/index.ts:1888`) becomes an option, not a bespoke re-edit.
- [I] **Shared component/embed builders as the only way to build a row** — nav, outcome-service, standard embed (colour + footer). Centralising the footer/colour means the standardisation in [[poc-build-action-ux]] actually holds over time.
- [I] **One menu-lifecycle helper** wrapping `consumeMenuMessage` + webhook delete, so "replace the menu with the scene" is one call, not an inline `WebhookClient` build.
- [I] **One error funnel** = the dead-interaction-aware `surface()` from the bug report, promoted to the layer's only error path. 10062/40060 are expected no-ops; everything else routes to `notifyAdmin` once.
- [I] **One in-flight guard** (generalised from join's `_userInFlight`) baked into the dispatcher, so double-click protection is automatic for every route.

## Optimisation angle (the "feel good", not just "don't crash")

- [I] **Optimistic ack < 3s, always.** With a guaranteed early defer, the player sees *something* (loading envelope) within a frame, even when the LLM takes 15s. Standardising the loading envelope makes this universal instead of per-button.
- [?] **Pre-warm / parallelise** — can cheap reads (character, location) run *concurrently* with the LLM call rather than before it, now that the ack is decoupled from the work? Worth measuring.
- [?] **Idle-line cadence** — should long LLM waits rotate the idle line (edit at N seconds) so the page doesn't look frozen, instead of one static line? Cheap with a shared helper, annoying to retrofit per button.
- [?] **Component reuse vs. re-send** — prefer `editReply`/`update` over new messages to keep channels clean (already the intent in nav `index.ts:2131`); standardise so no route accidentally spams.

## Open questions

- [?] **Scope split.** Ship the ASAP bug-report slice (guard + error funnel) on `0.2.x`, and land the full declarative layer at MVP? (Leaning yes — crash-stop now, standardisation later, no need to couple them.)
- [?] **How invasive at MVP?** Full route-table rewrite of the `index.ts:1335` block, or an incremental wrapper that the existing branches opt into one at a time? The busiest file in the repo argues for incremental.
- [?] **Boundary with [[mvp-discord-ux]].** When select menus / reactions / free text land, they become new *routes* in this layer — confirm they slot into the same ack-mode model. A select menu is `defer-update`-ish; a **reaction has no interaction token at all** and needs a different path. Flag the reaction case early — it doesn't fit the interaction model.
- [?] **Do we want a dev-mode assertion** that warns when ack→first-edit exceeds ~2.5s, to catch regressions before prod 10062s?

## Why MVP, not POC

- [c] The POC works *well enough* once the two bug-report fixes land — it doesn't need the full layer to ship.
- [p] But MVP multiplies the surface: more commands, select menus, reactions, co-op flows, daily-cron-driven messages. Without a standard layer, each new interaction re-litigates acking, loading, components, and errors — and the 10062 class quietly returns. The layer pays for itself exactly as the interaction count grows, which is the MVP story.

---

When this graduates: it's the interaction half of the engine/ui boundary → `git mv` into `engine/` (or `ui/`) at `exploring`, and the scope call (incremental wrapper vs. full route-table) gets a `decisions/` record. The ASAP bug fixes are tracked outside the vault in the bug report and the changelog.
