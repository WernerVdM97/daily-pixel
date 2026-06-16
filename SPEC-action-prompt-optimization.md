# Spec — `/action` Loop Prompt Optimization

**Status:** proposed
**Owner:** Werner
**Date:** 2026-06-16
**Branch context:** `poc-beta-release`
**Target artifact:** `assets/prompts/decision-prompts/decision-v6.md` + `src/llm/prompt-builder.ts`

---

## 1. Problem

The `/action` loop LLM (`deepseek-v4-flash`, prompt `v5`) spends large amounts of
reasoning on **game-state ambiguity** rather than narrative generation. Diagnosed via
`node scripts/llm-thinking-analysis.mjs 5 --include-think` plus an aggregate over the
`llm_calls` audit table.

### Evidence

| Cohort | n | avg think (chars) | max think | avg completion tok | avg latency |
|---|---|---|---|---|---|
| first call (`prev_decisions=0`) | 33 | 2,227 | 8,459 | 764 | 9.6s |
| follow-up (`prev_decisions>0`) | 54 | 3,048 | 10,424 | 955 | 12.2s |

Follow-up calls think ~37% more and run ~27% slower. The largest-thinking calls
(IDs 60 @10.4k, 86 @7.0k) are all follow-ups carrying a `PREVIOUS DECISIONS` block
but **no `ROLL RESULT`** line.

### Two distinct failure modes

**A. Phase ambiguity (follow-up calls).** The model cannot tell from the input whether
a prior choice has already been mechanically resolved or whether it must resolve it now.
Root cause: `buildUserMessage` (`src/llm/prompt-builder.ts:59-64`) emits each prior
decision as `prompt → chosen (dc_modifier)` and **omits the outcome**. The prompt has
two narration regimes (Rule 1b "decisions advance" vs Rule 4b "narrate the roll"), but
the input only signals the second one (via `ROLL RESULT`); the *absence* of that line is
ambiguous rather than meaningful. The model reconstructs the loop state machine from prose
and guesses. Verbatim from call ID 60:
> "the PREVIOUS DECISIONS only shows the prompt and the choice, **not the outcome** ... so the action hasn't been rolled yet? ... I'm confused."

This is also a **correctness hazard**: in call ID 86 the model, lacking a verdict,
adjudicated the roll itself (invented `base_dc 14`, computed odds, declared success) and
emitted `modify_wealth +7`. In a roll-first architecture where the engine owns the dice,
that is double-resolution.

**B. Schema friction (first calls).** Rule 5 demands a mix of options "clever (wisdom),
direct (physical), social (charisma)", but the JSON contract exposes a single global
`stat`. The model burns ~1–2k chars reconciling this, then speculates about per-option
mutation rewards that the schema does not support (mutations fire only on `done:true`,
never per option). Verbatim from call ID 58:
> "if I make a wisdom-based option, it would still roll against physical ... The model doesn't support per-option stats."

---

## 2. Goals

- **G1.** Eliminate phase-inference reasoning on follow-up calls.
- **G2.** Make it structurally impossible for the model to re-derive a DC or self-adjudicate
  a roll the engine owns.
- **G3.** Remove the per-option-stat contradiction so the model stops fighting the schema.
- **G4.** Reduce backtracking caused by late-discovered constraints.

### Non-goals

- No change to game mechanics, mutation types, or the engine's roll math.
- No model swap or temperature tuning (separate investigation).
- The `THINKING: 4/5 sentences` budget is **not** to be hardened with stronger wording —
  verbosity is a symptom of ambiguity, addressed by G1–G3.

---

## 3. Proposed changes (ranked by payoff / effort)

### Lever 1 — Make loop phase explicit in the input *(highest payoff)*
`src/llm/prompt-builder.ts`:
- Append the resolved outcome to each prior decision:
  `… → chose "<label>" → RESOLVED (success|failure)` instead of choice-only.
- Add an explicit `PHASE:` line: one of `NEW_ACTION` | `RESOLVE_ROLL` | `CONTINUE`.
  The engine knows this; the model must not infer it.

### Lever 2 — Never let the model own the dice
- When `PHASE: RESOLVE_ROLL`, pass the established `base_dc` from the opening beat back
  in context alongside `ROLL RESULT`. The model should never reach a state requiring it
  to choose success/failure or invent a DC.

### Lever 3 — Resolve the per-option-stat tension *(cheap, immediate)*
`decision-v6.md`, Rule 5: add one sentence —
> "All options test the single `stat` field. Vary the fiction and the `dc_modifier`,
> never the stat. Do not assign different stats per option."
- (Stretch / separate decision: add per-option `stat` to the schema, since the model
  clearly wants stat variety the contract forbids. Record as a `decisions/` ADR if pursued.)

### Lever 4 — Front-load a pre-flight checklist
`decision-v6.md`, immediately above the JSON CONTRACT, a 4-line ordered check:
1. Which `PHASE`?
2. If `done:true`: ≥1 positive mutation on success; only costs on failure.
3. `outcome_text` references every mutation.
4. `set_location` uses an exact name from the scaling hint.

This pulls forward constraints currently buried ~100 lines deep that force mid-thought
revision (observed in call ID 86 revising itself twice).

---

## 4. Acceptance criteria

- **AC1.** A new prompt version `decision-v6.md` is cut following the versioning protocol
  in `prompt-builder.ts` (copy v5 → v6, edit, bump `PROMPT_VERSION`, sync `current_source.md`).
  Old `v5` file retained for history.
- **AC2.** `buildUserMessage` emits a `PHASE:` line and per-decision `RESOLVED (outcome)`
  suffix; covered by unit tests.
- **AC3.** No `RESOLVE_ROLL` call reaches the model without both `ROLL RESULT` and the
  originating `base_dc`.
- **AC4.** Measured over a fresh play session on `v6`, follow-up-call median
  `reasoning_chars` drops meaningfully vs the `v5` baseline above (re-run
  `scripts/llm-thinking-analysis.mjs` and the cohort aggregate; target: follow-up avg
  think within ~20% of first-call avg, down from +37%).
- **AC5.** Zero observed instances of the model inventing a `base_dc` or declaring a roll
  verdict in `--include-think` output on `v6`.

---

## 5. Risks & caveats

- **Sample quality.** The diagnostic corpus is small (87 calls) and partly synthetic —
  calls 58 and 60 are the same input (`"sharpen my bow for the hunt"`) at `prev=0` and
  `prev=2`, indicating replay/test traffic. Confirm Mode A's frequency on real play before
  over-investing. Suggested pre-work query: count follow-ups arriving with decision history
  but no roll result.
- **Per-option `stat` (Lever 3 stretch)** is a contract change touching the engine's roll
  resolution and the response validator — out of scope for v6 unless explicitly decided.
- The `PROMPT_VERSION` bump invalidates direct cross-version comparison in the audit table;
  use the `prompt_version` column to segment, do not pool v5 and v6 rows.

---

## 6. Verification

```
# Before (v5 baseline — already captured in §1)
node scripts/llm-thinking-analysis.mjs 5 --include-think

# After cutting v6 + a play session
node scripts/llm-thinking-analysis.mjs 5 --include-think   # inspect spirals are gone
# re-run the cohort aggregate (first-call vs follow-up think size) per AC4
```
