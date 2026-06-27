---
title: Decision Prompt v10 — First-Class Combat, World Scaling & Multi-Stage Pipeline
status: spark
domain: spark
phase: poc
tags:
  - llm
  - prompt
  - pipeline
  - scaling
  - graph
  - combat
  - conversations
  - puzzles
  - immersion
  - engine
related:
  - "[[prompt-v9-markdown-and-critic]]"
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

# Decision Prompt v10 — First-Class Combat, World Scaling & Multi-Stage Pipeline

> *The kickoff for **POC round 2 (`0.3.0`)** — the deep, structural half of the original `decision-v8 → v-next` rework, building **on top of** what v9 ships. [[prompt-v9-markdown-and-critic]] (the next `0.2.x` patch) lands the LLM-layer changes — markdown input and a coherence critic — first. This doc carries the three threads that need real engine work: **(C)** combat as a frequent, long, high-reward mode in the wilds, backed by engine scene-state; **(B)** the world scales around each player — stronger players meet tougher foes for bigger rewards, climbing week by week; and **(D)** decompose the single mega-call into a multi-stage LLM pipeline (classify → decide → resolve) over graph-shaped scene-state. Raw — capture, don't build yet.*

**The thesis (shared with v9):** deepen *immersion* by **balancing probabilistic and deterministic mechanics** — let the dice rule what should be uncertain, let the engine deterministically own what players would feel cheated by if it drifted, let the LLM dress it. v9 takes the first, absorbable, LLM-only steps; v10 is where the mechanically-heavy ideas land: **combat** (a real fight mode with a tracked enemy spine), **scaling** (the world sized to the soul facing it), and **pipelining** (a chain of focused, type-specific LLM sessions over real scene-state). The coherence critic shipped in v9 is the deliberate first slice of (D) — v10 grows it into the full pipeline.

**Sequencing.** v9 ships first because it's absorbable without any engine change. v10 then slots **on top**: its `## World State` tier block (B) and its per-type templates (D) extend the v9 prompt — which by then is a single `decision-v9.md`. v10 turns that single file into a **versioned prompt set** (see Thread D's [!]). Combat (C) is where the engine first grows scene-state, so it and the pipeline (D) are deeply entwined — C's enemy spine *is* a slice of D1/D2.

---

## Threads shipped in v9 (forwarded — not repeated here)

- [>] **Markdown input** (was Thread A) → shipped in [[prompt-v9-markdown-and-critic]]. v10's
  per-type templates inherit the markdown framing rather than re-deriving it.
- [>] **Coherence critic** (new in v9) → the `decide → critique → correct` decorator is the first
  stage of v10's pipeline (Thread D). v10 generalises it into classify → decide → resolve, and the
  critic gains ground truth to check against once C/D bring scene-state.

## Thread C — Combat as a first-class mode

This is the heart of the spark. Combat today is a generic `/action` roll the prompt actively pushes to *end fast* (`decision-v8.md:44`, "prefer resolving in two or three beats"). For a survival game with a rising Threat that is backwards. Combat should be **frequent in the wilds, long, and richly rewarded** — see [[mvp-combat]] for the locked constraint (roll-resolution, never twitch).

**Why this needs v10, not v9 (the honest scoping call):** the rich version of combat — bounded severity bands, a no-one-shot floor, "a boar near death *stays* near death" — **cannot** be done with prompt rules alone. The engine has no enemy and no scene-state: `InternalActionState` (`src/engine/action/machine.ts:32`) tracks `accumulatedDc` and `decisions`, nothing else, and `modify_health` only ever hits the *player*. Real combat therefore needs engine scene-state — which *is* a slice of Thread D1 below — so it lives here in v10 with the pipeline, not in the LLM-only v9.

### C-a. Prompt-level rules (the combat template)

- [!] **Combat is the default in unsafe locations.** Replace v8 §3's "every 3rd or 4th decision"
  (`decision-v8.md:52`) with: in an `is_safe = 0` location a combat encounter is the *expectation*,
  not the exception. Safe locations (the Oak, town) stay calm. Danger is geographic — *where you go*
  becomes a real choice.
