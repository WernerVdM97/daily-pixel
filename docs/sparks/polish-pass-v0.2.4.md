---
title: Polish Pass — v0.2.4
status: spark
domain: spark
phase: poc
tags: [bugs, polish, coherency, thematic, release, footer, emoji, prompt]
related:
  - "[[bug-analysis-v0.2.2]]"
  - "[[handover-code-review-post-pr14]]"
  - "[[daily-work-teleport]]"
  - "[[per-option-stat-and-ability-checks]]"
---

The punch list for the **v0.2.4** patch. Scope is deliberately narrow: **bug-fixing, coherency, and thematic consistency** on surfaces the player already touches. **No new features, no MVP work.** This consolidates the still-open tails of [[bug-analysis-v0.2.2]] and [[handover-code-review-post-pr14]] (re-verified against current code), the POC-relevant items from `TODO.md`, and a fresh four-reader sweep of `src/discord` (frontend), `src/engine` + `src/index.ts` (mechanics), and `src/llm` + the decision prompt.

**Headline:** two bugs worth fixing first — (1) a **silent character-stat corruption**: four `/join` backgrounds produce a `NaN` stat (found in the second sweep, §B); and (2) a player-visible display bug — the outcome footer prints a hardcoded `/2` roll denominator after the daily allowance was bumped to **3** (Saturday **4**), so players see `🎲 3/2`. Everything else is small coherency/thematic tightening. No crashers found. `current_source.md` is byte-identical to `decision-v7.md` (the convention held).

> **Two sweeps:** §A below is the original hot-path review (`src/discord` frontend, `src/engine`/`index.ts` mechanics, `src/llm`). **§B (2026-06-21)** is a follow-up sweep over every source file the first pass had *not* opened — peripheral Discord, all DB repositories/migrations, engine internals, LLM/scene/asset loaders, the char-creation YAML, and the ops/scripts/config layer. Every `file:line` in both was opened and confirmed.

---

## How to read this

Severity is **impact on a live player or the live bot**, not code aesthetics. Each item has a `file:line`, the concrete thing a player/operator would see, and a small POC-scoped fix. `[?]` items need a design call, not a silent patch. Items I confirmed are *not* problems are listed under **Verified — not a bug** so we don't re-litigate them.

---

## 🔴 High — player-visible, fix first

- [!] **F1 · Outcome footer shows a stale `/2` roll denominator.** `src/engine/OutcomeRenderer.ts:205` hardcodes `🎲 ${ctx.rollsRemaining}/2`. But `DAILY_ROLL_ALLOWANCE` is now **3** (`src/db/schema.sql:24`, `character.ts:43`) and Saturday grants **+1 = 4** (`WorldEngineImpl.ts:58-59,930-932`). So after one action on a normal day the footer reads `🎲 2/2`, and at the start of the day `🎲 3/2` — a nonsensical "over-full" fraction. Every action outcome a player sees carries this wrong denominator.
  - [I] Fix: drop the denominator entirely (`🎲 ${ctx.rollsRemaining}`), matching `/hi`'s "Rolls: N" style — simplest and avoids re-deriving the daily max. **Fix this together with the `todo-roll-footer` item below** (surfacing the spent roll), since both live on this one line.

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

- [?] **E2 · No multi-day boot catch-up for missed world ticks.** `src/index.ts` `scheduleTick()` arms only the *next* 03:30 and relies on a single idempotency guard; the morning/goodnight announcements got boot-time catch-up (per [[bug-analysis-v0.2.2]]) but the tick itself does not backfill more than the current day. If the bot is offline across **two or more** tick windows, intervening days are not advanced — the world falls behind by the length of the outage minus one.
  - [?] Is multi-day backfill in POC scope, or is "bot stays up" an accepted POC assumption? If we want it: on boot, while `last_cron_date < today (UTC)`, run `engine.tick(false)` until caught up, then arm the next. Flagging rather than prescribing — could be deferred to MVP if outages are handled operationally.

---

## 🟡 Low — thematic / clarity / tests

