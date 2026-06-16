---
title: World Tick — Daily Simulation
status: shipped
domain: archived
superseded_by: "implemented in code"
phase: poc
tags:
- poc
- build-plan
- tick
related:
- '[[poc-build-poa]]'
- '[[poc-build-scaffold]]'
- '[[poc-build-probabilistic]]'
- '[[poc-spec-reconciliation]]'
---

# World Tick — Daily Simulation

> *Part of [[poc-build-poa]]. Extracted from polish. The daily tick: day advance, player state updates, NPC movement, and world scaling.*

---

## 1. Trigger

| Trigger | Behaviour |
|---|---|
| **Admin `/sleep`** | Gated to a configured Discord user ID (env var `ADMIN_USER_ID`). Advances the world immediately. **No cooldown** — admin can tick multiple times in one real day for testing. |
| **Cron (3:30 UTC)** | Fires exactly once per real day. If the admin already ticked today, cron is a no-op. Night-owl friendly. |

Cooldown tracking: store `last_cron_date` in the `meta` table ([[poc-build-scaffold]]). Compare against current UTC date. The `day_number` counter lives in the same table.

Only these two advance the world. A **non-admin `/sleep`** is *not* a tick trigger — it returns a rest scene and changes nothing (see §6).

- [x] `tick(isAdmin)` implements both paths: `true` = always advance, `false` = cron idempotent check.
- [x] `last_cron_date` written to `meta` on every tick (admin + cron).

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
| **Day counter** | Increment `meta.day_number`. |

- [x] All player effects implemented: stamina recovery/decay, health recovery (safe only), wealth income, roll reset, day_number increment.
- [x] Engine accepts `dayJobIncome: Record<string, number>` in config (parsed from day-jobs.yml at boot on frontend side).

### Consolation for unused rolls

Players who didn't use all their rolls still get income and recovery. They sacrificed potential adventure for safety — that's a valid choice.

---

## 3. NPC Effects

For every NPC in `npcs`:

**80% chance to move.** Destination determined by `class` (the only role field populated at spawn — see [[poc-build-scaffold]] `npcs`). Movement is deterministic — same NPC with same class always moves to the same type of location.

| Class | Movement pattern |
|---|---|
| Blacksmith | Stays at current location. `wealth += 5` (worked the forge). |
| Hunter | Moves to a random `locations` row where `tags` matches `wilderness` or `forest`. |
| Merchant | Moves to a random `locations` row where `tags` matches `town`, `market`, or `square`. `wealth += random(5, 15)`. |
| Herbalist | Moves to a random `locations` row where `tags` matches `forest` or `river`. |
| Acolyte | Moves to the `locations` row where `tags` matches `shrine` or `temple` (first match). |
| (none / other) | Moves to a random row from `locations`. |

Movement is deterministic: seed the random pick with `NPC.id + day_number` so the same NPC on the same day always moves to the same place. No stored RNG state needed.

- [x] Seeded determinism via `mulberry32(NPC.id + newDay)`.
- [x] Class-based destination filtering with fallback to all locations.
- [x] Current location excluded from candidates so NPCs truly "move".
- [x] Merchant wealth gain (5-15) on both move and no-move paths.
- [x] Blacksmith stays put and gains +5 wealth.

---

## 4. World Scaling

Minimal for POC — the LLM prompt gains a scaling hint.

| Day range | Effect |
|---|---|
| Day 1-3 | Base state. DC range in LLM prompt: 8-16. |
| Day 4-7 | "The smoke is closer now." DC range: 9-17. Threat flavor escalates. |

The bot passes `day_number` and the scaling hint in the LLM system prompt. The LLM uses it to generate more tense scenarios as days progress.

- [x] `TickResult.dayNumber` reports current day for frontend to apply scaling hints.

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

Available to everyone. No arguments. Behaviour branches on whether the caller is the admin.

**Admin (`interaction.user.id === ADMIN_USER_ID`):**
1. Run the full tick (sections 2-5).
2. Reply (visible to channel): the day transition message.

