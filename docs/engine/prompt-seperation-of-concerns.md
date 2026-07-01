---
title: Decision Prompt v12 — First-Class Combat, World Scaling & Multi-Stage Pipeline
status: exploring
domain: engine
phase: poc
tags:
  - llm
  - prompt
  - pipeline
  - scaling
  - graph
  - combat
  - conversations
  - puzzles
  - immersion
  - engine
related:
  - "[[action-engine-framework]]"
  - "[[prompt-v12-combat]]"
  - "[[prompt-v12-world-scaling]]"
  - "[[prompt-v12-pipeline]]"
  - "[[prompt-v12-scene-state]]"
  - "[[prompt-v9-markdown-and-critic]]"
  - "[[mvp-combat]]"
  - "[[mvp-llm-prompt-architecture]]"
  - "[[mvp-core-loop]]"
  - "[[mvp-data-model]]"
  - "[[mvp-social-model]]"
  - "[[mvp+world-state-projection]]"
  - "[[roll-economy-timeouts-and-world-growth]]"
  - "[[per-option-stat-and-ability-checks]]"
  - "[[prod-data-review-v0.2.3]]"
---
_Parent/overview for the `0.3.0` v12 prompt-set spark, split into four sibling parts (tracked in the Parts index below). Keeps the cross-cutting frame: prerequisites, sequencing, the thread-ownership map, risks, and the acceptance gate._

---

# Decision Prompt v12 — First-Class Combat, World Scaling & Multi-Stage Pipeline

**Thesis (shared with v9):** deepen immersion by balancing probabilistic and deterministic mechanics — dice rule the uncertain, the engine owns what players would feel cheated by if it drifted, the LLM dresses it. v9 took the LLM-only steps (markdown input + coherence critic); v12 lands the engine-heavy half: combat (C), world-scaling (B), and the multi-stage pipeline (D). This is the `v12` prompt *set* — it forks the single-file v11 into a versioned set of templates, and its Stage-1 classifier inherits v11's `category` enum.

## Must clear before any v12 build (gating prerequisites)

Not one buildable unit — two prerequisites plus three stageable threads that stay blocked until these land. Ordered by what unblocks the most:

- [ ] **Build the sim harness** — gates tuning **Thread B** (scaling curve) and **Thread C** (severity bands); tuning blind bricks the game into trivial-or-impossible. Doesn't exist yet, so it's the *real first deliverable* of `0.3.0`.
- [ ] **Settle prompt-set versioning** — asset layout + `PROMPT_VERSION` shape for a multi-template set (`decision-prompts/v12/{classify,…,resolve}.md`). Gates all of Thread D; decide before building (see [[prompt-v12-pipeline]]).
- [x] **Category enum** — standardised on v11's seven values (`combat · travel · social · skill · search · rest · other`); Thread D's Stage-1 `type` inherits it.
- [ ] **Pin the typed scene-state structure** before Thread C — `combatState` is its first writer (see [[prompt-v12-scene-state]]). Graph-*shaped*, persisted in SQLite this round; real graph backend defers to MVP.
- [ ] **Carry every v8–v11 rule forward** into whichever template now owns it (refunds, known-locations reuse, no-dead-turns, the security rule, markdown framing). A prompt-set rewrite is the easiest place to silently drop a hard-won rule.

> [>] Critical path: `v11 → {sim harness, prompt-set versioning} → D → C → B`. Stage the threads (D backbone first) so telemetry makes any regression attributable.

## Parts (this spark is split)

Each thread carries its full detail in a sibling part; this parent keeps the shared frame and tracks them here.

| Part                          | Thread             | What it covers                                                                                                                                                            |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [[prompt-v12-combat]]         | **C**              | Combat as a frequent, long, high-reward wilds mode: prompt rules + the engine combat spine (lifted decision cap, `combatState`, contested roll + severity bands, no-one-shot floor). |
| [[prompt-v12-world-scaling]]  | **B**              | The world sizes to the player (effective strength × week-indexed World Tier) → tougher foes, bigger rewards; **no** player-side dice buff; the anti-treadmill tension.    |
| [[prompt-v12-pipeline]]       | **D** (pipeline)   | Decompose the mega-call into classify → decide → resolve; per-type interaction shapes (D3), the free-text security stack (D4), and the cost/data case for the split (D5).  |
| [[prompt-v12-scene-state]]    | **D** (scene-state)| Engine-owned, graph-shaped spine across beats (D1); typed graph-delta mutations, no LLM SQL (D2); deterministic travel/location coherence (D6).                           |

