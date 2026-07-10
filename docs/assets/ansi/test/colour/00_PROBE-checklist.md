# ANSI-A operator checklist

Settles the two `[?]` markers in `mvp+ansi-art.md` (palette hex, box-drawing/half-block width on mobile) plus the `chrome=90` vs "only 30-37 render" contradiction between the `ansi-frames` skill and the spark doc. One live Discord session, desktop + mobile.

**Run:** `npx tsx scripts/send-ansi.ts` (repo-relative paths — runs on the dev Mac or the deploy host; needs `DISCORD_TOKEN`/`ADMIN_USER_ID` via repo `.env` or environment). It validates every frame against the single-width rule, then DMs every `.ansi` file in this directory to the admin, `00_PROBE-*` first. Open the DM on desktop (colour renders) and on the phone (colour strips) side by side.

For each row: read the label off the frame, tick both boxes once you've checked it, note anything that surprised you.

---

## 00_PROBE-1-fg-standard.ansi — fg 30-37

Question: which of these codes render as colour at all, and which show as plain/default text?

| Code | Desktop: renders colour? | Mobile: renders colour? |
|---|---|---|
| 30 black | [ ] | [ ] |
| 31 red | [ ] | [ ] |
| 32 green | [ ] | [ ] |
| 33 yellow | [ ] | [ ] |
| 34 blue | [ ] | [ ] |
| 35 magenta | [ ] | [ ] |
| 36 cyan | [ ] | [ ] |
| 37 white | [ ] | [ ] |

Verdict: ____________________ (which codes render, which don't, on each platform)

---

## 00_PROBE-2-fg-bright.ansi — bright fg 90-97

Question: does the bright range render as colour anywhere, or does it fall back to plain text everywhere (this is the `chrome=90` fact the skill assumes and the spark doc's line-27 finding disputes)?

| Code | Desktop: renders colour? | Mobile: renders colour? |
|---|---|---|
| 90 black | [ ] | [ ] |
| 91 red | [ ] | [ ] |
| 92 green | [ ] | [ ] |
| 93 yellow | [ ] | [ ] |
| 94 blue | [ ] | [ ] |
| 95 magenta | [ ] | [ ] |
| 96 cyan | [ ] | [ ] |
| 97 white | [ ] | [ ] |

Verdict: ____________________ (does 90-97 ever render as colour; does `chrome=90` hold or does the skill need correcting to a 30-37 code)

---

## 00_PROBE-3-bg.ansi — bg 40-47

Question: which background codes render as a coloured band vs plain/no fill?

| Code | Desktop: renders colour? | Mobile: renders colour? |
|---|---|---|
| 40 black | [ ] | [ ] |
| 41 red | [ ] | [ ] |
| 42 green | [ ] | [ ] |
| 43 yellow | [ ] | [ ] |
| 44 blue | [ ] | [ ] |
| 45 magenta | [ ] | [ ] |
| 46 cyan | [ ] | [ ] |
| 47 white | [ ] | [ ] |

Verdict: ____________________

---

## 00_PROBE-4-glyphs.ansi — glyph/ruler alignment

Question: do the box-drawing and half-block/shade glyphs stay single-width, i.e. does each glyph in the two glyph rows sit under exactly one digit of the ruler above and below it, with the right border landing in the same column on every row?

| Row | Glyphs | Desktop: aligned to ruler? | Mobile: aligned to ruler? |
|---|---|---|---|
| 1 | `═ ║ ─ │ █ ▀ ▄ ▌ ▐ ░ ▒ ▓` | [ ] | [ ] |
| 2 | `┌ ┐ └ ┘ ╔ ╗ ╚ ╝` | [ ] | [ ] |

If a row is misaligned, note which glyph(s) broke it and by how many columns: ____________________

Verdict: ____________________ (settles `mvp+ansi-art.md` line 33's `[?]` — safe for ANSI-B's border step, or fall back to plain ASCII `\ | / -`)

---

## 00_PROBE-5-palette-compare.ansi — Solarized-ish vs standard ANSI hex

Question: for each code, does the rendered colour match the Solarized-ish hint or the standard-ANSI hint printed under it?

| Code | Hint shown | Desktop: matches which? (solz / std / neither) |
|---|---|---|
| 33 yellow | `solz=gold/olive` vs `std=lemon` | ____ |
| 34 blue | `solz=cyan-blue` vs `std=navy` | ____ |
| 37 white | `solz=cream` vs `std=lt-gray` | ____ |

Verdict: ____________________ (settles `mvp+ansi-art.md` line 35's `[?]`; record the winning hypothesis and, once known, the actual hex per code for the palette module's doc comment)

---

## Close-out

- [ ] fg 30-37 vs 90-97 contradiction resolved; losing doc (skill or spark) corrected.
- [ ] Palette `[?]` settled and hex recorded.
- [ ] Box-drawing/half-block mobile verdict recorded; ANSI-B's border step un-gated (or explicitly deferred on a negative verdict).
