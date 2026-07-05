---
title: Polish Pass — v0.2.8
status: shipped
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
A POC-beta polish bump (`0.2.7 → 0.2.8`) collecting the small, high-confidence **presentation/comms** wins from the prod-data review. Shipped 2026-07-04 across two passes on `feat/polish-v0.2.8` (merged into `feat/prompt-refactor`). Every task here is render- or comms-only and **independent of the LLM prompt**, so it is unaffected by the in-flight prompt refactor (`feat/prompt-refactor`). Feedback that traces to the **old v11 prompting** (the auto-resolve/`done` behaviour, the rule-4b "success with no reward" violations, the 2026-07-02 companion-travel aborts) is **excluded here** and left to the refactor. The larger design asks from the same review (player-founded locations, cross-player buffs, item usability, communal currency) are routed to MVP/sparks and stay **out** of this bump. `F#`/`B#` cite the feedback/bug row.

**Remaining:** F#19a sidebar-verification — live Discord test of whether Pass 1 owner mentions trigger thread sidebar tracking. No code change expected.

---

## Tasks

### 🧾 Outcome footer

- [x] **Footer omits a `max_stamina` gain** *(local dev DB, 2026-07-04 — "got max stamina +1 but no indicator on the footer")* — an action that raises `max_stamina` (e.g. `+1`) applies the mutation but the outcome footer shows no indicator, so the reward reads as if nothing happened. Same class as the F#13 inspiration/roll-grant fix already shipped to `[Unreleased]`: surface a `max_stamina` delta in the outcome changes line. Render-only. Confirm the footer/changes-line builder (`buildOutcomeEmbed`) and how it already renders health/stamina/roll deltas, then add the missing `max_stamina` case. Watch a likely-related root cause: `TODO.md` notes `CharacterRepository.update`'s allow-list omits `max_stamina`, so first verify the gain actually persists before assuming the bug is render-only.

### 🪪 Identity

- [x] **Show the character's owner on action outcomes** *(F#3, F#8 — two separate players)* — the private + public outcome messages name the character but never the Discord user, so testers can't tell who's who. Surface the owning user next to the character name on success/failure/public outcome copy. The `users` table already links `discord_id` to a character; the join exists, this is a render-only add. Keep it lightweight (a mention or `@handle` suffix) — the richer community-tagging/show-off work stays deferred to `[[mvp-social-model]]`.

### 📌 Pins & comms

