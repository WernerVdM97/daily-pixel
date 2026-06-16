---
title: POC Build — Polish
status: decided
domain: engine
phase: poc
tags:
- poc
- build-plan
related:
- '[[poc-build-poa]]'
- '[[poc-build-scaffold]]'
- '[[poc-build-probabilistic]]'
- '[[poc-spec-reconciliation]]'
---

# POC Build — Polish

> *Part of [[poc-build-poa]]. Error handling, LLM fallback, outcome rendering, idle messages, help content, and pre-deploy final pass. `/sleep` tick moved to [[poc-build-world-tick]].*

---

## 1. Error Handling

| Error | Response |
|---|---|
| Invalid command | Ephemeral: "Unknown command. Try `/help`." |
| No rolls remaining | Ephemeral: "The day is done. `/sleep` to make camp by the Oak — the world turns at nightfall." |
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

Two-tier. Fallback rate tracked via a `meta` counter (tier-2 inserts no `actions` row — see [[poc-build-deploy]] §6). If >10% of actions hit fallback, revisit prompt or provider.

### Tier 1 — Simpler retry

On first failure (malformed JSON, timeout >5s, or API error), retry with the stripped prompt **`assets/prompts/fallback.md`** (loaded at boot, see [[poc-build-scaffold]]). No NPCs, no location, no history — just character basics + raw input.

### Tier 2 — Divine intervention

If retry also fails:

> *"A flash of light. The warden's hand on your shoulder. You wake beneath the Oak, your action lost to forces beyond mortal ken."*

- Roll IS NOT refunded
- `last_action_state` cleared
- No action row inserted
- Log the double-failure for review

---

## 3. Outcome Rendering

> *Amended by [[poc-action-ux-refinements]]: adds `↩ Bailed` and `✓ Done` (auto-finish) as neutral terminal variants alongside `↩ Skipped`, and standardises the footer glyphs. Skip/Bail/Finish are all neutral — the green Success banner is roll-only.*

