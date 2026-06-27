---
title: Polish Pass — v0.2.4
status: shipped
domain: archived
phase: poc
tags: [bugs, polish, coherency, thematic, release, footer, emoji, prompt]
superseded_by: "implemented in code"
related:
  - "[[bug-analysis-v0.2.2]]"
  - "[[handover-code-review-post-pr14]]"
  - "[[daily-work-teleport]]"
  - "[[per-option-stat-and-ability-checks]]"
  - "[[yaml-asset-schemas-and-tests]]"
---

The punch list for the **v0.2.4** patch. Scope is deliberately narrow: **bug-fixing, coherency, and thematic consistency** on surfaces the player already touches. **No new features, no MVP work.** This consolidates the still-open tails of [[bug-analysis-v0.2.2]] and [[handover-code-review-post-pr14]] (re-verified against current code), the POC-relevant items from `TODO.md`, and a fresh four-reader sweep of `src/discord` (frontend), `src/engine` + `src/index.ts` (mechanics), and `src/llm` + the decision prompt.

**Headline:** two bugs worth fixing first — (1) a **silent character-stat corruption**: four `/join` backgrounds produce a `NaN` stat (found in the second sweep, §B); and (2) a player-visible display bug — the outcome footer prints a hardcoded `/2` roll denominator after the daily allowance was bumped to **3** (Saturday **4**), so players see `🎲 3/2`. Everything else is small coherency/thematic tightening. No crashers found. `current_source.md` is byte-identical to `decision-v7.md` (the convention held).

> **Two sweeps:** §A below is the original hot-path review (`src/discord` frontend, `src/engine`/`index.ts` mechanics, `src/llm`). **§B (2026-06-21)** is a follow-up sweep over every source file the first pass had *not* opened — peripheral Discord, all DB repositories/migrations, engine internals, LLM/scene/asset loaders, the char-creation YAML, and the ops/scripts/config layer. Every `file:line` in both was opened and confirmed.

> **Division of labour — this doc and [[prod-data-review-v0.2.3]] are executed by separate agents.** To keep them from editing the same files: - **This doc (polish-pass) owns the *code-tidy & data-fix* work:** cosmetic/coherency/thematic fixes and the §B data/ops bugs. It makes **no edits to the decision prompt files** and **no edits to the auto-resolve / resolution path** (`machine.ts` auto-finish, `WorldEngineImpl.startAction` roll-debit, the gateway empty-decision handling). - **[[prod-data-review-v0.2.3]] owns the *decision/resolution/roll-economy/prompt-behaviour* domain** — its §C1 (auto-resolve eats a roll), §C2 (timeout), §G–§Q items, **and the `decision-v8.md` prompt bump** (into which the cosmetic prompt fixes below have been relocated). - Items here that touched that domain (former **E3**, **E4**, **P1**, **P2**) are now **deferred** to that doc; the footer fix (**F1**) stays here and prod-data §G1 defers to it. The only file both agents touch is `WorldEngineImpl.ts` — but in **different functions** (`countSoulsInUnsafe` here vs `startAction`/`isStateStale` there), so they don't collide.

---

## How to read this

Severity is **impact on a live player or the live bot**, not code aesthetics. Each item has a `file:line`, the concrete thing a player/operator would see, and a small POC-scoped fix. `[?]` items need a design call, not a silent patch. Items I confirmed are *not* problems are listed under **Verified — not a bug** so we don't re-litigate them.

---

## 🔴 High — player-visible, fix first

- [!] **F1 · Outcome footer shows a stale `/2` roll denominator.** `src/engine/OutcomeRenderer.ts:205` hardcodes `🎲 ${ctx.rollsRemaining}/2`. But `DAILY_ROLL_ALLOWANCE` is now **3** (`src/db/schema.sql:24`, `character.ts:43`) and Saturday grants **+1 = 4** (`WorldEngineImpl.ts:58-59,930-932`). So after one action on a normal day the footer reads `🎲 2/2`, and at the start of the day `🎲 3/2` — a nonsensical "over-full" fraction. Every action outcome a player sees carries this wrong denominator.
  - [I] Fix: drop the denominator entirely (`🎲 ${ctx.rollsRemaining}`), matching `/hi`'s "Rolls: N" style — simplest and avoids re-deriving the daily max. **Fix this together with the `todo-roll-footer` item below** (surfacing the spent roll), since both live on this one line.
  - [I] **Owned here.** [[prod-data-review-v0.2.3]] §G1 reaches the same finding from player complaints ("I'm losing rolls I didn't use") and explicitly defers the fix to this §F1 — it's a one-line `OutcomeRenderer.ts` change that doesn't touch the resolution path.

