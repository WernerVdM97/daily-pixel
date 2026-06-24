---
title: Decision Prompt v9 — Multi-Stage Pipeline, Markdown, Scaling & Combat
status: spark
domain: spark
phase: poc
tags:
  - llm
  - prompt
  - pipeline
  - combat
  - puzzles
  - conversations
  - rolls
  - scaling
  - graph
  - immersion
  - engine
related:
  - "[[mvp-combat]]"
  - "[[mvp-llm-prompt-architecture]]"
  - "[[mvp-core-loop]]"
  - "[[mvp-data-model]]"
  - "[[mvp-social-model]]"
  - "[[mvp+world-state-projection]]"
  - "[[roll-economy-timeouts-and-world-growth]]"
  - "[[per-option-stat-and-ability-checks]]"
  - "[[prod-data-review-v0.2.3]]"
---

# Decision Prompt v9 — Multi-Stage Pipeline, Markdown, Scaling & Combat

> *A radical rework of the decision-prompt asset (`decision-v8.md` → `decision-v9.md`) plus
> the roll math and the LLM call structure behind it. Four threads (best **staged**, not
> shipped at once): (A) make the input the LLM digests pure markdown, (B) let the world scale
> around each player — stronger players meet tougher foes for bigger rewards — and climb week
> by week, (C) turn combat into a long, frequent, high-reward mode in the wilds, and (D)
> decompose the single mega-call into a multi-stage LLM pipeline (classify → decide →
> resolve). Raw — capture, don't build.*

**The point of all four threads (the thesis):** deepen *immersion* by **balancing
probabilistic and deterministic mechanics** — let the dice rule what should be uncertain
(does the blow land, what does the search turn up) while the engine deterministically owns
what players would feel cheated by if it drifted (an enemy's wounds, a puzzle's answer, an
NPC's standing toward you). The tools for striking that balance are **pipelining** (a chain
of focused LLM sessions) and **template prompting** (a small, type-specific prompt per
interaction). Everything below serves that one goal.

The prompt is at `v8` (`src/llm/prompt-builder.ts:9`). It works, but four things are holding
the experience back: the input is a JSON-fragment dump the model has to parse; the world
never gets harder or the players stronger over a year; combat is just a reskinned skill check
that resolves in "two or three beats" — the opposite of what a survival game about a rising
Threat wants; and one mega-call does the DM's, the dice's, and the bookkeeper's job in a
single breath, carrying the entire rulebook on every action. This spark collects the
direction for all four — and (D) is the backbone the others slot into.

---

## Thread A — Markdown input (interpretability)

Today `buildUserMessage` (`src/llm/prompt-builder.ts`) emits a line-per-field block with
**embedded JSON**: `CHARACTER: class=Ranger, stats={"physical":3,"wisdom":2,...}, health=…`.
The model spends attention parsing key=value + stringified objects instead of reading a
scene. The response is and stays JSON (the JSON CONTRACT is unchanged) — this is about the
*input* only.

- [I] Render the whole input context as clean markdown — headings, short tables, bullet
  lists — so tokens read like a briefing, not a serialized struct. e.g.

  ```
  ## Character
  - **Class:** Ranger · **Alignment:** Neutral Good · **Day job:** Fletcher
  - **Health:** 7/10 · **Stamina:** 4/6

  | Stat | Score | Item bonus |
  |------|-------|-----------|
  | Physical | 3 | +2 (bow) |
  | Wisdom | 2 | — |

  ## Scene
  **Location:** The Dark Pines _(unsafe)_
  **Nearby:** Crow, the Toll-Taker — *a lean rider who owns the road now*
  ```
- [p] Pre-existing provenance: [[mvp-llm-prompt-architecture]] already lists "send the
  prompt as markdown, not JSON (friendlier to the model); responses stay JSON." This thread
  is that idea, made concrete and pulled forward.
- [p] Reuses every existing `LlmContext` field — pure presentation change in
  `buildUserMessage`; the gateway, schema, and resolution path are untouched.
