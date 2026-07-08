---
title: ANSI Art — Coloured Frames & Splash
status: spark
domain: spark
phase: mvp+
tags:
- ansi
- ascii
- discord
- ui
- art
related:
- '[[mvp-ascii-render-pipeline]]'
- '[[mvp-example-scenes]]'
- '[[mvp-discord-ux]]'
---
Findings and mock-ups from an ANSI-colour experiment (2026-07-08): Discord `ansi` code blocks give the existing ASCII presentation colour, HP-bar semantics, and pixel-art-style depth on desktop at zero dependency cost, degrading to plain monochrome art on mobile. Captures the empirically tested constraints (wrap widths, char budgets, palette), a colour-role convention, a frame/slot layout system, and a splash-screen treatment.

---

# ANSI Art — Coloured Frames & Splash

> Everything below was tested live through the bot (DM to admin) on desktop client + Nothing Phone 2a, 2026-07-08.

## 1. What Discord actually supports

- ` ```ansi ` code blocks render SGR escape codes on **desktop and browser only**: `0` reset, `1` bold, `4` underline, fg `30-37`, bg `40-47`. Fixed Solarized-ish palette, no RGB.
- **Mobile strips the codes** and shows plain monochrome art — layout intact, colour gone. Graceful degradation, but colour must never carry gameplay-critical information on its own.
- Escape codes count toward the 2 000-char message limit. Measured budgets: 30-wide interaction frames 820–1 250 chars incl fences; the 40-wide splash with bg fills + piped border lands at ~1 945 (near the ceiling).
- Wrap thresholds (via a ruler message, `30…56` cols): **40 cols max on the phone** (Nothing 2a, default font), desktop comfortably beyond 56. Existing 30-char loader cap stays right for anything mobile players must read; 40 is the ceiling for showpieces.
- Dark fg colours (esp. gray `30`) read badly on Discord's dark chat background. Prefer light fg (white/tan) and get "dark" from **bg fills** instead.
- Half-blocks (`█ ▀ ▄ ▐ ▌`), shade blocks (`░ ▒ ▓`) and box-drawing (`═ ║`, heavy `━ ┃`) render single-width on desktop.

[?] Do half-blocks/box-drawing stay single-width on all mobile fonts? Splash rendered on the Nothing but a broader device pass hasn't happened.
[?] A May 2026 comment on the community ANSI guide says Discord moved the palette from Solarized-custom toward standard ANSI colours — re-verify hex values before building UI that colour-matches them.

## 2. Colour-role convention

Small fixed vocabulary so colour becomes a convention, not per-frame decoration:

| Code | Colour | Role |
|---|---|---|
| 30 gray | chrome | frame borders, labels, empty bar segments (desktop only — too dark for body text) |
| 31 red | threat | enemy names, damage floaters, low HP, eyes |
| 32 green | life | healthy HP fill, healing floaters |
| 33 yellow | warmth/reward | fire, loot, NPC props, title lettering (tan-gold) |
| 34/36 blue/cyan | player | player name / sprite, NPC speech |
| 35 magenta | reserved | magic / status effects (unused so far) |
| 37 white | emphasis | sprites, item names |
| bg 40 | panel | dark-teal backdrop fill — makes a message read as a solid panel |
| bg 41/42 | surface | frame bars, ground strips |

## 3. Frame system (mocked, all validated ≤ 30 wide)

One fixed chrome with four swappable slots — matches the existing fragment-library approach:

- **Header slot** — name + level, HP bar rendered from state (`#`/`-`, or `█`/`░`).
- **Sprite slot** — ~6×20 region; monster/portrait/potion/chest are interchangeable fragments; variants (idle `o` eyes vs hit `x` eyes) instead of new art.
- **Floater slot** — one line for `-12`/`+10` from the tick result.
- **Message box** — 2×26 chars, a hard budget the LLM flavour text can be given.

Mocked and sent live: encounter opener, skill-use reply, NPC dialogue, item-use reply, loot reply (Pokémon-style layout, menu delegated to Discord buttons/replies). Also a 38-wide side-by-side battle layout and a 46-wide panorama — desktop-only shapes.

