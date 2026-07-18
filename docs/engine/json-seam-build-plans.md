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

Goal: a characterisation baseline — golden transcripts of the `index.ts` dispatcher's per-screen behaviour, diffable after every extraction step. Hard prerequisite for M3: it is the safety net the branch extraction migrates against, so it must observe exactly the branches M3 will move.

Groundwork (surveyed 2026-07-18, post-M0; line numbers predate the M1.1 hoist and shift once the closure moves):

[I] The dispatcher is a single closure `dispatchInteraction` inside `main()` (`src/index.ts:1487-2417`), registered at `client.on(Events.InteractionCreate, …)` (`:2419-2437`) behind the `_interactionInFlight` guard (`:362`, key via `interactionGuardKey` `:364`). It is not exported, and `src/index.ts` self-executes on import (DB open, YAML assets, LLM gateway/env, `client.login`), so no test can import it today.
[I] Branch inventory: one slash-command arm (`:1489`; character-gate reroute; hard-coded ephemeral list; sleep feedback-row append) plus 14 customId branches, of which `nav:` holds 3 sub-branches (`nav:action` `:2204` re-implements the /action menu, `nav:sleep` `:2330`, generic nav `:2372`) — 17 leaf behaviours total. The heaviest and least-tested is the `action:dayjob:` work flow (`:2000-2165`).
[I] Reachable from tests today (pattern in `tests/discord/`): exported command factories (`makeXCommand` + `MockWorldEngine` + hand-rolled fake interactions with `vi.fn()` spies — see `nav-action.test.ts:17`, `join.test.ts:22`), the exported `handleJoinInteraction`, and the pure builders. Locked inside the closure and unreachable: the whole `nav:` bar, the `action:dayjob:` work flow, the `action:custom:modal` chain, the four feedback/bug button→modal chains, and the slash-arm assembly (gate/ephemeral/payload) — plus the customId cascade order itself.
[I] Module-level flow state, keyed by userId, with NO exported clear-all: `pendingDecisions` + `_menuMessages` + `_sceneLookup` (`src/discord/commands/action.ts:90-107`), `_userInFlight` (`join.ts:63`). Wizard `sessions` (`WizardSession.ts:36`) is instance-scoped (fresh on `new WizardSession()`). `_interactionInFlight` (`index.ts:362`) lives at the registration site, outside the closure.
[I] No snapshot testing exists anywhere in `tests/` yet — the golden-transcript harness is greenfield; vitest snapshots are available.

Design point — SETTLED 2026-07-18 (resolves the `[!]` the parent doc's decision 4 left to the lead): **minimal DI hoist, not factories-only.** M1 is the safety net for M3, and M3's whole job is extracting these dispatcher branches — including the six areas locked inside the closure (the `nav:` bar, `action:dayjob:` work flow, `action:custom:modal`, the feedback/bug chains, the slash-arm assembly) and the cascade order. A factories-only oracle sees none of them, so it cannot protect the extraction; it is disqualified by purpose. The hoist is scaffolding for M1, explicitly NOT the M3 controller extraction — the closure body moves verbatim and the branches stay a byte-identical `if/else` on customId; M3 later reshapes them into a transport-neutral controller.

Design calls flowing from the survey:

[I] Guard + error funnel live OUTSIDE the closure, at the `client.on(InteractionCreate)` registration site (`:2419-2437`), not inside `dispatchInteraction`. So the hoist is a pure move of the closure body; the guard/funnel wrapper stays in `main()` and calls the hoisted function. M1's oracle characterises the closure's 17 leaf behaviours + cascade order (the M3 safety net); the registration-site guard/funnel is [[discord-interaction-layer]] plumbing (decision 5, sequenced after extraction) and is out of M1's golden-transcript scope — at most one cheap guard test if it falls out of the same harness for free.

[I] Byte-identical-body invariant. The hoist injects a `DispatchDeps` object and destructures it into locals at the function top under the SAME names the closure captured, so the ~930-line body below is copied character-for-character. If the body is verbatim, behaviour cannot change — this is the invariant the reviewer verifies, and it makes the "a snapshot cements a hoist bug" risk moot (there is nothing to cement).

[I] DI surface. Everything the closure references that is constructed in `main()`'s scope OR is module-level in the self-executing `src/index.ts` becomes an injected dep, so the new module never imports from `index.ts` and stays free of its DB-open/`client.login` self-exec. Compiler-guided: after the move, every unresolved symbol is either a Group-B import from a non-self-executing module (add the import) or a dep (add to `DispatchDeps`). Known members from the survey: `engine`, `registry`, `getCurrentScene`, `dayJobs`, `joinWizards`, `notifyAdmin`, `safeErrorReply`, `VERBOSE`, `ADMIN_USER_ID`, `CHARACTER_GATED_COMMANDS` — final list is whatever the compiler surfaces. Definitions are NOT relocated; `index.ts` stays their owner (relocation is M3's remit).