---

## 🟠 Medium — real coherency / thematic gaps

- [!] **F2 · `/stats` shows stamina with no max; `/hi` shows it with max.** `src/discord/commands/stats.ts:36` prints `**Stamina:** ${char.stamina}` while health on the same line shows `${char.health}/${char.maxHealth}`, and `/hi` correctly shows `Stamina: N/M`. A player comparing the two screens sees stamina "lose" its ceiling on `/stats`.
  - [I] Fix: `**Stamina:** ${char.stamina}/${char.maxStamina}` on `stats.ts:36`.

- [!] **F3 · Character header hardcodes ⚔️ for every class.** `src/discord/commands/stats.ts:19` and `src/discord/commands/hi.ts:86` both emit `⚔️  **${char.name}** — ${char.class}`. The action-broadcast path already has a single-source `classEmoji()` (Ranger→🏹, Wizard→🔮, etc., per [[handover-code-review-post-pr14]]). So a Ranger or Wizard sees a warrior's sword on their own header — thematically off and inconsistent with their own combat broadcasts.
  - [I] Fix: import `classEmoji` and use `${classEmoji(char.class)}  **${char.name}** — ${char.class}` in both files.

- [!] **F4 · Day-job surfaces hardcode 🔨 (hammer) for every job.** `src/discord/commands/action.ts:163,197` and `hi.ts:217,227` render `🔨 ${char.dayJob}` for all jobs. A `DAYJOB_EMOJI` map already exists in `src/discord/commands/join.ts:461` (Town Guard→🛡️, Hunter→🏹, Merchant→💰, …) but it is module-private and unused outside the wizard. A Merchant and a Herbalist both appear under a blacksmith's hammer.
  - [I] Fix: `export` `DAYJOB_EMOJI` from `join.ts`, import it in `action.ts`/`hi.ts`, and look up the job (fallback `🔨`). Pure presentation, no data change.

- [I] **E1 · `countSoulsInUnsafe()` counts unknown locations as unsafe + does N+1 lookups.** `src/engine/WorldEngineImpl.ts:900-908` does one `locationRepo.findByName(c.location)` per character and treats a missing row (`!loc`) as unsafe. This is now **live** — the 18:30 public goodnight reads it. With current seeding all locations resolve, so it's correct today; the risk is a single mismatched/cased `set_location` value silently inflating "souls still out in the wilds." (Carried forward as **L3** — confirmed still live.)
  - [I] Fix: build a `Set` of location names once (or a `name→is_safe` map) and filter in memory; treat an unknown location explicitly rather than implicitly-unsafe. Bounded by player count, so purely a robustness/clarity fix for POC.
  - [I] *Related, not a conflict (different file):* [[prod-data-review-v0.2.3]] §G3 covers where unknown locations **come from** (`set_location` to unseeded names). If G3 picks option (a) "lazily create the location row," unknown locations stop existing and this hardening becomes belt-and-braces; if it picks (b) "constrain the prompt," this stays the safety net. Either way `countSoulsInUnsafe` should treat unknown explicitly.

- [?] **E2 · No multi-day boot catch-up for missed world ticks.** `src/index.ts` `scheduleTick()` arms only the *next* 03:30 and relies on a single idempotency guard; the morning/goodnight announcements got boot-time catch-up (per [[bug-analysis-v0.2.2]]) but the tick itself does not backfill more than the current day. If the bot is offline across **two or more** tick windows, intervening days are not advanced — the world falls behind by the length of the outage minus one.
  - [?] Is multi-day backfill in POC scope, or is "bot stays up" an accepted POC assumption? If we want it: on boot, while `last_cron_date < today (UTC)`, run `engine.tick(false)` until caught up, then arm the next. Flagging rather than prescribing — could be deferred to MVP if outages are handled operationally.

---

## 🟡 Low — thematic / clarity / tests

