---
title: World Tick — Daily Simulation
status: exploring
domain: engine
phase: poc
tags:
- poc
- build-plan
- tick
related:
- '[[poc-build-plan]]'
- '[[poc-build-scaffold]]'
- '[[poc-build-probabilistic]]'
---

# World Tick — Daily Simulation

> *Part of [[poc-build-plan]]. Extracted from polish. The daily tick: day advance, player state updates, NPC movement, and world scaling.*

---

## 1. Trigger

| Trigger | Behaviour |
|---|---|
| **Admin `/sleep`** | Gated to a configured Discord user ID (env var `ADMIN_USER_ID`). Advances the world immediately. **No cooldown** — admin can tick multiple times in one real day for testing. |
| **Cron (3:30 UTC)** | Fires exactly once per real day. If the admin already ticked today, cron is a no-op. Night-owl friendly. |

Cooldown tracking: store `last_cron_date` in memory or a small `meta` table. Compare against current UTC date.

---

## 2. Player Effects

For every player in `player_characters`:

| Effect | Rule |
|---|---|
| **Unused rolls lost** | If `rolls_remaining > 0`, set to 0. |
| **Safe location recovery** | If `locations.is_safe = 1` for the player's current location: `stamina = MIN(stamina + 5, 10)`, `health = MIN(health + 3, max_health)`. |
| **Wilds decay** | If NOT at a safe location: `stamina = MAX(stamina - 1, 0)`. |
| **Day-job income** | `wealth += base_income` from `day-jobs.yml` matching the player's `day_job`. Always applies regardless of location. |
| **Roll reset** | `rolls_remaining = 2`. |
| **Day counter** | Increment global day counter. |

### Consolation for unused rolls

Players who didn't use all their rolls still get income and recovery. They sacrificed potential adventure for safety — that's a valid choice.

---

## 3. NPC Effects

For every NPC in `npcs`:

**80% chance to move.** Destination determined by `day_job`. Movement is deterministic — same NPC with same day_job always moves to the same type of location.

| Day-job | Movement pattern |
|---|---|
| Blacksmith | Stays at current location. `wealth += 5` (worked the forge). |
| Hunter | Moves to a random `locations` row where `tags` matches `wilderness` or `forest`. |
| Merchant | Moves to a random `locations` row where `tags` matches `town`, `market`, or `square`. `wealth += random(5, 15)`. |
| Herbalist | Moves to a random `locations` row where `tags` matches `forest` or `river`. |
| Acolyte | Moves to the `locations` row where `tags` matches `shrine` or `temple` (first match). |
| (none / other) | Moves to a random row from `locations`. |

Movement is deterministic: seed the random pick with `NPC.id + day_number` so the same NPC on the same day always moves to the same place. No stored RNG state needed.

---

## 4. World Scaling

Minimal for POC — the LLM prompt gains a scaling hint.

| Day range | Effect |
|---|---|
| Day 1-3 | Base state. DC range in LLM prompt: 8-16. |
| Day 4-7 | "The smoke is closer now." DC range: 9-17. Threat flavor escalates. |

The bot passes `day_number` and the scaling hint in the LLM system prompt. The LLM uses it to generate more tense scenarios as days progress.

---

## 5. Day Transition Message

When the tick fires, post to a configurable Discord channel (env var `TICK_CHANNEL_ID`):

```
🌅 Day {N} begins.

{scaling_flavor}

The Oak awaits. /hi to begin.
```

Scaling flavors:
- Day 1-3: *"The warden watches the horizon. The fire crackles, steady and low."*
- Day 4-7: *"The smoke on the eastern horizon has thickened. The warden hasn't spoken since yesterday."*

---

## 6. `/sleep` Command

Admin-only slash command. No arguments.

**Behaviour:**
1. Check `interaction.user.id === ADMIN_USER_ID`. If not → ephemeral "Only the warden may turn the hourglass."
2. Run the full tick (sections 2-5).
3. Reply (visible to channel): day transition message.

**No cooldown for admin.** Typing `/sleep` five times advances five days. Useful for testing the DC creep and NPC movement patterns.
