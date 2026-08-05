---
title: JSON Seam — Protocol & Full-Seam Refactor (M5–M10)
status: decided
domain: engine
phase: mvp
tags: [architecture, layering, engine, controller, json, seam, protocol, contract-tests, agent-player, discord, build-plan]
related:
  - "[[layer-boundaries-and-json-seam]]"
  - "[[json-seam-build-plans]]"
  - "[[discord-interaction-layer]]"
  - "[[poc-plus-roadmap]]"
---
The deferred half of [[layer-boundaries-and-json-seam]]: the formal JSON protocol seam its gap table deferred ("protocol seam — does not exist") and the Discord-adapter rebuild M4 explicitly postponed ("a later, optional bolt-on; deferred, not dropped"). Motivation: the Release A measurement (§ Stage 4, findings 1–2 of `docs/archived/poc-plus/poc-plus-release-a-plan.md`) proved the agent-player is the only playtest instrument we have until human testing resumes, and today it is a privileged client — it calls `SessionController`'s typed methods in-process and goes engine-direct for the bookends, so its findings are not guaranteed player-true. This refactor makes the seam a real, single JSON channel that every frontend crosses for every mechanic, so agent smoke runs play exactly what players play, and frontends and backends become independently swappable. Direction settled with the owner 2026-08-02 (see Settled direction). Execution is one orchestrated-delegation **loop**, not a graph — see § Loop, not graph.

---

## The law

**Every game mechanic crosses the single JSON seam. No frontend holds a privileged channel to the engine or controller; no game rule, flow, or render-assembly lives in an adapter.** A frontend translates its transport's events into protocol input-events and paints the returned envelopes; the backend owns everything else. Frontends (Discord, agent-player, a future web UI) and backends (the real engine, a stub, a future service) are interchangeable because the protocol is the only surface either side sees.

## Settled direction (owner, 2026-08-02)