- [>] **P1 · Prompt typo: "expendale".** `assets/prompts/decision-prompts/decision-v7.md:103` — "For items that are expendale, ammunition…". The LLM can mirror sloppy spelling into player-facing prose. **Relocated to [[prod-data-review-v0.2.3]] §C1** — it owns the `decision-v8.md` bump, so this typo lands there to avoid two competing v8 files.
- [>] **P2 · Prompt clarity: inventory reference.** `decision-v7.md:102` says "Check the INVENTORY in the input context", but there is no `INVENTORY` line — inventory rides inside the `SCALING HINT` block. Minor LLM-confusion risk; reword to point at the right field. **Relocated to [[prod-data-review-v0.2.3]] §C1** (same `decision-v8.md` bump).
  - [I] *Mechanism, for the doc that does it:* per `AGENTS.md`, never edit a published prompt in place — add `decision-v8.md`, bump `PROMPT_VERSION` to `'v8'` in `src/llm/prompt-builder.ts`, and copy it over `current_source.md` byte-identical. P1, P2, the former E3 contract decision, and prod-data §C1's behavioural prompt change all batch into that single v8.

- [I] **P3 · Fallback copy: "The warden's hand" (lowercase).** `src/llm/FallbackLlmGateway.ts:15`. Everywhere else the NPC is "**The Warden**". The divine-intervention fallback should read "The Warden's hand" for voice consistency. One-line string fix (not prompt-versioned — it's code copy).

- [>] **E3 · Prompt and engine disagree on the `done` flag → owned by [[prod-data-review-v0.2.3]] §C1.** The v7 prompt no longer documents `done`, yet the engine still consumes it (`machine.ts:204,301`, `DeepseekLlmGateway.ts:227,294`). It's not dead code — if the LLM emits `done` it changes behaviour, else the code falls back to `realOptions.length === 0`. This sits in the auto-resolve path that prod-data §C1 reworks, so the contract decision (re-document `done` in `decision-v8.md` vs strip the engine's reliance) is made there, in the same edit — not here. *Documented in this doc only so the code observation isn't lost.*

- [>] **E4 · Empty decision + no mutations resolves to a no-op that still spent a roll → owned by [[prod-data-review-v0.2.3]] §C1.** `machine.ts:99-111` auto-finishes with `mutations: []` / "The moment passes." when nothing is rollable, while the roll was already debited in `WorldEngineImpl.startAction()` (`:565`). This doc originally called it "bounded and rare" — **the prod telemetry upgrades it to Critical** (28% of v0.2.3 actions; see prod-data §C1). The fix (gateway-reject the empty response at `DeepseekLlmGateway.ts:264`, and the roll-cost design call) lives in prod-data §C1. *Kept here only as the code-side cross-reference; do not action from this doc.*

- [I] **F5 · `/stats` says "Rolls: N remaining"; `/hi` says "Rolls: N".** `stats.ts:40` vs `hi.ts` — the `/hi` test deliberately asserts "remaining" is absent. Align `stats.ts` to drop "remaining" for one rolls vocabulary across screens.

- [I] **E5 · Mock fixture out of step with the live default.** `src/engine/MockWorldEngine.ts:149` seeds `rollsRemaining: 2`, but the real default is `3`. Harmless in tests, but it's the kind of stale `2` that hid F1. Bump to `3` for fidelity.

- [I] **todo-roll-footer · Spent roll reads as "free".** `OutcomeRenderer.ts:205` shows the roll count with no `(−1)` because spending a roll is an engine decrement, not a mutation, so `formatDelta(d.rollsDelta)` has nothing to show. Surface the spend (compute `before − after` in the caller, or have `startAction` annotate a `-1` rolls delta for display). **Fold into the F1 fix** — same line, same render context.

### Test coverage (carried forward from [[handover-code-review-post-pr14]])

- [ ] **C1 · No test for the `/join` wizard-completion path.** `src/discord/commands/join.ts` does a `followUp → deleteReply → followUp(hi)` dance (public announcement + ephemeral replacement) with `.catch(() => {})` swallows — entirely untested.
- [ ] **C2 · No test for the `nav:action` handler.** `src/index.ts` (~`:1737+`) routes day-job-menu / resume / "out of actions" — a core UX flow with no coverage.
- [ ] **C3 · No test for the `/stats` vitals line.** Had one existed, F2 (missing stamina max) would not have shipped. Add an assertion on the `Health/Stamina/Rolls` formatting when fixing F2.

---

---

## §B — Second sweep: previously-unread files (2026-06-21)

A pass over the files the first review never opened. Findings below are de-duplicated against §A (e.g. the `MockWorldEngine` roll default already lived there as **E5**, now expanded). Confirmed false-positives from the sweep are recorded under **Verified — not a bug** so they don't resurface.