[I] Snapshot determinism. Neutralise nondeterminism before snapshotting — `randomIdleMessage` (`IdleMessageSelector`), any `Date`/now in footers, random art/banner selection: mock or seed so transcripts are stable. Because the four action/join maps have no clear-all, key every transcript on a UNIQUE userId to avoid cross-transcript bleed; construct a fresh `WizardSession` per transcript.

Tasks:

M1.1 — Hoist (own commit, mechanical refactor):
[ ] Create `src/discord/dispatchInteraction.ts` exporting `async function dispatchInteraction(interaction: Interaction, deps: DispatchDeps): Promise<void>` and the `DispatchDeps` interface; move the closure body from `src/index.ts:1487-2417` verbatim, destructuring `deps` into same-named locals at the top.
[ ] In `src/index.ts` `main()`, import and call it; the `client.on` guard/funnel wrapper (`:2419-2437`) stays, now wrapping `dispatchInteraction(interaction, deps)`, with `deps` wired from the existing main()-scope bindings.
[ ] Verify: `npm run typecheck` clean; `npm test` green at 78 files / 1462 tests (no delta — pure move, zero behaviour change).

M1.2 — Oracle (own commit, tests):
[ ] Golden-transcript harness under `tests/discord/` mirroring the existing fake-interaction pattern (`MockWorldEngine` + fresh `WizardSession` + `vi.fn()` spy interactions; assert on `spy.mock.calls[n][0]` embeds/components/modal shape), using vitest `toMatchSnapshot`.
[ ] Cover all 17 leaf behaviours: the slash arm (gate/reroute/nav-buttons), the 14 customId branches, and the 3 `nav:` sub-branches — including the heaviest, the `action:dayjob:` work flow.
[ ] Pin cascade ORDER via the specific-before-broad cases: `action:dayjob:custom` before `action:dayjob:`, `action:custom:modal` before `action:`, and `action:dayjob:` before `action:`.
[ ] Unique userId per transcript; neutralise the nondeterminism sources above; snapshots committed.
[ ] Verify: `npm test` green with the new suite; every transcript produces stable, meaningful output (not empty spies).

Scope fence (both tasks): no branch logic changes; no definition relocation; do not touch `action.ts` / `join.ts` / `WizardSession.ts` internals (import them as-is); no engine changes; M2/M3 shaping is out of bounds.

Execution state: _in progress — plan written 2026-07-18; design point settled (minimal DI hoist)._

## M2 — Semantic view-state DTO + shared renderers

[<] Plan written when M1 is green (may start alongside M1 per the parent doc).

## M3 — Controller extraction, screen-by-screen

[<] Plan written when M1 is green. First sizing task: inventory the `index.ts` dispatcher branches into pure-Discord vs game-flow buckets.

## M4 — Agent-player adapter

[<] Plan written when M3 lands.

---

Parent spec: [[layer-boundaries-and-json-seam]] — milestone checkboxes and all design decisions live there; changing a decision needs a `decisions/` record.
