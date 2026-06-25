---
title: Decision Prompt v9 — Markdown Input & Coherence Critic
status: spark
domain: spark
phase: poc
tags:
  - llm
  - prompt
  - markdown
  - critic
  - coherence
  - engine
related:
  - "[[mvp-llm-prompt-architecture]]"
  - "[[per-option-stat-and-ability-checks]]"
  - "[[roll-economy-timeouts-and-world-growth]]"
  - "[[prod-data-review-v0.2.3]]"
  - "[[prompt-v10-scaling-and-pipeline]]"
---

# Decision Prompt v9 — Markdown Input & Coherence Critic

> *The **next** release (a `0.2.x` POC-beta patch). Two shippable threads carved out of the larger
> v8→v-next rework: (1) make the LLM's input pure markdown, (2) add a **coherence critic** — a
> second LLM pass that reviews and repairs each decision before it reaches the player. Combat as a
> first-class mode is **on ice** (moved to [[prompt-v10-scaling-and-pipeline]]), along with
> world-scaling and the full multi-stage pipeline. This doc is spec-grade: written for a handoff
> agent to implement directly.*

**Thesis (inherited, narrowed):** deepen immersion by balancing the probabilistic and the
deterministic — let the dice rule what should be uncertain, let the engine own what players would
feel cheated by if it drifted, and let the LLM dress the result. v9 advances that on two fronts the
codebase can absorb **without** any engine/scene-state change: a cleaner input (Thread 1) and an
LLM proof-reader on the way out (Thread 2). Both are pure LLM-layer changes — independently
shippable, independently reversible, and they touch no game mechanics.

Today the prompt is `v8` (`src/llm/prompt-builder.ts:9`). v9 is a single new `decision-v9.md`
(one file, not a set — the set is a v10 concern) plus one new gateway wrapper.

---

## Thread 1 — Markdown input (interpretability)

`buildUserMessage` (`src/llm/prompt-builder.ts:29`) emits a line-per-field block with embedded
JSON: `CHARACTER: class=Ranger, stats={"physical":3,...}, health=…`. The model burns attention
parsing `key=value` + stringified objects instead of reading a scene. **Input only** — the response
stays JSON; the JSON CONTRACT is unchanged.

- [I] Render the whole input context as clean markdown — headings, short tables, bullet lists — so
  tokens read like a briefing, not a serialized struct. **Guiding rule: keep markdown's *structural*
  features (headings, tables, labels), skip its *typographic* ones (bold/italic).** Decorative `**`/`*`
  are invisible to the model (it sees literal tokens) and only cost verbosity — the one real downside
  of going markdown. See the settled per-block templates below.
- [p] Almost a pure presentation change in `buildUserMessage`. The gateway, the schema, and the
  resolution path are untouched; `buildContextDigest` (the audit snapshot, `prompt-builder.ts:108`)
  is a separate function and stays as-is. **Three small `LlmContext` additions**
  (`src/llm/LlmGateway.ts:1`): `maxHealth` / `maxStamina` so resources render as `7/10` fractions,
  and `location.isSafe` so the scene can carry a safety tag. All three are honest plumbing of state
  the engine already owns (`modify_max_stamina` makes max a live stat; `is_safe` exists on
  locations) — not invented data.
- [p] Provenance: [[mvp-llm-prompt-architecture]] already calls for "markdown in, JSON out." This
  thread is that, made concrete and pulled forward.
- [!] **Carry the SECURITY RULE forward intact** (`decision-v8.md:205`). Markdown is a softer
  prompt-injection surface, so the `PLAYER INPUT` block must stay clearly fenced and labelled as
  in-world speech, never an instruction.
- [!] **Carry ALL v8 hard-won rules into v9** — refund rules, `KNOWN LOCATIONS` reuse, no dead
  turns, roll-first resolution ([[roll-economy-timeouts-and-world-growth]],
  [[prod-data-review-v0.2.3]]). A rewrite is the easiest place to silently drop one.
