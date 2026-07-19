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
[x] Create `src/discord/dispatchInteraction.ts` exporting `async function dispatchInteraction(interaction: Interaction, deps: DispatchDeps): Promise<void>` and the `DispatchDeps` interface; move the closure body from `src/index.ts:1487-2417` verbatim, destructuring `deps` into same-named locals at the top.
[x] In `src/index.ts` `main()`, import and call it; the `client.on` guard/funnel wrapper (`:2419-2437`) stays, now wrapping `dispatchInteraction(interaction, deps)`, with `deps` wired from the existing main()-scope bindings.
[x] Verify: `npm run typecheck` clean; `npm test` green at 78 files / 1462 tests (no delta — pure move, zero behaviour change).

M1.2 — Oracle (own commit, tests):
[x] Golden-transcript harness under `tests/discord/` mirroring the existing fake-interaction pattern (`MockWorldEngine` + fresh `WizardSession` + `vi.fn()` spy interactions; assert on `spy.mock.calls[n][0]` embeds/components/modal shape), using vitest `toMatchSnapshot`.
[x] Cover all 17 leaf behaviours: the slash arm (gate/reroute/nav-buttons), the 14 customId branches, and the 3 `nav:` sub-branches — including the heaviest, the `action:dayjob:` work flow.
[x] Pin cascade ORDER via the specific-before-broad cases: `action:dayjob:custom` before `action:dayjob:`, `action:custom:modal` before `action:`, and `action:dayjob:` before `action:`.
[x] Unique userId per transcript; neutralise the nondeterminism sources above; snapshots committed.
[x] Verify: `npm test` green with the new suite; every transcript produces stable, meaningful output (not empty spies).
[x] Review fix: characterise the resolved/outcome render path (was uncovered — every transcript stopped at a decision) for the three action leaves; `broadcastOutcome`/`announceCollapse` neutralised via asserted spies; `getCurrentScene` given a fixed realistic scene.

Scope fence (both tasks): no branch logic changes; no definition relocation; do not touch `action.ts` / `join.ts` / `WizardSession.ts` internals (import them as-is); no engine changes; M2/M3 shaping is out of bounds.

Execution state: _done 2026-07-19._ M1.1 hoist `b9b4c4a` (DI surface = the 10 expected `DispatchDeps` fields; body verbatim, reviewer-confirmed 0-diff over 929 lines). M1.2 oracle `2a3a069` + review fix `0bd0401` (all 17 leaves + the resolved/outcome sub-path; cascade order pinned with branch-fired assertions). Final: typecheck clean, 79 files / 1489 tests green (+27 over the M0 baseline). Known deliberate property (accepted review finding, not a defect): the day-job snapshots bake in real `assets/char-creation/day-jobs.yml` content via the seeded sampler — a future YAML edit will (correctly) churn those snapshots; keep the driven day-job indices within Town Guard's real action pool.

## M2 — Semantic view-state DTO + shared renderers

Goal: introduce the semantic view-state DTO (parent doc decision 2) and the view-state→medium step, then port `buildDecisionMessage` / `buildOutcomeEmbed` (both in `src/discord/commands/action.ts`) behind them so Discord output is **byte-identical**. This is a pure internal refactor: the two public builders keep their exact signatures and output; no call site changes. The M1 oracle (`tests/discord/dispatch-oracle.test.ts`), `tests/discord/action-decision.test.ts` and `tests/discord/action-divine.test.ts` are the byte-identical gate — all must stay green with zero snapshot churn.

Design calls (lead, within decision 2):

[I] The seam splits each builder in two. `buildXView(...)` assembles a **semantic** `ViewState` DTO — named text/ANSI content blocks (all produced by the existing neutral string helpers) plus option semantics, footer, title and a colour *intent* — importing nothing from `discord.js`. `XViewToDiscord(view)` is the **medium step**: it owns block joining, the embed-length degradation ladder, and all `EmbedBuilder` / `ButtonBuilder` / `ActionRowBuilder` construction. The public builder becomes `XViewToDiscord(buildXView(...))`.

[I] The embed 4096-char degradation ladder is a *medium* concern (a Discord embed cap; a web adapter would not have it), so it lives in the medium step. To keep it byte-identical the DTO carries BOTH the full and the collapsed story-thread variant (each is just `buildStoryThread(..., collapse, ...)` with a fixed boolean), so the medium step re-runs the exact same `assemble`/degrade decisions on pre-rendered strings.

[I] Colour is carried as a semantic `ViewColorIntent` union; the medium step maps intent→hex, reproducing `outcomeColor()` and the decision constant `0xdaa520` exactly. The opening-frame embed's fixed `0x2c2f33` stays internal to the medium step (it is medium chrome, never a semantic choice).