- [I] **P1 · Prompt typo: "expendale".** `assets/prompts/decision-prompts/decision-v7.md:103` — "For items that are expendale, ammunition…". The LLM can mirror sloppy spelling into player-facing prose.
- [I] **P2 · Prompt clarity: inventory reference.** `decision-v7.md:102` says "Check the INVENTORY in the input context", but there is no `INVENTORY` line — inventory rides inside the `SCALING HINT` block. Minor LLM-confusion risk; reword to point at the right field.
  - [!] **Mechanism for P1+P2:** per `AGENTS.md`, **never edit a published prompt in place.** Add `decision-v8.md` with both fixes, bump `PROMPT_VERSION` to `'v8'` in `src/llm/prompt-builder.ts`, and copy it over `current_source.md` byte-identical. Batch P1+P2 into the one new version.

- [I] **P3 · Fallback copy: "The warden's hand" (lowercase).** `src/llm/FallbackLlmGateway.ts:15`. Everywhere else the NPC is "**The Warden**". The divine-intervention fallback should read "The Warden's hand" for voice consistency. One-line string fix (not prompt-versioned — it's code copy).

- [?] **E3 · Prompt and engine disagree on the `done` flag.** The v7 prompt no longer documents `done`, yet the engine still consumes it as a resolution signal: `machine.ts:204` (`isLastDecision || decision.done || …`), `machine.ts:301`, and `DeepseekLlmGateway.ts:227,294`. It's **not dead code** — if the LLM happens to emit `done`, it changes behaviour; if it doesn't, the code falls back to `realOptions.length === 0`. Today this is benign (the fallback covers it), but prompt-says-X / engine-relies-on-Y is exactly the drift the conventions warn about.
  - [?] Decide the contract: either re-document `done` in `decision-v8.md` (if the engine should keep honouring it) or strip the engine's reliance on it (if completion is purely inferred). Don't leave them disagreeing.

- [I] **E4 · Empty decision + no mutations resolves to a no-op that still spent a roll.** `machine.ts:99-111` auto-finishes with `mutations: []` and `outcomeText: 'The moment passes.'` when the LLM returns nothing rollable. The roll was already debited in `WorldEngineImpl.startAction()` (`:565`), so a player can spend a roll and get a literal nothing-happened. Bounded and rare, but reads as a wasted turn. (This is the benign residual of carried-forward **L1** — the roll *is* spent exactly once; there is no double-decrement.)
  - [I] Fix (optional): in the gateway, reject an empty-decision/no-mutation/no-outcome response (it already only *warns* — `DeepseekLlmGateway.ts:264`) so it retries the fallback instead of surfacing a dead turn.

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

- [!] **B1 · Four `/join` backgrounds produce a `NaN` stat (silent character corruption).** `assets/char-creation/backgrounds.yml` omits one required stat key in four entries — **Farmstead** (line 34, no `intelligence`), **Temple-Raised** (38, no `physical`), **Urchin** (42, no `intelligence`), **Scout** (50, no `intelligence`). `StatComputer.computeStats` (`src/engine/StatComputer.ts:40-50`) sums the three sources unguarded, so `cls + undefined + race = NaN`. A player picking any of these four backgrounds ends up with one ability score permanently `NaN`, which poisons every DC/ability-check (`d20 + NaN = NaN`), the stat display, and any LLM context built from stats. The other eight backgrounds spell out all four keys, so this only bites a third of choices — but silently.
  - [I] Fix (data): add the missing key with value `0` to all four entries. Two-minute edit, no code change.
  - [I] Fix (defence-in-depth, see B7): have the YAML loader (or `computeStats`) default missing stat keys to `0`, so a future omission can't recreate this.

### 🟠 Medium

- [!] **B2 · Saturday threat NPC double-spawns if its announcement fails.** `src/index.ts:701-714` (afternoon beat). The order is: idempotency check (`:701`) → `engine.spawnNpc(...)` (`:706`) → post announcement, and **only stamp `last_threat_date` if the post succeeds** (`:713-714`). So if the NPC spawns but `postAnnouncement` returns false (Discord hiccup, perms, channel gone), the meta is never stamped — and the next afternoon-beat run (boot-time catch-up or a later tick) passes the guard again and **spawns a second identical threat NPC**. This is exactly the "duplicate NPCs" class flagged in `TODO.md`.
  - [I] Fix: stamp `last_threat_date` immediately after a successful `spawnNpc` (the irreversible side effect), independent of the announcement. A failed announcement then just means no message that day — not a duplicate mob. (The leaderboard branch at `:721-727` is read-only, so its same-shape "stamp only on post success" is benign — at worst a re-post, no duplicate state.)

- [I] **B3 · `CharacterRepository.create()` never inserts `max_stamina`.** `src/db/repositories/character.ts:20-30` lists `health, max_health, stamina, rolls_remaining` in the INSERT but omits `max_stamina`, even though `WorldEngineImpl.createCharacter` passes `max_stamina: 10` and the type carries it. It works today only because the column has `DEFAULT 10` and the intended value is also 10 — pure luck. The moment a class/background wants a non-10 starting max stamina, the passed value is silently dropped.
  - [I] Fix: add `max_stamina` to the column list + `@max_stamina` to VALUES + `max_stamina: data.max_stamina ?? 10` to params. Closes the code-intent vs SQL drift.

### 🟡 Low

- [I] **B4 · `package.json` version (`0.1.8`) is stale vs `VERSION` (`0.2.3`).** `package.json:3`. Runtime is unaffected — `src/version.ts` reads the `VERSION` file, and this app isn't published to npm — but it contradicts the single-version release discipline in `AGENTS.md`. Either sync `package.json` to `VERSION` as part of the release step, or set it to `0.0.0` to make "VERSION is the source of truth" explicit.
- [I] **B5 · `expectTimestamp` interpolates a table name into SQL.** `src/db/repositories/user.ts:43` builds `SELECT created_at FROM ${table} …`. **Not exploitable** — the only caller passes the string literal `'users'` (`:21`) — but it's an injection-shaped footgun in a file full of correctly-parameterised queries. Inline the table (`FROM users`) and drop the `table` param.
- [I] **B6 · `makeJournalCommand` returns a sync `string`, unlike every other command.** `src/discord/commands/journal.ts:5` returns `(i) => string`; all siblings return `async … Promise<string>`. Harmless at runtime (the dispatcher `await`s it and `await "str"` yields the string) and the `asHandler` cast (`index.ts:922`) hides the type gap — but it's the kind of inconsistency that makes the blanket cast risky. Make it `async` for uniformity.
- [I] **B7 · The YAML loader does no schema-completeness check.** `src/assets/yaml-loader.ts` validates syntax/array shape but not that `modifiers` carries all four stat keys — which is precisely the gap that let B1 ship undetected. Optional hardening: assert required keys (or default-fill) when loading stat-modifier defs.
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

1. [ ] **B1** — fix the four `backgrounds.yml` entries (+ optional B7 loader guard). Silent stat corruption; data-only, highest impact-per-effort.
2. [ ] **F1 + todo-roll-footer** — one line in `OutcomeRenderer.ts`; the player-visible footer bug. Add the C3 stats test alongside.
3. [ ] **B2** — stamp `last_threat_date` on spawn, not on announcement success. Kills the duplicate-threat-NPC path.
4. [ ] **F2 / F5** — `/stats` stamina max + rolls label (+ the C3 assertion).
5. [ ] **F3 / F4** — `classEmoji` in headers; export + reuse `DAYJOB_EMOJI`. Pure thematic win, low risk.
6. [ ] **B3** — add `max_stamina` to the character INSERT.
7. [ ] **P1 + P2 (+ E3 decision)** — author `decision-v8.md`, bump `PROMPT_VERSION`, re-sync `current_source.md`. Settle the `done`-flag contract in the same pass.
8. [ ] **P3 / B8 / B9** — Warden casing; mock fixtures (`MockWorldEngine` 10/10/3, `MockLlmGateway` fields).
9. [ ] **E1 (L3)** — `countSoulsInUnsafe` robustness.
10. [ ] **B4 / B5 / B6 / B11** — version sync, `expectTimestamp` inline, async `journal`, env-var docs. Cheap housekeeping.
11. [ ] **C1 / C2** — wizard-completion and `nav:action` handler tests.
12. [ ] **B10** — confirmation prompts on destructive scripts (do before next prod script run).
13. [?] **E2 / E4** — design calls (multi-day tick backfill; reject empty no-op decisions). Resolve before coding.

> Sweep basis: four parallel readers over `src/discord`, `src/engine` + `src/index.ts`, `src/llm` + `assets/prompts`, plus a re-verification pass on the open tails of the two prior reviews and `TODO.md`. Every `file:line` here was opened and confirmed, not taken from the reader summaries.
