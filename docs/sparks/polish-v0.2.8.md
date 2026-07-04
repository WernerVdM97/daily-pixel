---
title: Polish Pass — v0.2.8
status: decided
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
A POC-beta polish bump (`0.2.7 → 0.2.8`) collecting the small, high-confidence **presentation/comms** wins from the prod-data review, scoped for handoff to an implementation pipeline. Refreshed 2026-07-04 against snapshot `warden-20260704-124954` (prod, build `0.2.7`) plus the local dev DB. Every task here is render- or comms-only and **independent of the LLM prompt**, so it is unaffected by the in-flight prompt refactor (`feat/prompt-refactor`). Feedback that traces to the **old v11 prompting** (the auto-resolve/`done` behaviour, the rule-4b "success with no reward" violations, the 2026-07-02 companion-travel aborts) is **excluded here** and left to the refactor. The larger design asks from the same review (player-founded locations, cross-player buffs, item usability, communal currency) are routed to MVP/sparks and stay **out** of this bump. `F#`/`B#` cite the feedback/bug row.

---

## Tasks

### 🧾 Outcome footer

- [ ] **Footer omits a `max_stamina` gain** *(local dev DB, 2026-07-04 — "got max stamina +1 but no indicator on the footer")* — an action that raises `max_stamina` (e.g. `+1`) applies the mutation but the outcome footer shows no indicator, so the reward reads as if nothing happened. Same class as the F#13 inspiration/roll-grant fix already shipped to `[Unreleased]`: surface a `max_stamina` delta in the outcome changes line. Render-only. Confirm the footer/changes-line builder (`buildOutcomeEmbed`) and how it already renders health/stamina/roll deltas, then add the missing `max_stamina` case. Watch a likely-related root cause: `TODO.md` notes `CharacterRepository.update`'s allow-list omits `max_stamina`, so first verify the gain actually persists before assuming the bug is render-only.

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

Also excluded and pushed down into `TODO.md` (MVP-deferred) on 2026-07-04: **LLM latency** (the snapshot shows 26 calls over 30s) and the **auto-resolve roll-refund** question (B#1, B#10). The broader auto-resolve/`done` frustration cluster and the v11 rule-4b violations are design/prompt wounds owned by the prompt refactor, not discrete polish items. **F#21** (the 2026-07-02 quarry/divine-intervention incident) stays a bug to investigate under the refactor, not a feature request.

---

## Cut line / notes

- Branch off `dev` (e.g. `feat/polish-v0.2.8`), log under `CHANGELOG.md` `[Unreleased]`, stage player notes at `assets/release-notes/v0.2.8.yml`. Release cut (VERSION bump, `dev`→`main`, tag) is a separate step per `[[releasing]]`.
- Code pointers are starting points, not verified seams — confirm the weekly-recap scheduler, the pin/announce helper, and the outcome renderers before touching them.
- The recap lock-and-summarise change interacts with the boot catch-up for a missed Monday tick (`0.2.5`) — make sure locking a finalized thread doesn't break the recreate-on-delete path.

---

Drawn from the prod-data review and refreshed 2026-07-04 (snapshot `warden-20260704-124954` + local dev DB); refresh again before cutting if much time passes.
