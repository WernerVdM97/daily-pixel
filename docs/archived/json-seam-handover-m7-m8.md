---
title: JSON Seam — M7/M8 Handover Briefing (lead prompt)
status: shipped
superseded_by: "implemented in code"
domain: engine
phase: mvp
tags: [architecture, layering, engine, controller, json, seam, protocol, contract-tests, agent-player, discord, handover]
related:
  - "[[json-seam-protocol]]"
  - "[[layer-boundaries-and-json-seam]]"
  - "[[json-seam-build-plans]]"
---
Handover prompt for the implementing lead taking the JSON seam arc through **M7 (bookends through the seam)** and **M8 (read-only screens through the seam)**. Paste in full to a fresh lead agent. M9 and M10 are deliberately out of scope here — the arc's `dev`-merge loop ends after M8 and a new handover is written before M9 starts.

---

## Role

You are the implementing lead for milestones **M7 and M8** of the JSON protocol seam arc, on branch `feat/json-seam-protocol`. You follow the spec's execution shape exactly: one orchestrated-delegation loop per slice, sequential, no parallel streams, no worktrees. You write each milestone's task checklist into the spec doc before you start it, run the slice loop, and record outcomes the way M5/M6 did.

## Read first (in this order, fully)

1. `docs/engine/json-seam-protocol.md` — the canonical arc spec: the law, settled direction, protocol design (envelope/events/router), the contract-test barrier, **loop not graph**, the M7/M8 milestone descriptions, the M5/M6 build plans and execution state. Your M7/M8 checklists go into this doc in the same style.
2. `docs/engine/layer-boundaries-and-json-seam.md` — the parent doc (M0–M4 record and the gap table the arc settles).
3. `docs/engine/json-seam-build-plans.md` — the M0–M4 slice pattern your checklists imitate.

## Current state (verified 2026-08-02, branch `feat/json-seam-protocol`, 9 commits ahead of `dev`, clean tree)

- **M0–M4 done**: engine seam, M1 golden-transcript oracle, view-state DTO, controller, agent adapter.
- **M5 done** (builds `050020c`/`a3920f0`, `513921a`/`22f291e`): `src/protocol/` — versioned `GameResponse` envelope, M5 `GameEvent` union, 9-code error taxonomy, hand-rolled validators, `GameRouter` with beat mechanism; `tests/protocol/` contract barrier green against real backend and canned stub.
- **M6 done** (build `7dc425c`): `src/agent/harness.ts` is a protocol client — only `GameEvent`/`GameResponse` through `GameRouter` for the mid-day loop; zero controller imports in the action path; `characterState` fact populated on every view-bearing response; deterministic harness tests ported (20 tests). `play.ts` wires `GameRouter` over the real `SessionController`.
- **Baseline: 91 files / 1823 tests green, typecheck clean.** Every commit must keep all prior gates green.
- **Deferred from M6**: the live `npm run agent:play` smoke run (needs a longer timeout than the CI tool allows — run manually at `AGENT_DAYS=1`). Not a blocker for M7; the deterministic gate is the correctness proof.

## The law (binding, restated)

**Every game mechanic crosses the single JSON seam. No frontend holds a privileged channel to the engine or controller; no game rule, flow, or render-assembly lives in an adapter.** A frontend translates its transport's events into protocol input-events and paints the returned envelopes; the backend owns everything else. Contract tests assert "every response matches the envelope" as a command, not a review. The stub backend proves frontends and backends are interchangeable.

Scope fences that also bind you: no game-rule/balance/prompt changes (the unsafe-rest penalty *moves*, it does not change value or conditions); no `sim/` changes; no network transport; no web adapter; the `AGENT_FORCE_FREE_ACTIONS` follow-up is the next arc's first task, not yours. `PROTOCOL_VERSION` stays `1` unless a breaking change forces otherwise (flag it). The `facts` whitelist is **closed** — no key is added without a consuming adapter justifying it in the same slice.

## M7 — Bookends through the seam (order is binding)

**Gate:** M7.0 oracle coverage green *before* each migration; contract suite extended per event in the same commit; the agent's lifecycle is fully protocol-driven (no engine-direct bookends left in the harness).

- **M7.0 — Characterise first, migrate second.** Extend the characterisation net to the **join/hi/sleep command paths before any migration** (the M1-before-M3 pattern: no migration without a net). Pattern to copy: `tests/discord/dispatch-oracle.test.ts` — deterministic idle (`IdleMessageSelector` mock), `broadcastOutcome`/`announceCollapse` spies, golden transcript + snapshots. These three commands are the M9 rebuild's drift net; M9's byte-identical gate depends on the net existing.
- **M7.1 — Rest + nightly tick.** The unsafe-rest −1 HP rule lives in `src/discord/commands/sleep.ts` (~:76–134: the `⚠️` penalty block keyed on `character.location`, the `engine.restAtOak` call, the collapse announcement) — a second rule leak, same smell as the M0 commute leak. Move the rule into the engine (value and conditions unchanged), add the `rest.begin` event + its view-state, rewire `sleep.ts` to translate + paint only, and cut the agent's engine-direct `endDay` (`src/agent/harness.ts` ~:228 — `restAtOak` + `tick(true)`; the harness drops the engine-direct half, the nightly world `tick` stays engine-owned as the cron mechanism). The agent's rest must surface unsafe-rest feedback it can never see today.
- **M7.2 — `/hi` through the seam.** `src/discord/commands/hi.ts` (112 lines) becomes translate + paint; the event + view-state carry what the character-header screen needs.
- **M7.3 — Character creation through the seam. The hardest slice — judge candidate.** The join wizard's state is instance-scoped adapter state: `src/discord/WizardSession.ts` (a `Map<discordUserId, WizardState>`, steps 1–8, in-memory) and `src/discord/commands/join.ts` (511 lines). For `character.create` + wizard-step events to cross the seam, wizard state ownership must become backend-owned — either controller-held session state keyed by `playerId` or engine-persisted draft state. **This extends parent decision 1 (session state is engine-owned, controller stateless) — a genuine design call, not a given. Your M7.3 plan MUST include a `docs/decisions/` record for whichever extension you choose; the parent doc requires one to change a settled decision. Do not smuggle it as a slice note.**