## Threads shipped in v9 (forwarded)

- [>] **Markdown input** → shipped in [[prompt-v9-markdown-and-critic]]. v12's per-type templates inherit the framing.
- [>] **Coherence critic** → the `decide → critique → correct` decorator is Thread D's first pipeline stage ([[prompt-v12-pipeline]]); it gains ground truth to check against once C/D bring scene-state.

## How the three threads compose (v12 ownership)

Thread D reframes C and B: they stop being edits to *one* prompt file and become properties of a **versioned prompt set** — new version, bump `PROMPT_VERSION` (`prompt-builder.ts:9`), but `v12` is now a set of templates, not a single file.

- [>] **The `v12` prompt set** owns the per-type templates (classify / combat / travel / social / skill / search / rest / resolve), each inheriting v9's markdown framing — including combat's unsafe-location rules (C, [[prompt-v12-combat]]) and the `## World State` tier block (B, [[prompt-v12-world-scaling]]).
- [>] **`machine.ts` + `dc.ts`** own the combat spine (C, [[prompt-v12-combat]]): lifted decision cap, contested roll + severity bands, no-one-shot floor, and the `combatState` object that D1/D2 model as graph-shaped state ([[prompt-v12-scene-state]]).
- [>] **`buildUserMessage` (`prompt-builder.ts`)** owns emitting only the per-type slice of context each stage needs (D, [[prompt-v12-pipeline]]).
- [>] **A new orchestrator** owns the chain (D, [[prompt-v12-pipeline]]): classify → select template → decide → (dice) → resolve, plus the structured handoff. The v9 `CritiquedLlmGateway` is its seed.
- [>] **`machine.ts` / the context builder** own computing the encounter's difficulty band + scaled reward from (player strength, world tier) (B, [[prompt-v12-world-scaling]]). The roll math in `dc.ts` stays **unchanged** — no player buff.
- [>] **A sim harness** ([[mvp-llm-prompt-architecture]]) is a *prerequisite* for tuning B and C and measuring D's latency/coherence trade-off — not a nice-to-have.

## Open questions (cross-cutting)

- [?] Ship C, B, D as one `v12`, or stage them (D backbone first, then C on its scene-state, then B on top)? Staging makes regressions attributable.
- [!] v12 must **carry every prior data-driven fix forward** (refunds, `KNOWN LOCATIONS`, no dead turns, security rule, markdown framing) — the rewrite is the easiest place to drop one.

## Risks

- [c] **Three structural changes at once.** Staged prompt versions let telemetry attribute any regression. Thread D is the most invasive and wants its own prototype before touching the live loop — the v9 critic is the on-ramp.
- [c] **Compounding latency.** C multiplies calls per fight (rounds), D per beat (stages). Not the binding constraint (D5), but watch the tail — the round cap, a heuristic/cached classifier, and decompose-only-where-it-pays keep it in check.
- [c] **Tuning the curve blind** (B) bricks the game into trivial or impossible. The sim harness gates it.

## Acceptance sketch (when this graduates)

- [ ] In unsafe locations combat dominates; in safe ones it's rare. Fights run multi-round (`required`), end within the round cap (4 after the initiating decision, ≤6 total), and a win yields loot/advance scaled to difficulty. No round one-shots a full-HP player; a would-be killing blow triggers the once-per-day survive-at-1 save; tier scaling changes enemy HP + band damage only, never the variance/floor.
- [ ] Over simulated weeks a stronger character meets measurably tougher foes than a weaker one in the *same* place, and those fights pay proportionally more — the world tracks the player but rewards growth (not a flat treadmill). The cross-session World Tier is observable on top of the within-encounter scaling.
- [ ] An action runs the chain: a typed classification routes to the right template, decide emits options only, and a fresh resolve stage produces mutations from a structured handoff — every row stamped with the exact `v12` prompt-set version.
- [ ] Scene-state survives across beats as graph-shaped, persistent state: enemy HP / NPC disposition / puzzle clues persist; the engine applies only whitelisted, clamped graph-deltas — the LLM never emits SQL. A boar near death stays near death; an NPC's price doesn't reset; a fled enemy is remembered.
- [ ] A conversation is judged on what the player types against the NPC's relationship edges, disposition gating the impossible; a puzzle's clues come from rolls but its solve is a rollless semantic match.
- [ ] Free-text is gated: oversized/injection-flagged input is caught pre-LLM and downgrades the offending player to buttons-only going forward.
- [ ] All v8/v9 rules verified present across whichever template now owns each.