- [c] Markdown is a few more input tokens than `key=value`. `llm_calls` already records
  tokens/latency — measure the cost against the coherence gain.
- [?] Does the per-option `stat`/`dc_modifier` contract and the `KNOWN LOCATIONS` block read better
  as a table or a list? Decide by eyeballing captured prompts after the first cut.
- [?] Does markdown change how the model authors DCs/options enough to invalidate the v8 DC
  calibration (base 10–18)? Re-tune **after**, not before.

### Settled — the character block

**Principle: pre-compute the join.** Today the model gets character data split across two blocks it
must mentally join — `CHARACTER: stats={"physical":3,...}` and `SCALING HINT: item bonuses: physical
+2` — re-deriving the very number the dice engine already computes (`abilityCheckBonus` = score +
item bonus, `dc.ts:62`). The template does that join *for* the model: a per-stat table whose `Bonus`
column is exactly what's added to the d20. That's the single most decision-relevant fact for both DC
calibration and per-option `stat` selection.

Two purpose-built views, no arithmetic left for the model:

```markdown
## You — Ranger · Neutral Good · Fletcher
Health 7/10 · Stamina 4/6

### Ability checks (roll = d20 + Bonus ≥ DC)
| Stat | Score | Gear | Bonus |
|------|-------|------|-------|
| Physical | 3 | +2 | +5 |
| Wisdom | 2 | — | +2 |
| Intelligence | 1 | — | +1 |
| Charisma | 2 | +1 | +3 |

### Inventory
- 🏹 Yew Bow — physical +2
- 🪙 Silver Charm — charisma +1
- 🏹 Arrows ×12 — ammo
```

- [I] **Stats table owns the math** — `Bonus = Score + Gear`; the inline `(roll = d20 + Bonus ≥ DC)`
  teaches its use in one phrase. Always show all four stats in fixed order (the model compares
  approaches; fixed order keeps the prompt prefix cache-stable).
- [I] **Inventory list owns the gear** — names, emoji, quantity, ammo. This is what `remove_item` /
  consumption and item-anchored narration need; it carries what doesn't belong in a math table
  (quantities, zero-modifier/narrative items). The model cross-references by stat name — cheap, only
  four stats.
- [x] No decorative bold/italic (per the guiding rule above) — the heading + table structure carry
  the meaning.

### Settled — the scene & NPC blocks

The old `SCALING HINT` block (item bonuses + inventory) **dissolves into the character block above** —
it disappears from the scene side entirely. What remains is the world the model narrates:

```markdown
PHASE: NEW_ACTION

## Scene
Location: The Dark Pines — unsafe (wilds; danger roams)

### Present
NPCs:
- Crow, the Toll-Taker — a lean rider who owns the road now
- Nikolai — an old, quiet hunter for the town butchery
Other players:
- Mara (Priest)

### Story so far (oldest first)
- travel (success): You pushed east off the road into the pines.
- forage (failure): The bramble gave nothing but scratches.

### Known locations
The Oak · Town · The Dark Pines · The Shrine of the First Flame

## What you're attempting
> draw my bow and put an arrow in Crow
```

