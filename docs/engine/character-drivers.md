---
title: Character Drivers — the D&D Layer
status: exploring
domain: engine
tags: [character, drivers, dnd, alignment, ideals, flaws, data-model]
related:
  - "[[world-state-projection]]"
  - "[[social-model]]"
  - "[[moral-drift]]"
---

## Character Drivers — the D&D Layer

A character is *driven* by the D&D-style descriptors that define who they are: alignment, class, background, ideals, flaws, bonds, motivations, agenda, traits. These do **not** split cleanly into "data" and "prose" — they fall on a spectrum, and **where you place each one decides whether it drives the deterministic sim for free or has to be authored.** This is the single most important modeling choice for a character.

The lever: **the further a driver sits toward the data end, the more it can steer the deterministic tick at zero token cost — but the more rigid it is. The further toward prose, the more flavorful and flexible — but the more mechanically inert it is** (it only affects the sim indirectly, by spawning `goals`). The art is putting each descriptor in the tier that matches how much mechanical work you want it to do.

| Tier | Descriptors | Modeled as | Drives the deterministic sim? | Token cost |
|---|---|---|---|---|
| **Enumerable data** | alignment, class, fighting style, background, species | Frontmatter enum from a **fixed vocabulary** | **Yes, directly** — categorical modifiers and decision weights | 0 |
| **Hybrid (enum + prose)** | ideals, flaws, traits | An enum **tag** (does the mechanical work) *plus* an optional cached prose line (expresses it in words) | **Yes, via the tag** | 0 to render; prose authored once when it changes |
| **Deterministic relationship** | bonds | A typed **edge** (`bonded_npc` / `trusts`: target + type + value), with optional "why" prose | **Yes** — by graph traversal | 0 |
| **Pure prose** | motivations, agenda, backstory | Cached prose field; an agenda may *spawn* `goals` (which are data) | **Only indirectly**, through the goals it generates | Authored once per change, then cached |

Three consequences worth stating plainly:

- **Alignment, class, background, fighting style are clean enums.** Alignment is the 3×3 grid (`{lawful, neutral, chaotic}` × `{good, neutral, evil}`); background is a fixed list (`scholar | noble | merchant | hero | …`); class and fighting style are bounded by the rules. All categorical, rarely change, and act as deterministic modifiers — zero tokens, full sim authority.
- **The personality triad (ideals / flaws / traits) is the interesting hybrid.** Model each as a tag from a constrained vocabulary — that tag does the mechanical work (a `proud` flaw deterministically weights Garrick toward *refusing* charity; a `community-first` ideal weights him toward *giving*). The prose is only the human-readable expression of the same tag, authored once and cached. This refines the "data vs. prose" table in [[world-state-projection]]: ideals and flaws are **not** pure data — their *tag* is data, their *expression* is prose.
- **Bonds are relationships, so they are edges — not prose, not tags.** `Garrick —friend→ Mera (value 6)` is an edge with a type and a strength the sim reads and updates. The *reason* for the bond ("they trade gossip") may be a short prose annotation, but the bond itself is structural. This is what "frame them as deterministic relationships" means.

The character-driver block of the frontmatter, made explicit:

```yaml
# --- Enumerable data: fixed vocabulary, drives the sim, 0 tokens ---
alignment: lawful-good          # DERIVED from moral_position (the 3×3 grid) — see [[moral-drift]]
background: merchant            # scholar | noble | merchant | hero | ...
class: fighter                  # PCs & combat NPCs only
fighting_style: great-weapon    # bounded subset of class

# --- Hybrid: the enum tag drives decision weights; prose expresses it ---
ideals: [community-first]       # constrained vocab → weight in the decision model
flaws: [proud]                  # "proud" → deterministically resists accepting help
traits: [stubborn, generous]

# --- Deterministic relationships: rendered from edges, never authored ---
# bonds come from bonded_npc / trusts edges → see [[social-model]]
```

Motivations and agenda are the pure-prose remainder: a cached block ("Garrick wants to matter to the fellowship; secretly fears the smoke means his town is next"), regenerated only when an event would change the person — and where it needs to *act*, it spawns a tracked `goal` (data) the sim can advance.
