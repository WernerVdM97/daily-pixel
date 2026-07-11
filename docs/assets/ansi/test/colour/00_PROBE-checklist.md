# ANSI-A operator checklist

Settles the two `[?]` markers in `mvp+ansi-art.md` (palette hex, box-drawing/half-block width on mobile) plus the `chrome=90` vs "only 30-37 render" contradiction between the `ansi-frames` skill and the spark doc. One live Discord session, desktop + mobile.

**Run:** `npx tsx scripts/send-ansi.ts` (repo-relative paths — runs on the dev Mac or the deploy host; needs `DISCORD_TOKEN`/`ADMIN_USER_ID` via repo `.env` or environment). It validates every frame against the single-width rule, then DMs every `.ansi` file in this directory to the admin, `00_PROBE-*` first. Open the DM on desktop (colour renders) and on the phone (colour strips) side by side.

For each row: read the label off the frame, tick both boxes once you've checked it, note anything that surprised you.

---

## 00_PROBE-1-fg-standard.ansi — fg 30-37

Question: which of these codes render as colour at all, and which show as plain/default text?

| Code       | Desktop: renders colour? | Mobile: renders colour? |
| ---------- | ------------------------ | ----------------------- |
| 30 black   | [ x]                     | [ ]                     |
| 31 red     | [x ]                     | [ ]                     |
| 32 green   | [ x]                     | [ ]                     |
| 33 yellow  | [x ]                     | [ ]                     |
| 34 blue    | [x ]                     | [ ]                     |
| 35 magenta | [x ]                     | [ ]                     |
| 36 cyan    | [x ]                     | [ ]                     |
| 37 white   | [x ]                     | [ ]                     |

Verdict: mobile is always monochrome. desktop colours look good! (are there more options?)

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

Verdict: it definitely looks "whiter" on desktop but identical on mobile. Also no colours on desktop nor phone.

---

## 00_PROBE-3-bg.ansi — bg 40-47

Question: which background codes render as a coloured band vs plain/no fill?

| Code       | Desktop: renders colour? | Mobile: renders colour? |
| ---------- | ------------------------ | ----------------------- |
| 40 black   | [ x]                     | [ ]                     |
| 41 red     | [x ]                     | [ ]                     |
| 42 green   | [x ]                     | [ ]                     |
| 43 yellow  | [x ]                     | [ ]                     |
| 44 blue    | [x ]                     | [ ]                     |
| 45 magenta | [x ]                     | [ ]                     |
| 46 cyan    | [x ]                     | [ ]                     |
| 47 white   | [x ]                     | [ ]                     |

Verdict: renders colour quite nicely on desktop. BUT on mobile its completely transparent or missing. Does not seem viable

---

## 00_PROBE-4-glyphs.ansi — glyph/ruler alignment

Question: do the box-drawing and half-block/shade glyphs stay single-width, i.e. does each glyph in the two glyph rows sit under exactly one digit of the ruler above and below it, with the right border landing in the same column on every row?

| Row | Glyphs                    | Desktop: aligned to ruler? | Mobile: aligned to ruler? |
| --- | ------------------------- | -------------------------- | ------------------------- |
| 1   | `═ ║ ─ │ █ ▀ ▄ ▌ ▐ ░ ▒ ▓` | [x]                        | [x]                       |
| 2   | `┌ ┐ └ ┘ ╔ ╗ ╚ ╝`         | [x]                        | [x]                       |

If a row is misaligned, note which glyph(s) broke it and by how many columns: ____________________

Verdict: all of them look good

---

## 00_PROBE-5-palette-compare.ansi — Solarized-ish vs standard ANSI hex

Question: for each code, does the rendered colour match the Solarized-ish hint or the standard-ANSI hint printed under it?

| Code      | Hint shown                       | Desktop: matches which? (solz / std / neither) |
| --------- | -------------------------------- | ---------------------------------------------- |
| 33 yellow | `solz=gold/olive` vs `std=lemon` | looks more like a dark yellow or light orange  |
| 34 blue   | `solz=cyan-blue` vs `std=navy`   | looks like a azure or ocean blue               |
| 37 white  | `solz=cream` vs `std=lt-gray`    | cream is accurate. or milky white              |

Verdict: **Solarized-ish wins** — 33 gold/dark-orange (not lemon), 34 azure (not navy), 37 cream. Standard-ANSI hypothesis rejected; hex recorded in `src/render/palette.ts` and `mvp+ansi-art.md`.

---

## Close-out

- [x] fg 30-37 vs 90-97 contradiction resolved (90-97 render nothing; 30-37 only): the `ansi-frames` skill lost — its chrome=90 guidance corrected to 37; chrome=37 recorded as final in `palette.ts`/`AnsiRenderer.ts`. Bonus fact recorded: bg 40-47 are desktop-only (invisible on mobile).
- [x] Palette `[?]` settled (Solarized-ish) and hex recorded in `palette.ts` + `mvp+ansi-art.md`.
- [x] Box-drawing/half-block mobile verdict recorded (single-width everywhere) — ANSI-B's border step un-gated.