- [I] **Physical, item-anchored decisions.** Each round offers approaches tied to gear and stats
  (v8 already gestures at this, `decision-v8.md:58`) — make it the rule. The per-option `stat` mix
  means *how* you fight is a build choice ([[per-option-stat-and-ability-checks]]).
- [I] **Bigger reward for the harder fight.** Reward scales with the encounter's difficulty (its DC
  band / enemy HP and, via Thread B, the World Tier) — a tough kill pays more loot, `modify_wealth`,
  `modify_max_stamina`, narrative unlocks.
- [I] **Combat overrides "resolve in 2–3 beats."** It runs several rounds, each a real exchange.
  `required: true` throughout — no clean Skip, only Bail (flee, at a cost) per the existing
  terminal-state model.

### C-b. Engine changes (the combat spine)

- [ ] **Lift the decision cap for combat.** `machine.ts:191` hard-caps an action at the 2nd choice
  (`isLastDecision = state.decisions.length >= 1`). A multi-round fight needs this raised — gated on
  the combat sub-mode, not globally, so non-combat actions keep their tight cap. Target **3–5
  rounds**, hard-capped so one fight can't eat a player's whole session.
- [ ] **A `combatState` scene object** carried across rounds — `enemyName`, `enemyHp`, `enemyMaxHp`,
  `round`, `savedOnce`. This is the deterministic spine: the engine owns `enemyHp`, the LLM only ever
  *narrates* it. In v10 this is modelled as graph-shaped, persistent state (Thread D1/D2) rather than
  a throwaway blob, so a fled enemy can be remembered and a co-op fight is just multiple edges.
- [ ] **Contested roll + severity bands** (extend `src/engine/action/dc.ts`). Each round the player
  rolls `d20 + stat + item` (unchanged, `dc.ts:72`) **and the enemy rolls an engine-side d20**. The
  margin maps to a small band table — `clean hit · trade · glanced · heavy` — and **each band maps to
  a bounded, tier-scaled HP delta** applied to `enemyHp` (and, on the bad bands, to player health).
  Crits/nat-1s still swing the round; the *consequence* stays bounded. The enemy d20 is an engine
  roll, so "contested" adds **no** LLM randomness and never touches the determinism rule.
- [!] **No one-shot floor.** A blow that would drop the player to ≤0 HP instead leaves them at
  **1 HP + a forced desperate choice** (bail bloodied, losing position/loot — or last stand, now
  genuinely lethal). **Once per fight** (`savedOnce`). Bad luck can corner a player; it cannot kill
  them from full HP out of nowhere.
- [p] **Fits the existing roll-first split exactly.** The engine already rolls *then* narrates
  (`resolveWithRoll`, `machine.ts:231`). Combat just rolls *two* dice + picks the band first, then
  the narration call dresses *that* band against the enemy's posture (the boar *reels* / *gores you*).
  Mechanics before flavour — the split that already shipped, with a second die and a table.
- [p] **Scale magnitude, not variance.** The distribution shape (bounded bands, no one-shot, the
  floor) is a global constant. The only thing Thread B's World Tier reaches in is `enemyMaxHp` and
  the band→damage numbers — it changes magnitude only, never the feel or the safety rails.

### Open questions (Thread C)

- [?] How are rounds capped — fixed N, or a soft cap that lets a near-win finish? Start fixed (3–5),
  revisit.
- [?] Is the survive-at-1 save once-per-fight (chosen — simplest) or per-day? Takes once-per-fight.
- [?] How does the combat sub-mode signal itself — a `distilled_type: combat` the engine treats
  specially, or a dedicated flag? Reusing `distilled_type` + `required: true` + presence of
  `combatState` is the lighter touch.
- [c] Multi-round `required` combat spends more LLM calls per encounter (each round is a call).
  Bounded by the round cap — but combined with the v9 critic and D's stages it stacks. **Measure the
  tail** (latency D5 below).

## Thread B — The world scales around the player (danger and reward)

