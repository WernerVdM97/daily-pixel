---
title: "Prompt v12 — Thread D: The Multi-Stage LLM Pipeline"
status: decided
domain: engine
phase: poc
tags:
  - llm
  - prompt
  - pipeline
  - conversations
  - puzzles
  - immersion
related:
  - "[[prompt-separation-of-concerns]]"
  - "[[prompt-v12-combat]]"
  - "[[prompt-v12-world-scaling]]"
  - "[[prompt-v12-scene-state]]"
  - "[[mvp-llm-prompt-architecture]]"
  - "[[prompt-v9-markdown-and-critic]]"
  - "[[mutation-vocabulary-refinement]]"
---
_Thread D of the v12 spark: decompose the single mega-call into a chain of focused, per-type sessions (classify → decide → resolve), plus the per-type interaction shapes (D3), the free-text security stack (D4), and the cost/data case for the split (D5)._

> **Part of the [[prompt-separation-of-concerns]] spark** (Thread D — pipeline half; the scene-state half is [[prompt-v12-scene-state]]). Siblings: [[prompt-v12-combat]] (C) · [[prompt-v12-world-scaling]] (B).

---

The backbone Thread B slots into. Today one call does everything for a beat — classify intent, pick stat/DC, author options, and (on `RESOLVE_ROLL`) compute mutations + narrate — carrying the **entire** rulebook whether the action is a knife-fight or a nap. Split it into a chain of focused, *fresh* sessions with small, type-specific templates. (Provenance: [[mvp-llm-prompt-architecture]]; the v9 coherence critic is the first such stage.)

**The pipeline (per custom action):**

1. [I] **Stage 1 — Classify.** A cheap, tiny-output call deriving the action's **`ActionType`** (the canonical routing key — `combat·travel·social·skill·search·rest·other`; see [[action-engine-framework]] for the one-term-per-concept vocabulary that retires today's `category`/`distilledType`) + routing flags (`unsafe_location`, `needs_roll`, `target_present`) from raw input. No narrative, no options — just routing metadata.
2. [I] **Stage 2 — Decide.** The type selects a template and *only its applicable rules + context are injected* — combat rules (C, [[prompt-v12-combat]]), `KNOWN LOCATIONS` for travel, NPC agendas for social, the `## World State` tier block (B, [[prompt-v12-world-scaling]]) where it matters. Authors the **decision** (options + per-option stat/dc) **only** — no outcomes.
3. [I] **Stage 3 — Resolve.** After the dice (roll-first, unchanged), a **fresh session** receives a structured **handoff** (decisions made + roll verdict + world context) and computes **mutations + `outcome_text`**. It never saw the decision session's reasoning — its only job is "given this verdict and this world, what changed?"

- [p] **Smaller, sharper prompts.** Each stage carries only its slice of the rulebook — decomposition beats length, and serves the markdown interpretability goal ([[prompt-v9-markdown-and-critic]]) better than one fat prompt. A fight never pays for travel rules.
- [p] **Separation of concerns.** The decision session can't pre-bake an outcome; the resolve session can't be led astray by narrative flourish — it works from a structured verdict. Each stage is independently testable and versionable.
- [p] **Per-type templates tune in isolation** — fix combat feel without touching travel; A/B one stage without perturbing the rest.
- [c] **Latency & cost.** 2–3 calls where there was ~1 — but not the binding constraint (D5). Keep Stage 1 tiny (or heuristic); decompose where it pays (combat, ambiguous intent), keep pure travel/rest single-call, cache the classifier.
- [c] **Handoff fidelity.** The handoff must be a **structured, typed payload**, not prose the next stage re-parses.
- [!] **This breaks one-file prompt-versioning.** `AGENTS.md` assumes a single `decision-v<N>.md` + one `PROMPT_VERSION`. A pipeline has several templates, so the convention must extend to a **versioned prompt set** (`decision-prompts/v12/{classify,combat,…,resolve}.md`) stamped together, so an outcome still traces to the exact set. Settle the layout *before* building.
- [?] Is Stage 1 an LLM call or cheap heuristics (verb/keyword) with an LLM fallback for ambiguous input? Heuristic-first dodges most of the latency hit.
- [?] How does the pipeline map onto the PHASE model (`NEW_ACTION` / `CONTINUE` / `RESOLVE_ROLL`)? Roughly classify+decide replace `NEW_ACTION`/`CONTINUE` and resolve replaces `RESOLVE_ROLL`, but the mapping needs spelling out.
- [?] Does the Stage-1 type *replace* the LLM-authored `distilled_type` or seed it? (Likely replaces — the classifier becomes the source of truth.)

> The scene-state spine the pipeline carries across beats (D1), its graph-shaped mutation vocabulary (D2), and the travel/location coherence it should close (D6) live in the sibling part [[prompt-v12-scene-state]].

## D3 — Per-type interaction shapes

