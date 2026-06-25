---
title: Prod Data Review — Player Feedback & LLM Telemetry (v0.2.3)
status: shipped
domain: archived
phase: poc
tags: [bugs, feedback, llm, telemetry, prod, auto-resolve, rolls, latency, review]
superseded_by: "implemented in code"
related:
  - "[[polish-pass-v0.2.4]]"
  - "[[bug-analysis-v0.2.2]]"
  - "[[goodnight-and-rest-features]]"
  - "[[yaml-asset-schemas-and-tests]]"
  - "[[roll-economy-timeouts-and-world-growth]]"
---

What the **live POC data actually says** — not a code sweep. Pulled the production SQLite DB off the container (`root@192.168.0.242:/home/bot/app/data/warden.db`, read-only `scp`, nothing on prod touched) and mined `feedback`, `bug_reports`, `actions`, and the `llm_calls` audit log. This is the player-voice + telemetry companion to [[polish-pass-v0.2.4]] (which found the same issues by *reading code*); where they overlap I say so, and in one case (**auto-resolve**) the data **upgrades the severity** of a finding the code sweep called "rare."

Scope per request: **what is still broken or a core-loop gap for the POC.** Net-new feature requests are catalogued but out of scope. MVP work is out of scope.

> **Division of labour — this doc and [[polish-pass-v0.2.4]] are executed by separate agents, on disjoint files.** This doc owns the **decision/resolution/roll-economy/prompt-behaviour** domain: C1 (auto-resolve), C2 (timeout), the C1/C2 roll *leak*, G2 (rest-risk copy), G3 (location growth), Q1–Q2, **and the `decision-v8.md` prompt bump** — into which the cosmetic prompt fixes from polish-pass (its former §P1/§P2/§E3) have been folded (see §C1). Polish-pass owns the cosmetic/data/ops fixes and the **footer denominator** (§F1, the *wrong-`/2`* half of G1). The only shared file is `WorldEngineImpl.ts`, touched in **different functions** (here: `startAction`/`isStateStale`; there: `countSoulsInUnsafe`).

---

## Dataset

> Snapshot pulled **2026-06-21 14:53 UTC**. The DB is live; numbers are a point-in-time read.

- **8 characters**, **67 actions**, **216 LLM calls**, **7 feedback**, **6 bug reports**.
- Span: actions **2026-06-16 → 2026-06-21** (6 game days; `day_number = 6`). Current build **v0.2.3 / prompt v7**.
- Build history in the data: `0.2.0`(v6) → `0.2.1`(v6) → `0.2.2`(v7) → `0.2.3`(v7). 32 of 67 actions ran on the current build.
- LLM health is **clean at the transport layer**: 216/216 calls `parse_ok=1`, `http=200`, `finish_reason=stop`, `tier=0`, model `deepseek-v4-flash`, `llm_fallback_count=0`. **Every problem below is behavioural, not an API failure.**

---

## Headline

- [!] **The single biggest live problem is the auto-resolve (`done`) path** — actions that resolve with **no dice roll** while still **spending one of the player's 3 daily rolls**. It is **growing**: `done` outcomes per build were **1 → 1 → 2 → 9**. On v0.2.3, **9 of 32 actions (28%) auto-resolved with `player_rolled = null`.** This maps one-to-one onto the most-repeated complaints ("auto-resolved… very boring and anti-climactic", "showed Done without rolling, consuming the roll while doing nothing"). [[polish-pass-v0.2.4]] §E4 flagged this from code as "bounded and rare" — **the prod data says it is neither.**
- [!] **A timeout cluster** (slow LLM → `timed_out` → travel silently dropped, roll consumed, grey half-rendered message) is real and reproducible: all 3 `timed_out`/`bailed` actions are on v0.2.3, and one matches a bug report **to the minute**.
- [p] No crashers, no parse failures, no fallbacks fired. The engine is stable; the **decision/resolution UX** is where the POC is bleeding.

---

## 🔴 Critical — POC-blocking, still live on v0.2.3

