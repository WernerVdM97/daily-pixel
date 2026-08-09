---
title: 'Wizard Session State Ownership (JSON-seam M7.3)'
status: decided
domain: engine
phase: mvp
tags:
- decision
- architecture
- controller
- session-state
- json-seam
- character-creation
related:
- '[[json-seam-protocol]]'
- '[[layer-boundaries-and-json-seam]]'
- '[[json-seam-build-plans]]'
---

Resolves the M7.3 wizard-state-ownership settle the coordinator's M6→M7 steer and the M7/M8 handover require as a deliverable ("a genuine design call, not a given — the parent doc requires a `decisions/` record to change a settled decision; do not smuggle it as a slice note"). It extends parent decision 1 of [[layer-boundaries-and-json-seam]]: **the join wizard's multi-step draft becomes controller-held session state keyed by `playerId`**. The engine stays the sole owner of world/game state; the controller gains the one thing its target shape always promised it.

## Context

Parent decision 1: "Session state is engine-owned. The engine absorbs option-resolution (button index → option label) into its already-persisted action state — `lastActionState.pendingDecision` carries the options … so the controller stays stateless." The controller was built stateless and the Discord-side `pendingDecisions` map was deleted.

The M7.3 seam cut requires the join wizard's multi-step draft — `WizardSession`, an in-memory `Map<discordUserId, WizardState>` with a 10-min TTL, today instance-scoped adapter state — to become backend-owned, because `character.create` + wizard-step events cross the seam and no adapter may hold flow state. The two candidate extensions of decision 1 are controller-held session state keyed by `playerId`, or engine-persisted draft state.

## Decision

**Controller-held wizard session state, keyed by `playerId`, as a scoped extension of parent decision 1.** `SessionController` drives the existing `WizardSession` store (constructor-injected; index.ts creates one instance shared by the controller and the dispatcher's `joinWizards` dep, so the bookend oracle's direct store reads stay valid). The engine never reads or writes the draft. The store's semantics (10-min TTL, throw-loud API, steps 1–8) are unchanged; only its driver moves.

What decision 1's "session state is engine-owned" continues to mean: **game state** — character data, `lastActionState`/pending decisions, rest state, the world — stays engine-owned, and the controller stays stateless with respect to every game rule. What M7.3 carves out is **UI-flow session state**: the transient multi-step form draft that no game rule reads, writes, or is affected by. The parent's own target shape (gap table) assigns the controller "**flow + session state**"; decision 1's controller-statelessness was a consequence of routing option-resolution into the engine, not a prohibition on the controller owning flow state.

Rationale:

- [p] The draft is read/written by no engine rule: no engine method consults the step or the choices, and nothing in the world is affected until `confirm` materialises the draft via `engine.createCharacter`. Engine-owning it would put UI-flow state into the world store the engine's rules never touch.
- [p] Engine-persisted draft would cost a schema change plus a TTL sweep in the engine for a transient flow only one player's modal walk ever touches — heavy for a disposable draft, and a step the M7 fence's spirit (no rule/balance changes) does not support.
- [p] In-memory is today's tested behaviour (`wizard-session.test.ts`); moving the store behind the controller preserves it byte-for-byte, which the M7.0 bookend oracle then pins.
- [p] Consistent with the parent's target shape: the controller owns flow + session state; the engine owns rules.
- [c] In-memory state is lost on process restart (same as today — the wizard is resumable only within its 10-min TTL anyway) and assumes a single process (already assumed by in-process transport, parent decision 3).
- [?] The TTL stays 10 minutes; the durable record is the character row the engine writes at confirm. The draft is disposable by design.

The store module physically remains `src/discord/WizardSession.ts` — a pure-TS module with no discord.js import, so the controller may cross into it exactly as it already crosses into `src/discord/format.js` via the `dayJob.ts` precedent (DC-M7.2.1). Ownership is who drives the state, not where the file sits; M9's dispatcher rebuild may relocate the file as housekeeping, which needs no further record.

## Acceptance

- `SessionController` exposes the wizard flow (`openJoin` / `answerWizardName` / `chooseWizardOption` / `restartWizard` / `confirmWizard`) over the injected `WizardSession`; no engine method reads or writes the draft.
- The M7.0 bookend-oracle join transcripts stay byte-green with zero changes to the test or its snapshot.
- The agent's character creation crosses the seam (wizard events through the router) and the created character is playable on a real engine.
- This record is the amendment to parent decision 1; the parent doc itself is not edited here (the record is the change).
