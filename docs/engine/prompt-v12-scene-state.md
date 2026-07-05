---
title: "Prompt v12 — Scene-State: Deterministic Spine, Graph Shape & Location Coherence (D1/D2/D6)"
status: decided
domain: engine
phase: poc
tags:
  - graph
  - engine
  - llm
  - immersion
  - conversations
  - puzzles
related:
  - "[[prompt-separation-of-concerns]]"
  - "[[prompt-v12-combat]]"
  - "[[prompt-v12-world-scaling]]"
  - "[[prompt-v12-pipeline]]"
  - "[[stage-2-scene-state-spine-plan]]"
  - "[[mvp-data-model]]"
  - "[[mvp-social-model]]"
  - "[[mvp+world-state-projection]]"
  - "[[per-player-map-exploration]]"
  - "[[mutation-vocabulary-refinement]]"
---
_The scene-state half of Thread D: an engine-owned, graph-shaped spine carried across beats (D1), typed graph-delta mutations with no LLM SQL (D2), and the deterministic travel/location coherence the pipeline should close (D6)._

> **Part of the [[prompt-separation-of-concerns]] spark** (Thread D — scene-state half; the pipeline half is [[prompt-v12-pipeline]]). Siblings: [[prompt-v12-combat]] (C) · [[prompt-v12-world-scaling]] (B).

---

## D1 — Scene-state: deterministic spine, narrative skin

The pipeline's real prize: it can carry a **per-type scene-state object across beats** instead of reconstructing "where are we" from `RECENT ACTIONS` prose every beat. That's what lets combat track wounds, a puzzle keep one answer, an NPC hold a grudge. Thread C's `combatState` ([[prompt-v12-combat]]) is the first instance; D1 generalises it across types and makes it persistent + graph-shaped. Ownership is **hybrid**:

- [p] **Engine owns the hard, cheatable truth** — enemy HP, whether a puzzle is solved, an NPC's disposition score.
- [p] **LLM owns the soft texture** — mood, what's been said, the *feel* of the scene.
- [!] The thesis in miniature: dice decide the uncertain, the engine pins the deterministic, the LLM dresses it — immersion is the seams not showing.

## D2 — Scene-state is graph-shaped; mutations are typed graph-deltas (no LLM SQL)

Model scene + relationship state as **nodes + edges** — the subject and object are nodes, and the **edges carry the context**. This is already the MVP world-state direction ([[mvp-data-model]], [[mvp-social-model]], [[mvp+world-state-projection]]), and where `combatState` becomes persistent graph state.

- [I] **Fight:** `PC ──in_combat{enemyHp, posture, round}──▶ enemy NPC`. Co-op falls out as multiple edges; enemy nodes can flee, heal, and remember.
- [I] **Conversation:** the *relationships are the state* — `trust`, `owes_debt`, `knows_secret`, `fears` edges. The strongest fit for graph.
- [I] **Puzzle:** a puzzle-node with a hidden `solution` prop + edges to clue/required-item nodes; "clues found" = which clue-edges the player has traversed.
- [I] **Location:** a node whose `is_safe` is **mutable scene-state** — it can flip (a safe road darkens, a cleared den re-infests). Combat viability/severity ([[prompt-v12-combat]]) reads *current* safety, not a static flag.
- [p] **Bonus — context assembly = subgraph → markdown.** To build a Stage-2 prompt, walk the subgraph around the two nodes and render it as the markdown briefing — making [[mvp+world-state-projection]]'s "graph → markdown at ~0 tokens" *become* the v9 context builder.
- [!] **The LLM must NOT generate SQL/Cypher** — that hands state-truth back to the model (violating D1) and opens injection/correctness/testability holes. Instead extend the typed mutation vocabulary to be edge-shaped; the engine validates against a whitelist, clamps numeric props, and writes the query itself:
  ```json
  { "op": "set_relation", "from": "<pc>", "to": "The Bramble Boar",
    "type": "in_combat", "props": { "enemyHp": 4, "posture": "enraged" } }
  { "op": "update_relation", "type": "in_combat", "props": { "enemyHp": -3 } }
  { "op": "set_relation", "from": "<pc>", "to": "Crow", "type": "trust", "props": { "delta": -1 } }
  ```
- [>] **Storage (decided):** graph-*shaped* now, persisted as a typed structure in SQLite this round; migrate to a real graph backend at MVP when [[mvp-data-model]] lands.
- [!] **Naming in code differs from this doc** ([[stage-2-scene-state-spine-plan]] decision 6): the relationship kind is `relType` in the codebase — `WorldMutation.type` already means the *op name* — and D6's `scene_location` field lands camelCase as `sceneLocation`. Grep with the code names, not this doc's design-level names.

## D6 — Deterministic travel/location coherence

The bug (testing review, action 16): a Blacksmith at **The Town Forge** (safe) typed *"Go to the woods and find a monster to brawl."* The model authored a boar fight **in the forest** with **no `set_location`** — so the scene teleported to the wilds while the engine still had the character at the Forge. The correct chain is **travel first, then fight**.

- [!] **The v9 critic detected but couldn't fix it.** The gate only critiques `required`/already-warned beats (`CritiquedLlmGateway.ts:36`), so the origin `NEW_ACTION` beats slipped; and a `major` verdict only triggers a bounded re-decide that can't *inject* the missing travel step — the model, anchored on "brawl," re-authored the same fight.
- [!] **You can't derive scene location from prose deterministically.** Extracting "this is a forest" is fuzzy NLP. Like `validateDecision` (`DeepseekLlmGateway.ts:596`), a coherence guard must read **structured fields only**.

Two ways to make it structured:

- [I] **B2 (recommended) — declare location as data.** Add a `scene_location` field to the decision contract. The check becomes clean equality: `normalize(scene_location) !== normalize(character.location) && !mutations.some(set_location)` → structural incoherence. Emitting a location name is far more constrained than getting the whole scene right. Cost: a contract version bump. **This field powers the deterministic travel-coherence gate** ([[action-engine-framework]]) — the "travel critic" *is* that gate: detect the mismatch, inject the missing `set_location`. No LLM re-authoring.
- [I] **B1 (cheaper fallback) — structured proxies, warn-only.** Without a contract change, flag correlates of the teleport (a hostile beat at a `safe` location with no `set_location`; input naming a known location yet no travel) as `_warnings` — which force the critic gate and become its checklist. Proxies, so warn, never block.
- [!] **Detection ≠ remedy.** The check is only the trigger. The durable fix: the engine **synthesises the missing travel beat** (inject a `set_location`-first decision so the character arrives before the encounter), or the re-decide note is made binding and re-checked once.

**Home in the pipeline:** Stage 1 Classify ([[prompt-v12-pipeline]]) routes *"go to the woods and brawl"* as **travel→fight** (or flags `needs_travel`), so the decide stage authors travel first by construction; the structured `scene_location` check is the deterministic backstop. Once D1/D2 make position an engine-owned node, a beat narrating elsewhere without a `set_location` edge is a hard, checkable contradiction — the `enemyHp` spine applied to position.
