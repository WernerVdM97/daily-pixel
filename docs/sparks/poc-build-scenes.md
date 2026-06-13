---
title: POC Build — ASCII Scenes
status: spark
domain: spark
phase: poc
tags:
- poc
- build-plan
- ascii
related:
- '[[poc-build-plan]]'
---

# POC Build — ASCII Scenes

> *Part of [[poc-build-plan]]. Fragment library, scene composition, and mobile testing.*

**Checklist:**

- [ ] Fragment library
- [ ] Scene composition
- [ ] Integration
- [ ] Mobile testing

---

## Fragment library

- [ ] Load all `.ascii` files from `assets/` at startup
- [ ] Store as `Map<sceneName, string>`
- [ ] Validate: all fragments fit within 30-char width (safe minimum); max tested: 60 chars

## Scene composition

- [ ] `getScene(actionType, location)` → picks the right fragment
- [ ] Mapping:
  - Default / Oak → `oak.ascii`
  - Travel → `road.ascii`
  - Rest → `campfire.ascii`
  - Town / settlement → `shopfront.ascii`
- [ ] Compose into message template: `header + scene + body + buttons`
- [ ] Wrap scene in Discord code block (monospace rendering)

## Integration

- [ ] `/hi` opening scene uses `oak.ascii` from fragment library (not hardcoded)
- [ ] `/action` messages include scene based on action type
- [ ] `/look` returns current scene fragment
- [ ] Location changes update which scene is shown

## Mobile testing

- [ ] Test all 4 scenes on phone Discord client
- [ ] Verify no horizontal scroll at 30-char width (phone portrait)
- [ ] Verify code block renders correctly (some fonts break ASCII art)
- [ ] Test with different Discord themes (light/dark)
