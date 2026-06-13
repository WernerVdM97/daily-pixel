---
title: Moral Drift — Alignment as a Derived Label
status: spark
domain: spark
tags:
- moral
- characters
- data-model
related:
- '[[mvp+world-state-projection]]'
- '[[mvp-character-drivers]]'
- '[[mvp-social-model]]'
phase: mvp+
---

## Moral Drift — Alignment as a Derived Label

Alignment sits in the enumerable-data tier, yet we want it to *change over time*. Resolve the tension with one move: **store a continuous moral vector; make the 3×3 label a projection of it.**

```
moral_position M = (law, good)     # two scalars in [-100, +100]
alignment_label  = bucket(M)       # which of the 9 cells M sits in — computed at render, 0 tokens
```

The label stays the cheap enumerable data the sim reads (faction reactions, modifiers); the *thing that drifts* is a number. Because the label is recomputed at render time, a drifting alignment costs **nothing** to display.

**Drift is deterministic.** Each action carries a template-defined moral delta — spare a foe `good +3`, break an oath `law −6`, steal `good −2, law −3`, charity `good +4`. The roll engine already knows what the player did, so tagging it is free; the vector simply accumulates. No LLM judges morality.

**The governor loop** (per tick, all deterministic):

```
M += Σ today's action_deltas        # behavior pushes you
M += k_decay * (anchor − M)         # the ideal pulls you back   ← keeps it in check
M += world_pressure                 # the world leans on you
M  = clamp(M, −100, +100)
```

Four governors keep it honest:

1. **Set-point gravity (the governor).** The character's **ideal** (a hybrid-tier tag) defines `anchor` — the moral position they relax toward (`community-first → ≈(+40,+60)`). `k_decay` is the conscience stiffness: **high = resists corruption and snaps back; low = malleable.** A character whose *behavior* persistently fights their *ideal* is the dramatic case — the spring loses and they drift. *This is what "keeping alignment in check" means.*
2. **Hysteresis (no flicker).** The label flips only on crossing a threshold *with margin* — Neutral→Good at `good > 34`, back only below `26` — so a boundary character doesn't oscillate daily.
3. **Mean reversion.** The decay term also stops a single bad day from locking someone Evil; yesterday's lapse fades if not repeated.
4. **Flaws bias the field.** `greedy` shifts the anchor toward evil-neutral, or shrinks the `−good` penalty on wealth-grabbing acts (rationalization).

Optional, on-theme for a dice game: gate big discrete temptations behind a **moral save** (d20 vs. resolve/WIS) — fail the save and the delta lands. Morality on the same visible-dice spine as everything else.

**World mechanic — ambient corruption.** `world_pressure` is the lever a world mechanic pulls. Proximity to the Threat applies a constant `good −p` each tick: linger near the rising evil and you drift dark *whether you act or not* — your conscience now fights an external field, not just your own choices. This is the Castlevania/Barovia premise, and the source campaign records it directly: a character "accepted the dark gift" and gained `vampirism` / `lichdom` traits. A **dark gift** is just a discrete large-delta event plus a trait flag that can flip the bucket.

**Ripple — moral drift reshapes the three axes in [[mvp-social-model]], for free:**

| Drift effect | Mechanism | Result |
|---|---|---|
| → **Bonds** | alignment *distance* modulates bond growth/decay | as someone drifts dark, bonds to the Good fellowship decay automatically — the social graph reacts unscripted |
| → **Sentiment** | `M` moving *away* from `anchor` (acting against the ideal) | guilt: `fear +`, `hope −`; living in accordance: `hope +` |
| → **Relationships** | factions read the derived label | temples bar the fallen; aligned towns price-favor their kin — all 0-token edge logic |

**When the LLM gets paid:** never for the drift — it is pure data. Only on a **threshold crossing** (the bucket actually flips, or behavior diverges sharply from the ideal): generate one cached beat — *"Garrick catches his own reflection and doesn't recognize the man holding the coin"* — append it to the C log, reuse forever. A full corruption system, emergent, at ~0 marginal token cost.

**Schema — added to the source-of-truth driver block in [[mvp-character-drivers]]:**

```yaml
moral_position: {law: -12, good: 41}   # the continuous truth — drifts each tick
moral_anchor:   {law: +40, good: +60}  # derived from ideals — the set point
k_decay: 0.15                          # conscience stiffness (high = sticky, low = malleable)
alignment: neutral-good                # DERIVED bucket(moral_position) — render-time output
```

`alignment` is *output*, recomputed each render — never authored. `moral_anchor` is itself derived from `ideals` (+ `flaws` bias), so the only independently stored field is `moral_position`.
