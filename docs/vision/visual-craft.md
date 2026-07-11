---
title: The Warden's Oak — Visual Craft
status: decided
domain: vision
phase: poc
tags:
  - visual
  - ansi
  - ux
related:
  - '[[pitch-and-pillars]]'
  - '[[mvp+ansi-art]]'
  - '[[ansi-art-classification-framework]]'
  - '[[poc-plus-0.3.1-polish-plan]]'
---
_The visual north star: how The Warden's Oak should look and feel. Every frame, embed, and message is judged on three things — perception, clarity, UX — before it is judged on anything else. A companion to [[pitch-and-pillars]] (the "why"); this is the "how it reads." The combat-frame redesign at the end is the first worked example of the creed._

---

# Visual Craft

> *The frame is the game. A player meets the Oak once a day, on a phone, in a slab of monospace text — so every cell has to earn its place.*

---

## The creed: perception, clarity, UX

Three words, in order. They are not decoration on top of the mechanics; for an async text RPG they **are** the product. A roll that resolved perfectly but reads as noise is a bad roll. A beautiful frame that a phone can't render is a broken frame.

- **Perception** — the player should *feel* something before they read anything. Register, stakes, mood, rarity: carried by shape, weight, and palette so the frame lands as an image, not a paragraph. A nat-20 should look like a nat-20 from across the room.
- **Clarity** — once they look, the meaning is unambiguous. One focal fact per frame, a real typographic hierarchy, elements floated to where the eye expects them. Never make the player decode; never bury the number that matters under the number that doesn't.
- **UX** — it works where the player actually is. Mobile, dark theme, one-handed, returning after three days having forgotten the plot. The frame reminds, orients, and rewards without a manual.

When these fight each other, the order breaks the tie: a frame that reads clearly and works everywhere beats one that's merely pretty.

## Why this is a pillar, not a nicety

The medium is unforgiving in exactly the ways that make craft matter:

- **The canvas is a phone.** 30 columns of monospace is the whole stage. There is no room for anything that isn't pulling weight.
- **Colour is a privilege, not a right.** Discord renders `ansi` colour on desktop only — mobile strips every escape code to plain grey. So **colour is always enhancement, never signal**: the monochrome frame must carry 100% of the meaning on its own. If it doesn't read in plain gray text on a phone, no palette will save it.
- **The ritual is daily and sparse.** A player spends seconds here, then leaves for a day. Each frame is a postcard from their own story — it has to reward the glance and rebuild the context in one look.
- **Deliberately low-res, never low-effort** ([[pitch-and-pillars]], the `pixelart` pillar). ASCII is the art direction, not a limitation we're apologising for. Constraint is the aesthetic.

## The craft rules

Distilled from the live-tested findings in [[mvp+ansi-art]] and the `ansi-frames` skill — the enduring principles, not the SGR tables:

