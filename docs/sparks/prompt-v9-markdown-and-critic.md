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

> *The **next** release (a `0.2.x` POC-beta patch). Two shippable threads carved out of the larger v8→v-next rework: (1) make the LLM's input pure markdown, (2) add a **coherence critic** — a second LLM pass that reviews and repairs each decision before it reaches the player. Combat as a first-class mode is **on ice** (moved to [[prompt-v10-scaling-and-pipeline]]), along with world-scaling and the full multi-stage pipeline. This doc is spec-grade: written for a handoff agent to implement directly.*

**Thesis (inherited, narrowed):** deepen immersion by balancing the probabilistic and the deterministic — let the dice rule what should be uncertain, let the engine own what players would feel cheated by if it drifted, and let the LLM dress the result. v9 advances that on two fronts the codebase can absorb **without** any engine/scene-state change: a cleaner input (Thread 1) and an LLM proof-reader on the way out (Thread 2). Both are pure LLM-layer changes — independently shippable, independently reversible, and they touch no game mechanics.

Today the prompt is `v8` (`src/llm/prompt-builder.ts:9`). v9 is a single new `decision-v9.md` (one file, not a set — the set is a v10 concern) plus one new gateway wrapper.

---

## Thread 1 — Markdown input (interpretability)

`buildUserMessage` (`src/llm/prompt-builder.ts:29`) emits a line-per-field block with embedded JSON: `CHARACTER: class=Ranger, stats={"physical":3,...}, health=…`. The model burns attention parsing `key=value` + stringified objects instead of reading a scene. **Input only** — the response stays JSON; the JSON CONTRACT is unchanged.

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

**Principle: pre-compute the join.** Today the model gets character data split across two blocks it must mentally join — `CHARACTER: stats={"physical":3,...}` and `SCALING HINT: item bonuses: physical +2` — re-deriving the very number the dice engine already computes (`abilityCheckBonus` = score + item bonus, `dc.ts:62`). The template does that join *for* the model: a per-stat table whose `Bonus` column is exactly what's added to the d20. That's the single most decision-relevant fact for both DC calibration and per-option `stat` selection.

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

The old `SCALING HINT` block (item bonuses + inventory) **dissolves into the character block above** — it disappears from the scene side entirely. What remains is the world the model narrates:

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

A second, focused LLM call that reviews each authored decision/narration for **coherence** before it reaches the player, and repairs or flags it. New idea (not in the original rework), and the cheapest reliability win available — and a pure LLM-layer addition, no mechanics touched.

### The governing principle

- [!] **The critic is a texture-corrector, not a truth-arbiter.** When prose and engine-truth
  disagree, *truth wins and the prose is rewritten* — never the mutations, verdict, DC, or roll. This
  is the same split as roll-first narration: dice/engine own truth, the LLM owns texture. It means the
  critic structurally **cannot corrupt state**, only reword it.
- [!] **The deterministic layer is always downstream of the critic.** The engine already corrects
  cheaply — `validateDecision` (`DeepseekLlmGateway.ts:429`, warnings), `applyOutcomeToMutations`
  (`machine.ts:379`, strips rewards on a failed roll + adds the stamina penalty), `toActionDecision`
  (`machine.ts:286`, clamps `dc_modifier`, strips/ensures bail), the empty-turn throw
  (`DeepseekLlmGateway.ts:262`). **The critic does only what code can't** — it never re-litigates DC
  range or overrides `applyOutcomeToMutations`.
- [!] **The critic IS a baby pipeline** — `decide → critique → correct`, a single extra stage. File
  it as the first 30% of v10's Thread D: the safest slice of decomposition, and the place we measure
  the latency/quality trade-off before the full classify→decide→resolve rebuild.

### 2a. When it kicks in — triggered, not blanket-applied