The final LLM response includes `outcome_text` — the LLM narrates the result in one sentence (see [[poc-spec-reconciliation]] D1). If that call fails, malforms, or times out, fall back to a template variant (3-5 per `distilled_type`, defined in [[poc-build-probabilistic]] §4) and log the fallback. The bot renders deterministic consequences below either way.

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
/sleep     — Make camp by the Oak and rest.
/bug       — Report a bug.
/feedback  — Share your thoughts.
```

### Economy

```
You have 2 rolls per day.
Each /action consumes 1 roll.
Your rolls reset at nightfall, when the world turns to the next day.
Optional actions can be skipped (Bail or Skip button).
Required actions (attacked, cornered) cannot be skipped.
```

---

## 6. Pre-Deploy Final Pass

Run the full flow end-to-end before shipping:

- [x] `/join` → full wizard → confirm → character in DB
- [x] `/hi` → atmosphere → hooks → pick day-job action
- [x] `/action hunt` → idle message → decisions → roll → outcome
- [x] `/look` → scene display with correct location
- [x] `/backpack` → items grid (starting items from join)
- [x] `/stats` → full sheet with correct values
- [x] `/hi` again → resumption hint when mid-action
- [x] `/sleep` (admin) → day advanced, rolls reset
- [x] `/sleep` (non-admin) → camp-by-the-Oak rest scene, no tick, nothing changes
- [x] `/hi` after sleep → new day, new hooks
- [x] LLM failure → tier 1 retry → tier 2 divine intervention
- [x] Mid-action disconnect → `/hi` resume from last decision
- [ ] 30-minute timeout → auto-fail message (defers to S7: runtime env)
- [x] `/bug` and `/feedback` → rows in DB
- [ ] Mobile: full `/action` flow on phone Discord (manual check at deploy)
- [ ] Check all text for typos (manual pass before deploy)
- [ ] Verify `ADMIN_USER_ID` is set in production `.env` (startup warns otherwise)
- [x] Verify SQLite file persists across bot restart

---

## 7. Mid-POC Fix Pass

Bugs surfaced during live POC play. Pure fixes (not design) — the UX *changes* they sit
beside are in [[poc-action-ux-refinements]]. Fix these first; several corrupt the data
the POC week is collecting.

- [ ] **Bail renders green Success** — bailing a non-required action shows a green success banner + success text. Should render the neutral `↩ Bailed` variant per §3. Divergence from the decided spec.
- [ ] **Stamina exceeds max** — observed `Stamina: 11/10`. `modify_stamina` (and tick recovery) must clamp to max.
- [ ] **Carriage returns in output** — stray `␍` / `\r` leaking into rendered outcome text; strip on render.
- [ ] **Item trade loses both items** — traded 1 of 2 Steel Ingots for a goat, lost both. Investigate `remove_item` quantity handling / double-apply.
- [ ] **Wasted-token audit** — fields the LLM generates that never reach the player. Diff the response schema against what Discord renders (now measurable via the `llm_calls` table) and cut the dead ones from the prompt + response contract.

---

## S6 Handover

- [x] **Shipped:** Help content fully updated per §5 (/sleep, /action, economy breakdown, rest section). `/sleep` command handler (frontend side): admin → tick + day transition message with scaling flavor; non-admin → camp-by-the-Oak rest scene, no tick. End-to-end happy-path test (`tests/e2e/happy-path.test.ts`) covering all 13 checklist flows. Restart persistence test (`tests/db/restart-persistence.test.ts`) verifying SQLite data survives close-reopen cycle. Code simplification: unused `channelId` removed from sleep command handler; flavor-let replaced with const ternary. **Review-driven fixes:** startup warning when ADMIN_USER_ID is unset; tick() wrapped in try/catch with mapError fallback.
- [!] **Frozen:** `makeSleepCommand(engine)` added to frontend command API — consumes `WorldEngine.tick(isAdmin)` with no interface changes. `makeHelpCommand()` behavior unchanged (returns static string). No changes to `WorldEngine.ts` or `LlmGateway.ts` (seam still clean).
- [x] **Tests:** 368 passing (23 new), 32 files. Run: `cd ~/projects/daily-pixel && npx vitest run`. `tsc --noEmit` clean. New files: `tests/e2e/happy-path.test.ts` (13 tests), `tests/discord/sleep.test.ts` (6 tests), `tests/db/restart-persistence.test.ts` (2 tests). Updated: `tests/discord/help.test.ts` (6 tests, added /sleep assertions).
- [>] **Next (S7):** Deploy — CI, Containerfile (Podman dev), LXC provision, systemd, deploy-check, invite testers. See `docs/engine/poc-build-deploy.md`. Also: manual typos pass, mobile test, and the 30-min timeout auto-fail runtime hook.

## S4 Handover

- [x] **Shipped:** `FallbackLlmGateway` (decorator: inner LLM → tier-1 stripped-context retry → tier-2 divine intervention, with `onTier2Fallback` callback), `ErrorMapper` (`mapError(e) → string`, covers all known error patterns + generic fallback), `OutcomeRenderer` (`formatOutcome(outcome, ctx) → string`, success/failure/skip/timeout with items/location/stats summary footer), `IdleMessageSelector` (`randomIdleMessage(rng?) → string`, 5 atmospheric messages, injectable RNG), wire-up in `WorldEngineImpl` (wraps LLM in `FallbackLlmGateway` at construction, checks `DIVINE_INTERVENTION_TYPE` to skip action-row insert, increments `meta.llm_fallback_count` on tier-2), `meta.llm_fallback_count` now live (seeded in schema, incremented on divine intervention).
- [!] **Frozen:** `FallbackLlmGateway` (public API: `constructor(inner, options?)` with `onTier2Fallback` callback — used by engine construction), `DIVINE_INTERVENTION_TYPE` (`'__divine__'` — checked in `WorldEngineImpl.stepAction()` to skip action row), `mapError(e)`, `formatOutcome(outcome, ctx)`, `randomIdleMessage(rng?)`. No changes to `WorldEngine.ts` or `LlmGateway.ts` interfaces (frozen seam per S0).
- [x] **Tests:** 313 passing (58 new), 28 files. Run: `cd ~/projects/daily-pixel && npx vitest run`. `tsc --noEmit` clean. New files: `tests/engine/outcome-renderer.test.ts` (20), `tests/engine/error-mapper.test.ts` (14), `tests/engine/idle-messages.test.ts` (3), `tests/llm/fallback-gateway.test.ts` (16).
- [>] **Next (S5):** World tick — `/sleep` (admin tick + non-admin rest), idempotent cron (`last_cron_date`), `meta` (day_number read/write), player effects (stamina/health recovery in safe zones, roll reset, wealth income), seeded NPC movement (NPCs by `class` + `day_number`), scaling hints. Start from `src/engine/WorldEngineImpl.ts` `tick()` stub — see `docs/engine/poc-build-world-tick.md` and `docs/engine/poc-build-poa.md` §5 for S5 scope.
