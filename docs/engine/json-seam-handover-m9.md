---
title: JSON Seam — M9 Handover Briefing (lead prompt)
status: decided
domain: engine
phase: mvp
tags: [architecture, layering, engine, controller, json, seam, protocol, contract-tests, discord, adapter, handover, orchestrated-delegation]
related:
  - "[[json-seam-protocol]]"
  - "[[json-seam-handover-m7-m8]]"
  - "[[layer-boundaries-and-json-seam]]"
  - "[[json-seam-build-plans]]"
---
Handover prompt for the implementing lead taking the JSON seam arc through **M9 (the Discord adapter rebuilt onto the protocol)**. Paste in full to a fresh lead agent. M10 (closeout) is deliberately out of scope here; a new handover is written before it starts. The M7/M8 briefing ([[json-seam-handover-m7-m8]]) is the precedent this one continues.

---

## Role

You are the implementing lead for milestone **M9** of the JSON protocol seam arc, on branch `feat/json-seam-protocol`. You run the **`orchestrated-delegation` skill**: you own analysis, spec, triage, verification and commits; `delegate-executor` builds, `delegate-reviewer` critiques in fresh read-only context, `delegate-fixer` applies what you accept, `delegate-coordinator` steers at stage boundaries, and `delegate-judge` gates the risky slice. You do not write the build plan: it already exists and is settled. You execute it slice by slice and record outcomes the way M5 through M8.5 did.

## Read first (in this order, fully)

1. `docs/engine/json-seam-protocol.md`, the canonical arc spec: the law, the protocol design (envelope/events/router), the contract-test barrier, **loop not graph**, and in particular **§ M9 build plan** (recon findings, design calls DC-M9.1 to DC-M9.10, the binding slice sequence M9.0 to M9.4) plus § Execution state, which carries the live status.
2. `docs/engine/json-seam-handover-m7-m8.md`, the previous lead prompt: same law, same gates, same execution rules, and the slice notes recording what drifted.
3. `docs/engine/layer-boundaries-and-json-seam.md`, the parent doc (M0 to M4 record and the gap table the arc settles).
4. `docs/decisions/wizard-session-ownership.md`, the one settled decision this arc changed, because DC-M9.9 moves the module it governs.

## Current state (verified 2026-08-08, branch `feat/json-seam-protocol`, clean tree, HEAD `6ed4922`)

- **M0 to M8.5 done.** Engine seam, M1 golden-transcript oracle, view-state DTO, controller, agent adapter, the M5 contract + router, M6 agent-as-protocol-client, M7 bookends, M8 read-only screens, M8.5 smoke-run tooling.
- **Baseline: 99 files / 2019 tests green, typecheck clean.** Every commit must keep all prior gates green.
- **The baseline was red on 2026-08-08 and was repaired first (`1fc4502`).** The `character.create` contract block asserts weekday copy but pinned no clock, and its `created` arm returns the first-day `/hi` view, which branches on `isWeekend()`. Green on the Thursday it landed, red every Saturday and Sunday. This was the first live bite of the SF3 same-weekday-class caveat. **If your run starts red, reconcile first: check the day of the week before you debug anything else.**
- **What already crosses the seam:** the six `screen.*` commands, `hi`, the join wizard, and the `/sleep` player path are translate + paint over `router` today. Runtime (non-type) engine/controller imports left in `src/discord/` are exactly five, listed in the plan's recon.
- **The M9 drift net you inherit:** `tests/discord/dispatch-oracle.test.ts` (M1), `bookend-oracle.test.ts` (M7.0), `screens-oracle.test.ts` (M8.0), the contract suite `tests/protocol/contract.test.ts` including the M8.5 stage-8 choice-fidelity describe, plus the M8.5 replay tooling (`npm run agent:replay`, `tests/agent/protocol-transcript.test.ts`, the committed corpus at `tests/fixtures/protocol-corpus/`).

## The law (binding, restated)

**Every game mechanic crosses the single JSON seam. No frontend holds a privileged channel to the engine or controller; no game rule, flow, or render-assembly lives in an adapter.** A frontend translates its transport's events into protocol input-events and paints the returned envelopes; the backend owns everything else. Contract tests assert "every response matches the envelope" as a command, not a review. The stub backend proves frontends and backends are interchangeable.

M9 is the milestone where that law finally binds the adapter it was written for. Everything before it built the seam; this one removes the bypass.

## M9 — the milestone

**Goal:** `dispatchInteraction.ts` and the command files become translate + paint only, so every game mechanic reaches the player through `GameEvent` → `GameRouter` → `viewToDiscord`.

**Gate (byte-identical, stacked):** the M1 oracle + M2 snapshots + M7.0 bookend oracle + M8.0 screens oracle green with **zero snapshot churn beyond the three classes DC-M9.10 declares in advance**; the M8.5 replay gate green (corpus replay byte-green); the DC-M9.1 structural check passing and proven non-vacuous; typecheck + full suite green at 99 files / 2019 tests plus your additions. **A snapshot change nobody predicted means the port drifted: fix the port, never re-bless.**

**Slice sequence (order binding, full detail in the plan):**

[ ] **M9.0** action-paths oracle (test-only, additive, zero `src/` edits)
[ ] **M9.1** the seam gaps: the `collapse` fact, the divine-intervention arm, two feedback surfaces, the `getNavButtons` widening
[ ] **M9.2** the slash `/action` crossing
[ ] **M9.3** the dispatcher rewrite
[ ] **M9.4** structural check + layering moves

Write each slice's task checklist into the spec doc immediately before you start that slice, M8-style. The plan settles the design; the checklist settles the mechanics.

### Three things the recon found that will save you a wrong turn