Example (encounter, monochrome; colour applied by role at render time):

```
+----------------------------+
|  GLOOMFANG           Lv 4  |
|  HP [########--------]     |
|                            |
|        /\        /\        |
|       /  \______/  \       |
|      |    o    o    |      |
|      |      /\      |      |
|       \    '--'    /       |
|        '-.______.-'        |
|                            |
|    ,^.                     |
|   ( _ )                    |
|   /|_|\      WARDEN  Lv 3  |
|  / |_| \     HP 24/30      |
|    |_|       [######----]  |
|   _/ \_                    |
+----------------------------+
|  A wild GLOOMFANG lunges   |
|  from the bracken!         |
+----------------------------+
```

Wire format — the bot embeds real ESC bytes inside the block; one HP-bar line spelt out:

```
[30m|  HP [[0m[32m########[0m[30m--------]     |[0m
```

## 4. Splash treatment

40-wide title splash in the style of pixel-art banners (ref: Polyducks' *Mushroom Hunt*): bg 40 teal panel fill for depth, 3-row half-block font for `WARDEN'S`, 4-row font for `OAK` in tan-gold, gold double-line piped border with red corner knobs and an acorn crest `╡@╞`, scene strip (pines, cottage, oak, mushroom) over a bg 42 ground band, credits line. The block fonts are dicts keyed by letter — reusable for chapter titles / version stamps.

```
o══════════════════╡@╞═════════════════o
║   *        .         *       .       ║
║         ----==[ THE ]==----          ║
║   █   █ ▄▀▄ █▀▄ █▀▄ █▀▀ █▄ █ ▀ ▄▀▀   ║
║   █ █ █ █▀█ █▄▀ █ █ █▀▀ █ ▀█   ▀▀▄   ║
║   ▀▄▀▄▀ █ █ █ █ █▄▀ █▄▄ █  █   ▄▄▀   ║
║         ▄████▄  ▄████▄  ██ ▄█▀       ║
║         ██  ██  ██  ██  ███▀         ║
║         ██  ██  ██████  ███▄         ║
║         ▀████▀  ██  ██  ██ ▀█▄       ║
║    ▄█▄     ▄█▄        ▄▄▓█████▓▄▄    ║
║  ▄█████▄ ▄█████▄    ▓█████████████▓  ║
║     █       █  ▄▄▄       ▀█▄█▀       ║
║     █       █ ▐█:█▌      ▄█▄█▄ ▄█▄   ║
║. , . , . , . , . , . , . , . , .▐▌ . ║
║  AN ASYNC TURN-BASED DISCORD RPG     ║
o══════════════════════════════════════o
```

[p] Zero dependencies, zero attachments — pure strings through the existing send path.
[p] Same art degrades cleanly to monochrome on mobile.
[c] 8+8 fixed colours cap the fidelity — the reference pixel art's ~16 tuned earth tones are unreachable; bg fills + `░▒▓` dither is the ceiling.
[c] Colour roughly doubles a frame's char cost; the splash is already at ~97% of one message.

## 5. Implications & direction

[I] Build a small `AnsiRenderer`: keep `.ascii` fragments **colour-free**, apply colour by role at render time (chrome/bar/sprite/floater slots), so mobile fallback and the 30-char width validation both operate on the monochrome source.
[!] If coloured strings are ever stored as assets, `SceneLoader` width validation must strip SGR codes before counting (`SceneLoader.ts` counts raw length today).
[I] Splash-as-PNG hybrid: for the one screen where fidelity matters, attach a rendered image (full colour on every client incl. mobile) and keep ANSI for in-game frames — pairs with the Aseprite pixel-art pipeline in [[mvp-ascii-render-pipeline]].
[I] Generator scripts (frame markup → validated `.ans`, block-letter fonts, width ruler) were session scratch — rebuild as repo tooling if this graduates.
[?] Where does colour land first: combat frames (highest information payoff: HP bars, damage) or the `/hi` splash (highest wow payoff)?