**No cooldown for admin.** Typing `/sleep` five times advances five days. Useful for testing the DC creep and NPC movement patterns.

**Non-admin:**

Moves the player's character to **The Warden's Oak** (the safe starting location) and returns an in-world rest scene. Does **not** trigger the tick — no day advance, no roll reset, no stamina change. The day only turns at nightfall (cron) or when the warden turns the hourglass.

The response branches on whether the player was already at the Oak:

| Condition | Flavour |
|---|---|
| Already at the Oak | *"The Oak's familiar boughs cradle you once more."* |
| Returning from elsewhere | *"You bank the fire and bed down beneath the Oak."* |

> *"The day turns when the world wills it — not when you do."*

**Gates** — `/sleep` is blocked if:
1. **Mid-action** (`last_action_state` is set) → *"You are mid-action — finish what you started before bedding down."*
2. **Rolls remaining** (`rolls_remaining > 0`) → *"The day is still young — you have actions left to take. Spend your remaining rolls before bedding down beneath the Oak."*

This prevents the optimal-play exploit of adventuring in the wilds then sleeping to dodge tick decay and collect safe-location recovery. To use `/sleep` as retreat the player must have spent all their rolls — they've already paid the risk by the time they're eligible.

- [x] `tick(isAdmin)` wired: admin=true always advances, admin=false checks cron idempotency.
- [x] `restAtOak(discordUserId)` — `WorldEngine` seam method: looks up user, sets location to `"The Warden's Oak"`, returns updated `CharacterData`.
- [x] Non-admin `/sleep` → `getCharacter()` + guards (mid-action, rolls) + `restAtOak()`.
  - If no character exists: "You don't have a character yet".

---

## S5 Handover

- [x] **Shipped:** `WorldEngineImpl.tick(isAdmin)` fully implemented — admin = always advance (no cooldown), cron = idempotent check against `last_cron_date`. Player effects: stamina recovery (+5 safe, cap 10), health recovery (+3 safe, cap max_health), wilds stamina decay (-1, floor 0), roll reset to 2, day-job wealth income. NPC movement: 80% seeded chance via `mulberry32(NPC.id + day_number)`, class-based destination filtering (Blacksmith stays, Hunter→forest/wild, Merchant→town/market, Herbalist→forest/river, Acolyte→shrine/temple, other→random), current location excluded from candidates. Blacksmith gains +5 wealth, Merchant gains 5-15 on both move and no-move. `TickResult` reports day number, players affected count, and per-NPC movement records. New helpers: `CharacterRepository.findAll()`, `NpcRepository.findAll()`, `NpcRepository.update()`, `NpcRepository.findById()`. Engine config gains `dayJobIncome: Record<string, number>` for income lookup.
- [!] **Frozen (S5):** `WorldEngine.tick(isAdmin): TickResult` interface unchanged. `TickResult` shape (`dayNumber`, `playersAffected`, `npcmovements`) unchanged. `WorldEngineImpl` constructor signature extended with optional `dayJobIncome` field (backwards-compatible via `?? {}` default).
- [+] **Post-S5 addition:** `WorldEngine.restAtOak(discordUserId): CharacterData | null` added to the seam for non-admin `/sleep` location movement. Implemented in `WorldEngineImpl` (user → character lookup, location update, idempotent if already at Oak). Mock counterpart in `MockWorldEngine` with call tracking.
- [x] **Tests:** 379 passing (34 new), 33 files. Run: `cd ~/projects/daily-pixel && npx vitest run`. `tsc --noEmit` clean. New file: `tests/engine/world-tick.test.ts` (32 tests covering idempotency, player effects, NPC movement seeded determinism, day advancement, last_cron_date tracking, merchant wealth, blacksmith staying).
- [>] **Next (S6):** Polish pass + pre-deploy — help content, flavor, end-to-end checklist, mobile pass, restart persistence. See `docs/archived/poc/poc-build-polish.md` §5-6.
