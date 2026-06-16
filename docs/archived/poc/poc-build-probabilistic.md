---
title: POC Build — Probabilistic Actions
status: shipped
domain: archived
superseded_by: "implemented in code"
phase: poc
tags:
- poc
- build-plan
- llm
related:
- '[[poc-build-poa]]'
- '[[poc-build-scaffold]]'
- '[[poc-spec-reconciliation]]'
---

# POC Build — Probabilistic Actions

> *Part of [[poc-build-poa]]. The core game loop: `/action` → reactive LLM decisions → DC adjustment → roll or skip → outcome → persistence. One LLM call per decision for true narrative branching.*

---

## 1. Action Lifecycle

One action = one Discord message edited through states. Roll consumed immediately on invoke.

```
/action go hunt a wolf
        │
        ▼
┌──────────────────────────────────────┐
│ 1. VALIDATE                           │
│    Alive? Has rolls? Not mid-action?  │
│    → Consume 1 roll. Save raw input.  │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ 2. LLM CALL (decision 1)             │
│    Prompt: character + location +    │
│    nearby NPCs + nearby PCs +        │
│    last 2 actions + raw input        │
│    → Parse JSON. Save state to       │
│      last_action_state.              │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ 3. DECISION LOOP (reactive)          │
│    Render decision + buttons.        │
│    On pick → apply dc_modifier,      │
│    call LLM again with previous      │
│    choices in context.               │
│    Repeat until done: true.          │
│    Max calls: 2 (weekday), 3 (Fri),  │
│    4 (Sat), 3 (Sun).                 │
│    30-min timeout → auto-fail.       │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ 4. ROLL OR SKIP                       │
│    Show final DC. [Roll d20] [Skip]. │
│    Skip only if required: false.      │
│    Skip → wisdom check vs DC.        │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ 5. OUTCOME + MUTATIONS               │
│    Final LLM call returns mutations. │
│    Bot validates + applies to DB.    │
│    Template outcome text.            │
│    INSERT actions. Clear state.      │
└──────────────────────────────────────┘
```

---

## 2. LLM Contract

**Model:** DeepSeek V4 Flash.

**Prompt storage:** all system/prompt templates live in `assets/prompts/` at the repo root, loaded + validated at boot like the other assets ([[poc-build-scaffold]] startup sequence) — never inlined in code. One file per prompt (e.g. `assets/prompts/decision.md`, `assets/prompts/fallback.md`), referenced by name.

**Pattern:** Reactive — one LLM call per decision. Previous choices feed into the next prompt for true narrative branching. The mutations block only appears in the final call.

### Prompt template

The system prompt is **`assets/prompts/decision.md`** (loaded at boot, see [[poc-build-scaffold]]). The bot fills the `{…}` placeholders with character, location, nearby NPCs/PCs, and recent actions. On **call 2+**, the running `PREVIOUS DECISIONS` block is appended so prior choices feed the next decision for true narrative branching:

```
PREVIOUS DECISIONS:
1. "Elder Bram catches your arm..." → chose: "Take the wolfsbane" (-2, DC now 13)
2. "You find the tracks heading east..." → chose: "Circle wide" (-2, DC now 11)
```

### Response JSON — decision (not done)

```json
{
  "distilled_type": "hunt",
  "stat": "wisdom",
  "base_dc": 15,
  "required": false,
  "done": false,
  "decision": {
    "prompt": "Elder Bram catches your arm. 'The grey one's been taking sheep from the east fold...'",
    "options": [
      { "label": "Take the wolfsbane", "dc_modifier": -2 },
      { "label": "Decline — I'll use steel", "dc_modifier": 0 },
      { "label": "Ask Bram what else he knows", "dc_modifier": -1 },
      { "label": "Bail", "dc_modifier": null }
    ]
  }
}
```

### Response JSON — final (done, with mutations)

```json
{
  "distilled_type": "hunt",
  "stat": "wisdom",
  "done": true,
  "outcome_text": "The wolfsbane flares; the beast recoils and limps into the dark.",
  "mutations": {
    "health_delta": 0,
    "stamina_delta": -1,
    "wealth_delta": 5,
    "items_gained": [
      { "name": "Wolf Pelt", "emoji": "🐺", "stat": "physical", "modifier": 1 }
    ],
    "items_lost": ["Wolfsbane"],
    "npcs_spawned": [
      { "name": "Grey Wolf", "class": "Beast", "description": "Wounded, limping east" }
    ],
    "new_location": {
      "name": "The Eastern Thicket",
      "description": "A dense stand of ancient oaks, their branches tangled like old fingers.",
      "tags": "forest, dark, eastern, ancient",
      "is_safe": 0
    }
  }
}
```

### Constraints

