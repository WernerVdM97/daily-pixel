---
title: Polish Pass — v0.2.8
status: exploring
domain: spark
phase: poc
tags:
  - polish
  - ui
  - feedback
  - discord
  - comms
  - pins
related:
  - "[[polish-v0.2.7]]"
  - "[[prod-data-review-v0.2.3]]"
  - "[[discord-interaction-layer]]"
  - "[[improved-item-features]]"
---
A POC-beta polish bump (`0.2.7 → 0.2.8`) collecting the small, high-confidence **Discord-surface** wins from the 2026-07-03 prod-data review (snapshot `warden-20260703-133521`, builds `0.2.6`/`0.2.7`). Scope is deliberately narrow — four presentation/comms items drawn straight from player `feedback` rows. The larger asks from the same review (player-founded locations, cross-player buffs, item usability, communal currency) are routed to MVP/sparks and stay **out** of this bump. `F#` cites the feedback row in the snapshot.

---

## Tasks

### 🪪 Identity

- [ ] **Show the character's owner on action outcomes** *(F#3, F#8 — two separate players)* — the private + public outcome messages name the character but never the Discord user, so testers can't tell who's who. Surface the owning user next to the character name on success/failure/public outcome copy. The `users` table already links `discord_id` to a character; the join exists, this is a render-only add. Keep it lightweight (a mention or `@handle` suffix) — the richer community-tagging/show-off work stays deferred to `[[mvp-social-model]]`.

### 📌 Pins & comms

- [ ] **Distinct emoji for release notes vs the weekly recap in pins** *(F#20)* — the two pinned message types share a glyph and blur together in the pin list. Give release notes their own icon (📬/✉️) so the pinned column reads at a glance. Decide whether to **retroactively edit** the already-sent release-notes messages (the player asked) — cheap if we still hold their message ids, skip if not worth the bookkeeping.
- [ ] **Trim pinned-message noise** *(F#18)* — leaderboards already auto-unpin the prior board (`0.2.5`), but the pin list still reads as cluttered. Reconsider pinning **every** Saturday-threat message (the player flagged Saturday events as low-value), and sweep for other low-signal pins. Goal: pins are a short, high-value index, not a log.

### 🧵 Weekly recap thread

- [ ] **Weekly-recap thread UX rework** *(F#19)* — three sub-asks against the `0.2.5` recap design (pinned header + per-week thread; Monday rollover rewrites the prior week's header into an LLM chronicle):
  - [ ] **Sidebar visibility** — a week's thread doesn't surface in Discord's sidebar until the player posts in it; tag the player in their **first** action outcome routed to that week's thread so it auto-tracks for them.
  - [ ] **Summary at the bottom of a locked thread, not the top header** — editing the top message as the running summary means scrolling all the way back to read it. At Monday finalize, **lock** the thread (no mid-week lock — outcomes still post into it while the week is live) and post the chronicle as a **final message at the bottom**; the pinned header can stay as the archive anchor.
  - [ ] **Kill the double-shown info** — the player reports the same content appearing twice; audit the private-outcome vs thread-copy vs header overlap and dedupe.

---

## Out of scope — routed elsewhere (same review)

Bigger than a polish bump; tracked in the root `TODO.md` "Player requests — prod data review (2026-07-03)" block and their target sparks:

- [>] **Player-founded structures become real locations** *(F#4, B#8)* → lazy world growth + `[[mvp-data-model]]`.
- [>] **Cross-player buff actions** ("bless everyone") *(B#11)* → multiplayer-aware mutation, `[[multiplayer]]`.
- [>] **Items should be usable, not stat-bonus clutter** *(F#11)* → `[[improved-item-features]]`.
- [>] **Communal / offering currency vs personal gold** *(F#9)* → the MVP wealth item + `[[improved-item-features]]` (personal vs communal coin).

Also excluded: the auto-resolve/`done` frustration cluster (a known design wound, not a discrete polish item) and **F#21** — the 2026-07-02 quarry/divine-intervention incident, which is a **bug to investigate**, not a feature request.

---

## Cut line / notes

- Branch off `dev` (e.g. `feat/polish-v0.2.8`), log under `CHANGELOG.md` `[Unreleased]`, stage player notes at `assets/release-notes/v0.2.8.yml`. Release cut (VERSION bump, `dev`→`main`, tag) is a separate step per `[[releasing]]`.
- Code pointers are starting points, not verified seams — confirm the weekly-recap scheduler, the pin/announce helper, and the outcome renderers before touching them.
- The recap lock-and-summarise change interacts with the boot catch-up for a missed Monday tick (`0.2.5`) — make sure locking a finalized thread doesn't break the recreate-on-delete path.

---

Drawn from the 2026-07-03 prod-data review; refresh against a newer snapshot before cutting if much time passes.