- [x] **Distinct emoji for release notes vs the weekly recap in pins** *(F#20)* — retroactive editing skipped (no message ids stored).
- [x] **Trim pinned-message noise** *(F#18)* — Saturday threats now use `pinReplacing`; no other low-signal pins found.

### 🧵 Weekly recap thread

- [x] **Weekly-recap thread UX rework** *(F#19)* — three sub-asks against the `0.2.5` recap design (pinned header + per-week thread; Monday rollover rewrites the prior week's header into an LLM chronicle):
  - [~] **Sidebar visibility** — deferred live-Discord verification (likely solved by Pass 1 owner mentions).
  - [x] **Summary at the bottom of a locked thread, not the top header** — at Monday finalize, the chronicle is posted as a final message at the bottom of the thread; the thread is locked; the pinned header stays as a minimal archive anchor.
  - [x] **Kill the double-shown info** — private outcome reply now uses a compact embed (no story thread); the thread copy retains the full gamebook format.

---

## Out of scope — routed elsewhere (same review)

Bigger than a polish bump; tracked in the root `TODO.md` "Player requests — prod data review (2026-07-03)" block and their target sparks:

- [>] **Player-founded structures become real locations** *(F#4, B#8)* → lazy world growth + `[[mvp-data-model]]`.
- [>] **Cross-player buff actions** ("bless everyone") *(B#11)* → multiplayer-aware mutation, `[[multiplayer]]`.
- [>] **Items should be usable, not stat-bonus clutter** *(F#11)* → `[[improved-item-features]]`.
- [>] **Communal / offering currency vs personal gold** *(F#9)* → the MVP wealth item + `[[improved-item-features]]` (personal vs communal coin).

Also excluded and pushed down into `TODO.md` (MVP-deferred) on 2026-07-04: **LLM latency** (the snapshot shows 26 calls over 30s) and the **auto-resolve roll-refund** question (B#1, B#10). The broader auto-resolve/`done` frustration cluster and the v11 rule-4b violations are design/prompt wounds owned by the prompt refactor, not discrete polish items. **F#21** (the 2026-07-02 quarry/divine-intervention incident) stays a bug to investigate under the refactor, not a feature request.

---

## Execution spec — Pass 1 (footer + identity)

Verified seams (2026-07-04, lead-confirmed against `feat/prompt-refactor`). This is the executor contract for the first orchestration pass. The two other groups (pins/comms, weekly-recap) are a later pass and are **out of scope** for Pass 1.

**Verification (run before returning; must stay green):** `npm run typecheck` and `npm test` (vitest). Baseline: the full suite is green before any change.

### Task A — footer shows a `max_stamina` change

- **File:** `src/engine/OutcomeRenderer.ts`. Deltas are aggregated from `outcome.mutations` in `deriveFromMutations()` (~L32-75) into the `MutationDeltas` struct (~L21-29); the stat block that prints them is ~L204-222, joined at ~L228. `formatDelta` (~L78-82) renders `" (+N)"`/`" (-N)"`.
- **Gap:** there is no `case 'modify_max_stamina'` in the switch and no `maxStaminaDelta` field, so the op (canonical name `modify_max_stamina`, `WorldEngine.ts:87`) is silently dropped. `ctx.maxStamina` already carries the new ceiling; there is no before-value (not needed — the delta is the mutation `amount`).
- **Change:** add `maxStaminaDelta: 0` to `MutationDeltas`; add `case 'modify_max_stamina': d.maxStaminaDelta += Number(m.amount ?? 0); break;`; render the delta on the stamina entry **unambiguously distinct from the current-stamina delta** — the current-stamina delta and the ceiling delta must not be confusable when both are nonzero. Use a labelled suffix, e.g. `⚡ 8/10 (max +1)` (only when `maxStaminaDelta !== 0`), rendered after any existing `staminaDelta` suffix. Final glyph/wording is the executor's to keep consistent with the file's style, but the two deltas must be visually separable.
- **Tests:** extend `tests/engine/outcome-renderer.test.ts` — a `modify_max_stamina` mutation surfaces the ceiling delta; both-deltas case stays unambiguous; a no-max-change outcome is unchanged.
- **Verify, do NOT fix (flag back to lead if broken):** confirm a `modify_max_stamina` mutation actually reaches `ctx.maxStamina` end-to-end (the `TODO.md` note that `CharacterRepository.update` omits `max_stamina` may mean the gain doesn't persist across loads). Persistence is **out of scope** for this render task; if it's broken, report it, don't fix it here.

### Task B — show the character's owner on outcome messages *(F#3, F#8)*

- **Send sites (all four, keep consistent):** `src/discord/commands/action.ts` auto-finish path (content ~L230) and button-resolution path (content ~L376); `src/index.ts` nav re-action (~L1764) and work path (~L2077). Each builds a `content` line like `` `${classEmoji(character?.class)} **${charName}** — ${outcome.distilledType}` `` and sends a private reply plus a public `broadcastOutcome` (`src/discord/weekly-recap.ts:163`).
- **Owner id:** the acting user *is* the owner; their Discord id is `interaction.user.id` / `i.user.id`, already in scope at every site. `CharacterData.userId` is the internal DB id, **not** the snowflake — do not use it. No DB lookup needed.
- **Change:** add the owner next to the character name in the **public** outcome `content` as a Discord mention (`<@${userId}>`), and **suppress the ping** so it renders as a name without notifying (`allowedMentions: { users: [] }` / `parse: []` on the public payload; add pass-through to `broadcastOutcome` if it doesn't already forward `allowedMentions`). The private reply may carry the same suffix (harmless self-reference) but is secondary — the public/shared message is the one testers asked for.
- **Scope fence:** identity is a lightweight name/mention suffix only. No guild-member display-name fetch, no new repo, no embed-author redesign, no touching the richer community-tagging work (deferred to `[[mvp-social-model]]`).
- **Tests:** cover the public content line carries the owner mention and that pings are suppressed (extend the relevant `tests/discord/*` action test).

### Scope fence (both tasks)

Render/comms only. Do **not** touch the LLM prompt, the auto-resolve/`done` path, roll-refund logic, latency, or the pins/weekly-recap groups. No drive-by refactors of adjacent code.

---

## Execution spec — Pass 2 (pins/comms + weekly recap)

Verified seams (2026-07-04, lead-confirmed against `feat/polish-v0.2.8`). Pass 1 (footer + identity) is committed; this pass handles the two remaining groups. The weekly-recap sub-tasks (F#19a-c) are the heavier ones; pins (F#18, F#20) are trivial.

**Verification (run before returning; must stay green):** `npm run typecheck` and `npm test` (vitest). Baseline: 70 test files, 1046 tests.

### Task C — distinct emoji for release notes vs weekly recap *(F#20)*

- **File:** `src/discord/release-notes.ts`, `buildReleaseNotesMessage()` at the top of its body.
- **Gap:** release notes and weekly-recap headers both start with `📜`, so the pin list can't tell them apart.
- **Change:** replace `📜` with `📬` in `buildReleaseNotesMessage()` — the line `📜 **What's New — ${rn.tag}: ${rn.title}**` becomes `📬 **What's New — ${rn.tag}: ${rn.title}**`.
- **Retroactive editing:** skip. `runReleaseAnnouncement` in `src/index.ts:1080` stores `last_release_announced` (the tag string), not the message id. Finding and editing old announcements would require fetching pinned messages by content prefix, and the benefit is marginal (only the most-recently-pinned icons matter).
- **Tests:** extend `tests/discord/release-notes.test.ts` (if it exists) or confirm `buildReleaseNotesMessage` output starts with `📬`.

### Task D — trim pinned Saturday threats *(F#18)*

- **File:** `src/index.ts`, the Saturday-threat block inside `runAfternoonBeat` (~L789).
- **Current:** `pinMessage(threatMsg, "Saturday threat")` — each week's Saturday threat accumulates as a separate pin. Over a few weeks, that's 3–4 threat pins cluttering the list.
- **Change:** switch from `pinMessage` to `pinReplacing(threatMsg, "⚔️ **A threat stirs in the wild.**", "Saturday threat")` — same pattern as the leaderboard. Only the latest Saturday threat stays pinned; older ones are unpinned. The marker is the opening line of `buildThreatAnnouncement` in `src/discord/afternoon.ts:110`.
- **No other low-signal pins to sweep.** The only accumulating pins are release notes (one per version, self-limiting), Saturday threats, leaderboards (self-replacing), and weekly headers (capped by `pinKeepingNewest`). After this change, every pin type is either capped or self-replacing.
- **Tests:** verify the call site uses `pinReplacing` with the correct marker. No new test file needed; the call site is straightforward.

### Task E — sidebar visibility for the week's thread *(F#19a)*

- **Status:** likely already solved by Pass 1 (Task B). Every public outcome now carries `<@${userId}>` with `allowedMentions: { users: [] }` — the mention renders without pinging but the thread should still surface in the mentioned user's Discord sidebar.
- **Verification-only task:** confirm this is sufficient by testing with a real Discord client. If Discord doesn't treat bot-authored mentions as sidebar triggers, flag it back for a different approach. No code change in this pass.
- **If needed:** the fallback is a first-outcome-only explicit mention in the thread (tracked per-thread-per-player). But try with Pass 1's mentions first.

### Task F — summary at the bottom of a locked thread *(F#19b)*

- **File:** `src/index.ts`, `finalizePreviousWeek()` (~L883).
- **Current flow:** fetches the header message in the guild channel → generates digest → edits the header message in place.
- **Change:** post the chronicle as a final message at the bottom of the thread, then lock it. The pinned header stays as the archive anchor.

  In `finalizePreviousWeek`:
  1. After generating `recapResult`, fetch the thread by `META_RECAP_THREAD_ID` (still the old thread at this point — `startNewWeek` hasn't flipped it yet).
  2. Post the chronicle text as a message to the thread: `await thread.send(buildRecapHeader(weekNumber, weekStart.slice(0, 10), recapResult))`.
  3. Lock the thread: `await thread.setLocked(true)`.
  4. Edit the header message minimally instead of with the full chronicle — keep it as the archive anchor, e.g.: `📜 **Week ${weekNumber}** — the tale is told. Scroll down to the last message in the thread for the chronicle.`
  5. Handle missing thread gracefully (deleted between when the week was active and when finalize runs). Fetching the thread is inside the existing try/catch.

- **Edge cases:**
  - **Boot catch-up (`catchUpWeeklyRecap`):** uses the same `finalizePreviousWeek` → no changes needed.
  - **Recreate-on-delete (`ensureWeeklyThread`):** triggers only on deleted threads (error code 10003), not locked ones. Locking doesn't break the recreate path. Verified: `isThreadDeleted` checks exactly code 10003; a locked thread is still fetchable.
  - **Lock fails:** already inside try/catch → the chronicle still posts.
  - **No mid-week lock:** outcomes still post into the thread while the week is live. The lock only happens at finalize, after the thread id has already flipped.

- **Tests:** extend `tests/discord/weekly-recap.test.ts` if it exists, or add assertions that the finalize path posts to the thread and locks it. Mock the Discord thread object.

### Task G — dedupe private-outcome vs thread-copy vs header *(F#19c)*

- **Audit scope (no code change required unless a clear, low-risk dedupe emerges):**
  1. **Private reply** (interaction reply): full embed with outcome + story thread + nav buttons + service buttons.
  2. **Thread copy** (`broadcastOutcome`): same embed + owner mention + service buttons only (no nav).
  3. **Header** (pinned channel message): LLM chronicle summary, completely different format.

- **The overlap is between (1) and (2):** the same embed appears in two places when a player completes an action. The player sees the outcome twice — once in the interaction (replacing the decision embed) and once scrolling the thread.

- **Audit deliverable:** read both render paths (`buildOutcomeEmbed` in `src/discord/commands/action.ts` and the four send sites), confirm the overlap, and propose a lightweight dedupe if one is possible without regressing the gamebook feel. Options to evaluate:
  - Trim the story-thread breadcrumb from the private reply (it's already visible in the decision embed the player just saw). Keep it in the thread copy for the public record.
  - Or leave as-is if the dedupe would cost more in UX than the minor duplication.

- **Concrete code change (if the audit concludes one is safe):** drop the `buildStoryThread` / breadcrumb block from the private reply embed, keeping it only in the thread copy. The private outcome shows just the outcome text + stats + footer. This eliminates the primary overlap without touching the thread or header.

### Scope fence (Pass 2)

Render/comms only. Do **not** touch the LLM prompt, auto-resolve/`done` path, roll-refund logic, latency, or `CharacterRepository.update`. Do **not** change the recap scheduler (`runWeeklyRecap`, `catchUpWeeklyRecap`, `ensureWeeklyThread`) beyond the `finalizePreviousWeek` changes specified in Task F. No drive-by refactors.

## Cut line / notes

- Branch off `dev` (e.g. `feat/polish-v0.2.8`), log under `CHANGELOG.md` `[Unreleased]`, stage player notes at `assets/release-notes/v0.2.8.yml`. Release cut (VERSION bump, `dev`→`main`, tag) is a separate step per `[[releasing]]`.
- Code pointers are starting points, not verified seams — confirm the weekly-recap scheduler, the pin/announce helper, and the outcome renderers before touching them.
- The recap lock-and-summarise change interacts with the boot catch-up for a missed Monday tick (`0.2.5`) — make sure locking a finalized thread doesn't break the recreate-on-delete path.

---

Drawn from the prod-data review and refreshed 2026-07-04 (snapshot `warden-20260704-124954` + local dev DB); refresh again before cutting if much time passes.