- **`viewPublic` is not a protocol gap.** RA-6 aliased `viewPrivate` and `viewPublic` to one object, so the adapter broadcasts the view it already painted. Do not add a second view to the envelope.
- **`announceCollapse` is a gap.** It needs pre and post vitals that `outcomeFacts` drops. DC-M9.2 copies the `restUnsafe` precedent rather than inventing a shape.
- **Divine intervention lives only in `commands/action.ts`.** The controller has no such branch, so everything already through the seam (the custom-modal path, and the agent harness since M6) renders a refunded divine outcome as an ordinary one. DC-M9.3 makes it a seam arm, which fixes that silently-degraded fidelity for every consumer at once. Do not "simplify" it away when porting the slash path.

### The one decision that is not yours to settle

**DC-M9.7** moves the profanity guard behind the seam. `checkProfanity` has exactly one call site today, the custom-action modal, so text typed into `/action <description>` reaches the engine unfiltered. Moving it closes that asymmetry, and it is a **recorded behaviour change on the slash path**: text that gets through today will be rejected after M9. The plan settles it as "move it", but **the owner signs it off before M9.3 lands.** If sign-off has not arrived when you reach M9.3, build the slice without the move, leave the guard where it is, and flag it: do not block the slice, and do not smuggle the change.

## Contract-test rule (the point of the exercise)

`tests/protocol/` is extended **in the same commit** as each new event, fact, surface or arm: conformance of every branch it can produce (success, every reachable error code, every view variant), negative space (malformed payloads, illegal moves), JSON round-trip, and beat order where beats exist. No new `facts` key without a consuming adapter in the same slice. `PROTOCOL_VERSION` stays `1` unless a breaking change forces otherwise, in which case flag it rather than bumping it quietly.

## Execution rules (binding)

1. **Loop, not graph.** One slice at a time: you spec it → `delegate-executor` builds → **you verify** (re-run the gates yourself, read the riskiest file, confirm the counts) → commit → `delegate-reviewer` in fresh read-only context → **you triage** (accept/drop with reasons) → `delegate-fixer` → you verify → commit → `delegate-coordinator` checkpoint → `/clear`. **No parallel streams, no worktrees.** M9's slices all touch `dispatchInteraction.ts`, the command files, `viewToDiscord.ts` and the contract suite; two streams would share files, which makes them one stream.
2. **Verify, do not trust the report.** The executor's summary is a claim. Re-run `npm run typecheck` and `npx vitest run` yourself, and diff the snapshots yourself against DC-M9.10's declared churn classes. This gate is byte-identical; a report saying "tests pass" is not evidence that nothing churned.
3. **Summon `delegate-judge` for M9.3.** The dispatcher rewrite is the risky slice: 927 lines on the live interaction path, every player surface behind it, and a byte-identical gate. Fresh context, read-only, verdict gates acceptance. M9.2 gets a judge at your call; M9.0, M9.1 and M9.4 do not need one.
4. **Build and review-fix land in separate commits.** The M5 to M8.5 history does this consistently and it keeps the bisect honest.
5. **Atomic commit per slice; changelog entry per slice** under `[Unreleased]` → `### Internal`, in the scannable one-liner style the existing entries use (route via the `changelog` skill).
6. **You never commit to, push to, or checkout `dev`/`main`.** The owner merges to `dev`. Stay on `feat/json-seam-protocol`.
7. **Record the coordinator's steer in the spec doc's execution state**, along with build hashes, review outcomes, test counts and deferred items, exactly as M5 to M8.5 did. That record is the memory that survives your context reset.
8. **Close the doc loop before declaring a slice done:** flip the checkbox in the plan's slice sequence, reconcile `TODO.md`'s RESUME HERE, settle any open question in the doc that asked it. If the docs do not match the repo, the next session inherits a lie.
9. A throwing `onBeat` callback must never escape the router (settled in M5; keep it that way in any new beat path).

## Scope fences (binding)

No game-rule, balance or prompt changes (DC-M9.7 moves an existing guard, it does not change what the guard blocks). No `sim/` changes. No network transport, no web adapter, no multi-agent co-located runs. The nightly `tick` cron and the admin tick stay engine-owned (DC-M9.8). The `facts` whitelist stays closed: DC-M9.2's `collapse` key is the only addition and its consumer lands in the same slice. `AGENT_FORCE_FREE_ACTIONS` is the next arc's first task, not yours.

## Carried watch items

- The **D2 stale `/hi` resume edge** is still unpinned. Pin it or record it as tolerated during M9.3; do not leave it unmentioned a third time.
- The charless `/help` slash arm does one `getCharacter` read via `addCharacterFacts` (M8.1). The call-log baseline moved; your gate should expect it.
- **Tests are not typechecked** (`tsconfig.json` covers `src/**` only). This is how the M8.1 stub drift stayed latent. M9.1 and M9.3 add `RouterBackend` surface, so the class is live; `src/protocol/stubBackend.ts` being in `src/` contains most of it.
- Deterministic real-backend corpus entries remain deferred (SF3 same-weekday-class). M9 is where they were meant to land; decide explicitly whether they do, or defer again with a reason.
- The map focus flow-order pin stays indirect (judged adequate).

## Definition of done (stop condition)

M9 fully landed: zero runtime engine/controller imports on the Discord interaction path, the structural check green and proven non-vacuous, every action surface crossing the seam, the contract suite covering every addition, all four oracles byte-green with only the declared churn, the M8.5 replay gate green, typecheck + full suite green, changelog current, the spec doc's execution state recording all five slices with build hashes and review outcomes, and `TODO.md` reflecting M10 as next. Leave a short note in this doc if anything blocked, drifted, or changed scope: the owner reads it before writing the M10 handover.