| Rule | Value |
|---|---|
| Max calls per action | 2 (Mon-Thu), 3 (Fri), 4 (Sat), 3 (Sun). LLM can signal `done: true` earlier. |
| Options per decision | 2-4 |
| `dc_modifier` range | -5 to +5. `null` = bail. |
| `required` | `true` blocks [Skip] button. Only set for reactive actions. |
| Malformed JSON | Retry once with same prompt. If still invalid → fallback to generic decision. |
| LLM timeout | >5s → fallback to generic. |
| `distilled_type` + `base_dc` + `stat` | Included in every response. Bot uses first values, ignores repeats. |

---

## 3. Roll Mechanics

### DC calculation

```
running_dc = base_dc
For each decision: running_dc += chosen_option.dc_modifier
item_bonus = SUM(items.modifier WHERE items.stat = action.stat AND items.character_id = player)
final_dc = running_dc - item_bonus
```

`dc_modifier` is literal and signed — added per decision as the player progresses. **Negative = a good decision that lowers difficulty (easier); positive = raises it (harder).** Items matching the action's stat also reduce the final DC (they help).

### d20 Roll

```
roll = Math.floor(Math.random() * 20) + 1
roll >= final_dc → success
roll <  final_dc → failure
```

Pure d20. No player stat added to the roll directly — stats express through items, class modifiers, and skip checks.

### Skip / Bail

| Trigger | Result |
|---|---|
| Player picks "Bail" option (`dc_modifier: null`) | Action ends as `skipped`. No wisdom check, no stamina penalty. |
| Player clicks [Skip] at final roll step | Only if `required: false`. Wisdom check: `d20 + wisdom_modifier >= final_dc`. Pass = clean skip. Fail = `skipped` + -1 stamina. |
| `required: true` | [Skip] button hidden. Must roll. |
| 30-min timeout | Auto-fail. `timed_out`. -1 stamina. |

---

## 4. Outcome Resolution

### Outcome text

The final (`done: true`) LLM call returns `outcome_text` — one narrated sentence (see [[poc-spec-reconciliation]] D1). Templates are the **fallback**, not the default: if the final call fails, malforms, or times out, pick a template variant and **log the fallback**.

| Outcome | Source |
|---|---|
| `success` | LLM `outcome_text`. Fallback: 3-5 variants per distilled_type, picked randomly |
| `failure` | LLM `outcome_text`. Fallback: 3-5 variants per distilled_type, picked randomly |
| `skipped` | 3-5 generic variants (no LLM call on bail/skip) |
| `timed_out` | 1 variant: "The moment passes. Whatever you were doing, it's gone now." |

Render format: `"🎲 {roll} vs {dc} {'✓'|'✗'} {outcome_text}"`. Rendering detail in [[poc-build-polish]] §3.

### Mutation application

The final LLM response includes a `mutations` block. The bot validates then applies:

| Field | Validation | DB action |
|---|---|---|
| `health_delta` | `health + delta` must be 0–max_health | `UPDATE player_characters SET health = health + delta` |
| `stamina_delta` | `stamina + delta` must be 0–10 | `UPDATE player_characters SET stamina = stamina + delta` |
| `wealth_delta` | `wealth + delta` must be ≥ 0 | `UPDATE player_characters SET wealth = wealth + delta` |
| `items_gained` | Max 3 items. Each needs `name`, `emoji`, `stat`, `modifier` | `INSERT INTO items` |
| `items_lost` | Must exist in player's inventory. Max 3. | `DELETE FROM items` (or decrement quantity) |
| `npcs_spawned` | Max 2 NPCs. Each needs `name`, `class`, `description` | `INSERT INTO npcs` |
| `location_change` | Must differ from current location | `UPDATE player_characters SET location` |
| `new_location` | Required if `location_change` is set. `{name, description, tags, is_safe}` | `INSERT INTO locations` if new |

Invalid mutations are silently dropped. Valid ones applied atomically with the `actions` INSERT. `last_action_state` cleared to NULL after commit.

---

## 5. Mid-Action State Persistence

Saved to `player_characters.last_action_state` after every LLM response. Enables `/hi` resumption.

```json
{
  "raw_input": "go hunt a wolf",
  "distilled_type": "hunt",
  "stat": "wisdom",
  "base_dc": 15,
  "required": false,
  "running_dc": 13,
  "decision_index": 1,
  "max_decisions": 4,
  "decisions_so_far": [
    {
      "prompt": "Elder Bram catches your arm...",
      "options": [
        { "label": "Take the wolfsbane", "dc_modifier": -2 },
        { "label": "Decline", "dc_modifier": 0 },
        { "label": "Ask Bram", "dc_modifier": -1 },
        { "label": "Bail", "dc_modifier": null }
      ],
      "chosen": "Take the wolfsbane"
    }
  ],
  "started_at": "2026-06-15T14:30:00Z"
}
```