- [c] Markdown is more verbose than `key=value` — a few more input tokens per call. Worth
  measuring against the coherence gain (`llm_calls` already records tokens/latency).
- [?] Does the per-option `stat`/`dc_modifier` contract and `KNOWN LOCATIONS` block read
  better as a table or as a list? Decide by eye-balling real captured prompts.
- [?] Measurable quality lift, or just nicer to read? A/B two prompt versions over the sim
  harness (also from [[mvp-llm-prompt-architecture]]) before committing.
- [!] Whatever the shape, the **SECURITY RULE** (ignore player attempts to set DC / grant
  items / change rules) must survive the rewrite intact — markdown is easier to
  prompt-inject into, so the player-input block must stay clearly fenced and labelled.

## Thread B — The world scales around the player (danger and reward)

The roll math stays **exactly as it is**: `d20 + stat + itemBonus ≥ DC` (`resolveRoll`,
`src/engine/action/dc.ts:72`). **No player-side buff — no roll bonus, no advantage.** A
player's power *is* their stats + gear (`effectiveStats`, `dc.ts:45`); we never inflate the
dice. What changes is the **world**: it scales to whoever is facing it.

Two inputs decide how hard an encounter is:

1. The player's **effective strength** (`effectiveStats` / might).
2. A **World Tier** `T` that climbs over the year (the weekly cadence already exists —
   `weeklyThreatIndex`, `src/discord/afternoon.ts:82`; game time is `day_number` meta).

- [I] **Stronger player → stronger foes.** A well-geared week-20 ranger meets tougher beasts,
  higher DCs, and deadlier brigands than a fresh week-2 recruit standing in the *same*
  clearing. The encounter is sized to the soul facing it — *steepest in unsafe locations*
  (`is_safe = 0`, including the lazy-created off-map wilds from
  [[roll-economy-timeouts-and-world-growth]]).
- [I] **Daunting challenge → bigger reward.** Reward scales with the encounter's difficulty,
  so beating a tougher foe pays proportionally more (rarer loot, more `modify_wealth`,
  `modify_max_stamina`, narrative unlocks). The world keeps pace, *and so does the payout* —
  growth still feels good.
- [I] **World Tier raises the floor for everyone.** As weeks pass, even baseline encounters
  drift up — the east darkens regardless of who walks it. Player-scaling sits *on top of*
  that rising floor.
- [p] Engine math barely moves: `resolveRoll` / the d20 / `dc.ts` are **untouched**. The
  change is in how the target DC band and foe strength are *chosen* — computed from (player
  strength, tier) and handed to the LLM, which then authors a scene/foe to match. Reuse the
  `scalingHint` plumbing (`machine.ts:356`) plus the new **`## World State`** block.

The tension to resolve (honest pushback):

- [!] **Don't build a treadmill.** If the world tracks the player *exactly*, getting stronger
  is pointless — win-rate is flat forever and every stat/gear investment is silently eaten
  (the "level-scaling" problem that soured *Oblivion*). There must be a payoff for growing
  strong.
- [I] Resolution: the world should **lag** the player slightly, not match exactly — getting
  stronger still wins you *more* fights, just against worthier foes — and the **reward curve**
  is where investment cashes out (a strong player faces harder fights but reaps far more).
  Stakes stay high; power still feels earned.
- [?] How tight is the tracking (the lag and reward coefficients)? This is the entire
  game-feel — **must** be tuned on the sim harness, not guessed.
- [?] How does `T` advance — strictly real-calendar weeks, or gated on collective player
  progress / Threat events (`afternoon.ts`)? Calendar is simplest; event-gating couples to
  the climax model in [[mvp-progression]].
- [?] Does foe-scaling read the *individual* player's strength or the *party/fellowship's*
  (co-op encounters, [[mvp-core-loop]])? Solo is simplest for POC; party-scaling leans MVP —
  and a shared scene with a strong and a weak player needs the foe sized carefully.
- [c] More knobs = more ways to mis-tune into "impossible" or "trivial." The sim harness is a
  prerequisite, not optional.

## Thread C — Combat as a first-class mode

