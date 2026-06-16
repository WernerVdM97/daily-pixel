---
title: The POC — One-Week Proof of Concept
status: decided
domain: game
phase: poc
tags:
- poc
- scope
related:
- '[[pitch-and-pillars]]'
- '[[hazard-map]]'
- '[[poc-build-poa]]'
- '[[poc-tech-stack]]'
- '[[poc-discord-ux]]'
- '[[mvp-core-loop]]'
---

# The POC — One-Week Proof of Concept

> *Prove the simplest version works end-to-end, ship it to a few friends, learn whether the ritual sparks joy. Everything else waits.*

---

## The one question

**Do people enjoy a daily Discord RPG where their decisions shape the dice?**

Not "is the NPC economy balanced," not "does moral drift feel right," not "is the December climax satisfying." Just the core ritual:

> **wake → take an action → make choices → roll the dice → see the outcome.**

If the ritual sparks joy → green-light the MVP. If not → we learned it in a week, not a year.

---

## What ships

A single-process Discord bot (TypeScript + discord.js, SQLite, DeepSeek for decisions). One player at a time. Buttons only, mobile-first.

- [p] **Onboarding** — `/join` builds a character (class, upbringing, race, alignment, day-job, starting items).
- [p] **The daily open** — `/hi` shows the Oak, then day-job hooks (weekdays) or adventure hooks (weekends).
- [p] **Probabilistic actions** — `/action <description>` (free text; the LLM distills the type). LLM generates 1–N decision branches, each choice nudges the DC, then roll a d20 or skip. Outcomes mutate the world and persist.
- [p] **Deterministic commands** — `/look`, `/backpack`, `/stats`, `/journal`, `/help`, `/feedback`, `/bug`. Instant, free, no roll.
- [p] **Roll economy** — 2 rolls/day; each `/action` spends one. Rolls reset on the daily tick.
- [p] **The day turns** — admin `/sleep` and a nightly cron advance the world (stamina/health recovery, income, NPC movement). A non-admin `/sleep` just makes camp by the Oak.
- [p] **ASCII scenes** — a library of tag-matched `.ascii` fragments; characters marked with class emoji, no sprite art.

## Two kinds of action

| Type | Trigger | LLM? | Dice? | Roll? |
|---|---|---|---|---|
| **Probabilistic** *(the game)* | `/action <description>` | Yes — generates the decision branches | Yes — d20 vs DC | Spends 1 of 2/day |
| **Deterministic** *(instant)* | `/look`, `/backpack`, `/stats`, `/journal`, `/help`, `/feedback`, `/bug` | No | No | Free, unlimited |

Each probabilistic action is one evolving Discord message: scene + decision → more decisions → roll/skip → outcome. Every session ends nudging players toward `/feedback` and `/bug`.

---

## Success looks like

- [!] **4/8** testers complete an action, and **2/8** come back the next day unprompted → green light for MVP.
- [!] Must-pass: the full action flow works on **mobile Discord**, and LLM decisions feel **coherent, not random**.

Full criteria + how they're measured live in [[poc-build-deploy]] §6.

---

## Deliberately NOT in the POC

- [-] **Graph DB / moral drift / December climax** — flat SQLite and the core loop are enough to answer the question.
- [-] **Free-form ASCII pipeline (`ascii-image-converter`), PNG/MP4** — deferred; fragments are faster.
- [-] **Deep stamina / weekly rhythm / death track** — one stamina integer is enough to test engagement.

---

## Where the detail lives

The build is planned and specced in `engine/` — start at **[[poc-build-poa]]** (the build root: patterns, the portable-backend seam, the session plan). Tech choices are in [[poc-tech-stack]]; the Discord interaction rules in [[poc-discord-ux]].
