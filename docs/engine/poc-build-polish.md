---
title: POC Build — Polish
status: exploring
domain: engine
phase: poc
tags:
- poc
- build-plan
related:
- '[[poc-build-plan]]'
- '[[poc-build-scaffold]]'
- '[[poc-build-probabilistic]]'
---

# POC Build — Polish

> *Part of [[poc-build-plan]]. Error handling, LLM fallback, outcome rendering, idle messages, help content, and pre-deploy final pass. `/sleep` tick moved to [[world-tick]].*

---

## 1. Error Handling

| Error | Response |
|---|---|
| Invalid command | Ephemeral: "Unknown command. Try `/help`." |
| No rolls remaining | Ephemeral: "The day is done. Rest at the Oak, or `/sleep` to advance." |
| Already mid-action | Ephemeral: "You're already in the middle of something. `/hi` to resume." |
| DB error | Log to console. Player sees: "Something went wrong. The warden has been notified." |
| Discord API error (rate limit, timeout) | Retry with exponential backoff (1s, 2s, 4s). Max 3 retries. |
| Stale button click (expired interaction) | Ephemeral: "This action has expired. Try `/hi`." |
| `/join` when character exists | Ephemeral: "You already have a character." |
| `/join` timeout (10 min inactivity) | Ephemeral: "Timed out. Try `/join` again." |
| LLM API error (see section 2) | Two-tier fallback. |
| Malformed mutations from LLM | Invalid entries silently dropped. Valid ones applied. Log the drops for review. |

---

## 2. LLM Fallback

Two-tier. Fallback rate tracked — if >10% of actions hit fallback, revisit prompt or provider.

### Tier 1 — Simpler retry

On first failure (malformed JSON, timeout >5s, or API error), retry with stripped prompt:

```
SYSTEM: You are the game master for a text-based Discord RPG.
Generate one simple decision. Return JSON only.

Rules: distilled_type (single word), stat (physical/wisdom/intelligence/charisma),
base_dc (8-18), required (true/false), done (false), decision (2-4 options, 
dc_modifier -5 to +5, null = bail).

CHARACTER: {class, stats, health, stamina}
PLAYER INPUT: {raw_input}
```

No NPCs, no location, no history. Just character basics + raw input.

### Tier 2 — Divine intervention

If retry also fails:

> *"A flash of light. The warden's hand on your shoulder. You wake beneath the Oak, your action lost to forces beyond mortal ken."*

- Roll IS NOT refunded
- `last_action_state` cleared
- No action row inserted
- Log the double-failure for review

---

## 3. Outcome Rendering

The final LLM response includes `outcome_text` — the LLM narrates the result in one sentence. The bot renders deterministic consequences below.

### Success example

```
🎲 16 vs 14 ✓ Success

The wolfsbane flares. The beast recoils, shrinking to the size of
a common wolf before limping into the dark.

+ Wolf Pelt ┃ Stamina: 8/10 ┃ Rolls: 1/2
```

### Failure example

```
🎲 3 vs 14 ✗ Failure

You lunge but the shale gives way beneath you. The beast is gone
before you find your feet, and your ankle throbs with every step back.

Stamina: 7/10 ┃ Rolls: 1/2
```

### Skipped example

```
↩ Skipped

You slip back into the brush. The hunt is lost, but your hide is whole.

Stamina: 9/10 ┃ Rolls: 1/2
```

### Timed out example

```
⏰ Timed out

The moment passes. Whatever you were doing, it's gone now.

Stamina: 8/10 ┃ Rolls: 1/2
```

### Deterministic summary rules

- Items gained: `+ {emoji} {name}`
- Items lost: `- {name}`
- Location change: `→ {new_location}`
- Stats: shown in footer (stamina, rolls remaining). Health shown only if changed.
- Wealth: shown only if changed.
- NPCs spawned: mentioned inline in the `outcome_text` by the LLM, not in summary.

---

## 4. Idle State Messages

Shown while the bot waits for an LLM response (<5s). Picked randomly:

- "The warden tends the fire."
- "A crow watches from the Oak."
- "The ember glows faintly."
- "The wind carries smoke from the east."
- "The old boards creak beneath your feet."

---

## 5. Help Content

`/help` structure defined in scaffold. Polish provides the content:

### Command list

```
/hi        — Begin your day. The Oak awaits.
/action    — Take an action. Describe what you want to do.
/look      — Survey your surroundings.
/journal   — Browse your journal: locations, NPCs, recent actions.
/backpack  — Check your inventory.
/stats     — View your character sheet.
/sleep     — Advance to the next day.
/bug       — Report a bug.
/feedback  — Share your thoughts.
```

### Economy

```
You have 2 rolls per day.
Each /action consumes 1 roll.
Use /sleep to advance to the next day and regain your rolls.
Optional actions can be skipped (Bail or Skip button).
Required actions (attacked, cornered) cannot be skipped.
```

---

## 6. Pre-Deploy Final Pass

Run the full flow end-to-end before shipping:

- [ ] `/join` → full wizard → confirm → character in DB
- [ ] `/hi` → atmosphere → hooks → pick day-job action
- [ ] `/action hunt` → idle message → decisions → roll → outcome
- [ ] `/look` → scene display with correct location
- [ ] `/backpack` → items grid (starting items from join)
- [ ] `/stats` → full sheet with correct values
- [ ] `/hi` again → cached scene, no regeneration
- [ ] `/sleep` → day advanced, rolls reset
- [ ] `/hi` after sleep → new day, new hooks
- [ ] LLM failure → tier 1 retry → tier 2 divine intervention
- [ ] Mid-action disconnect → `/hi` resume from last decision
- [ ] 30-minute timeout → auto-fail message
- [ ] `/bug` and `/feedback` → rows in DB
- [ ] Mobile: full `/action` flow on phone Discord
- [ ] Check all text for typos
- [ ] Verify SQLite file persists across bot restart
