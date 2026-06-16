---
title: ASCII Render Pipeline — Confirmed Intent
status: spark
domain: spark
tags:
- ascii
- discord
- poc
related:
- '[[mvp+world-state-projection]]'
phase: mvp
---

# ASCII Render Pipeline — Confirmed Intent

> Interview-me output. Confirmed: yes.

## Outcome

Server-side ASCII art pipeline for Discord bot. Photos → ASCII via `ascii-image-converter` CLI, displayed in Discord code blocks. Black and white for POC, colour at MVP with frontend.

## User

Solo dev iterating on POC visuals.

## Why now

Need immersion layer for Discord bot without building HTML frontend.

## Success

Pipeline callable from Node — input = image path, output = plain ASCII text ready for Discord code block. Three use cases: character portraits, location scenes, item images. Roll result cards built as templates combining ASCII art + dice + text.

## Constraint

Black and white only. Colour later with frontend at MVP stage.

## Out of scope

- HTML frontend
- Canvas/Skia render engine
- Real-time animation
- Video/MP4 rendering
- Colour output (MVP+)
- PNG generation server-side

## Technical approach

**Tool:** `ascii-image-converter` (Go CLI, by TheZoraiz) — already installed at `/usr/bin/ascii-image-converter`.

**Pipeline per image:**
```bash
ascii-image-converter <image> -W 30 -g --map " .:-=+*#@" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'
```

**Config:**
- `-W 30` — 30-character width (mobile Discord friendly)
- `-g` — grayscale mode
- `--map " .:-=+*#@"` — chunky pixel-art palette (darkest → lightest)
- `sed` strips ANSI escape codes for Discord code blocks

**Render split:**

| Source | Method |
|--------|--------|
| Character portraits | photo → ascii-image-converter → strip ANSI → code block |
| Location scenes | photo → ascii-image-converter → strip ANSI → code block |
| Item images | photo → ascii-image-converter → strip ANSI → code block |
| Roll result card | template-generated ASCII (location art + dice + text combined) |
| Pre-existing ASCII art | use directly, no conversion |

**Image sources:** Scraped or uploaded photos — TBD.

**Node.js integration:** `child_process.execFile` — spawn CLI, capture stdout, strip ANSI, return string.

## POC field notes

- [<] **Source art** — scrape/curate prettier ASCII art and source images to feed the converter; pre-existing good ASCII can be used directly (no conversion). Asset-gathering, deferred from POC alongside the pipeline itself.

## Hand-off

Downstream skill: `spec-driven-development` or `planning-and-task-breakdown` to formalize the pipeline contract and implementation order.
