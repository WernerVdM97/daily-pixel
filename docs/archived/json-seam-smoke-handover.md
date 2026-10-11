---
title: JSON Seam — Smoke-Run Upgrade Brainstorm (lead prompt)
status: superseded
superseded_by: "[[json-seam-protocol]] § Smoke-run tooling plan (M8.5)"
domain: engine
phase: mvp
tags: [architecture, engine, protocol, seam, agent-player, smoke, qa, brainstorm, handover]
related:
  - "[[json-seam-protocol]]"
  - "[[json-seam-handover-m7-m8]]"
  - "[[layer-boundaries-and-json-seam]]"
---
Brainstorm prompt for a fresh lead session: how the JSON seam upgrades the agent-player smoke runs, so the model inputs directly into the seam and plays the full player lifecycle exactly like a user would, and the smoke artifacts become protocol-shaped, replayable QA instruments. Paste in full to a fresh lead agent. This session SPECS, it does not implement: the deliverable is a settled design (a "smoke-run tooling plan" section in [[json-seam-protocol]] with settled calls, or a `docs/decisions/` record where a settled decision changes) plus the next slice's shape.

---

## Settled (2026-08-05)

This session settled all six design questions (Q1–Q6) as DC-S1–S6 in [[json-seam-protocol]]'s new "Smoke-run tooling plan" section (lead-settled 2026-08-05, docs only — no code landed):

- Q1 protocol transcript → **DC-S1** (Option A — augment, recorded always)
- Q2 replay + stub-backed modes → **DC-S2**
- Q3 full-lifecycle parity → **DC-S3**
- Q4 observer/player boundary → **DC-S4**
- Q5 choice-fidelity invariants → **DC-S5**
- Q6 slice shape + gate → **DC-S6** (a dedicated **M8.5** slice between M8 and M9)