### 🔴 High

- [!] **B1 · `/join` backgrounds produce a `NaN` stat (silent character corruption).** `assets/char-creation/backgrounds.yml` omits one required stat key in **five** entries — **Farmstead** (line 34, no `intelligence`), **Temple-Raised** (38, no `physical`), **Urchin** (42, no `intelligence`), **Entertainer** (46, no `wisdom`), **Scout** (50, no `intelligence`). `StatComputer.computeStats` (`src/engine/StatComputer.ts:40-50`) sums the three sources unguarded, so `cls + undefined + race = NaN`. A player picking any of these backgrounds ends up with one ability score permanently `NaN` (persisted as `null`), which poisons every DC/ability-check (`d20 + NaN = NaN`), the stat display, and any LLM context built from stats.
  - [!] **Correction + evidence:** this sweep originally said "four" and missed **Entertainer** — and [[prod-data-review-v0.2.3]]'s DB pull confirms **5 of 8 live characters already carry a `null` stat** (Flikker = Entertainer→`wisdom`, two Scouts + two Urchins→`intelligence`). The miscount is itself the argument for automated validation.
  - [x] Fix (data) **applied 2026-06-21**: added the missing key (`0`) to all five entries (normalised to `physical, wisdom, intelligence, charisma` order). Committed to `dev` (`fix missing stats`) and pushed live to the container, which was restarted so `/join` now computes complete stat blocks. *(The already-corrupted live characters were repaired separately via the scriptfix — see [[yaml-asset-schemas-and-tests]].)*
  - [>] Fix (defence-in-depth, was B7): the systematic validation layer + tests that prevent recurrence — **and the repair of the 5 corrupted live characters** — are specified in **[[yaml-asset-schemas-and-tests]]** (its T2/T3 turn this into a red test). Land the data edit here; that spark guards it.

### 🟠 Medium

- [!] **B2 · Saturday threat NPC double-spawns if its announcement fails.** `src/index.ts:701-714` (afternoon beat). The order is: idempotency check (`:701`) → `engine.spawnNpc(...)` (`:706`) → post announcement, and **only stamp `last_threat_date` if the post succeeds** (`:713-714`). So if the NPC spawns but `postAnnouncement` returns false (Discord hiccup, perms, channel gone), the meta is never stamped — and the next afternoon-beat run (boot-time catch-up or a later tick) passes the guard again and **spawns a second identical threat NPC**. This is exactly the "duplicate NPCs" class flagged in `TODO.md`.
  - [I] Fix: stamp `last_threat_date` immediately after a successful `spawnNpc` (the irreversible side effect), independent of the announcement. A failed announcement then just means no message that day — not a duplicate mob. (The leaderboard branch at `:721-727` is read-only, so its same-shape "stamp only on post success" is benign — at worst a re-post, no duplicate state.)

- [I] **B3 · `CharacterRepository.create()` never inserts `max_stamina`.** `src/db/repositories/character.ts:20-30` lists `health, max_health, stamina, rolls_remaining` in the INSERT but omits `max_stamina`, even though `WorldEngineImpl.createCharacter` passes `max_stamina: 10` and the type carries it. It works today only because the column has `DEFAULT 10` and the intended value is also 10 — pure luck. The moment a class/background wants a non-10 starting max stamina, the passed value is silently dropped.
  - [I] Fix: add `max_stamina` to the column list + `@max_stamina` to VALUES + `max_stamina: data.max_stamina ?? 10` to params. Closes the code-intent vs SQL drift.

### 🟡 Low

