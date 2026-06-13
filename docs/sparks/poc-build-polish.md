---
title: POC Build — Polish
status: spark
domain: spark
phase: poc
tags:
- poc
- build-plan
related:
- '[[poc-build-plan]]'
---

# POC Build — Polish

> *Part of [[poc-build-plan]]. Error handling, fallbacks, flavor, and the daily tick.*

**Checklist:**

- [ ] Error handling
- [ ] LLM fallback
- [ ] Flavor text
- [ ] Help text
- [ ] /sleep tick
- [ ] Final pass

---

## Error handling

- [ ] Invalid command → helpful message with `/help` suggestion
- [ ] No rolls remaining → "The day is done. Rest at the Oak, or wait for dawn. `/sleep` to advance."
- [ ] DB errors → log to console, show generic "Something went wrong" to player
- [ ] Discord API errors (rate limits, timeouts) → retry with backoff
- [ ] Unknown interaction (stale button click) → "This action has expired. Try `/hi`."

## LLM fallback

- [ ] API unavailable → show hardcoded generic decision per action type
- [ ] Malformed response → retry once, then fallback
- [ ] Timeout (>5s) → fallback, log the failure
- [ ] Track fallback rate — if >10%, revisit prompt or provider

## Flavor text

- [ ] Idle states: "The warden tends the fire." / "A crow watches from the Oak." / "The ember glows faintly."
- [ ] Success variants per action type (3-5 each)
- [ ] Failure variants per action type (3-5 each)
- [ ] Skip variants (3-5 total)

## Help text

- [ ] `/help` lists all commands with one-line descriptions
- [ ] Action types explained: what each does, what it costs
- [ ] Roll economy explained: 2 per day, `/sleep` to advance

## `/sleep` — Daily tick

- [ ] Manual command to advance the day
- [ ] Reset `rolls_remaining` to 2 for all players
- [ ] Apply overnight effects: stamina recovery at safe locations, decay elsewhere
- [ ] Increment day counter
- [ ] Show day transition message: "Day 2 begins. The smoke is closer."
- [ ] Limit: can only `/sleep` once per real day (cooldown)

## Final pass

- [ ] Full action flow test: `/hi` → `/action hunt` → decisions → roll → outcome → `/sleep` → `/hi` → `/action travel`
- [ ] Mobile test: full flow on phone
- [ ] Check all template text for typos
- [ ] Verify SQLite file persists across bot restarts
