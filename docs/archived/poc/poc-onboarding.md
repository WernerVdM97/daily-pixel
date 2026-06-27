---
title: Onboarding — Character Creation Wizard
status: shipped
domain: archived
phase: poc
superseded_by: "implemented in code"
tags:
- characters
- game-design
related:
- '[[archived/poc/poc-build-scaffold|poc-build-scaffold]]'
- '[[the-poc]]'
---

# Onboarding — Character Creation Wizard

> *Deterministic `/join` flow. Part of [[poc-build-scaffold]] deterministic commands.*

---

## Intent

**Outcome:** A deterministic `/join` wizard that guides a new player through character creation in 6 steps, culminating in a summary page to confirm or abort. One active character per user.

**User:** First-time player joining the Discord server. No prior game knowledge assumed.

**Why now:** The POC currently assumes a character exists. Players need a way to create one before `/hi` does anything.

**Success:** A new player types `/join`, makes 6 choices, confirms, and `/hi` immediately works with their character. Zero confusion, zero dead ends.

**Constraint:** Deterministic only — no LLM, no dice. All option data lives in YAML files under `assets/`. Stat modifiers accumulate cumulatively across creation steps.

**Out of scope:** Tutorial / game mechanics explanation (that's the opening scene's job). Stat respeccing. Multiple characters per user. Point-buy or manual stat allocation.

## `/join` — Wizard Flow

Multiple steps, one message per step (edited in place). All deterministic. All option data loaded from YAML files in `assets/`.

```
/join
  │
  ├─ Step 1: Name — free text input
  ├─ Step 2: Class — 5 options (Warrior/Ranger/Wizard/Bard/Priest)
  ├─ Step 3: Upbringing — how you grew up. Loaded from `backgrounds.yml`
  ├─ Step 4: Race — loaded from `races.yml`
  ├─ Step 5: Build — height (short/normal/tall) + weight (skinny/normal/fat)
  ├─ Step 6: Alignment — 3×3 grid, pick one
  ├─ Step 7: Day-job — 8 options, loaded from `day-jobs.yml`. Performance depends on stats.
  ├─ Step 8: Starting item set — loaded from `item-sets.yml`
  │
  └─ Summary page: all choices + total modifiers + day-job + items
       [Confirm]  [Abort]
```

**Stats tracked:** Physical (DEX+CON+STR), Wisdom, Intelligence, Charisma. **Modifiers:** Cumulative across all steps. Each option in YAML carries its own modifier values.

**Confirm:** Character saved to DB. `/hi` now works. **Abort:** Discard everything. No character created.

**After `/join`:** All subsequent `/join` calls show an error: "You already walk the eastern road, [Name]. `/hi` to continue."

---

## Data Files

All in `assets/char-creation/` as YAML:

### `classes.yml`
```yaml
- name: Warrior
  description: Blade and shield. Front line.
  modifiers: { physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }

- name: Ranger
  description: Bow and beast. The wilds are home.
  modifiers: { physical: 1, wisdom: 2, intelligence: 0, charisma: -1 }
```

### `backgrounds.yml` (upbringing)
```yaml
- name: Soldier
  description: Raised in a military family. Discipline was your first language.
  modifiers: { physical: 1, wisdom: 0, intelligence: -1, charisma: 0 }

- name: Merchant
  description: Grew up behind a counter. You could read a ledger before a story.
  modifiers: { physical: -1, wisdom: 0, intelligence: 1, charisma: 1 }
```

### `day-jobs.yml`
```yaml
- name: Town Guard
  depends_on: [physical]
  base_income: 10
  description: Patrol the walls. Break up tavern brawls.

- name: Scribe
  depends_on: [intelligence]
  base_income: 12
  description: Copy manuscripts. Translate old tongues.
```

### `races.yml`, `builds.yml`, `alignments.yml`, `item-sets.yml`
Same pattern. Each carries `name`, `description`, `modifiers`.

---

## Summary Page Example

```
══════════════════════════════
      CHARACTER CREATED
══════════════════════════════

  Kaelen — Warrior
  Soldier upbringing · Human · Tall · Normal
  Lawful Good

  PHYSICAL  +4   WISDOM  -1
  INT       -1   CHARISMA  0

  Day-job: Town Guard (10c/day)
  Patrol the walls. Break up tavern brawls.

  Items: Iron Sword, Wooden Shield

  [Confirm]  [Abort]
══════════════════════════════
```

---

## Integration

- Added to [[poc-build-scaffold]] as `/join` under Deterministic Commands
- Data files pre-populated with ~4 options each before POC ships
- Bot loads YAML at startup, validates against expected schema
