---
name: ansi-frames
description: Author ANSI/ASCII art frames for Discord (combat frames, event moments, splashes) from a prompt. Use when creating or editing any boxed art frame, splash banner, or `.ascii` fragment with shading, dither, or colour roles.
allowed-tools: Read, Glob, Grep, Bash, Write, Edit
---

# ANSI Frame Authoring

> Turn a prompt ("nat-20 boss kill", "shrine discovery") into a validated, ready-to-post Discord frame. Grounded in the live-tested findings of [`docs/sparks/mvp+ansi-art.md`](../../../docs/sparks/mvp+ansi-art.md) — read it for empirical constraints before deviating.

---

## 1. Hard constraints (tested live, non-negotiable)

- **Width**: 30 cols total for anything mobile players must read (combat, dialogue). 40 cols is the ceiling, reserved for showpieces (splash, chapter titles).
- **Char budget**: 2 000 chars per message incl code fences; escape codes count. Colour roughly doubles a frame's cost. Measured: 30-wide frames land at 820–1 250 coloured.
- **Mobile strips ANSI colour** — the monochrome art must carry all gameplay information alone. Colour is enhancement, never signal.
- **Author monochrome, colour at render.** `.ascii` fragments stay colour-free; an `AnsiRenderer` applies colour by role. Never store coloured strings as assets (`SceneLoader` width validation counts raw length).
- **Never use ANSI black (30 fg or 40 bg).** Discord code blocks render against a dark grey-blue background (#2b2d31). Black foreground is invisible; black background is indistinguishable from the code block itself. Border/chrome roles use 37 white — **the bright range 90–97 does not render colour at all** (confirmed live 2026-07-11, desktop and mobile: it falls back to plain default text). Get "dark" from shading glyphs (`░ ▒ ▓`) — never 40.
- **bg colours (41–47) are desktop-only** (confirmed live 2026-07-11: rendered on desktop, completely invisible on mobile). Treat bg fills as pure desktop enhancement; darkness and meaning must be carried by glyphs.
- **Always fill the background.** Never leave space transparent — Discord's dark theme transparency will silhouette art against an unpredictable backdrop. Every cell must carry a shading glyph (`░ ▒ ▓`) or a solid fill character (`█`); a bg colour (41–47) may layer on top for desktop but never substitutes for a glyph fill (mobile loses it). Negative space is filled, not empty.
- **Palette first, art second.** Choose an appropriate colour palette for the scene's mood before placing a single glyph. Every frame declares its palette in a comment block at composition time. Use complementary pairs (31↔32, 33↔34/36, 35↔37) for focal contrast; warm/cool push-pull for depth; monochrome ramps (bold + dim + `░▒▓` ≈ 4 steps) for understated moments. A good palette uses 3–4 roles, not all 8.
- Half-blocks (`█ ▀ ▄ ▐ ▌`), shades (`░ ▒ ▓`) and box-drawing (including corners `┌ ┐ └ ┘ ╔ ╗ ╚ ╝`) render single-width on desktop **and mobile** (confirmed live 2026-07-11 against a column ruler) — box-drawing is safe for borders and structural lines.
- **Single-width glyphs only (hard rule, non-negotiable).** Every character must occupy exactly one monospace cell, so columns and the right border always line up. Emoji and the Miscellaneous-Symbols / Dingbats glyphs (`⚠ ☺ ✦ ❖ ✓ ✗`, roughly U+2600–U+27BF plus the emoji planes) render **double-width** in Discord and on mobile, silently shoving that row's border out by a column. Stay inside the tested-safe set: ASCII, box-drawing, block/shade, and Geometric-Shapes glyphs (`■ ▪ ● ◄`). **Also beware East-Asian-Ambiguous punctuation that Discord silently widens** even though it looks innocuous: `§` and `→` both render double-width (confirmed live) — use `#` and `>`. When any non-ASCII glyph is not in the tested-safe set, assume it may be wide and prefer plain ASCII. Substitutes: warning `!`, crest face `@`, sparkle `*` or `+`, pass/fail `+` / `x`, section ref `#`, arrow `>`. This governs monospace frame art only (`.ascii`/`.ansi`, code-block frames); ordinary Discord embed and message text may still use emoji freely. Validate before shipping: strip ANSI codes, assert every line is exactly the interior width counting emoji/symbol glyphs as 2.

## 2. Frame chrome and slots

One fixed chrome, swappable slots (matches the fragment library):

```
+----------------------------+
|  <NAME>              Lv N  |   header: name, level, HP bar from state
|  HP [########--------]     |
|                            |
|        (sprite slot)       |   ~6 rows x 20 cols; variants over new art
|                            |   (o eyes idle, x eyes hit, dissolve dead)
|  <ACTOR> hits -NN  CRIT x2 |   floater: one line from the tick result
+----------------------------+
|  (message box, 2 x 26)     |   hard budget for LLM flavour text
+----------------------------+
```

Splashes use the piped border instead: `o══════╡@╞══════o` corners, `║` sides, block-letter fonts (3-row and 4-row dicts).

**Delivery — art post + reply body (universal).** Every frame is its own Discord message (the art post); the message body (narration, options, buttons, NPC speech) is a reply beneath it. The frame is visual only. **Opening frames** — the scene-setter shown after `classify` and before the first decision, one per classified action type (`combat`, `travel`, `social`, `skill`, `search`, `rest`, `other`) — follow this strictly: for `social` the NPC's speech lives in the reply, so the frame is a mute bust; for `skill`/`other` the scene slot is a placeholder player character. See the wireframes in `assets/ansi/wireframes/` and the OPENING family in `docs/engine/ansi-art-classification-framework.md` §3.0.

For **menu/inventory frames** (inventory, shop, character sheet) follow the bento item-grid reference in the spark doc §5: triple border (outer `█`-run frame + inner light box-drawing line, black-bg gutters), irregular one-icon-per-panel bento grid, rivet dots (`·`/`▪`) at panel corners and junctions, `≡ $ ≡` cash plaque as live text glyphs, flat two-tone fills with **zero dither** — dither belongs to scenes, flat fills to UI. Two warm + two cool tones per icon; the full palette is near-1:1 ANSI (gold→33, orange→31, lavender→35, white accents→37 sparse).

For **dialogue/prompt frames** (loot found, NPC speech, confirmations) follow the modal reference in the spark doc §6: ornamental dash-dot rim (`.-·-._.-·-.`) in one dim colour run, crest interrupting the border centre (`< ≡@≡ >` — crest-interrupts-the-border is house style), corner sparkles (single-width `*` or `+`, never the `✦`/`❖` dingbats — see §1), the 4-beat layout (event line `•`, detail line `+`, question, choices), inline colour on single keywords (item name in 37 white, quantity in 37 white, flavour/species name in 33 yellow, keyword in 34/36 cyan — one word per role), and shape-redundant selection markers (`●` filled vs `·` hollow) so state survives mobile's colour strip. Actual Yes/No lives in Discord buttons; in-frame choice rows are decoration only.

For **world/exploration scenes** follow the tree-town reference in the spark doc §7: outline-first contours with empty interiors, solid fill reserved for focal elements (fill = near/known, outline = distant/rumoured — usable as a discovery-state render trick), crosshatch `▒` for building texture, scatter decoration for grass/flowers. Outline style is also the cheapest to colour (long single runs); prefer tall-and-narrow over wide. Extend with the field-scene tools from spark doc §14: pattern fills that carry material identity (honeycomb, scales, weave — the pattern *is* the semantics), critters built from 3–6 glyph clusters (`(( )) | ∞` for bees), repeated-bracket runs for organic fringes (`))))|||(((` for gill edges, grass skirts, roots), and **diegetic text objects** (signs, gravestones, shop boards — red frame on a warning sign *is* warning semantics) for in-world flavour text with no frame chrome. Density/size falloff on drips/specks (honey drips shrink as they fall) — the scatter-falloff rule in yet another form.

For **combat frames**, on top of the chrome in §2: crumble the depleted end of low HP bars (`HP [█▓▒░--------]`), draw the acting creature large and the target small, and give nameplates an underline rule and a boxed `HP:` label. Letter-spaced caps are desktop-showpiece only (they blow the 28-char interior).

For **boss/showpiece encounters** (40-col) follow the HUD reference in the spark doc §9: HUD-sandwich layout (status strip / viewport / footer strip), in-scene name tags with underline, irregular texture islands (brick courses with `═`/`▭`, `╱` hatch runs — each a single dim colour run, never wall-to-wall) to fill dead space airily, segmented cell bars (`▮▮▮▮▯▯`) for charges (read better at small sizes than continuous fills), shape-redundant selection via white outline on the active hotbar slot, micro-doodads (spider on a thread, candles, tiny jester) as scene-scale inhabitants, and red reserved strictly for threat. Never use `▒` scanline texture on sprites — it mimics sub-cell scanlines that read as noise in ASCII.

For **offer/trade interactions** follow the hand reference in the spark doc §10: **colour scarcity** as a compositional rule — the offered item is the only saturated element (the less colour you use, the more each use means); a drawn elbow connector (box-drawing line from panel corner to scene object: `│`, `─`, `└`/`┌` junction) wiring the UI panel into the scene; a sectioned panel (title row right-aligned, offer row, button row — three stacked cells in plain box lines); plane shading by sparse dots/dashes on isometric faces (outline register's answer to shading, near-zero colour cost); and button state via `▒▓` shade fill — state by texture, shape-redundant, mobile-safe.

For **data cards** (roll results, skill checks, stat readouts) follow the roll-card reference in the spark doc §12: no sprite art, five-beat typographic hierarchy (dim caps label, big focal number with right-aligned dim context, calculation line, colour-coded outcome with shape-redundant ASCII markers (`+` pass / `x` fail, never the `✓`/`✗` dingbats — see §1), dim flavour), two colour switches total.

For **idle/rest replies** (quiet ticks, camping, "nothing happened") follow the rest-stop reference in the spark doc §15: a small scene vignette instead of empty text (the rest beat as content — quiet moments an async game has in abundance); status glyphs floating above sprites with their full comic-vocabulary — `z z Z` sleep, `°o` poison bubbles, `!` alert/surprise, `?` confusion — all in the 35 magenta role and shape-carried for mobile; costume/pose deltas on one base fragment to populate crowds (one mushroom base → dressed character, skirted pair, sleeper); and narrator captions in a tailed box — draw a small connector tail from the box down to the scene spot it anchors, letter-spaced caps as the narrator's typographic voice, short lines only (wide tracking is a voice marker, not a headline device).

For **item showcases** (rare+ drops only — the format itself signals rarity) follow the two card references in the spark doc §16: hero diagonal composition (`▀▄` staircases and `/` `\` edges on empty ground), corner-only chrome (stepped brackets — cheapest ornament tier), a `▢▪▪▪` pip meter for tier/charges (smallest resource notation, shape-redundant), and one of two colour strategies:

**One-hue ramp** (elemental/simple items): colour + bold/dim + `░▒▓` ≈ 4 steps in the item's signature colour; bevel planes one step apart (top facet brightest, side face mid, underside deep — that alone creates the 3D read), one highlight edge run does all the lighting, creature-silhouette inlay for lore in one dark shape.

**Temperature split** (ornate/named gear): cool blade/body = functional part, long single runs; warm ornate guard = crafted part, all colour switches concentrated in a ~6-col zone — the escape-code budget strategy. Detail budget concentrates at the guard; the blade stays nearly flat.

Shared devices: **blueprint backdrop** — dashed construction guides + corner `+` registration marks, a cheap dim-colour dressing that makes a plain frame feel like a museum plate/spec sheet. Reserve showcase treatment for rare+ drops; common loot stays in the dialogue layout.

For **item families** (consumables, sprite-slot scale) follow the potion set in the spark doc §17: identical card dressing across the set, identity by silhouette first (must read in monochrome outline), one 2–4 char motif glyph inside the outline (`~` liquid, `°o` bubbles, `xxx`, `▄:▄` skull), one-hue ramp per item as the effect class, and the stopper/cap line as a free variation slot. Build fragments parameterised: outline class + motif + colour role.

Item **state** is a render treatment, never new art (spark doc §18): solid = physical/owned; stipple the contour to `·`/`:`, drop the fill, and scatter 3–4 sparkles for spectral/sought/consumed; add a hue shift on top so the state reads in both shape and colour. Derive these transforms from the one monochrome fragment.

For **monster portraits** (bestiary, inspect replies) follow the zombie card in the spark doc §19: head-crop only (full bodies belong to encounter viewports — at sprite-slot scale a head reads where a full body turns to mush), **one gross signature detail** per creature (exposed brain, single eye, split jaw — the item-family identity-motif rule applied to creatures), corruption/damage carried by chipped-contour edge noise — the silhouette is deliberately pocked, with `▒` dither patches inside the body (monochrome-readable, can scale with HP: cleaner contour at full health, increasingly chipped as HP drops; extend the dither patch count across 2–3 posts for degradation-over-time), and red reserved strictly for the eyes (horror via sickly green body + pink detail + red eyes — complementary clash, red still the threat role).

## 3. Colour roles

| Code | Role |
|---|---|
| 37 white | chrome: borders, labels, empty bar segments (never 30 — black is invisible on Discord's code block bg; never 90 — the bright range doesn't render, confirmed live 2026-07-11) |
| 31 red | threat: enemy names, damage, low HP, eyes |
| 32 green | life: HP fill, healing, XP gains |
| 33 yellow | warmth/reward: fire, loot, crits, title lettering |
| 34/36 blue/cyan | player name/sprite, NPC speech; cool distance (treelines, hills) |
| 35 magenta | reserved: magic/status |
| 37 white | emphasis: sprites, item names, big numbers (bold for crits) |
| bg 44 blue | panel fill (never bg 40 — black bg matches code block, invisible) |
| bg 41/42 | surface bars, ground strips |

## 4. Shading technique vocabulary

Derived from the landscape reference (spark doc §11); each maps to a char class:

| Technique | Chars | Use for |
|---|---|---|
| Flat two-tone fill | `█` + one shade | Base shapes; every material gets base + exactly one shadow |
| Checkerboard dither | `▒` | Band transitions (sky/ground, path texture strips) |
| Scatter falloff | `░` thinning to `. ,` | Gradients fading to nothing (sky speckle, ground edges) |
| Sculpted shadows | `▓`/`▒` flanks, `▀ ▄` scallops | Shadow sides of foliage/objects; pick ONE light source and keep it |
| Dissolve gradient | `▓ → ▒ → ░ → .` trail | Death/despawn effects; density falls off with distance; advance it across 2–3 posts for free animation |
| Decorative clusters | small `·`/`*` diamonds | Sparkles, flowers, burst highlights (asymmetric placement) |
| Ramp sharing | same shade char, colour shifts at render | e.g. dissolve particles red 31 fading to uncoloured default text (90–97 don't render — fade via plain runs) |

Composition rules:

- **Background fill is mandatory.** Every cell in the frame (including interior edges) carries a bg colour or fill glyph. Layer back-to-front: bg fill first (flat `█` in the scene's backdrop role), then sky/distant band (`░▒` humps, one cool colour run) → subject → ground strip — all on top of a solid base. No gaps; if a region is meant to feel empty, fill it with the scene's ambient bg tone.
- **Warm/cool depth push/pull**: warm tans/yellows pull forward (paths, village, focal items), cool desaturated greens/blues push back (forest, distant hills, backdrop). Near-black framing vignette at edges — this plus warm/cool is what makes the 8-colour palette feel deep.
- **Texture never touches lettering or focal sprites** — leave blank breathing rows around lock-ups.
- Texture rows should be single-colour runs where possible; that keeps the coloured cost near the monochrome cost.
- Clarity first: every glyph must communicate; if a texture row reads as noise, delete it.
- **Never fill a frame edge-to-edge with density-mapped texture** (luminance-converter style) — shape first, shading second; negative space is the medium's lungs (anti-pattern documented in spark doc §13).

## 5. Workflow (always)

0. **Consult the wireframe library first (mandatory).** Before authoring any frame, read the canonical monochrome mocks in `assets/ansi/wireframes/` — per classified action type, a slot template (`opening-<type>.slots.ascii`, the generic grid of `[slot]` placeholders) beside a filled example (`opening-<type>.ascii`), width-validated by `tests/render/opening-wireframes.test.ts`. They are the inspiration input: match their width, slot layout, and register choice rather than inventing structure. Each file's frontmatter documents its register, slots, colour roles, binding, and what belongs in the replied message body.
1. Pick width from the audience rule in §1. Interior = width − 2.
2. Compose the monochrome frame as a Python list of strings in the scratchpad and **assert every line is exactly the interior width** before showing anything:

```python
W = 28
interior = [
  "  GLOOMFANG           Lv 4  ",
  # ...
]
bad = [(i, len(l)) for i, l in enumerate(interior) if len(l) != W]
assert not bad, bad
print("+" + "-" * W + "+")
for l in interior:
  print("|" + l + "|")
print("+" + "-" * W + "+")
```

3. Self-review as art before presenting: consistent light source, texture not touching focal elements, mobile-monochrome still carries the information, **every cell has a fill** (no transparent gaps).
4. Estimate the coloured budget (~1.5–2× monochrome chars incl fences); flag anything within ~10% of 2 000.
5. State the colour-role mapping per element alongside the monochrome art.
6. If the frame is worth keeping, save the monochrome source as an `assets/` fragment (`.ascii`), never the coloured string.

## 6. Worked example — nat-20 boss kill (30-wide)

d20 gem centrepiece with ASCII burst rays and scatter sparkle; boss dies by dissolve gradient drifting up-right; floater and message slots filled from the tick result:

```
+----------------------------+
|  GLOOMFANG           Lv 4  |
|  HP [----------------] KO  |
|                            |
|    *    \   |   /    .     |
|      -   ▄▀▀▀▀▄   -     ░  |
|   ░     ▐  20  ▌     *     |
|      -   ▀▄▄▄▄▀   -        |
|    .    /   |   \    ░     |
|                            |
|      /\          ░   ▒     |
|     /  \____▓▒ ░    ░    . |
|    |   x  x  ▓ ▒░  ▒       |
|     '-.__▄▄▓▒ ░     .      |
|                            |
|  WARDEN hits -46   CRIT x2 |
|  +250 XP     LOOT DROPPED  |
+----------------------------+
|  A perfect strike! The     |
|  GLOOMFANG comes apart!    |
+----------------------------+
```

Colour: chrome 90 (never 30 — black invisible on code block bg), boss name and damage 31, d20/rays 33 with bold-white 20, player 34, XP 32, loot 33, dissolve particles 31 fading to 90.

---

> **Remember:** the monochrome frame is the asset. If it does not read on a phone in plain gray text, no amount of colour will save it. Every cell must be filled — no transparent spaces. Palette first.
