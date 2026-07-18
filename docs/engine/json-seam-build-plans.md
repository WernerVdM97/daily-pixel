---
title: JSON Seam — Milestone Build Plans (M0–M4)
status: decided
domain: engine
phase: mvp
tags: [architecture, layering, engine, controller, json, seam, build-plan]
related:
  - "[[layer-boundaries-and-json-seam]]"
---
Task-level build plans for the milestones in [[layer-boundaries-and-json-seam]] (the running spec; its Decisions section is binding). One section per milestone, written by the implementing lead just before that milestone starts. The parent doc keeps the milestone checkboxes; this doc holds the per-milestone task breakdown, execution state, and commit hashes.

---

## M0 — Commute rule into the engine

Goal: the engine owns the day-job commute rule ("standing at The Warden's Oak with a workplace elsewhere → move there, −1 stamina floored at 0, record the fog-of-war visit"); the Discord handler only calls the engine and renders the result. Deletes the Discord layer's sole direct `charRepo.update` (`src/index.ts`, the `── Commute from the Oak to the workplace ──` block).

Design calls (lead, within the parent doc's decision 4):

[I] The rule lands as a dedicated engine method `commuteToWorkplace(characterId, workplace)` called by the handler right where the old block sat, rather than buried inside `startAction`. Rationale: byte-for-byte Discord UX (the transient "🚶 Daily Commute" embed must render *before* the seconds-long LLM call, so the handler needs the commute result up front), and decision 4's "one site, engine-testable in isolation". Folding it into the `startAction` work path can ride M3 when the controller owns the flow.
[I] Workplace *resolution* (`getWorkplaceLocation`) stays caller-side for M0: it shares a seeded PRNG with `getDayJobActions` in `src/discord/commands/hi.ts` so `/hi` and the action agree within a day; splitting that pair across layers is out of M0's one-site scope. The engine receives the resolved destination as input and owns every other part of the rule (the at-Oak condition included).
[I] `WorldEngine.recordVisit` exists only for this commute block (sole caller `src/index.ts:2068`); the new method absorbs the visit recording, so `recordVisit` is removed from the interface and impl.

Tasks:

[x] Engine: add `commuteToWorkplace(characterId: number, workplace: string | null): { to: string; stamina: number } | null` to `WorldEngine` + `WorldEngineImpl` (row via `charRepo.findById`; condition `location === "The Warden's Oak" && workplace && workplace !== location`; `Math.max(0, stamina − 1)`; one `charRepo.update`; `charLocRepo.recordVisit`; null when no commute applies).
[x] Engine: remove the now-callerless `recordVisit` from `WorldEngine` + `WorldEngineImpl` (also re-stubbed in `MockWorldEngine`, a necessary follow-on).
[x] Discord: replace the commute block in `src/index.ts` with the engine call; patch the local `char` snapshot from the result (preserves the `announceCollapse` before-baseline); keep the transient embed text byte-identical.
[x] Tests: new `tests/engine/commute.test.ts` mirroring `visit-recording.test.ts` setup — happy path (move + stamina −1 + visit recorded + persisted), stamina-0 floor, not-at-Oak no-op, null workplace no-op, workplace-equals-location no-op.
[x] Lead closeout: verify, commit, review loop, changelog entry, tick M0 in the parent doc.

Execution state: _done 2026-07-18._ Build commit `98a4de1` (typecheck clean; 78 files / 1462 tests green, +5 over baseline). Adversarial review found no code defects; two informational notes recorded: the engine re-reads the row at call time (fresher than the old handler snapshot under any future concurrency — deliberate), and the handler-level e2e gap is M1's job, not M0's.

## M1 — Behavioural oracle

[<] Plan to be written next (groundwork below is done; one design point to settle first).

Groundwork (surveyed 2026-07-18, post-M0 — save the re-exploration):

[I] The dispatcher is a single closure `dispatchInteraction` inside `main()` (`src/index.ts:1466`), registered at `client.on(Events.InteractionCreate, …)` (`:2421`) behind the `_interactionInFlight` guard (`:362`, key via `interactionGuardKey` `:364`). It is not exported, and `src/index.ts` self-executes on import (DB open `:1136`, YAML assets `:1139`, LLM gateway/env `:1170+`, `client.login` `:2439`), so no test can import it today.
[I] Branch inventory: one slash-command arm (`:1469`; 13 registered commands `:1269-1331`; character-gate reroute `:1518`; hard-coded ephemeral list `:1544`; sleep feedback-row append `:1560`) plus 14 customId branches (`:1623-2193`), of which `nav:` holds 3 sub-branches (`nav:action` `:2204` re-implements the /action menu, `nav:sleep` `:2330`, generic nav `:2383`) — 17 leaf behaviours total. The heaviest and least-tested is the `action:dayjob:` work flow (`:2000-2165`).
[I] Reachable from tests today (pattern in `tests/discord/`): exported command factories (`makeXCommand` + `MockWorldEngine` + hand-rolled fake interactions with `vi.fn()` spies — see `nav-action.test.ts:17`, `join.test.ts:22`), the exported `handleJoinInteraction`, and the pure builders. Locked inside the closure and unreachable: the whole `nav:` bar, the `action:dayjob:` work flow, the `action:custom:modal` chain, the four feedback/bug button→modal chains, the slash-arm assembly (gate/ephemeral/payload), the in-flight guard and error funnel, and the customId cascade order itself.
[I] Module-level flow state the oracle must reset between transcripts: `pendingDecisions` + `_menuMessages` + `_sceneLookup` (`src/discord/commands/action.ts:90-107`), `_userInFlight` (`join.ts:63`), wizard `sessions` (`WizardSession.ts:36`), `_interactionInFlight` (`index.ts:362`).
[I] No snapshot testing exists anywhere in `tests/` (no `toMatchSnapshot`, no `__snapshots__`) — the golden-transcript harness is greenfield; vitest snapshots are available.
[!] Design point the lead must settle when writing the M1 plan: golden transcripts through the live handlers (decision 4's lean) require making the closure drivable, i.e. a minimal mechanical hoist of `dispatchInteraction` out of `main()` into an exported, dependency-injected function (engine, registry, joinWizards, dayJobs, getCurrentScene, …) with zero behaviour change — scaffolding for M1, not the M3 extraction. The alternative (drive only the exported factories) needs no hoist but misses the six locked areas above, including the heaviest branch. Whichever is chosen, the oracle must pin the closure's cascade order (e.g. `action:dayjob:` matching before the broader `action:`), which nothing tests today.

## M2 — Semantic view-state DTO + shared renderers

[<] Plan written when M1 is green (may start alongside M1 per the parent doc).

## M3 — Controller extraction, screen-by-screen

[<] Plan written when M1 is green. First sizing task: inventory the `index.ts` dispatcher branches into pure-Discord vs game-flow buckets.

## M4 — Agent-player adapter

[<] Plan written when M3 lands.

---

Parent spec: [[layer-boundaries-and-json-seam]] — milestone checkboxes and all design decisions live there; changing a decision needs a `decisions/` record.