The roll math stays **exactly as it is**: `d20 + stat + itemBonus ≥ DC` (`resolveRoll`, `src/engine/action/dc.ts:72`). **No player-side buff — no roll bonus, no advantage.** A player's power *is* their stats + gear (`effectiveStats`, `dc.ts:45`); we never inflate the dice. What changes is the **world**: it scales to whoever is facing it.

Two inputs decide how hard an encounter is:

1. The player's **effective strength** (`effectiveStats` / might).
2. A **World Tier** `T` that climbs over the year (the weekly cadence already exists —
   `weeklyThreatIndex`, `src/discord/afternoon.ts:82`; game time is `day_number` meta).

- [I] **Stronger player → stronger foes.** A well-geared week-20 ranger meets tougher beasts,
  higher DCs, and deadlier brigands than a fresh week-2 recruit standing in the *same* clearing.
  The encounter is sized to the soul facing it — *steepest in unsafe locations* (`is_safe = 0`,
  including the lazy-created off-map wilds from [[roll-economy-timeouts-and-world-growth]]).
- [I] **Daunting challenge → bigger reward.** Reward scales with the encounter's difficulty, so
  beating a tougher foe pays proportionally more (rarer loot, more `modify_wealth`,
  `modify_max_stamina`, narrative unlocks). The world keeps pace, *and so does the payout*. Thread C
  scales reward to the *encounter's own* difficulty; Thread B adds the **cross-session World Tier**
  on top (a week-20 kill worth more than an identical week-2 one).
- [I] **World Tier raises the floor for everyone.** As weeks pass, even baseline encounters drift
  up — the east darkens regardless of who walks it. Player-scaling sits *on top of* that rising
  floor.
- [I] **Pull players toward the danger with rumours/hints (the carrot for the geography).** Scaling only matters if players *go* to the unsafe, unexplored places. Surface global hints of treasure or rumours that nudge players into the dangerous spots that haven't been charted yet (the caves, the off-map wilds from [[roll-economy-timeouts-and-world-growth]]) — the reward-scaling above is the payoff once they arrive. On the map side this lands as a `reveal_location` "rumoured, uncharted" leaf ([[per-player-map-exploration]] notes the hook); the prompt/world-growth side is what *authors* the rumour and ties it to a tier-scaled reward. Keep it from reading as spam — a global beat on a cadence, not per-action chatter.
- [p] Engine math barely moves: `resolveRoll` / the d20 / `dc.ts` are **untouched**. The change is
  in how the target DC band and foe strength are *chosen* — computed from (player strength, tier)
  and handed to the LLM, which authors a scene/foe to match. This is where Thread C's `combatState`
  (`enemyMaxHp`, the band→damage table) gets its two tier-scaled numbers. Reuse the `scalingHint`
  plumbing (`machine.ts`) plus the new **`## World State`** block.

The tension to resolve (honest pushback):

- [!] **Don't build a treadmill.** If the world tracks the player *exactly*, getting stronger is
  pointless — win-rate is flat forever and every stat/gear investment is silently eaten (the
  "level-scaling" problem that soured *Oblivion*). There must be a payoff for growing strong.
- [I] Resolution: the world should **lag** the player slightly, not match exactly — getting
  stronger still wins you *more* fights, just against worthier foes — and the **reward curve** is
  where investment cashes out. Stakes stay high; power still feels earned.
- [?] How tight is the tracking (the lag and reward coefficients)? This is the entire game-feel —
  **must** be tuned on the sim harness, not guessed.
- [?] How does `T` advance — strictly real-calendar weeks, or gated on collective player progress /
  Threat events (`afternoon.ts`)? Calendar is simplest; event-gating couples to the climax model in
  [[mvp-progression]].
- [?] Does foe-scaling read the *individual* player's strength or the *party/fellowship's* (co-op
  encounters, [[mvp-core-loop]])? Solo is simplest; party-scaling leans MVP — a shared scene with a
  strong and a weak player needs the foe sized carefully.
- [c] More knobs = more ways to mis-tune into "impossible" or "trivial." **The sim harness is a
  prerequisite, not optional.**