This is the heart of the spark. Combat today is a generic `/action` roll that the prompt
actively pushes to *end fast* ("prefer resolving in two or three beats… once the player
commits, return an empty decisions array", `decision-v8.md` §1b). For a survival game with a
rising Threat that is backwards. Combat should be **frequent in the wilds, long, and richly
rewarded** — see [[mvp-combat]] for the locked constraint (roll-resolution, never twitch).

- [!] **More frequent in unsafe locations.** v8 §3 says "roughly every 3rd or 4th decision
  raises danger" — far too tame for the wilds. New rule: in an **unsafe** location, a combat
  encounter is the *default expectation*, not the exception. Safe locations (the Oak, town)
  stay calm; danger is geographic, and that makes *where you go* a real choice.
- [!] **Combat is long and multi-decision.** A combat encounter explicitly **overrides** the
  "resolve in 2-3 beats" rule: it runs several `CONTINUE` rounds, each a real exchange
  (the boar lunges → you brace/strike/dodge → it reels or gores you → …). `required: true`
  throughout — no clean Skip, only Bail (flee, at a cost) per [[per-option-stat-and-ability-checks]]
  / the Bail terminal state.
- [I] **Physical, item-anchored decisions.** Each round offers approaches tied to the
  player's gear and stats (v8 §3 already gestures at this — "use a sword to strike as a
  reaction to a boar lunging") — make it the rule, not a suggestion. The per-option `stat`
  mix (physical/wisdom/charisma) means *how* you fight is a build choice.
- [I] **Great rewards that push the narrative.** A won fight is a milestone: rare loot,
  `modify_max_stamina`, a fleeing/witnessing `spawn_npc`, ground opened up (`set_location`
  into new off-map wilds). Reward scales with Thread B's tier so a week-20 kill matters more
  than a week-2 one. Defeat costs real health and gear — the stakes [[mvp-combat]] calls for.
### Combat resolution — contested rolls for feel, severity bands for control

The design problem of dice combat is *exciting + unpredictable* vs *controllable + easy to
scale*. Resolve it by separating the two: keep the d20 swing for **texture**, but never let a
single round **decide the fight**.

- [I] **Both sides roll, engine-side.** Each round the player rolls `d20 + stat + item` and the
  **enemy rolls too** — but the enemy d20 is an *engine* roll, so "contested" adds no LLM
  randomness and never touches the D1 determinism rule. The enemy has agency; the engine still
  owns the truth.
- [I] **Margin → severity band, not raw subtraction.** The gap between the two rolls maps to a
  small band table — `clean hit · trade · glanced · heavy` — and **each band maps to a bounded,
  tier-scaled HP delta**. The swing stays alive (crits and nat-1s happen and swing the round),
  but the *consequence* is bounded. A nat-1-vs-nat-20 lands the worst band: brutal, you're
  suddenly bloodied — a **crisis, not a corpse**.
- [!] **No one-shot floor.** A blow that would drop the player to ≤0 HP instead leaves them at
  **1 HP + a forced desperate choice** (bail bloodied, losing position/loot — or last stand,
  one more round now *genuinely* lethal). **Once per fight.** Bad luck can corner a player out
  of nowhere; it cannot kill them out of nowhere. Press on after the save and death is real.
- [p] **Scale magnitude, not variance.** The distribution *shape* (bounded bands, no one-shot,
  the floor) is a **global constant** at every tier. Thread B tunes only **two numbers per
  tier** — enemy HP and the band→damage table — so a week-20 foe hits harder and soaks more,
  but the *feel* and the safety rails are identical. You re-balance magnitude, never variance.
- [p] **Fits the roll-first pipeline exactly.** The engine rolls both dice + picks the band
  *first*; the Stage-3 resolve template then narrates *that* band against the `posture` edge
  (the boar *reels* / *gores you and you stagger*). Mechanics before flavour — the roll-first
  split, just with two dice and a severity table. (Extends [[mvp-llm-prompt-architecture]]'s
  "bot rolls severity before flavour".)
- [?] Is the survive-at-1-HP save **once-per-fight** (chosen — most forgiving, one less number
  to track) or per-day (a second hard fight is deadlier)? POC takes once-per-fight; revisit if
  fights feel weightless.

- [?] **Enemy persistence.** Are foes ephemeral encounter rolls, or persistent NPC nodes
  that flee, heal, and remember (`spawn_npc` already persists)? Persistent enemies are
  richer but lean **MVP** (need the world-state/graph model) — POC v9 can ship ephemeral
  multi-round combat first.
- [?] How does a combat sub-mode signal itself through the loop — a `distilled_type:
  combat` the prompt treats specially, or a dedicated PHASE? Reusing `distilled_type` +
  `required: true` is the lighter touch.
- [?] How long is "long" before it drags on mobile? Target 3–5 rounds; cap it so a single
  fight can't eat a player's whole session.
- [c] Multi-round `required` combat spends more LLM calls per encounter (each round is a
  call). Bounded by the round cap, but it raises cost/latency — measure.

## Thread D — Decompose the action into a multi-stage LLM pipeline

The biggest structural change, and the **backbone** the other three slot into. Today one LLM
call does everything for a beat: classify the intent, pick the stat/DC, author the options,
*and* (on `RESOLVE_ROLL`) compute mutations + narrate. The model is the DM, the dice, and the
bookkeeper in one breath — and every call carries the **entire** v8 rulebook whether the
action is a knife-fight or a nap. Split it into a chain of focused, *fresh* sessions, each
with a small, type-specific template. (Provenance: [[mvp-llm-prompt-architecture]] — "multiple
short agent calls / a chain… distil intent → offer choices → resolve → narrate.")

**The pipeline (per custom action):**

1. [I] **Stage 1 — Classify.** A cheap, fast call with tiny output that derives the action's
   metadata from the raw player input + minimal context: its **type** (`fight | travel |
   trade | talk | other`) and routing flags (`unsafe_location`, `needs_roll`,
   `target_present`). No narrative, no options — just the routing metadata.
2. [I] **Stage 2 — Decide.** The type selects a **prompt template** (combat / travel / trade /
   talk / generic), and *only the rules and context applicable to that type are injected* —
   combat rules (Thread C) for a fight, the `KNOWN LOCATIONS` block for travel, NPC agendas
   for talk, the `## World State` tier block (Thread B) where it matters. This session authors
   the **decision** (options + per-option stat/dc) **only** — it does **not** compute outcomes
   or mutations.
3. [I] **Stage 3 — Resolve.** After the dice (roll-first, unchanged), a **fresh session**
   receives a structured **handoff** — a summary of the decision(s) made + the roll verdict +
   the applicable world context — and computes the **mutations + `outcome_text`**. It never
   saw the decision session's reasoning; its only job is "given this verdict and this world,
   what changed?"

- [p] **Smaller, sharper prompts.** Each stage carries only its slice of the rulebook, not the
  v8 monolith. This serves Thread A's interpretability goal *better than one fat markdown
  prompt does* — decomposition beats length. A fight never pays for trade rules.
- [p] **Separation of concerns = fewer contradictions.** The decision session can't pre-bake
  an outcome; the mutation session can't be led astray by narrative flourish — it works from a
  structured verdict + world state (it extends the roll-first split that already shipped). Each
  stage is independently testable and versionable.
- [p] **Per-type templates tune in isolation** — fix the combat feel without touching travel;
  A/B a single stage without perturbing the rest.
- [c] **Latency & cost.** 2–3 calls on the critical path where there was ~1 — but **not the
  binding constraint** (see D5: engagement holds under ~30 s, we average well below, models are
  cheap). Still worth keeping lean: Stage 1 tiny (or heuristic — below); decompose where it pays
  (combat, ambiguous intent) and keep pure travel/rest single-call; cache the classifier.
- [c] **Handoff fidelity.** "A summary of decisions + world context" as free prose loses
  information between sessions. The handoff must be a **structured, typed payload**, not a
  paragraph the next stage re-parses.
- [!] **This breaks the one-file prompt-versioning convention.** `AGENTS.md` assumes a single
  `decision-v<N>.md` + `PROMPT_VERSION` stamped on every row. A pipeline has *several*
  templates (classify, per-type decide, resolve). The convention must extend — e.g. a
  **versioned prompt set** (`decision-prompts/v9/{classify,combat,travel,…,resolve}.md`)
  stamped together so an outcome still traces to the exact set that produced it. Settle the
  asset layout + `PROMPT_VERSION` shape *before* building.
- [?] Is Stage 1 even an LLM call, or cheap heuristics (verb/keyword match) for the obvious
  cases with an LLM fallback only for ambiguous input? Heuristic-first dodges most of the
  latency hit.
- [?] How does the pipeline map onto the existing PHASE model (`NEW_ACTION` / `CONTINUE` /
  `RESOLVE_ROLL`)? The pipeline is essentially a *refinement* of PHASE — classify+decide
  replace `NEW_ACTION`/`CONTINUE`, resolve replaces `RESOLVE_ROLL` — but the mapping needs
  spelling out.
- [?] Does the Stage 1 type *replace* the LLM-authored `distilled_type`, or seed it? (Likely
  replaces — the classifier becomes the source of truth for type.)

### D1 — Scene-state: deterministic spine, narrative skin

The pipeline's real prize is that it can carry a **per-type scene-state object across beats**,
instead of every beat reconstructing "where are we" from `RECENT ACTIONS` prose. That's what
makes combat track wounds, a puzzle keep one answer, an NPC hold a grudge. Ownership is
**hybrid** (the "C" option, decided in brainstorm):

- [p] **Engine owns the hard, cheatable truth** — enemy HP, whether a puzzle is solved, an
  NPC's disposition score. These are numbers a player would feel cheated by if they drifted.
- [p] **LLM owns the soft texture** — mood, what's been said, the *feel* of the scene.
- [!] This *is* the spark's thesis in miniature: dice decide the uncertain, the engine pins
  the deterministic, the LLM dresses it. Immersion comes from the seams not showing.

### D2 — Scene-state is graph-shaped; mutations are typed graph-deltas (no LLM SQL)

Model scene + relationship state as **nodes + edges** — the subject and object of a scene are
nodes, and the **edges between them carry the context**. This is already the MVP world-state
direction ([[mvp-data-model]], [[mvp-social-model]]'s three axes, [[mvp+world-state-projection]]).

- [I] A fight: `PC ──in_combat{enemyHp, posture, round}──▶ enemy NPC`. Group/co-op combat
  falls out for free as multiple edges — no special-casing.
- [I] A conversation: the *relationships are the state* — `trust`, `owes_debt`, `knows_secret`,
  `fears` edges between PC and NPC. This is the single strongest fit for graph.
- [I] A puzzle: a puzzle-node with a hidden `solution` prop + edges to clue-nodes and
  required-item nodes; "clues found" = which clue-edges the player has traversed.
- [p] **Bonus — context assembly = subgraph → markdown.** To build a per-type decide prompt
  (Stage 2), walk the subgraph around the two nodes and render it as the markdown briefing.
  That makes [[mvp+world-state-projection]]'s "graph → markdown at ~0 tokens" *become* the
  Thread-A context builder. Threads A + D + the projection idea unify here.
- [!] **The LLM must NOT generate SQL/Cypher.** That would hand state-truth back to the model
  (violating D1) and blow open injection/correctness/testability. Instead extend the existing
  **typed mutation vocabulary** to be edge-shaped — the engine validates against a whitelist of
  node/edge types, clamps numeric props, and writes the query itself:
  ```json
  { "op": "set_relation", "from": "<pc>", "to": "The Bramble Boar",
    "type": "in_combat", "props": { "enemyHp": 4, "posture": "enraged" } }
  { "op": "update_relation", "type": "in_combat", "props": { "enemyHp": -3 } }
  { "op": "set_relation", "from": "<pc>", "to": "Crow", "type": "trust", "props": { "delta": -1 } }
  ```
- [>] **Storage (decided "A"):** graph-*shaped* now, but persisted as a typed structure in the
  existing SQLite for v9/POC — migrate to a real graph backend at MVP when [[mvp-data-model]]
  lands. The interaction design is graph-native; the storage bet is deferred.

### D3 — Per-type interaction shapes (where the dice/determinism balance lives)

Each type resolves differently — that's the point of per-type templates:

- [I] **Combat** — buttons + roll (snappy, physical). Multi-round (Thread C); the roll decides
  whether the blow lands / the hit is taken; the `enemyHp` edge is the deterministic spine.
- [I] **Conversation** — *free-text, judged*. The player types their argument; the resolve
  stage judges it against the NPC's hidden goals **read off the relationship edges**; the roll
  modifies confidence, it does not replace the judgment. **Disposition gates the possible** —
  a hostile NPC cannot be silver-tongued into the secret no matter the roll; trust must be
  earned across beats first.
- [I] **Puzzle** — model **ii: dice pace discovery, brains solve.** You *roll to investigate*
  (a good roll traverses a clue-edge and reveals it; a bad roll costs time/stamina or springs
  a trap), but the **final solution attempt is a semantic match with NO roll** — type an answer
  that fits the hidden `solution` and you win. It would feel awful to deduce the answer and lose
  on a die. Clues are earned by dice; the solve is earned by thought.

### D4 — Free-text input, judged (model "B") + the security stack

Decided: free-text drives **conversations & puzzles**; **combat stays buttons + roll**. Players
type arguments and guesses; the pipeline judges them against hidden state. The extra judgment
call is affordable — see D5.

Free text is an attack surface, so it is a **revocable privilege**, defended in layers:

- [I] **Pre-LLM gate** — cap custom-input size; regex/heuristic scrape for injection
  (role-resets, "ignore previous", fenced-instruction lookalikes).
- [I] **In-template SECURITY RULE** — survives into every template; player text is in-world
  speech only, never an instruction to the engine.
- [I] **Classifier tripwire** — Stage 1 can flag input `suspicious` and route to a
  refusal/buttons path.
- [I] **Strike → downgrade** — flagged input **revokes free-text for that player going
  forward**; they fall back to buttons-only until trust is restored. Models cleanly as a
  `freetext_trust` / strike-count prop on the **PC node** (graph again). Degrades gracefully
  instead of hard-erroring.

### D5 — Cost stance & thinking-data mining

- [p] **Latency is not the binding constraint.** Players stay engaged under ~30 s and we
  average well below; models came in far cheaper than projected. Hitting the LLM more often
  (pipeline stages, free-text judgment, multi-round combat) is viable.
- [I] **But trim context anyway** — template prompting should shrink each stage's input, which
  curbs the model's tendency to *spiral* in its thinking (long reasoning, retries,
  self-contradiction) and so *improves* latency as a side effect, not just cost.
- [<] **Mine the thinking data.** `llm_calls` already records `reasoning_chars`, latency, and
  tokens. Mine it to find what trips the model up most — which inputs make it spiral — and feed
  that back into trimming the per-type templates. A flywheel: shorter, sharper templates → less
  spiral → faster + cheaper → easier to tune.

---

## How the four threads compose (v9 ownership)

Thread D reframes the others: A/B/C stop being edits to *one* prompt file and become
properties of a **versioned prompt set**. Per `AGENTS.md` the move is still "new version, bump
`PROMPT_VERSION` (`prompt-builder.ts:9`), mirror to `current_source.md`" — but `v9` is now a
*set of templates*, not a single file (see Thread D's [!]).

- [>] **The `v9` prompt set owns** the markdown framing of every template (Thread A), the
  combat template's unsafe-location frequency + long-combat rules (Thread C), and the
  `## World State` tier block the decide/resolve templates read (Thread B). Each template is
  small and single-purpose.
- [>] **`buildUserMessage` (`prompt-builder.ts`)** owns the JSON→markdown input rewrite
  (Thread A) and emitting only the per-type slice of context each stage needs (Thread D).
- [>] **The gateway / a new orchestrator** owns the chain itself (Thread D): classify → select
  template → decide → (dice) → resolve, plus the structured handoff payload between sessions.
  This is the genuinely new component — today it's one `DeepseekLlmGateway` call.
- [>] **`machine.ts` / the context builder** own computing the encounter's target difficulty
  band + scaled reward from (player strength, world tier) and handing it to the decide/resolve
  stages (Thread B). The roll math in `dc.ts` is deliberately **unchanged** — no player buff.
- [>] **A sim harness** (from [[mvp-llm-prompt-architecture]]) is a *prerequisite* for tuning
  Thread B, validating Thread C pacing, *and* measuring the pipeline's latency/coherence
  trade-off (Thread D) — not a nice-to-have.

## Open questions (cross-cutting)

- [?] Ship all four in one `v9`, or stage them (D pipeline + A markdown first — they're the
  backbone; then B scaling, then C combat on top)? Staging makes regressions attributable.
- [?] Does the markdown input meaningfully change how the model authors DCs/options, in a way
  that invalidates the v8 DC calibration (10–18)? Re-tune after, not before.
- [!] Every prior data-driven fix lives in v8 (refund rules, `KNOWN LOCATIONS`, no dead
  turns — [[roll-economy-timeouts-and-world-growth]], [[prod-data-review-v0.2.3]]). v9 must
  **carry all of it forward** — a rewrite is the easiest place to silently drop a hard-won rule.

## Risks

- [c] **Four big changes at once** is the headline risk — if the experience regresses, you
  can't tell which thread did it. Strong argument for staging on separate prompt versions with
  telemetry between. Thread D (pipeline) is the most invasive and probably wants its own
  prototype before it touches the live loop.
- [c] **Compounding latency** — Thread C multiplies calls *per fight* (rounds) and Thread D
  *per beat* (stages). Not the binding constraint (D5: ~30 s engagement budget, cheap models),
  but worth watching the *tail* — a multi-round fight that also free-text-judges could stack up.
  The round cap, heuristic/cached classifier, and decompose-only-where-it-pays keep the tail in
  check.
- [c] **Tuning the curve blind** (Thread B) bricks the game into trivial or impossible. Sim
  harness gates it.

## Acceptance sketch (when this graduates)

- [ ] Captured prompts show pure-markdown input; the response JSON contract is unchanged and
  still validates at the gateway.
- [ ] Over simulated weeks, a stronger character meets measurably tougher foes (higher DCs /
  deadlier enemies) than a weaker one in the *same* place, and the tougher fights pay
  proportionally more — the world tracks the player but rewards growth (not a flat treadmill).
- [ ] In unsafe locations, combat encounters dominate; in safe ones they're rare. Fights run
  multi-round (`required`), end in 3–5 beats, and a win yields loot/narrative advance.
- [ ] No combat round can one-shot a full-HP player; a would-be killing blow triggers the
  once-per-fight survive-at-1 save. Bad luck (nat-1 vs enemy nat-20) lands the worst severity
  band — bounded, not lethal-from-full. Tier scaling changes enemy HP + band damage only, never
  the variance/floor.
- [ ] All v8 rules (refunds, known-locations reuse, no dead turns, security rule) verified
  present in v9 — across whichever template now owns each.
- [ ] An action runs the chain: a typed classification routes to the right template, the
  decide stage emits options only, and a fresh resolve stage produces mutations from a
  structured handoff — every row stamped with the exact `v9` prompt-set version that produced it.
- [ ] Scene-state survives across beats: enemy HP / NPC disposition / puzzle clues persist as
  graph-shaped state; the engine applies only whitelisted, clamped graph-deltas — the LLM never
  emits SQL. A boar near death stays near death; an NPC's price doesn't reset.
- [ ] A conversation is judged on *what the player types* against the NPC's relationship edges,
  with disposition gating the impossible; a puzzle's clues come from rolls but its solve is a
  rollless semantic match.
- [ ] Free-text is gated: oversized/injection-flagged input is caught pre-LLM and downgrades the
  offending player to buttons-only going forward.