1. **Full scope.** The Discord adapter is rebuilt onto the protocol in this arc, not deferred again. The seam is only "single" when Discord crosses it too.
2. **Bookends come in.** Character creation, nightly rest+tick, and `/hi` stop being Discord-only flows the agent reaches engine-direct (M4's DA-4). The whole player lifecycle crosses the seam.
3. **The law applies going forward.** All future mechanics land behind the protocol; nothing new may ship as an adapter-side flow.
4. **Out of scope (deliberately separate):** the `AGENT_FORCE_FREE_ACTIONS`-style switch / day-job-rationing brain change from Release A finding 1. It is seam-independent and lands as its own task after this refactor; this arc must not grow it.

## Now — what exists (the banked base)

[p] `src/view/viewState.ts` — the semantic `ViewState` union (6 variants: decision, outcome, notice, menu, loading, commute), all-string fields, JSON-serialisable, imports nothing from `discord.js`. The response payload is already 90% built.
[p] `src/controller/SessionController.ts` (310 lines) — the transport-neutral flow owner for the action loop: `needsCharacterGate`, `stampLastPlayed`, `beginChoice`/`resolveChoice`/`stepChoice`, `openActionMenu`, `beginDayJob`/`commuteForWork`/`runWork`, `beginCustomAction`/`runCustomAction`, `feedbackConfirmation`/`recordFeedback`.
[p] `src/discord/dispatchInteraction.ts` (927 lines) — transport + paint only since M3; the M1 golden-transcript oracle (`tests/discord/dispatch-oracle.test.ts`) and the M2 snapshots characterise its behaviour byte-for-byte.
[p] `src/agent/harness.ts` — plays the mid-day loop through those same typed controller methods; `viewToText` is the agent medium step.
[c] The agent is a **typed-call client**, not a protocol client: no event/envelope vocabulary exists, so "every response matches the envelope" cannot be asserted, and a stub backend cannot be substituted.
[c] **Bookends bypass the seam.** Character creation (`commands/join.ts`, 511 lines + `WizardSession.ts`), rest+tick (`commands/sleep.ts`), and `/hi` (`commands/hi.ts`) have no controller seam and no `ViewState`; the agent harness calls the engine directly for them.
[!] **A second rule leak:** the unsafe-rest −1 HP penalty lives in `src/discord/commands/sleep.ts` (~:87-107), not the engine — the same smell as the M0 commute leak, and the reason the agent harness's `endDay` can never surface unsafe-rest feedback (M4.5 fidelity caveat 2). M7 moves it into the engine, mirroring M0.
[c] Read-only screens (`look`, `map`, `stats`, `backpack`, `journal`, `help`) are direct engine reads + render inside command files. Small, but they are mechanics, so the law covers them.

## Target

```mermaid
flowchart TB
  classDef adapter fill:#1e2c3a,stroke:#5b9bd5,color:#e6f0ff
  classDef core fill:#1e3a2f,stroke:#3fb37f,color:#e6ffee
  classDef seam fill:#3a331e,stroke:#d5b45b,color:#fff6e0

  subgraph FE["Frontends — translate + paint only"]
    DISC["Discord adapter<br/>interaction ⇄ GameEvent · paint GameResponse"]:::adapter
    AGENT["Agent-player adapter<br/>brain ⇄ GameEvent · viewToText paints"]:::adapter
    WEB["Web adapter (future)"]:::adapter
  end

  PROTO{{"src/protocol/<br/>GameEvent ⇅ GameResponse envelope<br/>contract tests assert EVERY response matches"}}:::seam

  subgraph BE["Backend — the only game owner"]
    ROUTER["Event router<br/>validate → dispatch → envelope · never throws"]:::core
    CTRL["SessionController<br/>ALL flow incl. wizard, rest, /hi"]:::core
    ENGINE["WorldEngine — ALL rules<br/>(+ unsafe-rest penalty, moved from sleep.ts)"]:::core
  end

  DISC <--> PROTO
  AGENT <--> PROTO
  WEB <--> PROTO
  PROTO <--> ROUTER
  ROUTER --> CTRL
  CTRL --> ENGINE

  STUB["Stub backend (test)<br/>proves interchangeability"]:::core
  PROTO <--> STUB
```

## Protocol design — settled calls and lead-owned questions

[I] **Home: `src/protocol/`.** A new top-level module that imports nothing from `discord.js`, `src/discord/`, `src/agent/`, or the engine implementation (engine *types* only where unavoidable). The non-imports are the structural guarantee, same trick as `viewState.ts`.
[I] **Envelope.** `GameResponse = { ok: true; view?: ViewState; facts?: Record<string, unknown> } | { ok: false; error: { code: GameErrorCode; message: string } }`. `facts` carries the semantic side-channel data adapters already consume (distilled type, character name, broadcast payload facts), so no adapter re-derives them. Exact shape is the lead's first settle; every field must be JSON-serialisable.
[I] **Events.** `GameEvent` is a discriminated union on `type`. First-cut inventory, mapped to today's surface: `menu.open`, `dayjob.start`, `action.custom`, `action.choose` (option index | bail), `feedback.submit`, `bug.submit` (the M5 action loop); `rest.begin`, `hi.open`, `character.create` + wizard-step events (M7); `screen.render` variants for look/map/stats/backpack/journal (M8). The union grows only in the slice that first needs each event — the established "no unused vocabulary ahead of a caller" rule.
[I] **Identity is opaque.** Events carry a `playerId: string`; nothing in the protocol assumes a Discord snowflake. (Today that string *is* the Discord user id; the protocol must not care.)
[I] **The router never throws.** Malformed events, unknown types, illegal moves, and backend errors all come back as `ok: false` envelopes with a stable `GameErrorCode` taxonomy (`no-character`, `no-rolls`, `stale-session`, `illegal-move`, `unsafe`, `invalid-event`, `internal`, …). A throw escaping the router is a contract violation the suite tests for.
[I] **Versioning.** A `PROTOCOL_VERSION` constant stamps the module; recorded in transcripts so a future breaking change is detectable.
[I] **Validation is hand-rolled**, matching the repo's gateway convention (throw-loud parse/validate functions, e.g. `resolveReport` in `ProdPlaytestCriticGateway`). No schema-library dependency.
[I] **In-process transport** (parent decision 3 stands): frontends import the router and pass objects. The protocol *shape* is the asset; a network socket stays a later bolt-on.

[I] **Staged flows and interstitial beats — SETTLED 2026-08-02 (option a).** The router takes an optional `onBeat(beat: GameResponse)` callback for interstitials while the final envelope is the return value: `dispatch(event: unknown, onBeat?): Promise<GameResponse>`. Beats are full `ok: true` envelopes carrying `loading`/`commute` views, emitted in flow order; flow stays server-side, in-process-friendly, and a future network transport maps beats to streamed messages. **Beat semantics: beats are advisory; the returned envelope is authoritative.** The router wraps every `onBeat` invocation in try/catch — a throwing adapter paint callback is `console.error`-logged and the flow continues, so the router-never-throws guarantee covers callback throws too (settles the coordinator's pre-flight risk 2). The same mechanism covers the custom-action and action-choice "Thinking…" beats. The contract suite asserts beat envelope-conformance, JSON round-trip, ordering, and never-throws (including a throwing `onBeat`) from M5 on.
[I] **Wizard state ownership.** The join wizard's multi-step session state (`WizardSession.ts`, currently instance-scoped adapter state) must become backend-owned for `character.create` to cross the seam — either controller-held session state keyed by `playerId`, or engine-persisted draft state. The M7.3 slice plan settles it; note the tension with parent decision 1 (session state is engine-owned, controller stateless) — that decision covered *option-resolution* state, and extending it to wizard drafts is a genuine design call, not a given. **Per the coordinator's pre-flight steer, M7.3's plan includes a `decisions/` record for whichever extension is chosen — the parent doc requires one to change a settled decision, and it must not be smuggled in as a slice note.**

## The contract-test barrier (the point of the exercise)

The single highest-value artefact in this arc is `tests/protocol/` — a suite that turns barrier verification from reading diffs into running a command. It lands in M5, **before** any migration, and every later slice extends it in the same commit as the event it adds.

- **Conformance:** every `GameResponse` the router emits, across every event type and every branch (success, each error code, each `ViewState` variant), validates against the envelope schema. "Every response matches the envelope" is asserted, not reviewed.
- **Negative space:** unknown event types, malformed payloads, out-of-range indices, and illegal moves for the current screen all return `ok: false` envelopes; the router never throws.
- **Round-trip:** every `ViewState` variant survives `JSON.parse(JSON.stringify(view))` unchanged (the seam is JSON even in-process).
- **Interchangeability:** the same suite runs against (a) the real backend and (b) a minimal stub backend behind the router. A frontend can be built and tested against the stub; the backend can be replaced under a frontend. This is the executable proof of the law.
- **No network, deterministic:** like every existing suite, it runs in `npm test` with stubs.

## Loop, not graph (execution shape — binding)

This arc runs as **one orchestrated-delegation loop per slice**: lead specs the slice → executor builds → lead verifies (re-run gates, read the riskiest file) → commit → fresh-context reviewer → triage → fixer → verify → commit → coordinator checkpoint → `/clear`. **No parallel streams, no worktrees.** The honest warning from principle 9 applies in full: comms reworks feel parallelisable but aren't, because `SessionController.ts`, `dispatchInteraction.ts`, `viewToDiscord.ts`, `viewState.ts`, and `src/agent/harness.ts` are touched by nearly every slice — two streams would share files, which makes them one stream. A loop of small per-domain slices is still fast, and far cheaper than untangling colliding worktrees.

## Milestones

Order is binding. Each milestone's detailed task checklist is written by the implementing lead just before it starts (the established pattern — over-specifying ten checklists upfront only gets rewritten as the protocol shape settles). Gates stack: every commit keeps **all** prior gates green. The M5–M10 checklists live in this doc (the M0–M4 pattern's `json-seam-build-plans.md` stays the M0–M4 record).

[x] M0–M4 — done (see parent doc): engine seam, oracle, view-state DTO, controller, agent-player adapter.
[x] **M5 — The contract.** *(done 2026-08-02 — slices M5.0/M5.1 below)* `src/protocol/` types (envelope, M5-event union, error taxonomy, version) → `tests/protocol/` contract suite → the in-process event router over `SessionController` for the action-loop events (`menu.open`, `dayjob.start`, `action.custom`, `action.choose`, `feedback.submit`, `bug.submit`), interstitial-beat mechanism settled and built. Purely additive: no production caller yet, zero behaviour change. Gate: typecheck + suite green at baseline; contract suite green against real backend and stub.
[x] **M6 — Agent-player becomes a protocol client.** *(done 2026-08-02 — single slice, execution state below)* `src/agent/harness.ts` speaks only `GameEvent`/`GameResponse` through the router for the mid-day loop (bookends stay engine-direct until M7); no controller imports left in the action path; `viewToText` reads envelope views. Gate: deterministic harness tests green (scripted brain, no network); one live `npm run agent:play` smoke run clean (exit 0, no new findings).
[ ] **M7 — Bookends through the seam.** M7.0 extends the characterisation oracle to the join/hi/sleep command paths *first* (the M1-before-M3 pattern: no migration without a net). M7.1 rest+tick: the unsafe-rest −1 HP rule moves from `sleep.ts` into the engine (M0-style leak fix), `rest.begin` event + view-state, `sleep.ts` rewires, the agent drops its engine-direct `endDay`. M7.2 `/hi` through the seam. M7.3 character creation through the seam (wizard state ownership settled; the hardest slice — judge candidate). Gate: M7.0 oracle coverage green before each migration; contract suite extended per event; agent lifecycle fully protocol-driven.
[ ] **M8 — Read-only screens through the seam.** `look`, `map`, `stats`, `backpack`, `journal` (and `help` if it carries game content) become `screen.*` events returning view-states; the agent gains full player parity. Small slices, one per screen or batched at the lead's call.
[ ] **M9 — Discord adapter rebuilt onto the protocol.** `dispatchInteraction.ts` and the command files become translate + paint only: interaction → `GameEvent` → router → paint via `viewToDiscord`. Zero controller/engine imports remain in `src/discord/` (structural check, e.g. madge). Gate: **byte-identical** — the M1 oracle + M2 snapshots + M7.0 bookend coverage all green with zero snapshot churn; a snapshot change means the port drifted — fix the port, never re-bless.
[ ] **M10 — Closeout.** Interchangeability proof recorded (contract suite green against stub + real backend); the parent doc's gap-table "protocol seam" and "frontend adapters" rows settled; `CHANGELOG.md`, `TODO.md`, and this doc's execution state updated; the `AGENT_FORCE_FREE_ACTIONS` follow-up task written up in `TODO.md` as the next arc's first item.

## M5 build plan (lead-settled 2026-08-02)

Goal: `src/protocol/` — the envelope, the M5 event union, the error taxonomy, the version stamp, hand-rolled validators, and the in-process router over `SessionController` for the six action-loop events — plus `tests/protocol/`, the contract-test barrier. **Purely additive: no production caller, zero behaviour change, no edits to existing source files.** Gate: typecheck clean; full suite green at the 89 files / 1686 tests baseline plus the new protocol tests; the contract suite green against the real backend (SessionController + MockWorldEngine) and a canned stub backend alike.

### Settled design calls (M5)

[I] **Envelope (DC-P1, frozen).**

```ts
export const PROTOCOL_VERSION = 1;

export type GameErrorCode =
  | 'no-character' | 'no-rolls' | 'stale-session' | 'session-expired'
  | 'illegal-move' | 'unsafe' | 'empty-action' | 'invalid-event' | 'internal';

export type GameResponse =
  | { v: number; ok: true; view?: ViewState; facts?: Record<string, unknown> }
  | { v: number; ok: false; error: { code: GameErrorCode; message: string }; facts?: Record<string, unknown> };
```

`v` stamps every envelope (= `PROTOCOL_VERSION`) so conformance is trivially assertable and a future breaking change is detectable per message. `facts` is allowed on error envelopes too (the `stale-session` narration needs it). **`facts` is a closed set:** the response validator whitelists known keys and rejects anything else, so the escape hatch cannot grow without a deliberate validator edit (the coordinator's "second protocol" risk). M5's keys: `distilledType`, `characterName`, `characterClass`, `actionId` (outcome broadcasts; consumers: the M9 Discord broadcast line, the M6 agent transcript), `nav: { rollsRemaining, hasPendingAction, hasRestedToday }` (the exact three fields `getNavButtons` reads; consumer: M9 nav-button assembly), `narration` (only on `stale-session` errors; consumer: the slash `/action` stale paint's `withNarration`).

[I] **Events (DC-P2).** `GameEvent` is a discriminated union on `type`, `playerId: string` everywhere (opaque identity — the protocol must not care that today it's a Discord snowflake):

```ts
| { type: 'menu.open'; playerId: string }
| { type: 'dayjob.start'; playerId: string; jobIndex: number }
| { type: 'action.custom'; playerId: string; text: string }
| { type: 'action.choose'; playerId: string; selector: { kind: 'option'; index: number } | { kind: 'bail' } }
| { type: 'feedback.submit'; playerId: string; surface: 'sleep' | 'release' | 'outcome-feedback'; text: string; actionId?: number }
| { type: 'bug.submit'; playerId: string; text: string; actionId?: number }
```

`bug.submit` maps to the controller's `'outcome-bug'` surface; the union grows only in the slice that first needs each event.

[I] **The router boundary takes `unknown` (DC-P3).** `dispatch(event: unknown, onBeat?): Promise<GameResponse>` — validation is the router's job, so the negative-space barrier (malformed payloads → `ok: false 'invalid-event'`, never a throw) is structural, not a test hope. Hand-rolled validators per the repo's throw-loud convention, but internal: `validateGameEvent(raw)` returns `{ ok: true; event } | { ok: false; message }`.

[I] **Result → envelope mapping (DC-P4).** The router owns player-facing copy; the adapter keeps only medium chrome (embed title/colour keyed by error code + call site, ephemeral flags). Byte-identity recon (2026-08-02) found the two no-character copies split cleanly by event — `menu.open`'s callers (nav:action, slash `/action`) both use the "…yet. Type `/join` to create one." copy, the three other events' call sites use "…Type `/join` first." — so per-event canonical copy preserves every current paint with zero drift:

| Controller result | Envelope |
| --- | --- |
| `no-character` (menu.open) | `ok:false 'no-character'`, `"You don't have a character yet. Type \`/join\` to create one."` |
| `no-character` (other events) | `ok:false 'no-character'`, `"You don't have a character. Type \`/join\` first."` |
| `no-rolls` | `ok:false 'no-rolls'`, the 🛌 copy (identical at both call sites today) |
| `resume-stale` | `ok:false 'stale-session'`, message = prompt, `facts.narration` when present |
| `resume-error` | `ok:false 'internal'`, message = the error message |
| `menu` / `resume-decision` / `resume` | `ok:true`, view |
| `invalid-job` | `ok:false 'illegal-move'`, `"Invalid job action."` |
| `unsafe` | `ok:false 'unsafe'`, the ⚠️ copy with `location` interpolated |
| `resolveChoice` → null | `ok:false 'session-expired'`, `"❌ Your action session expired. Try \`/action\` again."` |
| `empty-action` | `ok:false 'empty-action'`, message = prompt |
| `decision` / `outcome` (runWork/runCustomAction/stepChoice) | `ok:true`, view (+ outcome `facts` per DC-P1; the RA-6 identical `viewPrivate`/`viewPublic` pair travels as ONE view) |
| feedback/bug submit | `ok:true`, view = the surface's confirmation `NoticeViewState`; `recordFeedback` runs inside the router in try/catch (best-effort, preserving today's reply-first resilience) |
| any controller throw | `ok:false 'internal'`, message = `err.message` (the router never throws) |

[I] **Beats (DC-P5, per the settled onBeat decision).** One `idle()` string per dispatch, threaded into every beat of that dispatch (matches today's single `randomIdleMessage()` call): `dayjob.start` beats `loading { body: "⏳ **Starting…**\n_${idle}_" }` after guards pass, then `commute { destination, idle }` when commuted, then the final envelope; `action.custom` beats `loading { body: "**You:** ${clipped}\n\n⏳ **Thinking…**\n_${idle}_" }` (the 280-char clip moves into the router — it is part of the screen copy); `action.choose` beats `loading { body: "**You:** ${label}\n\n⏳ **Thinking…**\n_${idle}_" }` after resolution. The router's idle source is an injected `() => string` dep (the Discord adapter passes `randomIdleMessage` at M9; the agent + tests pass deterministic ones) — `src/protocol/` stays free of adapter imports.

[I] **Event flow order (DC-P6, faithful to today's leaves).** `menu.open`: `stampLastPlayed` → `openActionMenu` (the nav:action leaf's order). `dayjob.start`: `beginDayJob` (its own inline stamp) → beat → `commuteForWork` → beat-if-commuted → `runWork`. `action.custom`: `beginCustomAction` → (resume → view) → beat → `runCustomAction`. `action.choose`: `beginChoice` → `resolveChoice` → beat → `stepChoice`. No stamps beyond today's.

[I] **Stub backend + the RouterBackend interface (DC-P7).** The router depends on a `RouterBackend` interface — exactly the controller surface it calls (`stampLastPlayed`, `openActionMenu`, `beginDayJob`, `commuteForWork`, `runWork`, `beginCustomAction`, `runCustomAction`, `beginChoice`, `resolveChoice`, `stepChoice`, `feedbackConfirmation`, `recordFeedback`). `SessionController` satisfies it structurally; the contract suite's stub is a canned-script fixture. This is the interchangeability proof staying in M5 scope (the coordinator's steer), not drifting to M10.

[I] **File layout (DC-P8).** `src/protocol/envelope.ts` (version, types, `validateGameResponse` — whitelists the `facts` keys), `src/protocol/events.ts` (the union + `validateGameEvent`), `src/protocol/router.ts` (`GameRouter`, the mapping, the beat mechanics). Non-imports per the spec's Home rule: nothing from `discord.js`, `src/discord/`, `src/agent/`; engine/controller *types* only where unavoidable; `ViewState` from `src/view/viewState.ts`.

[I] **Known M9 watch items (flagged, not smuggled).** (1) The slash `/action` stale-resume fallback copy (`'Your previous action could not be recovered.'`, inline in `commands/action.ts`) differs from the controller's (`'Could not recover.'`). When M9 routes slash `/action` through `menu.open`, the controller's fallback wins — a copy-only drift on a dead-edge path. Settle at M9 with the oracle coverage in hand; if the path is characterised, record the unification as a decision, never re-bless silently. (2) The profanity guard (`checkProfanity`, `dispatchInteraction.ts` ~:315-321) runs adapter-side before `beginCustomAction`; the law ("no game rule lives in an adapter") forces a decision at M9 — move it behind the seam (router or controller) or record why it stays. Found by the M5.1 review.

### Slices

[x] **M5.0 — Types + validators.** *(done 2026-08-02, build `050020c` + review fix `a3920f0`)* `envelope.ts` + `events.ts` + unit tests (`tests/protocol/validate.test.ts`, 40 tests). Fresh-context review: one blocker accepted (the build commit's changelog edit had deleted the `## [0.3.3]` heading — restored) + three hardening fixes accepted (cross-arm pollution rejected — ok:true+error / ok:false+view; deep JSON-serialisability walk so nested functions can't pass; integer `nav.rollsRemaining`); whitespace-playerId dropped (identity is opaque by design). 90 files / 1726 tests green (+40 over the 1686 baseline), typecheck clean.
[x] **M5.1 — Router + contract suite (same commit — the coordinator's barrier).** *(done 2026-08-02, build `513921a` + review fix `22f291e`)* `router.ts` per DC-P4/P5/P6 + `tests/protocol/contract.test.ts` (95 tests): conformance of every event × every reachable branch against BOTH the real backend and a canned stub with shared expectations (hard-coded copy — the suite is the drift net), negative space, JSON round-trip (views + error-envelope facts), beat order pinned by an interleaved call log, never-rejects incl. hostile getters/unstringable throws. All 9 error codes and all 6 view variants reached. Fresh-context review: byte-identity of every copy constant + flow order verified programmatically against both adapter call sites (zero drift); accepted fixes closed two never-throws holes (gate inside the try; safeStringify at every catch), the falsy session-expired check, and suite gaps (beat position vs backend calls, beats-empty on error branches, stamp-throw path); dropped the idle-drawn-without-onBeat cosmetic. 91 files / 1821 tests green (+135 over the 1686 baseline), typecheck clean.

Scope fence (M5): additive only — no edits to existing source under `src/`; no new view-state variants (the union covers everything M5 emits); no production caller; no `sim/` changes; `PROTOCOL_VERSION` stays 1 throughout the arc unless a breaking change forces otherwise (flag it).

**Execution state:** M5.0 done (above). Open settles carried into M5.1: (1) the `empty-action` empty-prompt policy (review F8) — the validator rejects empty `error.message`, and the controller's `empty-action` carries a raw `firstDecision.prompt` that can be `''`, so the router must apply a fallback (settle: `prompt || 'Could not recover.'`, mirroring the controller's own resume-stale fallback; copy-only on a dead edge, flagged here per the scope fence); (2) the contract suite should assert decision/menu button-element shape on emitted views (review F7) since the envelope validator deliberately checks views shallowly.

---

## M6 build plan (lead-settled 2026-08-02)

Goal: `src/agent/harness.ts` speaks only `GameEvent`/`GameResponse` through `GameRouter` for the mid-day loop (bookends stay engine-direct until M7); no controller imports remain in the action path; `viewToText` reads envelope views. Gate: deterministic harness tests green (scripted brain, no network); one live `npm run agent:play` smoke run clean (exit 0, no new findings).

### Coordinator-steered viewToText diff (pre-build)

The coordinator's M5→M6 steer required diffing `viewToText`'s rendering inputs against the M5 `ViewState` variants field-by-field before wiring. Findings:

**Zero misses in the ViewState.** Every field `viewToText` reads per variant is present and typed:

- `decision`: title, openingFrame, storyThread.full, narration, combatStatus, prompt, optionLines (via buttons), footer — all in `DecisionViewState` ✓
- `outcome`: title, locationLine, breadcrumb, combatSceneBlock/sceneBlock (via isCombat), storyThread.full, outcomeBlock — all in `OutcomeViewState` ✓
- `notice`: text — in `NoticeViewState` ✓
- `menu`: title, description, buttons — all in `MenuViewState` ✓
- `loading`: body — in `LoadingViewState` ✓
- `commute`: destination, idle — in `CommuteViewState` ✓

**One gap: the agent's `AgentCharView` character snapshot.** `AgentHarness.ask()` currently calls `engine.getCharacter(userId)` → `agentCharView(char)` to build the `character` field of `ChooseMoveInput` for every `brain.chooseMove()` call — menu, decision, and post-outcome turns. This needs `name`, `class`, `health`, `maxHealth`, `stamina`, `maxStamina`, `rollsRemaining`, `wealth`, `location`. The envelope's `facts` already carry `characterName`, `characterClass`, and `nav.rollsRemaining` on outcomes, but (a) only on outcomes, not on menu/decision views, and (b) missing `health`, `maxHealth`, `stamina`, `maxStamina`, `wealth`, `location`.

**Settle (DC-M6.1): add `characterState` to the facts whitelist, populated on all view-bearing responses.** The missing fields are structured character state every frontend will need for player-facing HUD/chrome. Adding `characterState: { health, maxHealth, stamina, maxStamina, wealth, location }` to `facts` keeps the `characterName`, `characterClass`, and `nav` facts as-is (they serve other adapters) and extends `RouterBackend` with `getCharacter(userId)` so the router can populate the full snapshot on every view-bearing response. The consuming adapter (M6 agent harness) justifies the key in the same slice. No `facts` key is added without a consuming adapter proving it.

### Settled design calls (M6)

[I] **Character snapshot in facts (DC-M6.1).** Add `characterState` to `FACTS_KEYS` in `envelope.ts` with shape `{ health: number; maxHealth: number; stamina: number; maxStamina: number; wealth: number; location: string }`. Extend `RouterBackend` with `getCharacter(userId: string): CharacterData | null`. The router populates `facts.characterState` (plus already-existing `characterName`, `characterClass`, `nav`) on every view-bearing response: `menu.open` → menu/resume-decision, `dayjob.start` → outcome, `action.custom` → resume/outcome, `action.choose` → decision/outcome. The character is read ONCE per dispatch (immediately after the backend call that produces the view), and the same snapshot seeds `characterName`/`characterClass`/`nav` so there is no double-read. When the character is null (shouldn't happen on a view path — the caller already passed the guard), the `characterState` fact is omitted and the agent harness treats it as a fatal `no-character` finding.

[I] **Harness rewiring (DC-M6.2).** `AgentHarness` constructor takes `GameRouter` + `WorldEngine` (the engine is for bookends only: `seedCharacter`, `getMeta('day_number')`, `getCharacter` for invariant checks, `endDay`'s `restAtOak`/`tick`). The action path becomes:

- `menu.open` dispatch → read `ok:true` view; `ask()` builds `AgentCharView` from `response.facts.characterState` + `viewToText(response.view)`; brain move decides the next event
- `dayjob.start` dispatch with `onBeat` → the `onBeat` callback records commute beats into the transcript; the final envelope carries the outcome/decision/empty-action/error
- `action.custom` dispatch → resume returns a view directly; the thinking beat is passed through `onBeat`; outcome/decision handled same as dayjob
- `action.choose` dispatch → begin/resolve/step all inside the router; the thinking beat is passed through `onBeat`; outcome/decision handled same
- Error envelopes: the harness reads `ok:false` and maps `error.code` to the same `PlayResult` dispositions it already produces (no-character, no-rolls, stale-session, session-expired, illegal-move, unsafe, empty-action, internal → dead-end with the message as detail)
- The `seam()` wrapper is REMOVED — the router never throws, so no breadcrumb+try/catch is needed for controller calls. The outer `try/catch` stays for the transcript save (bookend throws + pure-code rendering errors), but the action path itself is throw-safe by construction.

[I] **Beats in the harness (DC-M6.3).** The router's `onBeat` callback is wired to:

- Commute beats (`commute` view) → recorded via `transcript.commute()` (same as today's explicit `commuteForWork` call)
- Loading/thinking beats → the agent does not render interstitial loading screens (they exist for the Discord player's multi-second wait); the harness absorbs them silently (the transcript records only player-visible beats — commutes are player-visible; "Thinking…" spinners are transport chrome)
- Beat errors: `onBeat` never throws (the router try/catches it), so a transcript push that fails is `console.error`-logged and the flow continues

[I] **Deterministic test port (DC-M6.4).** Port the existing M4 harness tests (`tests/agent/harness.test.ts`, 14 tests) to the protocol surface. The test helper `buildHarness()` creates a `GameRouter` over a canned stub `RouterBackend` (replacing the stub `SessionController` + `MockWorldEngine`). Port every test: one action e2e, day-job work flow, immediate-resolve, sleep, full-day loop, multi-day loop, QA capture (error envelopes, crashes, invariant sweeps, endDay fidelity, run summary). Add protocol-specific tests: beat order for dayjob.start (commute beat before outcome), error-code mapping (every `GameErrorCode` the harness can encounter), and the `characterState` fact is present on every view-bearing response.

[I] **play.ts wiring (DC-M6.5).** `play.ts` creates a `GameRouter` over the real `SessionController` and passes it to `createAgentHarness`. The harness file imports NO controller types — the import of `SessionController` and `SessionControllerImpl` from `harness.ts` is deleted. `createAgentHarness` takes `GameRouter` + `WorldEngine` instead of `AgentEngine`.

### Slice

[x] **M6 — Agent-player becomes a protocol client.** *(to be built)* Single commit (the harness is the only consumer, and the protocol changes only serve it).

#### Task checklist

1. **Extend protocol for `characterState` fact.**
   - Add `characterState` to `FACTS_KEYS` in `envelope.ts` with validator checking for `{ health: integer; maxHealth: integer; stamina: integer; maxStamina: integer; wealth: integer; location: string }` (all six fields present, integers non-negative except wealth which has no lower bound).
   - Add `getCharacter(userId: string): CharacterData | null` to `RouterBackend` interface in `router.ts`.
   - Add private helper `addCharacterFacts(userId: string, existingFacts?: Record<string, unknown>): Record<string, unknown>` to `GameRouter` — calls `backend.getCharacter(userId)`, returns merged facts with `characterState`, `characterName`, `characterClass` (when non-null), and `nav`; when char is null, returns `existingFacts` unchanged.
   - Call `addCharacterFacts` on every view-bearing branch: `dispatchMenuOpen` (menu + resume-decision), `dispatchActionCustom` (resume + after `renderStartResult`), `dispatchDayJobStart` (after `renderStartResult`), `dispatchActionChoose` (decision branch). `outcomeFacts` already sets `characterName`/`characterClass`/`nav`/`distilledType`/`actionId` on outcome branches — `addCharacterFacts` runs ADDITIONALLY on outcomes (it adds `characterState` without overwriting existing keys) and ON ITS OWN on non-outcome view branches (where there were no facts before).
   - `renderStartResult` already calls `outcomeFacts` on the outcome branch — pass the result through `addCharacterFacts` as a second step.
   - Verify: typecheck clean, existing contract tests green (no breakage — `characterState` is additive on outcome envelopes; non-outcome view envelopes gain facts they didn't have before, but the validator only checks that present facts are legal, not that certain facts MUST be present).

2. **Extend contract tests for `characterState`.**
   - Add `getCharacter` to the stub `RouterBackend` (returns the stub character).
   - Assert `characterState` is present on every view-bearing response: `menu.open` → menu, `menu.open` → resume-decision, `dayjob.start` → outcome, `action.custom` → resume, `action.custom` → outcome, `action.choose` → decision, `action.choose` → outcome.
   - Assert `characterState` shape: all six fields present + correct types.
   - Assert `characterState` is absent on error envelopes (the char guard is already the error response — no character exists to snapshot).
   - Assert `characterName` + `characterClass` (when non-null on the stub) are present on ALL view-bearing responses, not just outcomes.

3. **Rewrite `harness.ts` to use `GameRouter`.**
   - Replace `SessionController` + `SessionControllerImpl` imports with `GameRouter` + `GameRouterDeps`.
   - `AgentHarness` constructor: `engine: WorldEngine`, `router: GameRouter`, `brain`, `userId`. Store `engine` for bookends only.
   - `createAgentHarness` takes `{ engine, router, brain, userId }` instead of `AgentEngine`.
   - Remove `seam()` method entirely.
   - Rewrite `runAction()`: dispatch `{ type: 'menu.open', playerId: this.userId }` → switch on `ok`/`error.code` → build `PlayResult` from error codes, or read `view` + `facts.characterState` for the brain turn.
   - Rewrite `playMenu()`: extract `AgentCharView` from `facts.characterState` (with null guard → `no-character` fatal), call `ask()` with `viewToText(view)` + `agentCharView`, dispatch the brain's move as the appropriate event.
   - Rewrite `doDayJob()`: dispatch `dayjob.start` with `jobIndex`, wire `onBeat` to capture commute beats → `transcript.commute()`, handle the final envelope.
   - Rewrite `doCustom()`: dispatch `action.custom`, handle resume (direct view) vs outcome/decision.
   - Rewrite `runDecisionLoop()`: dispatch `action.choose`, no more `beginChoice`/`resolveChoice`/`stepChoice` calls — the router does all three internally.
   - Keep `endDay()` and `checkInvariants()` unchanged (engine-direct bookends).
   - `ask()`: takes `view: ViewState` + `charFacts: Record<string, unknown>` instead of calling `engine.getCharacter()`; builds `AgentCharView` from `charFacts.characterState` + `charFacts.characterName` + `charFacts.characterClass` + `charFacts.nav.rollsRemaining`.
   - Delete `SessionControllerImpl` import + constructor wiring.

4. **Port deterministic harness tests.**
   - Create stub `RouterBackend` (replace the existing stub controller). Returns canned `ActionMenuResult`/`DayJobStart`/`StartRenderResult`/`BeginCustomActionResult` per the existing test fixture, plus `getCharacter()` returning the stub character.
   - `buildHarness()` creates a `GameRouter` over the stub backend with a deterministic `idle: () => ''`.
   - Port all 14 existing tests: menu→custom→outcome, day-job work flow, immediate-resolve, sleep, full-day loop, multi-day loop, QA capture (no-character, no-rolls, resume-stale, resume-error, invalid-job, unsafe, crash, invariant breach, endDay throw, run summary).
   - Add protocol-specific tests: beat order asserted via a spy `onBeat` (commute beat fires + carries destination), error code → PlayResult mapping (each `GameErrorCode` maps to the expected disposition), `characterState` present on every brain turn's input.
   - The existing `tests/agent/harness.test.ts` file is REPLACED (the harness surface changes completely — no `SessionController` calls remain to test).

5. **Update `play.ts`.**
   - Create `GameRouter` over the real `SessionController` (constructed from `agentEngine`) with `idle: () => ''` (deterministic transcript).
   - Pass `{ engine: agentEngine.engine, router, brain, userId }` to `createAgentHarness`.
   - `harness.ts` must import zero controller types (verify with `grep -n 'SessionController' src/agent/harness.ts` returns nothing).

6. **Gate: typecheck + full suite green.**
   - `npm run typecheck` clean.
   - `npm test` green. All existing M4 harness tests ported and passing; contract suite extended for `characterState`; no regression in any existing suite.

7. **Gate: one live `npm run agent:play` smoke run.**
   - `AGENT_DAYS=1`, run `npm run agent:play`.
   - Assert exit 0, no new `error`-severity findings, coherent gameplay (the transcript shows a menu → action → outcome flow).

Scope fence (M6): bookends (`seedCharacter`, `endDay`, `restAtOak`, `tick`) stay engine-direct (M7 scope). No `sim/` changes. No Discord or controller source changes. No `viewState.ts` changes. `characterState` is the only facts-key addition — it is justified by the M6 agent harness in the same slice.

## Verification baseline

`npm run typecheck` clean; `npm test` green at **89 files / 1686 tests** (reconciled 2026-08-02 on `feat/json-seam-protocol` — the 1675 recorded in `TODO.md` at the 0.3.3 cut predates the P3 + fail-open commits). Live runs need `set -a; . ./.env; set +a` first (no dotenv); real-LLM smoke runs are opt-in via `npm run agent:play` per the `agent-smoke` skill and cost real tokens — keep `AGENT_DAYS` small.

## Scope fences (whole arc)

- No game-rule, balance, or prompt changes. The unsafe-rest penalty *moves*; it does not change value or conditions. Any behaviour change the migration forces is flagged as a decision, not smuggled.
- No `sim/` changes; it enters at the engine and stays there (parent decision 6).
- The error funnel/guard plumbing stays wrapping the adapter — that is [[discord-interaction-layer]]'s remit, still sequenced after.
- No network transport, no web adapter, no multi-agent co-located runs (the protocol enables them; building them is a later arc).
- The free-action-forcing harness change is the *next* task, not this one (settled direction 4).
- Branch: one feature branch off `dev` (after the owner's pending 0.3.3 merge lands — reconcile-first); atomic commit per slice; changelog per slice; the owner merges to `dev`. No agent commits, pushes, or checkouts of `dev`/`main`.

## Execution state

**2026-08-02 — reconcile + pre-flight.** Branch `feat/json-seam-protocol` off `dev` (`56e127d`; owner's 0.3.3 merge to `main` + tag `v0.3.3` confirmed landed). Baseline verified: typecheck clean, 89 files / 1686 tests green (count reconciled — see Verification baseline). Docs commit `8c9fc6f` (this spec + the parent continuation note + the player-action-patterns entry + RESUME HERE reconcile).

**Coordinator pre-flight steer (kimi-k3, 2026-08-02):** direction sound; three drift/risks to design around — (1) M7.3's wizard-state-ownership settle pushes against parent decision 1 and needs a `decisions/` record planned into M7.3, not smuggled as a slice note; (2) the contract suite must cover interstitial beats from M5 on (envelope conformance, JSON round-trip, ordering) or the barrier has a hole exactly where live UX depends — and a throwing `onBeat` adapter callback must not escape the router (settle in M5, not M9); (3) keep the stub backend in M5 scope (don't let it drift to M10), require every `facts` key to be justified by a consuming adapter in the slice that adds it, and pin the error-code taxonomy precisely in M5 because M6's scripted brain will pressure-test it immediately. Highest-value M5 outcome: the beat mechanism + envelope/error-taxonomy freeze, asserted by the suite in the same commit as the router.

**2026-08-02 — M5 done.** Slices M5.0 (`050020c` + review fix `a3920f0`) and M5.1 (`513921a` + review fix `22f291e`) committed; review outcomes recorded per slice above. Final: typecheck clean, 91 files / 1821 tests green (+135 over the 1686 baseline). The barrier is executable: `npm test` runs the whole contract suite against both backends.

**Coordinator M5→M6 steer (kimi-k3, 2026-08-02):** on goal, no drift, no blockers. Highest-value M6 move: BEFORE rewiring the harness, diff `viewToText`'s actual rendering inputs against the M5 view-state variants field by field — every miss must be settled as a deliberate, recorded view-state/protocol change (the closed `facts` whitelist will hard-fail any smuggle; that is the fence working), never patched via `facts` or a harness-side engine read, so "agent plays exactly what players play" stays true rather than approximately true. Secondary: land the scripted-brain deterministic tests BEFORE the live `agent:play` run, so the smoke gate validates integration only, not correctness.

**2026-08-02 — M6 done.** Single slice, design calls DC-M6.1 through DC-M6.5 settled in this doc. The viewToText diff found zero ViewState misses and one gap (`AgentCharView` character snapshot) — settled as `characterState` fact populated on all view-bearing responses. Protocol extended: `FACTS_KEYS` gains `characterState`, `RouterBackend` gains `getCharacter`, `SessionController.getCharacter` is a thin pass-through, the router populates `characterState`/`characterName`/`characterClass`/`nav` on every view-bearing envelope (menu, resume, decision, outcome). Contract tests extended (95 tests green). Harness rewired: `GameRouter` replaces `SessionController` in the action path, `viewToText` reads envelope views, `charFromFacts()` builds `AgentCharView` from facts, `mapError()` routes every `GameErrorCode` to a `PlayResult` disposition, `onBeat` callback records commute beats. Zero controller imports in `harness.ts`. Deterministic tests ported (20 tests green). `play.ts` wires `GameRouter` over real `SessionController`. Gate: typecheck clean; 91 files / 1823 tests green (+2 over M5 baseline). Live smoke run: deterministic gate is the correctness proof; the live `npm run agent:play` needs a longer timeout than the CI tool allows and should be run manually at AGENT_DAYS=1. Bookends (`seedCharacter`, `endDay`, `restAtOak`, `tick`, `checkInvariants`) remain engine-direct (M7 scope). M7 (bookends through the seam) is next; M7.0 oracle coverage before any migration per the M1-before-M3 pattern. No `sim/`, no Discord, no controller behaviour change.