## Thread D — Decompose the action into a multi-stage LLM pipeline

The biggest structural change, and the **backbone** Thread B slots into. Today one LLM call does everything for a beat: classify the intent, pick the stat/DC, author the options, *and* (on `RESOLVE_ROLL`) compute mutations + narrate. The model is the DM, the dice, and the bookkeeper in one breath — and every call carries the **entire** rulebook whether the action is a knife-fight or a nap. Split it into a chain of focused, *fresh* sessions, each with a small, type-specific template. (Provenance: [[mvp-llm-prompt-architecture]] — "multiple short agent calls / a chain… distil intent → offer choices → resolve → narrate." The v9 coherence critic is the first such stage.)

**The pipeline (per custom action):**

1. [I] **Stage 1 — Classify.** A cheap, fast call with tiny output that derives the action's
   metadata from the raw player input + minimal context: its **type** (`fight | travel | trade |
   talk | other`) and routing flags (`unsafe_location`, `needs_roll`, `target_present`). No
   narrative, no options — just routing metadata.
2. [I] **Stage 2 — Decide.** The type selects a **prompt template** (combat / travel / trade / talk
   / generic), and *only the rules and context applicable to that type are injected* — combat rules
   (Thread C) for a fight, the `KNOWN LOCATIONS` block for travel, NPC agendas for
   talk, the `## World State` tier block (Thread B) where it matters. This session authors the
   **decision** (options + per-option stat/dc) **only** — it does **not** compute outcomes or
   mutations.
3. [I] **Stage 3 — Resolve.** After the dice (roll-first, unchanged), a **fresh session** receives
   a structured **handoff** — a summary of the decision(s) made + the roll verdict + the applicable
   world context — and computes the **mutations + `outcome_text`**. It never saw the decision
   session's reasoning; its only job is "given this verdict and this world, what changed?"

- [p] **Smaller, sharper prompts.** Each stage carries only its slice of the rulebook, not the
  monolith. This serves the markdown interpretability goal ([[prompt-v9-markdown-and-critic]])
  *better than one fat markdown prompt does* — decomposition beats length. A fight never pays for
  trade rules.
- [p] **Separation of concerns = fewer contradictions.** The decision session can't pre-bake an
  outcome; the mutation session can't be led astray by narrative flourish — it works from a
  structured verdict + world state (it extends the roll-first split that already shipped). Each
  stage is independently testable and versionable. (The v9 critic is the proof-of-concept that an
  extra stage is affordable.)
- [p] **Per-type templates tune in isolation** — fix the combat feel without touching travel; A/B a
  single stage without perturbing the rest.
- [c] **Latency & cost.** 2–3 calls on the critical path where there was ~1 — but **not the binding
  constraint** (see D5). Keep lean: Stage 1 tiny (or heuristic — below); decompose where it pays
  (combat, ambiguous intent) and keep pure travel/rest single-call; cache the classifier.
- [c] **Handoff fidelity.** "A summary of decisions + world context" as free prose loses
  information between sessions. The handoff must be a **structured, typed payload**, not a paragraph
  the next stage re-parses. (Prototype the slim handoff in the v9 critic.)
- [!] **This breaks the one-file prompt-versioning convention.** `AGENTS.md` assumes a single
  `decision-v<N>.md` + `PROMPT_VERSION` stamped on every row. A pipeline has *several* templates
  (classify, per-type decide, resolve). The convention must extend — e.g. a **versioned prompt
  set** (`decision-prompts/v10/{classify,combat,travel,…,resolve}.md`) stamped together so an
  outcome still traces to the exact set that produced it. Settle the asset layout + `PROMPT_VERSION`
  shape *before* building.
- [?] Is Stage 1 even an LLM call, or cheap heuristics (verb/keyword match) for the obvious cases
  with an LLM fallback only for ambiguous input? Heuristic-first dodges most of the latency hit.