The four brainstorm deliverables landed as: the "Smoke-run tooling plan" section in the spec doc (deliverable 1); no `docs/decisions/` record (deliverable 2 — the observer boundary is a clarification of the law's scope, not a change); the M8.5 slice outline in the plan section (deliverable 3); and this doc's supersede flip + TODO.md reconcile (deliverable 4). The body below stays intact as the historical record of the questions.

## The opportunity (why now)

The original Release A motivation ([[json-seam-protocol]] preamble): the agent-player is the only playtest instrument until human testing resumes, but until M6 it was a privileged client, so its findings were not guaranteed player-true. M5/M6/M7.0–M7.2 have gone most of the way: the harness's mid-day loop and its nightly rest already cross the seam, and the contract suite proves every response matches the envelope against a stub backend. The remaining gaps are lifecycle-shaped (character creation, read-only screens, the greeting), artifact-shaped (the transcript does not record the protocol stream), and tooling-shaped (no replay, no stub-backed full runs). M7.3 and M8 close the lifecycle gaps; this brainstorm settles how the smoke tooling should change to make the seam its backbone. The deferred-from-M6 live `agent:play` smoke gate (TODO.md standing caution) is the natural test bed.

## Current state (verified 2026-08-05, branch `feat/json-seam-protocol` @ `e3b50c0`)

**Crosses the seam today.** The mid-day loop (M6): `menu.open`, `dayjob.start`, `action.custom`, `action.choose`, `feedback.submit`, `bug.submit` all dispatch through `GameRouter`. The brain consumes `viewToText(view)` + `facts.characterState`; the harness (the agent adapter) emits events; choices are grounded in the rendered view (`isLegal` against `menuLegalMoves`/`decisionLegalMoves` before dispatch). Rest (M7.1): `endDay`'s rest half dispatches `rest.begin`; the unsafe-rest −1 HP surfaces as a finding through the `restUnsafe` fact. `/hi` (M7.2): `hi.open` exists but the agent never calls it (it is player chrome).

**Still engine-direct in the harness.** `seedCharacter` (M7.3 moves it behind the seam); `getMeta('day_number')` for the day-line label (QA label, not a rule); `checkInvariants` engine reads (QA verification by design). `tick(true)` stays engine-owned as the cron mechanism (settled, M7.1 DC-M7.1.6: a user never runs the nightly tick).

**The transcript** (`src/agent/transcript.ts`) records semantic events only: `turn` (screen text, offered moves, chosen move), `outcome`, `dead-end`, `day`, `commute`, `finding`. The raw `[{ event, response }]` protocol stream per dispatch is NOT recorded, so a run cannot be replayed, diffed against a later build, or audited as "the exact events a user would have produced". The critic reads the semantic log.

**Read-only screens** (`look`, `map`, `stats`, `backpack`, `journal`) are direct engine reads + render inside command files (M8 scope). The agent cannot reach them through the seam today.

**The contract suite** (`tests/protocol/contract.test.ts`) asserts conformance, negative space, JSON round-trip, beat order and stub-backend interchangeability at unit level, per event, against BOTH the real backend and a canned `StubBackend`.

## The vision

The agent-player becomes a full-lifecycle protocol client: every player affordance the seam exposes is reachable by the agent, the play path is seam-only (events in, envelopes out, nothing else), and a smoke run produces a protocol-shaped transcript that is replayable, diffable, and literally the event stream a Discord user's clicks will produce after M9. "The model inputs directly into the seam" means the ADAPTER's event surface covers the full player surface (the brain stays an intent producer; a future web player's frontend will consume the same envelopes). The brainstorm settles the questions below, then specs the slice.

## Design questions (the brainstorm)

[!] **Q1 — Protocol transcript: the foundation.** Should the run transcript record the raw `[{ event, response }]` stream per dispatch, alongside (or replacing) the semantic `TurnEvent` log?
[I] **Option A — augment.** Add a parallel `protocol` log to `Transcript`: every dispatched event + every envelope (final only, or beats too) + a tick. Semantic log stays the critic's input; the protocol log is the replay/audit artifact.
[p] Reproducible: a recorded stream replays exactly (Q2). Diffable: a later build's re-run diffs event-by-event. Audit: "what the agent sent" becomes the user-equivalent interaction record, which after M9 IS what a user's clicks produce.
[c] Verbosity (every beat + facts snapshot), transcript size, the critic doesn't need it.
[I] **Option B — replace.** The semantic log becomes derived data recomputed from the protocol stream (the `TranscriptSummary` is already "pure derived data, never a second source of truth").
[p] One source of truth for the run; the protocol stream is the rawest record.
[c] The semantic log carries QA-specific labels (offered moves, dead-end reasons) that are adapter-internal, not protocol; forcing them through the protocol stream pollutes the seam vocabulary.
[I] **Option C — separate debug file.** Write the protocol stream only when `AGENT_PROTOCOL_LOG=1`.
[c] Off-by-default means it rots; the whole point is the protocol log becoming the canonical artifact.
[!] Recommend Option A, with the protocol log recording final envelopes always and beats optionally (a knob), and the semantic log staying as-is. Settle this first: every other question leans on it.

[?] **Q2 — Replay + stub-backed modes.** Two tooling additions:
[I] **Replay runner** — `npm run agent:replay -- <transcript.json>` replays a recorded event stream against a backend (real or stub), asserting every response still validates and matches the recorded one (or a scripted subset). Zero LLM tokens; regression smoke for any backend change; the interchangeability proof applied to the whole agent loop instead of single events.
[?] Open sub-question: the real engine's RNG (mulberry32 seeds keyed by characterId/dayNumber) is deterministic per seed, and the LLM is the only nondeterminism in a live run. A replay of a live transcript therefore replays a LIVE brain's events, not a deterministic policy. So replay is a backend-regression tool, not a full-run reproducer, unless the brain is scripted. Is that the right framing?
[I] **Stub-backed full run** — run the harness loop against the contract `StubBackend` (scripted responses) to smoke the AGENT side independent of the engine. Catches adapter drift (event vocabulary, facts consumption) without state setup; complements the live run, which catches engine/pipeline bugs.
[p] Both are cheap, deterministic, token-free, and they make the per-slice smoke gate runnable in CI.
[c] Scope: replay needs the recorded-event format (Q1) and a stable event vocabulary; stub-backed runs need the stub's scripted surface to cover the full lifecycle (creation, rest, screens), which grows with M7.3/M8.

[!] **Q3 — Full-lifecycle parity: what does "fully like a user" mean after M7.3/M8?**
[?] **Character creation** (M7.3 lands `character.create` + wizard events):
[I] Option A — scripted profile through the seam (a fixed name/class/race/upbringing/alignment/dayJob/itemSet as `character.create` events). Deterministic, reproducible runs, the same character every time (the current `seedCharacter` semantics, but through the protocol).
[p] QA determinism; the transcript's day 1 is comparable across builds; no brain variance.
[I] Option B — the brain chooses through the wizard (free-text name + step choices), like a real user at the character screen.
[p] Realism; exercises the wizard event surface and the free-text name-answer event live; every run creates a different hero.
[c] Non-deterministic; the wizard's 8-step walk costs tokens; name validation paths (bad names) become a QA-visible hazard.
[?] Recommend: Option A for the standard smoke fleet (determinism wins), Option B as an opt-in realism mode (`AGENT_BRAIN_CHOOSES_CHAR=1`). Settle where the profile lives (a fixture file? CLI args? the existing `seedCharacter` data shape).
[?] **The greeting (`hi.open`)** — the brain has nothing to gain from it, but a user's day starts there. Options: a scripted day-start `/hi` beat (exercises the hi path live at zero brain cost), or skip it (chrome, tokens). Parity argues for the scripted beat, once per day.
[?] **Read-only screens (M8)** — after `screen.*` events land, does the agent's policy include periodic `/look` / `/stats` etc.? A scripted low-frequency beat exercises the M8 events live; the brain-driven alternative burns tokens with no QA payoff. Parity argues for a scripted beat (e.g. `/look` once per action, `/stats` at day start), keeping the brain out of chrome.
[!] **`tick(true)` stays engine-direct** (cron; a user never runs it). Not up for debate, but the handover's "zero engine-direct bookends in the harness" gate should be restated as "zero engine-direct PLAY actions in the harness" once the observer/player boundary (Q4) is settled.

[!] **Q4 — The observer/player boundary.** The law says no frontend holds a privileged channel to the engine for PLAY. The harness's `checkInvariants` (post-action engine reads that detect negative HP/stamina/wealth, roll underflow) and the day-line label are QA-observer reads, not play. Settle the boundary explicitly so the tooling and the M9 rebuild don't fight:
[I] Proposed wording: the PLAY path is seam-only and structurally enforced (a madge/grep gate: no `engine.` calls reachable from the play-path methods in `harness.ts`, the M9-style structural check); the QA-OBSERVER path (invariant checks, final character dump, day label) is engine-direct, explicitly declared, and never on the play path. A finding that needs an engine read is an observer result, not a player action.
[?] Is a grep/madge gate the right enforcement, or should the observer reads move behind a dedicated seam-adjacent interface (e.g. `observer.getCharacter`/`observer.getMeta`) so the boundary is typed, not grepped?

[?] **Q5 — Choice-fidelity invariants.** The harness already enforces `isLegal` pre-dispatch (the emitted selector is always within the shown view's buttons). The seam now makes this assertable at the artifact level: the protocol transcript (Q1) can carry a recorded invariant ("emitted selector ∈ shown view's buttons" per `action.choose`), and the contract suite can add a check that every event the agent emits validates and every received envelope is in that event's allowed response set. Cheap, high-value: catches event-synthesis drift before it becomes a live-run anomaly.

[?] **Q6 — Slice shape and gate.** Where does this land?
[I] Option A — a dedicated slice before M9 (e.g. "M7.4 — smoke tooling" or the last M8 slice), so the M9 Discord rebuild inherits replay + the protocol transcript as its drift net, and the M9 byte-identical gate gains a replay gate.
[I] Option B — fold into M10 closeout (the interchangeability proof is already a closeout deliverable).
[p] Option A: the tooling is exactly what M9's byte-identical gate wants (replay the recorded pre-M9 transcript against the rebuilt adapter). Option B risks M10 becoming a mega-slice.
[?] Proposed per-slice gate going forward: typecheck + full suite + a protocol-transcript smoke assertion (deterministic replay or stub-backed run) green; the live `agent:play` run stays opt-in (tokens) per the `agent-smoke` skill.

## Constraints (binding, unchanged)

- **The law.** Every mechanic crosses the single seam; no game rule, flow, or render-assembly lives in an adapter. The agent adapter (harness) translates brain intents to events and paints envelopes via `viewToText`; the brain never crafts raw events or reads engine internals on the play path.
- **No balance conclusions from agent runs** (TODO.md standing caution): the brain structurally cannot measure RA-2 (day-job work strips inspiration by design; the brain overwhelmingly picks day-job work). `AGENT_FORCE_FREE_ACTIONS` stays a separate follow-up task, not this work.
- `PROTOCOL_VERSION` stays 1; no new facts key without a consuming adapter in the same slice.
- Token costs: live fleet stays small (`AGENT_DAYS` 1–2); the deterministic gates are the correctness proof.
- No commits to `dev`/`main`; atomic slice commits on `feat/json-seam-protocol`; changelog per slice; spec-doc execution state + slice records written before stopping.

## Deliverables of this brainstorm session

1. A settled design written into [[json-seam-protocol]] as a new "Smoke-run tooling plan" section (settled calls, DC-S1…, in the M5/M7 checklist style): the Q1 transcript decision, the Q2 tooling scope, the Q3 lifecycle parity calls, the Q4 boundary wording, the Q5 invariant list, the Q6 slice shape + gate.
2. A `docs/decisions/` record ONLY if a settled decision changes (e.g. the observer/player boundary restatement of the law's scope).
3. The next slice's task checklist (in the spec doc) sized to the Q6 choice.
4. TODO.md RESUME HERE reconciled.
Do NOT implement code in this session. If a question cannot be settled without seeing code, read the code (`src/agent/harness.ts`, `src/agent/transcript.ts`, `src/agent/play.ts`, `tests/protocol/contract.test.ts` StubBackend, `.claude/skills/agent-smoke/SKILL.md`) and settle with evidence.

## Reading order

1. `docs/engine/json-seam-protocol.md` — the law, the M5/M6/M7 sections (the harness rewiring, DC-M6.1–6.5), the contract-test barrier, execution state.
2. `docs/engine/json-seam-handover-m7-m8.md` — the M7/M8 lead prompt (gates, loop shape).
3. `src/agent/harness.ts`, `src/agent/transcript.ts`, `src/agent/play.ts` — the current agent adapter.
4. `tests/protocol/contract.test.ts` — the StubBackend and the conformance harness (the interchangeability pattern to extend).
5. `.claude/skills/agent-smoke/SKILL.md` — the live smoke-run mechanics.
