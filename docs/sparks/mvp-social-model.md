---
title: Sentiment, Bonds & Relationships
status: spark
domain: spark
tags:
- social
- data-model
related:
- '[[mvp+world-state-projection]]'
- '[[mvp-character-drivers]]'
- '[[mvp+moral-drift]]'
phase: mvp
---

## Sentiment, Bonds & Relationships

Three axes that are easy to conflate but do different jobs. Keeping them separate is what lets the social simulation run deterministically — and it's the substrate the moral system ([[mvp+moral-drift]]) acts on.

| | Lives in | Directed? | Affective? | Answers |
|---|---|---|---|---|
| **Sentiment** | a node **attribute** (a vector on one character) | No — intrinsic | Yes (mood) | "How does this character *feel*, in general?" |
| **Bond** | an **edge** between two characters | Yes (A→B) | Yes (social) | "How does A feel about *B specifically*?" |
| **Relationship** | the **umbrella for all typed edges** | Yes | Not necessarily | "How is X *linked* to Y at all?" |

- **Sentiment** is intrinsic and undirected — `{hope, fear, trust_in_fellowship, local_tension}` living *on* the node. It points at nothing; it's a state, not a link. It is the **only** one of the three with LLM-authored prose attached (the weekly summary). Everything else feeds into it.
- **Bond** is directed, typed, and valued — `Garrick —friend(6)→ Mera`, `Kiril —rivalry→ Emil`. The affective subset of edges (family, friendship, rivalry, romance). The sim reads and updates the value deterministically; an optional short prose annotation records the *why*.
- **Relationship** is the superset: every typed edge. Most carry no feeling — `works_at`, `owns`, `at_location`, `trades_with`, `owes_debt`. **All bonds are relationships; most relationships are not bonds.**

**Two overlaps to keep straight:**

- **`trust_in_fellowship` (sentiment) vs. a `trusts` edge (bond)** — *diffuse vs. directed*. The scalar is "how warm toward the party as a whole"; the edge is "how much I trust *Kaelen specifically*." Store the edge only if the sim needs per-target resolution; otherwise the scalar suffices. Don't store both by reflex.
- **`owes_debt` (relationship) vs. a `rivalry` bond** — *money vs. emotion*. A debt is structural and economic; the feeling about it is a separate bond. The two coexist so the economy sim can settle the debt without touching the social graph.

**Mechanics — how each updates and what it drives:**

| Axis | Updated by | Drives | Token cost |
|---|---|---|---|
| **Sentiment** | aggregation of bonds + events + moral drift (deterministic); summarized by the weekly LLM pass | the weekly prose beat; town "mood" flavor; quest-hook tone | 0 to update; ~200 tok weekly summary |
| **Bonds** | events — gift `+`, betrayal `−`, co-op `+`, alignment distance (deterministic) | co-op bonuses, missed-week rescue, who travels with whom, sentiment aggregation | 0 |
| **Relationships** | the sim wiring the world — jobs, ownership, trade, debt | economy, location of things, faction logic, graph traversal for the vault | 0 |

The flow: **events update bonds and relationships → those aggregate into sentiment → the weekly LLM turns sentiment into prose.** Only the last arrow costs tokens.