Run the critic only when one of three triggers fires (OR'd). Most beats trip none → near-zero cost.

- [I] **Always on the resolution beat** (`rollOutcome` present). This is the irreversible output —
  `outcome_text` + mutations hit the world and the player. Highest stakes, always check.
- [I] **When `validateDecision` already raised ≥1 warning.** The deterministic layer flags cheaply;
  the critic only spins up where there's smoke, and adjudicates whether the warning is a real defect.
  This is the main cost lever — clean beats never invoke it.
- [I] **High-stakes authoring beats** — `required: true` / combat / detected intent-mismatch with
  `rawInput`.
- [-] Skip pure travel/rest decisions with no warnings.

### 2b. What it references — anchor every check to engine truth

The trap is a critic that just re-reads the prose and second-guesses the same model. To earn its
latency it checks against facts the engine owns, in three tiers:

- [I] **Hard anchors (engine truth — a mismatch is a defect):** the **roll verdict** (`rollOutcome`)
  the narration must match; the **final mutations** (post-`applyOutcomeToMutations`) the
  `outcome_text` must reference (the wound, the item, the journey); the **character/world state in
  context** (don't narrate full HP at 2/10, don't cite an NPC absent from `nearbyNpcs`, don't grant
  an item the player can't have); the player's **`rawInput`** (was intent honoured — v8 §0a, never
  silently convert combat).
- [I] **Soft anchors (rules from `decision-v9.md`):** no dead turn, success carries a reward, the
  Warden secret is never stated outright, the security fence holds.
- [I] **Self-consistency:** `outcome_text` ↔ mutations ↔ option set internally agree.
- [I] **Hand the critic the validator's warnings as its checklist** — it adjudicates concrete
  suspicions, not free associations.
- [c] **Ceiling, honestly:** without v10 scene-state there's no `enemyHp` truth to anchor against, so
  "boar near death stays near death across rounds" is **not** checkable in v9. The critic is strongest
  on within-response and against-context checks now, and *grows* when v10 adds scene-state anchors.

### 2c. How the corrected state is derived — the ladder

Cheapest first, deterministic layer last, one pass only:

```
decide() → deterministic normalise (validate + applyOutcomeToMutations + toActionDecision)
        → gate? ──no──────────────────────────────────────────► emit
        → critic (sees: context digest + normalised decision + verdict + FINAL mutations + warnings)
            ├─ ok ───────────────────────────────────────────► emit
            ├─ minor → patch prose only (outcome_text / labels)
            └─ major (wrong intent, dead turn, structural) → re-decide() once, issues as guidance
                 → re-run deterministic normalise   ← critic output is NEVER trusted raw
                 → still flagged? → emit the normalised original (safe, maybe slightly off)
```

- [I] **Critic contract:** returns `{ ok, severity, issues[], patch? }`. Prefer a **targeted patch**
  (mostly `outcome_text`/labels) over a full rewrite — least collateral.
- [!] **Re-normalise the critic's output.** Whatever it emits goes back through
  `applyOutcomeToMutations` / `toActionDecision`, so it can never reintroduce a banned state (e.g.
  sneak a reward onto a failure).
- [!] **One pass, hard cap.** No critic-of-critic loop. If still flagged after one correction/retry,
  emit the deterministic-safe original — incoherent prose beats an infinite spin or a fabricated
  scene.
- [I] **Bias to non-intervention.** The critic prompt corrects only on *confident, concrete*
  contradictions; when in doubt, pass. Over-correction is pure latency + churn.

### Wiring — the one `machine.ts` touch

- [!] **A transparent decorator is not enough for the resolution beat.** `CritiquedLlmGateway`
  (wrapping the Deepseek gateway like `FallbackLlmGateway` does) works cleanly for **decision-
  authoring** beats. But the resolution critic must see the mutations *after*
  `applyOutcomeToMutations` — and that stripping happens in `resolveWithRoll` (`machine.ts:248`),
  downstream of the gateway. A pure decorator would critique pre-strip mutations and bless prose that
  then mismatches the stripped set. So: keep the decorator for decision beats, and add **one explicit
  critic hook inside `resolveWithRoll`, after `applyOutcomeToMutations`**, where the verdict and final
  mutations both exist. Small, surgical — and necessary for correctness.
- [?] **Critic prompt asset layout.** Recommend a **versioned** `assets/prompts/critic/critic-v1.md`
  + a `CRITIC_VERSION` constant, so critic verdicts are attributable in `llm_calls` exactly like
  decisions are (mirrors, and stays inside, the `AGENTS.md` system-prompt convention).
- [c] **+1 call per gated beat** — record critic calls in `llm_calls` (a new call-kind tag) and watch
  the tail.

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
  `CRITIC_VERSION` own Thread 2's decision-beat path (wired in where the gateway is constructed).
- [>] **`machine.resolveWithRoll`** (`machine.ts:231`) owns the resolution-beat critic hook — one
  explicit call after `applyOutcomeToMutations`, so the critic sees the verdict + final mutations.

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
- [ ] The critic fires only on its triggers (resolution beat / validator-warning / high-stakes) and
  is skipped on clean travel/rest. It corrects **prose only** against engine truth (verdict, final
  mutations, context state, intent), its output is re-normalised through the deterministic layer, it
  caps at one pass, and on an unresolved flag it falls back to the deterministic-safe original. Critic
  calls are recorded in `llm_calls` for mining.

## Handoff checklist (suggested implementation order)

1. [ ] **Thread 1** — markdown `buildUserMessage`; new `decision-v9.md` + `PROMPT_VERSION` bump +
   `current_source.md` mirror; diff v8 rules forward. Ship & measure alone.
2. [ ] **Thread 2** — `CritiquedLlmGateway` decorator (decision beats) + the `resolveWithRoll` hook
   (resolution beat, after `applyOutcomeToMutations`) + `critic-v1.md` + `CRITIC_VERSION`. Implement
   the trigger set, the three reference tiers, the prose-only correction ladder (patch → re-decide
   once → deterministic-safe fallback), and re-normalise critic output. Record critic calls.
