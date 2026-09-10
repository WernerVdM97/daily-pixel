---
title: Player Action Patterns — observed /action behaviour
status: exploring
domain: game
phase: mvp
tags: [telemetry, prod-data, engagement, roll-economy, player-behaviour, action-pipeline]
related:
  - "[[mvp-core-loop]]"
  - "[[action-engine-framework]]"
  - "[[combat-system-v12]]"
  - "[[poc-plus-roadmap]]"
  - "[[prod-data-review-v0.2.3]]"
---

What players actually do in `/action`, mined from the prod snapshots rather than from intent: session rhythm, the shape of one action, the intent vocabulary the classifier sees, the recurring daily loops, and how the roll economy is really spent. A companion to [[prod-data-review-v0.2.3]] (that one asked "what's broken", this one asks "what do people do"). It exists to keep future balance and pacing work grounded in observed behaviour instead of assumptions.

## Dataset & caveats

Snapshot `warden-20260802-212213` (2026-07-07 → 08-02, day 27): 123 actions, 1016 LLM calls, 5 characters / 5 users. Read with the [`db-backups/`](../../db-backups/README.md) tooling, nothing on prod touched.

Caveats before any number is trusted:

- **Small N, two dominant voices.** BendiusOver (45 actions) and WernerVanDerMervwe (59) together are 104 of 123. Ser Redquad (13), Sir Gary (3) and Schlong (3) are minor. Archetypes below are really "how two people play" plus glimpses.
- **Mostly v12-era data.** v13 has exactly 2 actions (both 08-02). The DC ladder, failure costs and inspiration rate all changed under v13, so the *balance* observations are historical; the *behaviour* observations (what players type, when they play, how sessions run) carry over.
- **`type` is LLM-authored, not a curated menu.** The 123 actions carry 58 distinct type strings. Treat them as a vocabulary of player *intent* as the model classifies it, not as a designed taxonomy — "search" and "investigate" are the same habit with different spellings.

## When players play

Session hours (all actions, local time of the action row):

| Hour block | Actions | Share |
| --- | --- | --- |
| 05-07 | 14 | 11% |
| 08-12 (morning peak) | 69 | 56% |
| 13-15 | 9 | 7% |
| 16-20 (evening secondary) | 31 | 25% |

The game is played in **morning bursts**: over half of all actions happen 08:00-12:00, with a secondary evening bump. Early-morning (05-06) play appears too, which matches an async "check in before the day starts" habit rather than scheduled sessions.

Play is **bursty, not daily**: 19 active days out of 27, with gaps of 2-7 days between sessions (e.g. nobody played 07-17, 07-21/22, 07-24 → 07-27). When a player sits down they commit: typical sessions are 3-11 actions in one sitting (BendiusOver 07-08: 10 actions across ~2.5h; WernerVanDerMervwe 07-09: 11 actions). Active players average ~4-5 actions per played day.

## What one /action looks like

The modal action is a **three-beat decision chain**: classify → 3 × (decide + coherence critic) → 2 × resolve, for 8-9 LLM calls (52 of 123 actions have exactly 9, 39 have exactly 8). A 4-beat action runs ~10 calls; the extreme is the 08-02 wolf fight at 14 calls (13 combat rounds). At ~7.5k tokens per call, a typical action costs **~60-70k tokens** and ~25-30s of pure LLM latency; the player's wall-clock is minutes because beats interleave with reading and thinking.

Two structural facts dominate the feel of the game:

- **63% of actions consume a roll** (78/123), 37% auto-resolve without one (travel/rest and friends, `player_rolled IS NULL`). The roll is the scarce resource, so the no-roll third is where the game breathes.
- **DCs cluster 8-14** (modal 10-12, mean 11, observed range 5-17). Nothing ever reached the old daunting band — that was the measured 0/21 finding that drove the v13 re-anchor (hard 16-18, daunting 20-24). Expect the distribution to stretch upward once v13 has real play.

## What players ask for (the intent vocabulary)

Grouped families by action count (58 distinct strings collapsed):

| Family | Count | Types observed |
| --- | --- | --- |
| Search / investigate | ~23 | search, investigate, investigation, inquiry, study, translate, interpret |
| Movement | ~25 | travel, explore, scout, descend, vantage, approach, escape |
| Faith verbs (priest) | ~19 | pray, prayer, devotion, ritual, consecrate, bless, spiritual warfare, heal |
| Combat | ~12 | combat, fight, duel, hunt, purge |
| Rest / recover | ~9 | rest, recover, feast, eat, drink |
| Gather / craft | ~14 | fish, forage, gather, butcher, cook, craft, forge, trap |
| Day-job labor / work | 4 | labor, work |
| Social / misc | ~13 | gamble, trade, negotiate, teach, aid, help, steal, delivery, scribe, dictation, inspire, observe |

Readings: **search is the default verb** — when a player wants "something" without a specific idea, they search. Faith verbs track class (both priests use them heavily, nobody else does). Movement and combat are always present but combat is the *rare, big* ask, not the daily one. Work/labor appears far less than the day-job menu would suggest — the day-job flow mostly bypasses `actions` (commute + guaranteed income), which is consistent with players treating it as the reliable floor rather than content.

## The daily loops (session archetypes)

Five recurring shapes, each with a canonical observed day:

- **The resource loop** (BendiusOver 07-28): `rest → fish → fish → travel → cook → eat → rest → vantage`. Gather, process, consume, recover. Comfort play: top up stamina, make a feast, go to bed safe. This is the healthy default loop the game's economy is built around.
- **The temple grind** (WernerVanDerMervwe 07-09): `heal → bless → ritual → forge ×2 → ritual → consecrate ×4 → devotion`. One verb family, eleven actions, class-flavoured throughout. Players commit to *a project* (the temple) and hammer one verb until it stops paying.
- **The quest chase** (WernerVanDerMervwe 07-18, 07-30, 07-31): `search ×3 → hunt` and `help → retrieve → search` and `search ×2 → recover`. Follow-the-thread play: keep pulling the same thread (the archive) until it resolves. Repetition here is *engagement*, not grind — the player chose it.
- **The combat day** (BendiusOver 07-11): `rest → scout → combat (bail) → combat (loss) → escape → heal → cook → inquiry`. Combat as punctuation: one bad fight ends the adventuring and the rest of the day is recovery. Of 9 recorded fights: 6 wins, 1 loss, 2 bails — and both bails came when the fight was going badly (07-11 after the first rounds, 08-02 at 1/10 HP). Players bail rather than lose.
- **The tourist day** (Sir Gary 07-29, a newcomer): `search → travel → explore`. New players do discovery: find a thing (bank), go see it, poke around. No resource management until the first bad thing happens.

Cross-cutting: **players retry after timeouts** (the 07-28 fish timed out and was immediately re-attempted successfully), **players rest before and after risky work**, and **players gamble with real stakes** (07-29: all gold on rock-paper-scissors, lost; 100 gold on wisdom, won) — the economy is already being used as fun-money, not hoarded.

## The roll economy as observed

Rolls spent per day: 1-3 for the recent, post-inspiration-fix era (07-19 onward: 2,1,3,3,5,2,3,1; mean 2.5) versus 6-13 in the first week when inspiration leaked at 29% of actions. The RA-2 dial (target ~3.3 per active day) is in the right ballpark; the observed 2.5 sits just under, mostly because players auto-resolve a third of actions.

Failures are rare (13/123 ≈ 11%) and they **cluster in specific verbs**: labor (2/3), consecrate (1/4), devotion (1/1), approach (1/1), inquiry (1/1), loot (1/1), gamble (1/2). Players who found a failing verb mostly stopped using it — repeated consecrate failure did not stop the 4-peat, but nobody touched labor again after two failures. Under v12 a failure cost stamina, which reads as "success minus reward"; v13's non-stamina failure cost is still untested by humans.

## Who is playing

- BendiusOver (Warrior) — the frontier tester: combat, survival loops, ends days at The Forest Edge. Currently 1/10 HP after the 08-02 wolf fight. Files feedback when things break (14 of 14 feedback rows).
- WernerVanDerMervwe (Priest) — the temple-builder: faith verbs, forge/craft, then the archive quest. Healthiest player state (full HP, at the Oak). Plays mornings, last seen 07-31.
- Ser Redquad (Priest) — a liturgical week (dictation, delivery, spiritual warfare), then gone after 07-13.
- Sir Gary (Bard) — newcomer tourist, one session 07-29.
- Schlong (Ranger) — scout loop, gone after 07-14.

**Two of five churned inside the first week.** The surviving active set is two players, one of whom is currently at 1/10 HP having just filed "This sucked". Retention, not onboarding, is the live risk.

## What this means for the design

- **Search is the comfort verb and combat is the emotional extreme.** The search spine (DC 8-14, cheap, mostly successful) is what players default to; combat produces the only bails, the only loss-and-escape day, the 20-minute slog, and the only "This sucked". Pacing work should treat combat as the *event*, not the loop, and the open combat-length item (TODO: combat round cap / break-off) is the highest-leverage pacing lever.
- **Three beats is the sweet spot; thirteen is not.** The modal action is 3 beats ≈ 9 calls ≈ 60-70k tokens. Every extra beat adds latency + a decision the player must make; the 08-02 fight's 13 rounds cost ~95k tokens and ended in a bail. The lifted decision cap in v12 combat was designed for long fights — the data says players do not enjoy long fights.
- **Verb-family play means class identity works.** Both priests committed to faith verbs; nobody else used them. The vocabulary the classifier sees is effectively "search/travel/combat/rest + class flavour" — future content that feeds a player's chosen family (project play, quest threads) is the engagement engine.
- **Auto-resolve is load-bearing.** 37% of actions resolve without a roll, and the no-roll paths (travel, rest) are what make multi-action sessions possible in one sitting. Any change that rolls more of these shortens sessions.
- **The failure menu matters more than the failure rate.** 11% failures, but the *shape* of a failure (what it costs) changed under v13 and is unobserved. The two bails suggest players would rather walk away than lose — a "costly but meaningful" failure band needs watching once v13 has human play.
- **Retention is the metric to watch.** The active set shrank from 5 to 3 within the first two weeks, and the most active tester ended at 1/10 HP with the worst session on record. The next BendiusOver session is the single most informative future datapoint.

Refresh path: re-run `node db-backups/extract.mjs` and the queries in `db-backups/README.md` against a newer snapshot, and update the numbers here (this doc is a snapshot, not a dashboard).