- **Monochrome is the asset.** Author every frame colour-free and width-validated; apply colour by role at render. The stored art is the grey version.
- **Colour is redundant, always.** Anything colour conveys (good/bad, threat, rarity) must also be carried by a glyph, a sign, or a word — because half the audience never sees the colour. Green `+2` is a bonus; the `+` alone still says so.
- **Palette first, art second.** Pick the mood's 3–4 roles before placing a glyph. `chrome` white, `threat` red, `life` green, `warmth`/reward gold, `player` azure, `status` magenta. Complementary pairs for focal contrast; a mood variant (ember, gloom) shifts the register.
- **Hierarchy, like a data card.** One dim caps label, one big focal number, a quiet calc line, a colour-coded outcome with a shape-redundant marker (`+` pass / `x` fail — never dingbats), one line of flavour. Two colour switches, not eight.
- **Float for clarity.** Put each element where the eye reaches for it — the roll left, the DC boxed and emphasised right, the verdict on its own beat. Whitespace is structure, not filler.
- **Borders carry meaning.** Chrome is not just an edge — it signals register and stakes (see the ladder below). Escalate the border for intensity and rarity, never decorate at random.
- **Single-width discipline (hard rule).** Every glyph is exactly one cell so columns and the right border always align on mobile. Box-drawing, block/shade, and Geometric-Shapes glyphs are safe; emoji and dingbats silently render double-width and break the box. When unsure, use ASCII.
- **Fill the negative space, but keep it breathing.** No transparent gaps (Discord's dark theme silhouettes them), yet never wall-to-wall texture — shape first, shading second.

---

## Worked example — the combat frames

The first application of the creed, redesigned for `0.3.1` ([[poc-plus-0.3.1-polish-plan]] ANSI-D). A colour preview rendered exactly as Discord draws it (desktop colour beside mobile monochrome) lives in the design artifact: <https://claude.ai/code/artifact/fded3d8c-e34b-411b-81ef-5a6840005ef1>. The monochrome frames below are the durable asset; the colour-role mapping follows each.

### The roll readout

Perception fix: drop the `d20` label (it named the die, not the drama), float the calc left and **box the DC** on the right so the number the roll is measured against is the emphasised anchor, and colour the margin and band by favourability. Clarity fix: the sign and the band word carry good/bad in monochrome, so the meaning survives the colour strip.

Between-decision continue frame (standard border):

```
┌────────────────────────────┐
│  GLOOMFANG                 │
│  HP [▓▓▓░░░░░]    BRUISED  │
│  YOU                       │
│  HP [██████████░░]  18/24  │
├────────────────────────────┤
│  14 +3 = 17       [DC 15]  │
│  hit +2 margin      TRADE  │
└────────────────────────────┘
```

Colour: enemy name + banded condition `threat` red; player HP fill `life` green (`threat` below ~40%); the total `= 17` bold white `emphasis`; `[DC 15]` gold `warmth`, boxed; margin sign `life`/`threat` by sign; band word by favourability (CLEAN/GLANCED green, TRADE gold, HEAVY red).

Fight-over terminal card — a pure data card, no nameplate or HP bars (those duplicate the outcome embed's own stats line):

```
┌────────────────────────────┐        ┌────────────────────────────┐
│  COMBAT WON                │        │  COMBAT LOST               │
│                            │        │                            │
│  16               [DC 15]  │        │  6                [DC 15]  │
│  16 +4 = 20                │        │  6 +3 = 9                  │
│  + WIN          margin +5  │        │  x LOSS         margin -8  │
│  The GLOOMFANG collapses.  │        │  You stagger and fall.     │
└────────────────────────────┘        └────────────────────────────┘
```

Colour: focal roll `warmth` gold, bold; `+ WIN` / `x LOSS` line `life` / `threat`; everything else quiet (label, calc, flavour plain). The `+`/`x` marker and the WIN/LOST word are the mobile-safe carriers.

### The border ladder — intensity & rarity

Chrome as a signal. The same renderer swaps the border register to match the stakes, so a punishing round or a critical hit *looks* different before a word is read:

```
 standard — an ordinary round        heavy — a punishing round, low HP        crit — a nat-20, rare moment
┌────────────────────────────┐      ╔════════════════════════════╗      o════════════ ╡@╞ ═══════════o
│  ...                       │      ║  GLOOMFANG                 ║      ║  CRITICAL HIT              ║
│  14 +3 = 17       [DC 15]  │      ║  HP [▓░░░░░░░]   BLOODIED  ║      ║  20 * * *         [DC 15]  ║
│  hit +2 margin      TRADE  │      ║  YOU                       ║      ║  20 +4 = 24                ║
└────────────────────────────┘      ║  HP [███░░░░░░░░░]   5/24  ║      ║  + CLEAN        margin +9  ║
                                     ╠════════════════════════════╣      ║  The GLOOMFANG is felled!  ║
                                     ║  8 +3 = 11        [DC 16]  ║      o════════════════════════════o
                                     ║  hit -3 margin      HEAVY  ║
                                     ╚════════════════════════════╝
```

- **standard** — single-line box-drawing (`┌─┐│└┘├┤`). The default register.
- **heavy** — double-line (`╔═╗║╚╝╠╣`) when the round bites: a HEAVY band, or the player bloodied. The frame itself tenses up.
- **crit / rare** — an ornamental crest-interrupt rim (`o══╡@╞══o`) reserved for a nat-20 (and, later, rare loot). The format is scarce, so the format itself signals the moment.

All three are single-width-safe on desktop and mobile (verified live, ANSI-A 2026-07-11), so escalating the border never breaks the box on a phone.

---

_Open threads: how far up the border ladder `0.3.1` ships (standard-only vs the full set) is tracked in [[poc-plus-0.3.1-polish-plan]]. Tying a border tier to loot rarity is a stage-2 candidate, not yet scoped. This is a design intent, not a specification — the width/SGR contracts live in [[mvp+ansi-art]] and the `ansi-frames` skill._