- [I] **B4 · `package.json` version (`0.1.8`) is stale vs `VERSION` (`0.2.3`).** `package.json:3`. Runtime is unaffected — `src/version.ts` reads the `VERSION` file, and this app isn't published to npm — but it contradicts the single-version release discipline in `AGENTS.md`. Either sync `package.json` to `VERSION` as part of the release step, or set it to `0.0.0` to make "VERSION is the source of truth" explicit.
- [I] **B5 · `expectTimestamp` interpolates a table name into SQL.** `src/db/repositories/user.ts:43` builds `SELECT created_at FROM ${table} …`. **Not exploitable** — the only caller passes the string literal `'users'` (`:21`) — but it's an injection-shaped footgun in a file full of correctly-parameterised queries. Inline the table (`FROM users`) and drop the `table` param.
- [I] **B6 · `makeJournalCommand` returns a sync `string`, unlike every other command.** `src/discord/commands/journal.ts:5` returns `(i) => string`; all siblings return `async … Promise<string>`. Harmless at runtime (the dispatcher `await`s it and `await "str"` yields the string) and the `asHandler` cast (`index.ts:922`) hides the type gap — but it's the kind of inconsistency that makes the blanket cast risky. Make it `async` for uniformity.
- [>] **B7 · The YAML loader does no schema-completeness check → owned by [[yaml-asset-schemas-and-tests]].** `src/assets/yaml-loader.ts` validates syntax/array shape but not that `modifiers` carries all four stat keys — precisely the gap that let B1 ship undetected. That spark expands this nit into a per-asset schema module + validate-on-load + a real-file test layer (T1–T5). *Kept here only as the code-side cross-reference; do not action from this doc.*
- [I] **B8 · `MockWorldEngine` defaults drift from real character creation.** `src/engine/MockWorldEngine.ts:145-146,149`: `health/maxHealth: 12` and `rollsRemaining: 2`, but real defaults are `10` and `3` (`WorldEngineImpl` + `schema.sql`). Tests assert against a character that can't exist in prod, which can mask off-by-one/clamping bugs. Align to `10`/`10`/`3`. *(Supersedes/expands E5.)*
- [I] **B9 · `MockLlmGateway.defaultDecision()` omits `mutations`/`outcomeText`.** `src/llm/MockLlmGateway.ts:24-39` returns a decision missing the optional fields a real gateway populates, so tests can pass on shapes the engine would treat differently. Populate `mutations: []` and a stub `outcomeText` for fidelity.
- [I] **B10 · Ops/scripts hardening (dev-only, low live impact).** Bundled because they share a theme — destructive/automation scripts lacking guards: `clear-admin.sh` and `clear-channel.sh` perform irreversible deletes (wipe a character / purge a channel) with **no confirmation prompt**, and `clear-admin.sh` leaves its `/tmp/warden-clear.db` copy (with `-wal`/`-shm`) behind; `deploy-check.sh` does an unconditional `git checkout $BRANCH` (a branch switch mid-deploy if HEAD drifted); `daily-pixel-deploy.service` has no `[Unit] After=network-online.target` ordering. None affects the live player loop; all are "fix before someone fat-fingers a prod script." Add a `read -r confirm` gate to the two destructive scripts at minimum.
- [I] **B11 · Undocumented env vars.** `.env.example` omits vars the code reads — `SLEEP_ADMIN_TICK` (`src/index.ts`, `sleep.ts`) and `CLEAR_CHANNEL_ID` (`clear-channel.sh`). Add them so operators aren't guessing.

---

## ✅ Verified — not a bug (closed; don't re-open)

- [x] **L6 · `notifyAdmin` does not send duplicate admin DMs.** `src/index.ts:202-233` — the gateway path early-`return`s on success, so the REST fallback only runs when the gateway threw. Mutual-exclusion holds; no duplicate. (The only residual is that if *both* paths fail it just logs a warning — a pure observability nicety, not a correctness bug. Not worth a POC change.)
- [x] **todo-dup-npc · "The Warden" and "A Hooded Figure" are two intentional NPCs, not a duplicate.** `src/db/migrate.ts` seeds `The Warden` (Warden, at The Warden's Oak, with special lore injection in `prompt-builder.ts`) and `A Hooded Figure` (Wanderer, at The Weary Lantern Inn) — distinct names, classes, and locations. The TODO note conflates them. No action. *(If the intent was that the hooded figure should later be revealed as the Warden, that's a narrative-design decision for `decisions/`, not a bug.)*
- [x] **todo-join-yaml · `/join` options already load from YAML.** `src/index.ts:150-159` loads all char-creation YAML into `CharDefs`; `join.ts` consumes them with no hardcoded option arrays, and `tests/discord/join-options.test.ts` asserts every YAML option is offered. Done.
- [x] **todo-move-people · No player-stranding / soft-lock path found.** `set_location` mutations are validated against known locations and snap to canonical casing (`mutations.ts`); the day-job teleport updates DB + local state with stamina cost (`index.ts`). Daily work intentionally leaves you where the action ends (the sleep-penalty workplace carve-out from [[bug-analysis-v0.2.2]] handles the consequence). No code path leaves a player unable to act. The "often forgets to move people" note is a *prompt-behaviour* observation (the LLM not emitting `set_location` when travel is implied) — it belongs to the MVP prompt-architecture work, **out of scope here**.
- [x] **Prompt sync intact.** `current_source.md` is byte-identical to `decision-v7.md`; `PROMPT_VERSION === 'v7'`.
- [x] **"`last_played_at`/`narrative`/`applied_mutations` missing from `schema.sql`" is by design.** A fresh DB runs the baseline then the dated migrations; those columns are added by later migrations on purpose (confirmed in [[bug-analysis-v0.2.2]]). Not drift.
- [x] **`expectTimestamp` is not a live SQL-injection vuln.** Its `table` arg is only ever the literal `'users'`; no user input reaches it. Logged as the B5 footgun-hardening nit, not a vulnerability.
- [x] **The sync `journal` handler does not break at runtime.** The dispatcher `await`s it; `await` on a plain string returns the string. It's the B6 consistency nit only.
- [x] **Release-notes re-announcing on a failed send is intended.** `runReleaseAnnouncement` leaving `last_release_announced` unstamped on failure means it retries next boot — matching the `AGENTS.md` "fires exactly once per tag, when a matching file exists" contract.
- [x] **Day-job `workplace_location`s all resolve.** Every `workplace_location` in `day-jobs.yml` matches a seeded location (`migrate.ts`); no phantom-workplace teleport target.