[I] File layout. DTO types → new `src/view/viewState.ts` (a module that imports NOTHING from `discord.js` — that non-import is the structural guarantee the DTO is transport-neutral). Medium step → new `src/discord/viewToDiscord.ts` (owns the `discord.js` weld; produces embed/component JSON, not strings, so it belongs in the adapter layer, not the pure `src/render/*`). The text helpers (`quoteLines`, `clip`, `dcArrow`, `statEmoji`, `buildStoryThread`, `renderCombatStatusFrame`, `MAX_EMBED_DESC`, `INSIGHT_MARGIN`) stay in `action.ts` and are imported/used as-is; relocation is M3's remit (mirrors M0/M1 "definitions not relocated").

DTO shape (final — the executor implements exactly this):

[I] `DecisionViewState` = `{ screen: 'decision'; title: { emoji; text }; colorIntent: 'decision'; storyThread?: { full: string; collapsed: string }; narration?: string; combatStatus?: string; prompt: string; optionLines: string[]; buttons: Array<{ kind: 'choice'; letter: string; customId: string; favoured: boolean } | { kind: 'bail'; label: string; customId: string }>; footer: string; openingFrame?: string }`. `narration`/`combatStatus`/`prompt`/`storyThread.*`/`optionLines`/`openingFrame` are the already-rendered strings the current code produces (quoted narration/prompt, ANSI frames, `**A.** …` option lines); `buttons` mirror the current `ButtonBuilder` set 1:1 (bail carries `shortLabel(opt.label, 80)`; choice carries just the letter).

[I] `OutcomeViewState` = `{ screen: 'outcome'; title: { emoji; text }; colorIntent: ViewColorIntent; locationLine?: string; breadcrumb?: string; sceneBlock?: string; combatSceneBlock?: string; isCombat: boolean; storyThread?: { full: string; collapsed: string }; outcomeBlock: string }`. `storyThread` is absent when `opts.compact` (the current `!compact` guard); `isCombat` = `!!outcome.combatBeat` (selects `combatSceneBlock` over `sceneBlock` when including the scene). The medium step's `assemble(collapseHistory, includeScene)` reproduces the current part order exactly: `locationLine`, `breadcrumb`, scene (combat vs plain per `isCombat`+`includeScene`), story-thread (unless compact), `outcomeBlock`.

[I] `ViewColorIntent` = `'decision' | 'success' | 'failure' | 'skipped' | 'bailed' | 'done' | 'timed_out' | 'default'`. `buildOutcomeView` maps `outcome.outcome` to the intent; the medium step maps intent→hex per the current `outcomeColor` switch.

Tasks:

M2.1 — DTO + medium step + port (own commit):
[ ] Create `src/view/viewState.ts`: export `DecisionViewState`, `OutcomeViewState`, `ViewState` (union), `ViewColorIntent`, and the button-item union type. No runtime code, no `discord.js` import.
[ ] Create `src/discord/viewToDiscord.ts`: export `decisionViewToDiscord(view: DecisionViewState): { embeds; components }` and `outcomeViewToDiscord(view: OutcomeViewState): ReturnType<EmbedBuilder['toJSON']>`. Move the join + degradation ladder + `EmbedBuilder`/`ButtonBuilder`/`ActionRowBuilder`/5-per-row chunking + colour-intent→hex mapping here, verbatim in behaviour.
[ ] In `action.ts`: add `buildDecisionView(...)` and `buildOutcomeView(...)` (same parameter lists as the current builders) returning the DTOs; re-express `buildDecisionMessage` as `decisionViewToDiscord(buildDecisionView(...))` and `buildOutcomeEmbed` as `outcomeViewToDiscord(buildOutcomeView(...))`. Export `buildDecisionView`/`buildOutcomeView`. Keep every helper in place.
[ ] Verify: `npm run typecheck` clean; `npm test` green at 79 files / 1489 tests with ZERO snapshot churn (`git diff --stat` shows no change under `tests/discord/__snapshots__/`). If any snapshot changes, the port drifted — fix the port, never re-bless the snapshot.

M2.2 — DTO-level test (own commit, or fold into M2.1 at lead's call):
[ ] Add `tests/discord/view-state.test.ts` asserting `buildDecisionView`/`buildOutcomeView` return the expected semantic shape for a representative decision (with options + favoured hint) and outcome (combat + non-combat), and that a round-trip `XViewToDiscord(buildXView(...))` equals the direct `buildXMessage(...)` on the same inputs. This pins the seam independently of the Discord snapshots.

Scope fence: no behaviour/branch changes; no caller changes in `dispatchInteraction.ts` or `action.ts` button handlers; do not relocate helper definitions; no engine changes; no `src/render/*` changes; M3 controller shaping is out of bounds. The DTO is a presentation view-state (screen/prompt/options/art/footer), NOT an engine or protocol type.

Execution state: _in progress._

## M3 — Controller extraction, screen-by-screen

[<] Plan written when M1 is green. First sizing task: inventory the `index.ts` dispatcher branches into pure-Discord vs game-flow buckets.

## M4 — Agent-player adapter

[<] Plan written when M3 lands.

---

Parent spec: [[layer-boundaries-and-json-seam]] — milestone checkboxes and all design decisions live there; changing a decision needs a `decisions/` record.