### C1 · Auto-resolve eats a roll and gives no agency (the "Done" problem)

- [!] **What players said (verbatim):**
  - *Warden's Apprentice (06-18):* "my most recent action sucked. I gave it a big prompt but it just auto resolved and took me to a place I already am :("
  - *Warden's Apprentice (06-21):* "I just had three actions all auto resolve, one after the other... Very boring and anti climactic"
  - *Flikker (bug, 06-18):* "Inspiration that was given seems to be ignored on my third attempt… it just showed Done without any rolling and consuming the roll while doing nothing."
  - *UlrichTheShort (bug, 06-19):* "long custom action auto resolved and gave me nothing"
- [!] **What the data shows:** `done` outcome distribution by build — `0.2.0:1`, `0.2.1:1`, `0.2.2:2`, **`0.2.3:9`**. On v0.2.3 the outcome split is `success 14 / done 9 / failure 6 / timed_out 2 / bailed 1`. Every `done` row has `player_rolled = null` (e.g. action #61 "prepare a campfire and stew", #64 "pursue the messenger at the east gate", #41 "wander to the temple plot"). Several even carry a real `final_dc` (10, 14) that was **never rolled against**.
- [!] **What the code does:** `src/engine/action/machine.ts:79-111` — when the LLM returns no real options (`dcModifier !== null` filter empty), not `required`, not divine, the action resolves immediately as `outcome:'done'`, `playerRolled:null`. The roll is **still debited** in `src/engine/WorldEngineImpl.ts:565` (`rolls_remaining = max(0, n-1)`). So a player spends 1 of 3 scarce daily rolls and gets a no-dice, no-choice result — sometimes "The moment passes." (`machine.ts:99-111`).
- [c] This is *by design* for travel/rest. The failure is that **the LLM is increasingly classifying substantive, effortful player input as a no-option auto-resolve** — exactly the inputs players wrote a paragraph for.
- [x] **Already partially addressed (don't re-litigate):** the *rendering* of auto-finished actions was fixed in v0.2.3 ("Stale stats on auto-finished actions", "Missing Feedback/Bug buttons on auto-finished actions") and v0.2.2 made `done` *inferred* from absent options rather than trusting the flag. **The dissatisfaction is not fixed** — complaints #5/#6 post-date those fixes.
- [I] **POC fix direction (design call, not a silent patch):**
  - [?] Should an action that the LLM wants to auto-resolve **with no rollable choice cost a roll at all?** Refunding the roll (or not debiting until a real roll occurs) would remove the "wasted turn" sting immediately. **Absorbs [[polish-pass-v0.2.4]] §E4** (which the code sweep called "bounded and rare" — the data says otherwise).
  - [I] Tighten the v7→v8 prompt so a paragraph of player intent must yield **at least one rollable decision** unless it is genuinely pure travel/rest; reject empty-decision/no-mutation responses at the gateway (`DeepseekLlmGateway.ts:264` currently only *warns*) and retry instead of surfacing a dead turn.
  - [!] **This doc owns the `decision-v8.md` bump.** Per `AGENTS.md`, never edit a published prompt in place: add `decision-v8.md`, bump `PROMPT_VERSION` to `'v8'` in `src/llm/prompt-builder.ts`, and copy it over `current_source.md` byte-identical. Into that single v8, fold the cosmetic prompt fixes **relocated from [[polish-pass-v0.2.4]]** so there aren't two competing v8 files:
    - [>] **(was polish §P1)** typo `decision-v7.md:103` "expendale" → "expendable".
    - [>] **(was polish §P2)** `decision-v7.md:102` "Check the INVENTORY in the input context" → point at the `SCALING HINT` block where inventory actually lives.
    - [>] **(was polish §E3)** settle the `done`-flag contract: the v7 prompt dropped `done` but the engine still consumes it (`machine.ts:204,301`, `DeepseekLlmGateway.ts:227,294`). Either re-document `done` in v8 or strip the engine's reliance — decide it here, in the same edit, since it's the same auto-resolve path.

### C2 · Timeout drops travel, keeps the roll, and renders as a confusing ghost message

- [!] **What players said:**
  - *Warden's Apprentice (feedback 06-20):* "My latest action seemed to auto resolve but the response was weird... No heading or auto resolved label. Literally just text..? No indication of travel."
  - *Warden's Apprentice (bug 06-20 13:06):* "…it gave the timeout error yet it looked 'done'. I tried traveling but it seems like no travel happened. The message was posted with a grey label."
- [!] **What the data shows:** action **#57 `timed_out` at 2026-06-20 13:03** — input *"I flee the broken keep and run back to camp to rest."* The bug report lands **3 minutes later**. All `timed_out`/`bailed` actions (#37, #40, #57) are on v0.2.3.
- [!] **What the code does:** `WorldEngineImpl.ts:173-205` (`isStateStale`) — on a 30-min stale action it writes `outcome:'timed_out'`, `playerRolled:null`, **clears the state, and applies no mutations** (so the intended `set_location` travel is silently lost). The roll spent at `startAction` is **not refunded**. The renderer paints `timed_out` grey (`action.ts:617`) with a sparse body — exactly the "ghost message, no travel" the player saw.
- [c] Compounded by latency (see Q1): slow multi-step beats invite the player to walk away mid-action, which is what trips the 30-min stale timer.
- [I] **POC fix direction:** on `timed_out`, **refund the roll** (the player got nothing) and render an explicit, in-voice "the moment slipped away — nothing happened, your travel did not occur" message instead of a bare grey card. Decide whether a committed travel should be re-applied or cleanly cancelled — today it's neither (cancelled but invisibly).

---

## 🟠 Core-loop gaps — in scope, hurt the loop

### G1 · The roll economy feels leaky to players

- [!] **What players said:** *Warden's Apprentice (bug 06-19):* "Only getting two rolls.." · *Flikker (bug 06-19):* "Roll got consumed for some reason when the server was experiencing difficulties."
- [I] **What the data shows:** the three most active characters (Flikker, Apprentice, Ulrich) all sit at `rolls_remaining = 0`; the inactive five sit at `3`. The allowance **is** 3 today (`DAILY_ROLL_ALLOWANCE = 3`, raised from 2 in v0.2.2).
- [!] **Why players still perceive a deficit:** rolls leak into outcomes that feel free — **auto-resolve (C1)** and **timeout (C2)** both debit a roll for a non-roll. Plus the **outcome footer prints `🎲 N/2`** against the new max of 3/4 ([[polish-pass-v0.2.4]] §F1, `OutcomeRenderer.ts:205`), so a player literally sees `3/2` then `2/2` — reading as "I'm losing rolls I didn't use."
- [x] **Partially addressed:** allowance raised 2→3 (v0.2.2). **The footer fix is owned by [[polish-pass-v0.2.4]] §F1 — not actioned here** (one-line `OutcomeRenderer.ts` change, off the resolution path). This doc owns the *leak* (the roll debited by C1/C2 for a non-roll); polish owns the *wrong denominator*. **Still live:** both, until each doc's owner lands its fix.

### G2 · Rest / unsafe-HP rules are invisible to the player

- [!] **What players said:** *Warden's Apprentice (06-21):* "Why do i loose HP for clicking rest from an unsafe location. And it says the night was rough... I thought it is just stamina for traveling back to camp?"
- [I] **What the code does:** resting in an unsafe, non-workplace location applies **−1 HP** with "The night was rough" flavour (`src/discord/commands/sleep.ts:98-108`), introduced v0.2.2. It is working *as designed* — but the player models rest as a stamina thing and is surprised to take HP damage.
- [c] This is a **clarity gap, not a bug.** For a POC it still costs trust: a player punished by a rule they can't see reads it as the bot misbehaving.
- [I] **POC fix direction:** surface the risk **before** the rest resolves (e.g. the Rest button / confirm copy at an unsafe location warns "resting rough ground costs 1 HP — return to safety first"), and make the post-rest line state the cause plainly. No mechanic change. Relates to [[goodnight-and-rest-features]].

### G3 · The world can't grow new locations from play — players get stranded "unknown"

- [!] **What players said:** *UlrichTheShort (feedback 06-19):* "i think a new location should be added for the newly constructed temple…" · *UlrichTheShort (bug 06-20):* "my location hasnt been added as a known location."
- [I] **What the data shows:** auto-resolve action #41 set the player toward a temple plot via `set_location:"Town Square"`, but the temple/new-town the narrative keeps referencing is **not a row in `locations`**. There are 11 seeded locations; the LLM narrates places beyond them.
- [!] **Why it's a core-loop gap, not just a content request:** v0.2.3 added **day-work gating that refuses to start from an unknown/procedural location**. So a player who followed the story "off the map" can no longer take day-job actions there and sees their spot as "unknown" — the world actively *fights* exploration it invited.
- [I] **POC fix direction:** either (a) let a confirmed `set_location` to an unseeded name **lazily create a minimal location row** (so the world grows as players push outward), or (b) constrain the prompt to only move players between known locations. (a) is more on-theme; (b) is the safer POC clamp. **Needs a design call.**
  - [-] The literal request ("hand-add a temple location") is net-new content → out of POC scope; the *systemic* fix above is what matters.

---

## 🟡 LLM telemetry — quality patterns worth fixing for the POC

### Q1 · Latency is high and is the upstream cause of the timeouts

- [I] Successful calls average **~13 s**, **max 41 s**. Distribution of all 216 calls: `0-5s:5 · 5-10s:72 · 10-20s:114 · 20-30s:17 · 30s+:8` — **~12% take ≥20 s.** Reasoning is heavy (avg 3,205 reasoning chars, max 13,826).
- [c] v0.2.3 averages **~2.8 LLM calls per action** (91 calls / 32 actions), so a 3-decision beat can stack to **30–40 s+** of "Thinking…" — long enough that players abandon mid-action and trip the 30-min stale timeout (C2).
- [I] **POC fix direction:** cap reasoning / set a per-call latency budget with a faster narration model on the secondary call, and/or reduce calls-per-action. Quality-of-life, but it directly feeds C2.

### Q2 · `base_dc = 0` and empty-decision warnings — mostly tamed, small residue

- [I] Validation warnings by build: `0.2.1:3 · 0.2.2:10 · 0.2.3:2` (against 91 calls on v0.2.3). The "empty decision array but done=false" noise that peaked on v0.2.2 is largely gone — v0.2.3 "reworded a validation warning that false-positived on every legitimate resolve" and made `step()` infer resolution.
- [c] **Residue still on v0.2.3:** `base_dc 0 is outside expected range 10-18` recurs (e.g. call #172, 06-20) and #184 produced *"decision array is empty with no mutations or outcome_text — nothing to resolve and no options"* (the casino "dump my net worth" input) — i.e. the gateway still occasionally emits a literally empty turn that becomes a wasted roll (feeds C1).
- [x] Don't re-litigate the warning *logging* — that's fixed. The **behaviour** behind a `base_dc 0` / empty turn is the C1 tail.

---

## 📉 Engagement signal (context, not a bug)

- [I] Distinct players acting per day: **4 → 5 → 5 → 4 → 3 → 3.** Of 8 characters, **5 have not acted in ≥2 days** (last activity: Otto never, Froggy & SirAlex 06-18, Oom & UlrichTheTall 06-19). The 3 who stuck around are the 3 who hit the wall at `rolls_remaining = 0`.
- [c] Small-n POC caveat — 8 players, six days. **But** the drop-off correlates with the frustration surface above (auto-resolve, lost rolls, ghost timeouts land on the *engaged* players). Worth watching; not a standalone finding.

---

## ✅ Wins (keep)

- [p] *Warden's Apprentice (06-18):* "This worked well! the new actions read much easier" — validates the v0.2.2 gamebook-layout / blockquote rework. Whatever else changes, **don't regress the readability of the action recap.**
- [p] Transport-layer LLM reliability is excellent (0 parse failures, 0 fallbacks, 0 non-200s across 216 calls). The integration is solid; the work is in decision *shaping*, not plumbing.

---

## Out of scope (catalogued, not for this POC pass)

- [-] **Feedback #3 (Flikker, 06-18):** "link the character to their discord user on the resolution message… not sure who is who." Partially addressed already (v0.2.2 added the class emoji + character name on public outcomes). A real Discord **@mention** link is a net-new feature → MVP.
- [-] **Feedback #4 (Ulrich):** literally hand-adding a temple location — net-new content. The *systemic* version is **G3** (in scope).

---

## Method & reproducibility

- [I] Backup pulled read-only: `scp root@192.168.0.242:/home/bot/app/data/warden.db{,-wal,-shm}` → `db-backups/` (gitignored; **never commit** — contains player data). Nothing was written to the container; no source code was modified.
- [I] Analysis scripts live in `db-backups/` (`probe.mjs`, `extract.mjs`, `correlate.mjs`), opened against the copy with `better-sqlite3` in `readonly` mode. Re-runnable against any future snapshot.
- [I] `feedback` / `bug_reports` carry no `status` or `version` column, so "already addressed" was determined by correlating `created_at` against the `CHANGELOG.md` release dates and the `app_version` stamped on `actions`/`llm_calls`.

### Appendix — full verbatim feedback (7) & bug reports (6)

> Names retained per request. All timestamps UTC.

**Feedback**
- [I] `#1 06-18 07:57 Warden's Apprentice` — "This worked well! the new actions read much easier"
- [!] `#2 06-18 10:25 Warden's Apprentice` — "my most recent action sucked. I gave it a big prompt but it just auto resolved and took me to a place I already am :(" → **C1**
- [-] `#3 06-18 20:11 Flikker` — link character ↔ discord user on resolution messages → **out of scope**
- [-] `#4 06-19 11:39 UlrichTheShort` — add a location for the new temple → **G3 (systemic)**
- [!] `#5 06-20 12:16 Warden's Apprentice` — "auto resolve but the response was weird… No indication of travel" → **C2**
- [!] `#6 06-21 09:40 Warden's Apprentice` — "three actions all auto resolve… Very boring and anti climactic" → **C1**
- [!] `#7 06-21 11:07 Warden's Apprentice` — confused about losing HP resting at an unsafe location → **G2**

**Bug reports**
- [!] `#1 06-18 14:59 Flikker` — inspiration ignored, "showed Done without rolling, consuming the roll while doing nothing" → **C1**
- [!] `#2 06-19 10:19 Flikker` — "Roll got consumed… when the server was experiencing difficulties" → **C2 / G1**
- [!] `#3 06-19 10:28 Warden's Apprentice` — "Only getting two rolls.." → **G1**
- [!] `#4 06-19 11:33 UlrichTheShort` — "long custom action auto resolved and gave me nothing" → **C1**
- [!] `#5 06-20 10:22 UlrichTheShort` — "my location hasnt been added as a known location" → **G3**
- [!] `#6 06-20 13:06 Warden's Apprentice` — ghost message, timeout, "no travel happened", grey label → **C2**

---

## Priority for the POC (my recommendation)

- [!] **1. C1 — stop auto-resolve from silently eating a roll for no agency.** Highest complaint volume, worsening trend, hits the most-engaged players. Quickest credibility win.
- [!] **2. C2 — refund + clearly render timeouts; don't drop travel invisibly.** Reproducible, trust-destroying.
- [!] **3. G1 footer `🎲 N/2` → `N`** ([[polish-pass-v0.2.4]] §F1) — trivial fix, removes a daily "I'm losing rolls" misread.
- [I] **4. G2 rest-risk warning copy** and **G3 unknown-location handling** — core-loop coherence; both need a one-line design call first (`[?]` items above).
- [I] **5. Q1 latency budget** — quality lever that also de-risks C2.