- [?] How does the pipeline map onto the existing PHASE model (`NEW_ACTION` / `CONTINUE` /
  `RESOLVE_ROLL`)? The pipeline is essentially a *refinement* of PHASE — classify+decide replace
  `NEW_ACTION`/`CONTINUE`, resolve replaces `RESOLVE_ROLL` — but the mapping needs spelling out.
- [?] Does the Stage 1 type *replace* the LLM-authored `distilled_type`, or seed it? (Likely
  replaces — the classifier becomes the source of truth for type.)

### D1 — Scene-state: deterministic spine, narrative skin

The pipeline's real prize is that it can carry a **per-type scene-state object across beats**, instead of every beat reconstructing "where are we" from `RECENT ACTIONS` prose. That's what makes combat track wounds, a puzzle keep one answer, an NPC hold a grudge. Thread C's `combatState` is the first instance of this; D1 generalises it across types and makes it persistent + graph-shaped. Ownership is **hybrid** (the "C" option, decided in brainstorm):

- [p] **Engine owns the hard, cheatable truth** — enemy HP, whether a puzzle is solved, an NPC's
  disposition score. Numbers a player would feel cheated by if they drifted.
- [p] **LLM owns the soft texture** — mood, what's been said, the *feel* of the scene.
- [!] This *is* the thesis in miniature: dice decide the uncertain, the engine pins the
  deterministic, the LLM dresses it. Immersion comes from the seams not showing.

### D2 — Scene-state is graph-shaped; mutations are typed graph-deltas (no LLM SQL)

