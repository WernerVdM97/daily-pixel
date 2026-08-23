---
title: "Prompt v13 — Post-Cutover Roadmap: World Scaling, Conversations & Puzzles, Free-Text Security"
status: exploring
domain: engine
phase: poc
tags:
  - llm
  - prompt
  - pipeline
  - scaling
  - conversations
  - puzzles
  - security
  - roadmap
related:
  - "[[prompt-separation-of-concerns]]"
  - "[[prompt-v12-world-scaling]]"
  - "[[v12-prompt-set-versioning]]"
---
_Everything the v12 cutover deliberately shipped without, collected as the roadmap for the next prompt-set round. v12 went live scale-neutral and buttons-first in `0.3.0`, and the v13 set itself shipped with Release A (`0.3.3`) — so the threads below land as a further set bump per [[v12-prompt-set-versioning]], or as engine work riding one. The F#21 divine-intervention rework, originally thread 4 here, shipped in `0.3.1`._

---

# Prompt v13 — Post-Cutover Roadmap

Each remaining thread changes templates, so per [[v12-prompt-set-versioning]] it lands as a new prompt set (`decision-prompts/v14/`) or bumps it further; the engine halves ride the same stages. Every thread below is _designed_ (its v12 sibling doc carries the detail) but has **no build plan yet** — each needs a `stage-N`-style handoff doc before an implementing session starts. Several threads want live-data telemetry, which has been accumulating since the `0.3.0` flip.

## Threads

### 1 · Stage 4 — Thread B world scaling ([[prompt-v12-world-scaling]])

The world sizes to the player: effective strength × week-indexed World Tier → tougher foes, bigger rewards, no player-side dice buff. The engine seam already exists (`scale` left at 1, [[stage-3-combat-spine-plan]] D7) — this thread turns it on.

- [ ] Spec a `stage-4` build plan (the missing doc — the parent's build sequence names the stage but nothing owns it).
- [?] Its three open questions, carried verbatim: tracking tightness (lag + reward coefficients — tune on the sim harness against _live_ curves, do not guess), how the World Tier advances (calendar vs event-gated), individual vs party scaling for co-op.
- [>] Touches: difficulty-band + scaled-reward computation, the `## World State` tier block in decide templates (the template change that makes this a new set), rumour cadence.

### 2 · D3/D4 — Conversation & puzzle shapes + the free-text security stack ([[prompt-v12-pipeline]] §D3/D4)

The biggest unspecced chunk. Relationship edges have been live since Stage 2, so the data spine exists; what's missing is the per-type interaction shapes and the layered defence for free text.

- [ ] Spec a build plan for the conversation shape: free-text judged against the NPC's relationship edges, disposition gating the impossible, the roll modifying confidence not replacing judgment.
- [ ] Spec the puzzle shape: rolls pace clue discovery, the final solve is a rollless semantic match against a hidden `solution` prop.
- [ ] Spec the security stack: pre-LLM gate (size cap + injection regex), classifier `suspicious` tripwire, strike → buttons-only downgrade via a `freetext_trust` prop on the PC node.
- [!] Scope fence carried from the parent: **revoke only, no trust restoration this round** — restoration defers to MVP.
- [>] New `conversation`/`puzzle` decide+resolve templates = the other template change driving the next set version.

### 3 · Prose-critic trigger — decide from live telemetry ([[prompt-v12-pipeline]] §D7)

The two critics (coherence over decide, faithfulness over resolve-narrate) are placed; the _trigger policy_ stays parked until real data exists. The per-round `CombatBeatLog` ([[T5-combat-telemetry-spec]]) is the instrument — it now records live rounds.

- [ ] After a few live weeks, decide gate-on-signal (high reasoning / validator warning) vs the unified validator-gate, from the beat-log data. Record it as a `decisions/` doc.
- [!] Watch the "text implies a change absent from `final_mutations`" rate — the parent's explicit tripwire for whether mutations are under-authored (and the only justification that would ever exist for a mutation critic).

### 4 · Carried cleanups (small, actionable now the legacy path is deleted)

Open questions the v12 stages explicitly punted, actionable since the legacy state machine was deleted (`0.3.1` dead-code sweep):

- [ ] Promote `CATEGORY_MUTATION_MAP` / `allowedMutations` from warn-only to enforced ([[stage-1-thread-d-backbone-plan]] carried question).
- [ ] Fully retire `distilledType` (demoted, not removed, in Stage 1).
- [ ] Per-`relType` prop schemas for relation edges ([[stage-2-scene-state-spine-plan]] deferral).
- [ ] Decide the `'other'` decide-template question left open in [[v12-prompt-set-versioning]] (real template vs classify-time special case) with live routing data.

## Explicitly still deferred beyond v13 (MVP)

- [>] **Death mechanic** — HP 0 stays observable-not-fatal (`hpZero` marker); the real death/consequence design is MVP scope ([[stage-3-combat-spine-plan]], `TODO.md`).
- [>] **Real graph backend** — scene-state stays SQLite-typed until [[mvp-data-model]] lands.
- [>] **Free-text trust restoration** — v13 ships revoke-only; the earn-it-back path is MVP.

## Sequencing sketch

D3/D4 can be specced at any time (its edges are live; it needs no tuning data). Stage 4 and the prose-critic trigger both _want_ live data first — spec Stage 4 against observed curves and decide the trigger from the beat logs. The carried cleanups slot in wherever a session has slack.

> [>] Suggested order: **D3/D4 spec+build → (data accumulates) → prose-critic trigger decision → Stage 4 spec+build** — each through `planning-and-task-breakdown` + `orchestrated-delegation`, with template work under `prompt-versioning`.