---

## 🚫 Out of scope for v0.2.4 (named so they're not pulled in)

- [-] Combat as a mechanic → [[mvp-combat]].
- [-] Prompt rearchitecture (roll-before-flavour, agent chaining, markdown prompts) → [[mvp-llm-prompt-architecture]]. P1–P3/E3 above are copy/contract tidy-ups, *not* this.
- [-] Pacing engine ("every Nth encounter dangerous", DC scaling with time) → MVP.
- [-] Graph DB / world-state tracking → [[mvp-data-model]].
- [-] Roll-economy redesign / bonus-roll mechanic surfacing → MVP roll-economy work. (F1 + todo-roll-footer are *display* fixes only.)
- [-] `renderScreen(userId, commandName)` shared helper — optional refactor, no behaviour change, deferred in [[handover-code-review-post-pr14]].

---

## Suggested triage order

> Scope: **only the code-tidy & data-fix items this doc owns.** The auto-resolve / roll-economy / prompt-`v8` cluster (former E3, E4, P1, P2) is triaged in [[prod-data-review-v0.2.3]], not here.

1. [ ] **B1** — fix the **five** `backgrounds.yml` entries. Silent stat corruption; data-only, highest impact-per-effort. The loader guard + tests (B7) and the live-character repair are owned by [[yaml-asset-schemas-and-tests]].
2. [ ] **F1 + todo-roll-footer** — one line in `OutcomeRenderer.ts`; the player-visible footer bug. Add the C3 stats test alongside.
3. [ ] **B2** — stamp `last_threat_date` on spawn, not on announcement success. Kills the duplicate-threat-NPC path.
4. [ ] **F2 / F5** — `/stats` stamina max + rolls label (+ the C3 assertion).
5. [ ] **F3 / F4** — `classEmoji` in headers; export + reuse `DAYJOB_EMOJI`. Pure thematic win, low risk.
6. [ ] **B3** — add `max_stamina` to the character INSERT.
7. [ ] **P3 / B8 / B9** — Warden casing (code copy, not the prompt file); mock fixtures (`MockWorldEngine` 10/10/3, `MockLlmGateway` fields).
8. [ ] **E1 (L3)** — `countSoulsInUnsafe` robustness.
9. [ ] **B4 / B5 / B6 / B11** — version sync, `expectTimestamp` inline, async `journal`, env-var docs. Cheap housekeeping.
10. [ ] **C1 / C2** — wizard-completion and `nav:action` handler tests.
11. [ ] **B10** — confirmation prompts on destructive scripts (do before next prod script run).
12. [?] **E2** — design call (multi-day tick backfill). Resolve before coding.
13. [>] **Deferred to [[prod-data-review-v0.2.3]]:** E3 (`done`-flag contract), E4 (empty no-op wastes a roll → its §C1), P1/P2 (prompt typo + wording → its `decision-v8`).

> Sweep basis: four parallel readers over `src/discord`, `src/engine` + `src/index.ts`, `src/llm` + `assets/prompts`, plus a re-verification pass on the open tails of the two prior reviews and `TODO.md`. Every `file:line` here was opened and confirmed, not taken from the reader summaries.