Model scene + relationship state as **nodes + edges** — the subject and object of a scene are nodes, and the **edges between them carry the context**. This is already the MVP world-state direction ([[mvp-data-model]], [[mvp-social-model]]'s three axes, [[mvp+world-state-projection]]). **This is where Thread C's `combatState` is modelled as persistent, graph-shaped state.**

- [I] A fight: `PC ──in_combat{enemyHp, posture, round}──▶ enemy NPC`. Group/co-op combat falls out
  for free as multiple edges — no special-casing. Persistent enemy NPC nodes can flee, heal, and
  remember.
- [I] A conversation: the *relationships are the state* — `trust`, `owes_debt`, `knows_secret`,
  `fears` edges between PC and NPC. The single strongest fit for graph.
- [I] A puzzle: a puzzle-node with a hidden `solution` prop + edges to clue-nodes and required-item
  nodes; "clues found" = which clue-edges the player has traversed.
- [p] **Bonus — context assembly = subgraph → markdown.** To build a per-type decide prompt
  (Stage 2), walk the subgraph around the two nodes and render it as the markdown briefing. That
  makes [[mvp+world-state-projection]]'s "graph → markdown at ~0 tokens" *become* the markdown
  context builder v9 introduced. The markdown framing, the pipeline, and the projection idea unify
  here.
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
  existing SQLite for this round — migrate to a real graph backend at MVP when [[mvp-data-model]]
  lands. The interaction design is graph-native; the storage bet is deferred.

### D3 — Per-type interaction shapes (where the dice/determinism balance lives)

Each type resolves differently — that's the point of per-type templates:

- [I] **Combat** — buttons + roll (snappy, physical). Multi-round (Thread C); the roll
  decides whether the blow lands / the hit is taken; the `enemyHp` edge is the deterministic spine.
- [I] **Conversation** — *free-text, judged*. The player types their argument; the resolve stage
  judges it against the NPC's hidden goals **read off the relationship edges**; the roll modifies
  confidence, it does not replace the judgment. **Disposition gates the possible** — a hostile NPC
  cannot be silver-tongued into the secret no matter the roll; trust must be earned across beats
  first.
- [I] **Puzzle** — model **ii: dice pace discovery, brains solve.** You *roll to investigate* (a
  good roll traverses a clue-edge and reveals it; a bad roll costs time/stamina or springs a trap),
  but the **final solution attempt is a semantic match with NO roll** — type an answer that fits the
  hidden `solution` and you win. It would feel awful to deduce the answer and lose on a die. Clues
  are earned by dice; the solve is earned by thought.

### D4 — Free-text input, judged (model "B") + the security stack

Decided: free-text drives **conversations & puzzles**; **combat stays buttons + roll**. Players type arguments and guesses; the pipeline judges them against hidden state. The extra judgment call is affordable — see D5.

Free text is an attack surface, so it is a **revocable privilege**, defended in layers (extends the v9 critic's pre-LLM checks):

- [I] **Pre-LLM gate** — cap custom-input size; regex/heuristic scrape for injection (role-resets,
  "ignore previous", fenced-instruction lookalikes).
- [I] **In-template SECURITY RULE** — survives into every template; player text is in-world speech
  only, never an instruction to the engine.
- [I] **Classifier tripwire** — Stage 1 can flag input `suspicious` and route to a refusal/buttons
  path.
- [I] **Strike → downgrade** — flagged input **revokes free-text for that player going forward**;
  they fall back to buttons-only until trust is restored. Models cleanly as a `freetext_trust` /
  strike-count prop on the **PC node** (graph again). Degrades gracefully instead of hard-erroring.

### D5 — Cost stance & thinking-data mining

- [p] **Latency is not the binding constraint.** Players stay engaged under ~30 s and we average
  well below; models came in far cheaper than projected. Hitting the LLM more often (pipeline
  stages, free-text judgment) is viable.
- [I] **But trim context anyway** — template prompting should shrink each stage's input, which curbs
  the model's tendency to *spiral* in its thinking (long reasoning, retries, self-contradiction) and
  so *improves* latency as a side effect, not just cost.
- [<] **Mine the thinking data.** `llm_calls` already records `reasoning_chars`, latency, and tokens
  (and, from v9, the critic's verdicts). Mine it to find what trips the model up most — which inputs
  make it spiral — and feed that back into trimming the per-type templates. A flywheel: shorter,
  sharper templates → less spiral → faster + cheaper → easier to tune.

### D6 — Deterministic travel/location coherence (a v9-critic gap the pipeline should close)

Captured from a testing-data review (action 16, `llm_calls` 67–73). A Blacksmith standing at **The Town Forge** (a `safe` location) typed *"Go to the woods and find a monster to brawl."* The model authored a boar fight set **in the forest** with **no `set_location` / travel beat** — so the scene teleported to the wilds while the engine still has the character at the Forge. This is the "fight where you aren't" bug: the encounter is narrated somewhere the character physically isn't, and nothing moved them there. The correct chain is **travel first, then fight**.

Why the v9 critic detected but could not fix it (the gap to close):

- [!] **The gate skips the origin beat.** `CritiquedLlmGateway` only critiques a decision beat when it is `required` or the validator already warned (`CritiquedLlmGateway.ts:36`). The opening `NEW_ACTION` beats that *introduced* the forest weren't `required` and weren't warned, so they slipped — the critic first engaged on the downstream combat beat, after the teleport was baked in.
- [!] **`major` has only one weak lever.** A `major` verdict triggers a single bounded re-decide with the issues as a note (`CritiquedLlmGateway.ts:62`); the re-decide is **never re-critiqued**, and it cannot *inject the missing travel step* — it just asks the model to retry. The model, anchored on "brawl," re-authored the same forest fight, which then shipped. The resolution-beat critic flagged `major` again but resolution-`major` is a deliberate no-op (`machine.ts:300`) — dice/mutations are locked. The critic caught the incoherence twice and corrected nothing.

The honest constraint on "just have the critic/engine check the location":

- [!] **You cannot derive the scene's location deterministically from the prose.** The narration is free-form NL; extracting "this is set in a forest" is fuzzy NLP, not deterministic. `validateDecision` (`DeepseekLlmGateway.ts:596`) is the model to follow — it only ever reads **structured fields** (`distilled_type`, `stat`, `base_dc`, the `decision`/`mutations` arrays), never prose. A location coherence guard must live in that structured world.

Two ways to make the check structured (the second is the real fix):

- [I] **B1 — structured proxies (no contract change).** Don't derive the scene location; check structured invariants that *correlate* with the teleport, all computable from data on hand (`ctx.location.isSafe`, `ctx.knownLocations`, `distilledType`, the `mutations` array, raw input): (a) **sanctuary vs wild-encounter** — at a `safe` location, a hostile beat (`distilled_type ∈ {combat, hunt, …}` or a monster `spawn_npc`) with no `set_location`; (b) **stated movement vs no travel** — raw input contains a known-location name or a movement verb, yet no `set_location` and location unchanged; (c) **field self-consistency** — `distilled_type: travel` with no `set_location`, or a `set_location` to a name absent from `knownLocations`. Emit these as `_warnings`, which already (i) force the critic gate (`CritiquedLlmGateway.ts:36`) so the origin beat stops slipping, and (ii) become the critic's checklist (`prompt-builder.ts:71`). Cheap, zero schema change — but proxies, so **warn, never block** (the known-location-name match is solid; the safety/verb heuristics will false-positive on a legit "ambushed at the forge" beat).
- [I] **B2 — make the location structured at the source (recommended).** Add a `scene_location` field to the decision JSON contract: the model declares, as data, the location name the beat is set in. The check becomes a clean equality, not a guess: `normalize(scene_location) !== normalize(character.location) && !mutations.some(set_location)` → structural incoherence. This converts "parse English" (impossible deterministically) into "compare two strings" (trivially deterministic). It relies on the model to *populate* `scene_location`, but emitting a location name is far more constrained than getting the whole scene right — and a contradictory value (forest while at the Forge, no travel) **is** the deterministic signal. Cost: a prompt/contract version bump and re-parse.
- [!] **Detection ≠ remedy.** The check above is only the *trigger*. The durable fix pairs it with a stronger remedy than "re-decide and hope": the engine **synthesises the missing travel beat itself** (deterministically inject a `set_location`-first decision so the character actually arrives before the encounter), or the re-decide note is made **binding and re-checked once**. The detector says a travel step is missing; injecting it is what actually fixes the case.

How this folds into the v10 threads (it isn't a new thread, it's a coherence property of the pipeline):

- [>] **Stage 1 Classify (Thread D) is the natural home for the trigger.** Classifying *"go to the woods and brawl"* should route it as **travel→fight** (or flag `needs_travel` when intent names a place the player isn't), so the decide stage authors the travel beat first by construction — the structured `scene_location`/`set_location` check (B2) then becomes the deterministic backstop the resolve/critic stage enforces.
- [>] **D1/D2 make location a deterministic spine.** Once scene-state is engine-owned and graph-shaped, "where the character is" is a node the engine controls, and a beat that narrates elsewhere without a `set_location` edge is a hard, checkable contradiction — the same shape as the `enemyHp` spine, applied to position.
- [>] **Linkage bug found alongside (already fixed in code, noted for provenance).** Row 69 (the flagged decision) had a NULL `action_id`: on a `major` re-decide `CritiquedLlmGateway` discarded the flagged decision and dropped its `_llmCallId` from action linkage, even though the critic had captured its reasoning via `promoteDeepCapture`. Fixed by carrying `_supersededCallId` forward so the rejected call still links — relevant here because mining critic-flagged beats (like this travel/location class) depends on those rows being attributable to their action.

---

## How the three threads compose (v10 ownership)

Thread D reframes C and B: they stop being edits to *one* prompt file and become properties of a **versioned prompt set**. Per `AGENTS.md` the move is still "new version, bump `PROMPT_VERSION` (`prompt-builder.ts:9`), mirror to `current_source.md`" — but `v10` is now a *set of templates*, not a single file (see Thread D's [!]).

- [>] **The `v10` prompt set owns** the per-type templates (classify / combat / travel / trade /
  talk / resolve), each inheriting v9's markdown framing — including the combat template's
  unsafe-location frequency + long-combat rules (Thread C) and the `## World State` tier block the
  decide/resolve templates read (Thread B).
- [>] **`machine.ts` + `dc.ts`** own the combat spine (Thread C): the lifted decision cap, the
  contested roll + severity bands, the no-one-shot floor — and the `combatState` scene object, which
  D1/D2 model as graph-shaped persistent state.
- [>] **`buildUserMessage` (`prompt-builder.ts`)** owns emitting only the per-type slice of context
  each stage needs (Thread D) — generalising the single markdown briefing v9 introduced.
- [>] **A new orchestrator** owns the chain itself (Thread D): classify → select template → decide →
  (dice) → resolve, plus the structured handoff payload between sessions. The v9 `CritiquedLlmGateway`
  is the seed of this orchestrator.
- [>] **`machine.ts` / the context builder** own computing the encounter's target difficulty band +
  scaled reward from (player strength, world tier) and handing it to the decide/resolve stages
  (Thread B). The roll math in `dc.ts` is deliberately **unchanged** — no player buff.
- [>] **A sim harness** (from [[mvp-llm-prompt-architecture]]) is a *prerequisite* for tuning Threads
  B and C *and* measuring the pipeline's latency/coherence trade-off (Thread D) — not a nice-to-have.

## Open questions (cross-cutting)

- [?] Ship C, B and D together as one `v10`, or stage them (D pipeline first — it's the backbone;
  then C combat on its scene-state; then B scaling on top)? Staging makes regressions attributable.
- [!] Every prior data-driven fix lives in v8/v9 (refund rules, `KNOWN LOCATIONS`, no dead turns,
  the security rule, the markdown framing). v10 must **carry all of it forward** — a prompt-set
  rewrite is the easiest place to silently drop a hard-won rule.

## Risks

- [c] **Three big structural changes at once** (combat, scaling, pipeline) — if the experience
  regresses, telemetry between staged prompt versions tells you which thread did it. Thread D
  (pipeline) is the most invasive and probably wants its own prototype before it touches the live
  loop — the v9 critic is the on-ramp.
- [c] **Compounding latency** — Thread C multiplies calls *per fight* (rounds) and Thread D *per
  beat* (stages). Not the binding constraint (D5: ~30 s engagement budget, cheap models), but watch
  the *tail* — a multi-round fight that also free-text-judges (D4) could stack up. The round cap,
  heuristic/cached classifier, and decompose-only-where-it-pays keep the tail in check.
- [c] **Tuning the curve blind** (Thread B) bricks the game into trivial or impossible. Sim harness
  gates it.

## Acceptance sketch (when this graduates)

- [ ] In unsafe locations, combat encounters dominate; in safe ones they're rare. Fights run
  multi-round (`required`), end within the 3–5 round cap, and a win yields loot/narrative advance
  scaled to the encounter's difficulty. No round can one-shot a full-HP player; a would-be killing
  blow triggers the once-per-fight survive-at-1 save; tier scaling changes enemy HP + band damage
  only, never the variance/floor.
- [ ] Over simulated weeks, a stronger character meets measurably tougher foes (higher DCs /
  deadlier enemies) than a weaker one in the *same* place, and the tougher fights pay proportionally
  more — the world tracks the player but rewards growth (not a flat treadmill). The cross-session
  World Tier is observable on top of Thread C's within-encounter scaling.
- [ ] An action runs the chain: a typed classification routes to the right template, the decide
  stage emits options only, and a fresh resolve stage produces mutations from a structured handoff —
  every row stamped with the exact `v10` prompt-set version that produced it.
- [ ] Scene-state survives across beats as **graph-shaped, persistent** state (Thread C's
  `combatState` generalised): enemy HP / NPC disposition / puzzle clues persist; the engine applies
  only whitelisted, clamped graph-deltas — the LLM never emits SQL. A boar near death stays near
  death across sessions; an NPC's price doesn't reset; a fled enemy is remembered.
- [ ] A conversation is judged on *what the player types* against the NPC's relationship edges, with
  disposition gating the impossible; a puzzle's clues come from rolls but its solve is a rollless
  semantic match.
- [ ] Free-text is gated: oversized/injection-flagged input is caught pre-LLM and downgrades the
  offending player to buttons-only going forward.
- [ ] All v8/v9 rules (refunds, known-locations reuse, no dead turns, security rule, markdown input)
  verified present across whichever template now owns each.
