---
title: POC Build — Probabilistic Actions
status: spark
domain: spark
phase: poc
tags:
- poc
- build-plan
- game-design
- llm
related:
- '[[poc-build-plan]]'
---

# POC Build — Probabilistic Actions

> *Part of [[poc-build-plan]]. The core game loop: /action → LLM decisions → DC adjustment → roll or skip → outcome.*

**Checklist:**

- [ ] Slash command
- [ ] LLM decision generation
- [ ] Decision flow
- [ ] Roll or skip
- [ ] Persistence

---

## Slash command

- [ ] `/action <type>` with fixed choices: `hunt`, `travel`, `scout`, `talk`, `attack`
- [ ] Validate player state: alive, has rolls remaining, not mid-action
- [ ] Consume 1 roll from `rolls_remaining`

## LLM decision generation

- [ ] Build prompt: action type + player context (class, location, stamina) + world state
- [ ] Call DeepSeek V4 Flash API
- [ ] Parse structured JSON response: `{ decisions: [{ prompt, options: [{ label, dc_modifier }] }] }`
- [ ] 1-2 decisions per action (LLM decides how many)

## Decision flow

- [ ] Render decision 1 as Discord message with buttons
- [ ] Each button carries `dc_modifier` value
- [ ] On pick: apply modifier to running DC total, advance to decision 2 (if any) or final step
- [ ] Message editing: update the same Discord message as flow advances

## Roll or skip

- [ ] Final step: show accumulated DC, [Roll d20] and [Skip] buttons
- [ ] Roll: `Math.floor(Math.random() * 20) + 1`, compare to DC
- [ ] Skip: passive wisdom threshold check (class-based)
- [ ] Template outcome text for success / failure / skipped

## Persistence

- [ ] Save action to `actions` table: type, decisions, outcome, timestamp
- [ ] Update player state: `rolls_remaining`, `stamina`, `location` (if changed), items (if gained/lost)
- [ ] Store mid-action state in `players.last_action_state` for `/hi` resumption
- [ ] Clear `last_action_state` on action completion or timeout

## Edge cases

- [ ] No rolls remaining → show message, suggest `/sleep` or wait
- [ ] Player dead / lost → prevent actions, show appropriate message
- [ ] LLM API fails → fallback to hardcoded generic decision for the action type
- [ ] LLM returns malformed JSON → retry once, then fallback
- [ ] Player disconnects mid-action → `/hi` resumes from `last_action_state`
- [ ] Action times out (no response for N minutes) → auto-fail, clear state