### M7 watch items (flagged, not smuggled)

- Oracle coverage of the join/hi/sleep paths must land **before** each migration, or the M9 byte-identical gate has no net.
- The wizard-state settle is the one place this arc changes a settled decision — budget the review accordingly.
- `dispatchInteraction.ts` (927 lines) is not touched in M7; the profanity guard and the slash `/action` stale-resume copy drift are M9 items. Leave them.

## M8 — Read-only screens through the seam

**Gate:** the read-only screens (`look`, `map`, `stats`, `backpack`, `journal`, and `help` if it carries game content) become `screen.*` events returning view-states; the agent gains full player parity (its smoke runs can play every player surface).

- One small slice per screen or batched at your call — these are direct engine reads + render inside the command files today, so each slice is: event + view-state → router branch → command rewires to translate + paint → contract tests extended in the same commit.
- Parity check per screen: the agent harness can reach the screen through the protocol the way a player does, and its transcript renders it.

## Contract-test rule (the point of the exercise — applies to both milestones)

`tests/protocol/` is extended **in the same commit** as each new event: conformance of every branch the event can produce (success, every reachable error code, every view variant), negative space (malformed payloads, illegal moves), JSON round-trip, and beat order where beats exist. "Every response matches the envelope" is asserted, not reviewed. No new `facts` key without a consuming adapter in the same slice.

## Gates (stack — every commit keeps all prior gates green)

- `npm run typecheck` clean; `npm test` green (baseline 91 files / 1823 tests plus your additions) at every commit.
- **M7:** M7.0 oracle coverage green before each migration; contract suite extended per event; the harness has zero engine-direct bookends left (character creation, rest); the agent lifecycle is fully protocol-driven.
- **M8:** all read-only screens behind `screen.*` events; agent parity across every screen.
- Changelog updated per slice (see below); spec doc execution state + slice records written before you stop.

## Execution rules (binding)

1. **Loop, not graph.** One slice at a time: you spec it → executor builds → you verify (re-run gates, read the riskiest file) → commit → fresh-context reviewer → triage → fixer → verify → commit → coordinator checkpoint → `/clear`. No parallel streams, no worktrees — M7/M8 touch `SessionController.ts`, `dispatchInteraction.ts`, the command files, `viewToDiscord.ts`, `viewState.ts`, and `harness.ts`; colliding streams would share files.
2. **Atomic commit per slice**; changelog entry per slice under `[Unreleased]` → `### Internal` (scannable one-liner style per the changelog skill — e.g. the M5/M6 entries already there).
3. **You never commit to, push, or checkout `dev`/`main`.** The owner merges to `dev`. Stay on `feat/json-seam-protocol`.
4. Write each milestone's task checklist into `docs/engine/json-seam-protocol.md` before starting it (the established pattern — the M7/M8 checklists are yours to write as the protocol shape settles).
5. Record slice outcomes in the spec doc's execution state exactly like M5/M6 did (build hashes, review outcomes, test counts, deferred items).
6. A throwing `onBeat` callback must never escape the router (already settled in M5 — keep it that way in any new beat paths).

## Definition of done (stop condition)

M7 and M8 fully landed: every bookend and every read-only screen crosses the seam; the contract suite covers them; the harness plays the whole player lifecycle; typecheck + full suite green; changelog current; spec doc execution state records M7/M8 with slice records; `TODO.md`'s RESUME HERE reflects the new state (M9 next). Leave a short note in this handover doc if anything blocked, drifted, or changed scope — the owner reads it before writing the M9 handover.

## Slice notes (2026-08-05)

- **M7.2 `/hi` (done, build `078aaba` + review fix `8b08059`).** One recorded behaviour drift, no blocks: the D2 stale-action `/hi` resume throw now surfaces as `ok:false 'internal'` — the bare timeout copy is painted as content and `notifyAdmin` no longer fires for that edge. Consistent with the seam's internal-error convention (the `action.custom` D2 edge has behaved identically since M6) and unpinned; pin it in M7.3/M9 if it matters. Also recorded: the charless `nav:hi` copy unifies onto "…Type `/join` first." (the old "yet" copy was dead behind the slash gate). Full record in the spec doc's M7.2 execution-state entry.
- **Smoke-run tooling (settled 2026-08-05, docs only).** The smoke-run upgrade brainstorm settled as DC-S1–S6 in the spec doc's new "Smoke-run tooling plan" section; the tooling lands as a dedicated **M8.5** slice between M8 and M9 (the M7/M8 handover's M9+ out-of-scope line is unaffected — M8.5 is planned in the spec doc, not built here). M7.3 and M8 feed it: the wizard-event names and `screen.*` events its parity beats pin.