- [I] **Combat** — buttons + roll (snappy, physical). Multi-round (C, [[prompt-v12-combat]]); the roll decides whether the blow lands; the `enemyHp` edge is the deterministic spine.
- [I] **Conversation** — *free-text, judged.* The player types an argument; resolve judges it against the NPC's hidden goals **read off the relationship edges**; the roll modifies confidence, it doesn't replace judgment. **Disposition gates the possible** — a hostile NPC can't be silver-tongued into the secret; trust is earned across beats.
- [I] **Puzzle** — *dice pace discovery, brains solve.* You roll to investigate (a good roll reveals a clue-edge; a bad one costs time/stamina or springs a trap), but the **final solve is a rollless semantic match** — an answer that fits the hidden `solution` wins. Deducing the answer and losing on a die would feel awful.

## D4 — Free-text input, judged + the security stack

Free-text drives **conversations & puzzles**; **combat stays buttons + roll**. It's an attack surface, so it's a **revocable privilege**, defended in layers (extending the v9 critic's pre-LLM checks):

- [I] **Pre-LLM gate** — cap input size; regex-scrape for injection (role-resets, "ignore previous", fenced-instruction lookalikes).
- [I] **In-template SECURITY RULE** — player text is in-world speech only, never an engine instruction.
- [I] **Classifier tripwire** — Stage 1 can flag input `suspicious` and route to a refusal/buttons path.
- [I] **Strike → downgrade** — flagged input revokes free-text for that player (buttons-only until trust is restored). A `freetext_trust` / strike-count prop on the PC node. Degrades gracefully.

## D5 — Cost stance & the data behind the split

- [p] **Latency isn't the binding constraint.** Players stay engaged under ~30 s and we average well below; models are cheap. More calls (pipeline stages, free-text judgment) is viable — but watch the tail.
- [!] **The spiral tracks rule-surface, not player-input length.** Mining `llm_calls` (dev + prod, v9/v10): the heaviest reasoning traces come from *trivial* inputs (e.g. `"Rest"` → ~8k reasoning chars) re-reasoning over the monolithic ~5,600-token rulebook carried every call; the v9 critic's scoped prompt runs ~38% leaner. **This is the quantified case for Thread D** — inject only the per-type slice. Flywheel: shorter templates → less spiral → faster + cheaper.
- [!] **Two engine-level levers the data surfaced** (rule design, not prompt-tuning): (1) **no-op contradiction** — "never emit an empty turn" vs "nothing should change" forces the model to fabricate a result on a full-HP `"Rest"`; let genuine no-ops resolve empty ([[mutation-vocabulary-refinement]] §5a). (2) **CONTINUE re-derivation** — mid-beat state rebuilt from prose every call; the D1/D2 scene-state spine ([[prompt-v12-scene-state]]) removes it.
- [!] **Stage-3 handoff must carry `final_mutations`.** Critic-v1 prod data (38 calls, 76% ok) shows every *minor* issue was `outcome_text` written against the *authored* mutations, not the engine's post-adjustment set. Feeding resolve the final world state eliminates the class by design. The staged approach is confirmed viable at scale — the extra stage costs ~5 s and a bounded re-decide fixes structural failures in one pass.

## D7 — Verification: validators first, two critics, no LLM state-authoring

**Deterministic-first.** Every check that *can* be deterministic lives in the ⚙️ engine as a validator (the suite + the mutation-coherence gate are specified in [[action-engine-framework]]); the 🗣️ LLM critics handle only what needs semantic judgment over free prose. **No critic ever authors or edits mutations/state** — the sole auto-repair is the deterministic scene-location/travel gate, where the destination is a *declared field*, not a guess.

- [>] **Coherence critic** (today's `critic-v1`, renamed from the generic "critic"). Semantic beat/world coherence a validator can't compute. **Gated:** fires iff a validator warned **or** reasoning was very high — the principled form of "critique only when the model likely struggled." Authority: **patch prose only.**
- [>] **Prose critic** (new). **Faithfulness-first:** does the player-facing narration accurately convey the verdict + `final_mutations` + scene-state? Covers the final outcome *and* per-round combat narration (where a slip compounds). It reads free prose, so it must be an LLM — a validator can't. Authority: **patch prose only.**
  - [?] **Trigger parked** pending combat telemetry. Mutations fire most rounds, so a "material-change-only" heuristic likely collapses into "always" — the real contest is gate-on-signal (high reasoning / suspicious pre-check) vs the unified validator-gate. Decide from data (the combat round-beat logging, [[prompt-v12-combat]]).
- [!] **No mutation critic.** A generative pass that adds or edits mutations re-hands state truth to the model and overlaps the prose critic's seam from the wrong side. If the prose critic frequently flags "text implies a change absent from `final_mutations`," *that* is the telemetry signal mutations are under-authored — measure it before ever building one.
- [<] **Both critics read `final_mutations`** (post-adjustment), per D5b — never the authored set.