**Resumption:** `/hi` → [Begin] → bot reads `last_action_state`, calls LLM with full context including `decisions_so_far`.

**Timeout:** if `started_at + 30min < now()`, action is auto-failed on next interaction.

---

## 6. Edge Cases

| Case | Handling |
|---|---|
| No rolls remaining | Ephemeral: "The day is done. `/sleep` to make camp by the Oak — the world turns at nightfall." |
| Already mid-action | Ephemeral: "You're already in the middle of something. `/hi` to resume." |
| LLM API unavailable | Fallback to hardcoded generic decision. Track fallback rate. |
| LLM malformed JSON | Retry once. Still invalid → fallback. |
| LLM timeout (>5s) | Fallback to generic. Log failure. |
| Player disconnects mid-action | State in `last_action_state`. `/hi` resumes. |
| 30-min timeout | Auto-fail. -1 stamina. Outcome shown. State cleared. |
| Player dead (health ≤ 0) | Show death message. All commands blocked. |
| Player picks "Bail" | Action ends as `skipped`. No wisdom check. No stamina penalty. |
| Malformed mutations | Bot validates. Invalid entries silently dropped. |

---

## 7. Slash Command

`/action <description>` — free text, no fixed choices.

**Registration:** single string option. Description: "Take an action. Describe what you want to do."

**Validation at invoke:**
1. `description` not empty, ≤ 200 characters
2. Player exists in `player_characters`
3. `health > 0`
4. `rolls_remaining > 0`
5. `last_action_state IS NULL`

All failures → ephemeral reply. Pass → consume 1 roll, begin LLM loop.

---

## 8. Discord Rendering

One message per action, edited through states.

| State | Content |
|---|---|
| Loading | "The warden considers your request..." (shown while LLM responds) |
| Decision N | ASCII scene (from location) + `decision.prompt` + buttons (one per option) |
| Final | DC displayed + [Roll d20] + [Skip] (hidden if `required: true`) |
| Outcome | Scene + roll emoji + result text + consequences + rolls/stamina footer |

After outcome the message is final. Next `/action` creates a new message.

---

## S3 Handover

- [x] **Shipped:** Action state machine end-to-end — `ActionStateMachine` (start/step/resume with `LlmGateway` injection, reactive decision loop, bail=skip, roll resolution with nat1/nat20), `DeepseekLlmGateway` (OpenAI-compatible client for DeepSeek V4 Flash, JSON mode, injectable fetch, error handling — source: api-docs.deepseek.com), DC math (`accumulateDc` clamped [0,30], `computeItemBonus` per-stat with quantity, `resolveRoll` d20+b vs DC), mutation validator (8 types, bounds checks, multi-error return) + applier (health/stamina/wealth/rolls/location/items/npcs), `WorldEngineImpl` (real engine: startAction drains roll → persists state, stepAction validates→continues or resolves with transaction-wrapped mutations+action insert, resumeAction sync from `last_action_state` JSON), 5 new repos (Item, Action, Npc, Location, Meta).
- [!] **Frozen:** `ActionStateMachine` (public API: `start(char, rawInput, items) → {state, firstDecision}`, `step(state, choice, char, items) → StepResult`, `resume(state) → {state, nextDecision}` — injectable `LlmGateway` + `rollD20`), `InternalActionState` (extends `ActionState` with `pendingDecision`, `distilledType`, `rollStat` — stored in `last_action_state` JSON), `DeepseekLlmGateway` (constructor takes `DeepseekConfig: {apiKey, model?, temperature?, fetch?}`), `validateMutations(mutations, ctx) → ValidationResult`, `applyMutations(mutations, ctx) → AppliedState`. `LlmDecision.prompt?` (optional string, added to frozen interface — backward compatible).
- [x] **Tests:** 250 passing (110 new), 24 files. Run: `cd ~/projects/daily-pixel && npx vitest run`. `tsc --noEmit` clean. New files: `tests/llm/deepseek-gateway.test.ts` (26), `tests/engine/action-dc.test.ts` (20), `tests/engine/action-machine.test.ts` (13), `tests/engine/action-mutations.test.ts` (34), `tests/engine/world-engine-impl.test.ts` (17).
- [>] **Next (S4):** Action polish — two-tier LLM fallback, template fallback for `outcome_text` (logged), error mapper, idle messages, outcome rendering. Start from `src/llm/DeepseekLlmGateway.ts` → build the fallback chain (primary → retry → simpler prompt → template/divine fallback), then wire into `WorldEngineImpl.stepAction()` error paths. See `docs/engine/poc-build-poa.md` §5 for S4 scope — inject failing mocks to test degradation tiers.
