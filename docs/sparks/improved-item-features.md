---
title: Improved Item Features
status: spark
domain: spark
phase: mvp
tags:
  - items
  - inventory
  - economy
  - quests
  - loot
related:
  - "[[polish-pass-follow]]"
  - "[[mvp-data-model]]"
---

---

Placeholder. Items today are thin — every item is a flat stat-bonus token, the backpack is a single emoji grid with a soft capacity, and nothing ties an item to *why* the player picked it up. Testers feel it: loot reads as noise that mysteriously buffs stats, and the pack just fills. This spark collects the "items should mean more" thread so it isn't lost; it is **not yet a direction**.

The immediate `12/10`-overflow symptom was handled cheaply in the polish follow-up — backpack capacity bumped to 40 with a tidy 10×4 grid — so this spark is about *depth*, not the capacity bug.

## What's thin today

- [c] Every item is a flat `stat + modifier` — a note, a key, and a sword all reduce to "+N to a stat", which feels arbitrary (*feedback #11: "they aren't getting used or giving me much insight… that seems weird"*).
- [c] No notion of an item's *role* — quest token vs. consumable vs. equippable vs. flavour keepsake are indistinguishable.
- [c] Inventory management is display-only: no equipping, using, dropping, gifting, or combining; capacity is a soft number, not a decision.
- [c] Items aren't coupled to quests or the world — a "key" opens nothing, a "note" reveals nothing.

## Threads to explore (not decided)

- [I] **Item kinds / layers** — a `category` on items (quest / consumable / equippable / currency / keepsake) that changes how they render and what you can do with them.
- [I] **Items that *do* something** — use/consume verbs, equip slots, keys that gate a location or beat, notes that drop journal/lore.
- [I] **Crafting as a location-gated item action** — blacksmithing / cooking / brewing as a `use_item`-style action requiring a location with the right **affordance** (a forge, a hearth). Deferred here from the v12 action-precondition discussion ([[action-engine-framework]]): the engine's coherence gate could block "forge a sword" where there's no forge — but that needs locations to carry feature tags first, which is MVP-level granularity.
- [I] **Quest coupling** — items minted by a quest, consumed or required to advance it, so loot has narrative weight instead of being a stat sticker.
- [I] **Inventory management** — equip/unequip, drop, gift-to-another-player, stack/combine; capacity becomes a real trade-off again rather than a number to outrun.
- [I] **Economy tie-in** — distinguish personal coin from communal/offering funds (*feedback #9*), and let items have buy/sell value, not just a stat bonus.

## Open questions

- [?] Is "every item buffs a stat" worth keeping for the simple ones, or should flavour items carry **zero** mechanical effect and earn their place narratively?
- [?] Does this land in POC at all, or is it an MVP feature? (Tagged `mvp` for now.)
- [?] How much of this needs the v11/[[prompt-separation-of-concerns]] mutation vocabulary (e.g. a `use_item` verb) before it's buildable?

---

footer