- [I] **Section order: control → you → scene → present → story → reference → the ask.** `PHASE` stays
  a bare top control line (it's a directive, not narrative). `PLAYER INPUT` goes **last**, right
  before generation — best for instruction-following, and it brackets the untrusted text with our
  framing.
- [ ] **Plumb `location.isSafe` into `LlmContext`** (same move as `maxHealth`/`maxStamina`). Safety is
  the highest-leverage scene fact — it drives danger pacing (v8 §3) and is the combat-frequency lever
  for v10. Render it as a semantic tag (`unsafe (wilds; danger roams)` / `safe (sanctuary)`), not a
  bare flag, so the model weights it without needing bold.
- [!] **Lift the Warden lore out of the NPC list.** Today it's a `KNOW THIS, NEVER STATE` directive
  injected *inline among the NPCs* (`prompt-builder.ts:50`) — an out-of-character instruction
  masquerading as scene data, which the model could render. Move it to a clearly-fenced **GM note**,
  conditional on the Warden being present and kept visually separate from in-world data:
  ```
  > GM note (out of character): The Warden is not one person — the title has passed across
  > centuries; the current one is the last. Reveal only in fragments. Imply, never explain.
  ```
  Keeping it conditional (not in the system prompt) avoids paying those tokens on every Warden-absent
  call.
- [!] **Player input is the security surface — fence and label it.** A labelled blockquote
  (`## What you're attempting` + `>`) frames it as in-world words and resists "ignore previous
  instructions" reasonably; the real defense stays the system-prompt SECURITY RULE. A code fence is
  marginally more injection-resistant ("this is data") but a player typing ``` breaks out — so that
  route needs backtick-normalisation on `rawInput`. **Chosen: blockquote + label.**
- [I] **NPCs and PCs stay separate labelled lists** — different mechanics (NPCs are scene-drivers with
  motives; PCs are co-op companions). Recent actions stay **oldest-first** so the model reads the
  story forward. `KNOWN LOCATIONS` is an inline `·`-separated line (reference data, not narrative —
  cheaper than bullets).
- [?] **CONTINUE / RESOLVE_ROLL additions** (`PREVIOUS DECISIONS`, `ROLL RESULT`) follow the same
  voice — a `### So far this beat` list and a `ROLL RESULT: SUCCESS|FAILURE` directive line. Settle
  their exact framing when wiring those phases.

## Thread 2 — Coherence critic (a proof-reading LLM pass)

A second, focused LLM call that reviews each authored decision/narration for **coherence** before
it reaches the player, and repairs or flags it. New idea (not in the original rework), and the
cheapest reliability win available — and a pure LLM-layer addition, no mechanics touched.

- [p] **Architecturally trivial to add — decorator gateway.** The codebase already wraps gateways:
  `FallbackLlmGateway` (`src/llm/FallbackLlmGateway.ts`) wraps an `LlmGateway`. v9 adds
  `CritiquedLlmGateway implements LlmGateway` that wraps the Deepseek gateway: `decide()` →
  `critique()` → (repair) → return. **Zero changes to `machine.ts`** — it still calls
  `this.llm.decide(context)`.
- [I] **Division of labour with the deterministic validator.** `validateDecision`
  (`src/llm/DeepseekLlmGateway.ts:429`) already does cheap mechanical checks (DC range, reward-on-
  success, empty turns). Push *more* mechanical checks down into it; reserve the **LLM** critic for
  genuine coherence judgments it can't express as code:
  - [I] narration contradicts its own mutations (a wound described, no `modify_health`);
  - [I] a `SUCCESS` that reads as a loss, or a `FAILURE` that hands a reward;
  - [I] the new beat contradicts `RECENT ACTIONS` / `PREVIOUS DECISIONS` (re-presents a standoff,
    forgets a thread already resolved);
  - [I] tone/lore breaks (states the Warden secret outright, `decision-v8.md:50`).
- [!] **The critic IS a baby pipeline — file it as the first 30% of v10's Thread D, not as
  orthogonal.** It is `decide → critique → correct`, a single extra stage. That's intentional: it's
  the safest possible slice of decomposition, and it lets us measure the latency/quality trade-off
  before committing to the full classify→decide→resolve rebuild.
- [I] **Gate it — don't critique every beat.** Run the critic on ambiguous/resolution/combat beats;
  skip pure travel/rest where the deterministic validator already suffices. Gate on the returned
  `distilledType` / `required` / presence of `rollOutcome`. Keeps cost and the latency tail in check.
- [c] **Its ceiling is capped until v10 brings ground truth.** Without scene-state the critic judges
  coherence from the same prose the author saw — strong at "narration ≠ mutations" (both in one
  response) and "contradicts recent actions" (in the context), weaker at "contradicts world truth"
  (no deterministic fact to check against). v10's scene-state (e.g. enemy HP) is what lets the critic
  catch drift against engine truth — so the critic *grows* with v10, but earns its keep in v9 on the
  in-response checks alone.
- [?] **Critic prompt asset layout.** Like the cartographer/recap prompts (inline consts in
  `DeepseekLlmGateway.ts:39`/`:56`), or a versioned file? Recommend a **versioned**
  `assets/prompts/critic/critic-v1.md` + a `CRITIC_VERSION` constant, so critic verdicts are
  attributable in `llm_calls` exactly like decisions are (this mirrors, and stays inside, the
  `AGENTS.md` system-prompt convention rather than breaking it).
- [?] **Repair vs flag-and-retry.** Does the critic *rewrite* the offending decision, or return a
  verdict that triggers a single bounded re-`decide`? Rewrite is one call; flag-and-retry is cleaner
  to reason about but adds a call. Lean rewrite for cost; measure.
- [?] **What does the critic see?** Minimum: the original context digest + the authored decision.
  Decide whether it gets the full context or a slim handoff (a slim, typed handoff is the v10
  pattern — prototype it small here).
- [c] **+1 call per gated beat.** D5's stance (below) says latency is not the binding constraint, but
  the extra call adds up — record critic calls in `llm_calls` (a new call-kind tag) and watch the
  tail.

### Cost stance (shared, from the original rework's D5)

- [p] **Latency is not the binding constraint.** Players stay engaged under ~30 s and we average well
  below; models came in far cheaper than projected. Hitting the LLM more often (the critic) is viable
  — but keep each call lean and gate where it pays.
- [<] **Mine the data.** `llm_calls` already records `reasoning_chars`, latency, tokens. Tag critic
  calls and mine whether the critic actually catches incoherence often enough to justify its cost —
  feed that back into the gating rules.

---

## How v9 maps onto the code (ownership)

- [>] **`decision-v9.md`** (new file) owns the markdown framing of the whole prompt (Thread 1). Bump
  `PROMPT_VERSION` (`prompt-builder.ts:9`) and mirror to `current_source.md` per `AGENTS.md`.
- [>] **`buildUserMessage` (`prompt-builder.ts:29`)** owns the JSON→markdown input rewrite
  (Thread 1).
- [>] **`CritiquedLlmGateway`** (new, wraps Deepseek) + `assets/prompts/critic/critic-v1.md` +
  `CRITIC_VERSION` own Thread 2. Wired in wherever the gateway is constructed; `machine.ts` is
  untouched.

## Risks

- [c] **Two changes at once** — stage them on the one prompt version with telemetry between, and land
  Thread 1 (lowest-risk, isolated) first so any regression is attributable.
- [c] **Compounding latency** — the critic adds a call per gated beat. Not the binding constraint
  (D5) but watch the tail; critic gating keeps it bounded.
- [!] A rewrite is the easiest place to silently drop a hard-won v8 rule. Diff v8→v9 rule-by-rule
  before shipping.

## Acceptance sketch (when v9 graduates)

- [ ] Captured prompts show pure-markdown input; the response JSON contract is unchanged and still
  validates at the gateway. All v8 rules (refunds, known-locations, no dead turns, security rule)
  verified present in v9.
- [ ] The coherence critic runs on gated (resolution/ambiguous/combat) beats, repairs or re-rolls an
  incoherent decision (narration ↔ mutations, success/failure framing, contradiction with recent
  actions), and is skipped on pure travel/rest. Critic calls are recorded in `llm_calls` for mining.

## Handoff checklist (suggested implementation order)

1. [ ] **Thread 1** — markdown `buildUserMessage`; new `decision-v9.md` + `PROMPT_VERSION` bump +
   `current_source.md` mirror; diff v8 rules forward. Ship & measure alone.
2. [ ] **Thread 2** — `CritiquedLlmGateway` decorator + `critic-v1.md` + `CRITIC_VERSION`; gate to
   resolution/ambiguous beats; record critic calls.
