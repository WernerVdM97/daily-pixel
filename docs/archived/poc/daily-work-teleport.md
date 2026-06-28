---
title: Daily-Work Teleport — Commute to the Job
status: shipped
domain: archived
phase: poc
superseded_by: "implemented in code"
tags: [daily-job, teleport, workplace, travel, stamina]
related:
  - "[[the-poc]]"
  - "[[poc-example-scenes]]"
---

# Daily-Work Teleport

A daily action that teleports the character from The Warden's Oak to their workplace — a fast commute that costs 1 stamina and consumes no roll beyond the action itself.

---

## Design

### Flow

1. Player is at **The Warden's Oak**.
2. Player runs `/action` with no description → sees the daily-work menu (3 job-specific actions or COMMON_ACTIONS, plus "Custom…").
3. Player clicks any daily-work button (not "Custom…").
4. If at the Oak: deduct 1 stamina, teleport to workplace location, show a commute message.
5. The action starts at the workplace location as normal (the roll is spent on the action itself).
6. If **not** at the Oak: skip the teleport, start the action at the current location normally.
7. Custom typed actions (`/action <description>` or the "Custom…" modal) never trigger teleport.

### Cost

- **1 stamina** for the commute (not a full action roll).
- The action's roll (consumed by `engine.startAction`) is spent on the work itself.
- No DC check — teleport always succeeds when from the Oak.

### Constraint

- Only works from **The Warden's Oak**.
- From anywhere else, the daily-work buttons start the action at the current location with no teleport.

---

## YAML Changes — `assets/char-creation/day-jobs.yml`

Each job gains a `workplace_location` field:

| Job | Workplace Location | Exists? |
|---|---|---|
| Town Guard | Town Square | ✅ |
| Blacksmith | The Town Forge | ❌ **new** |
| Hunter | The Forest Edge | ✅ |
| Scribe | The Warden's Library | ❌ **new** |
| Herbalist | The Forest Edge | ✅ |
| Minstrel | The Weary Lantern Inn | ✅ |
| Merchant | Town Square | ✅ |
| Acolyte | The Shrine of the First Flame | ✅ |
| Wanderer | *(random safe spot — see below)* | — |

### Wanderer teleport

Wanderers have no fixed workplace. When they pick a daily-work button from the Oak:

- Teleport to a **random safe location** (excluding The Warden's Oak itself, since they're already there).
- Candidates: Town Square, The Shrine of the First Flame, The Weary Lantern Inn, The Town Forge, The Warden's Library.
- Destination is seeded: `(characterId, dayNumber)` — same Wanderer gets the same destination on the same day, so `/hi` and the action stay consistent.

---

## New Locations

### The Town Forge

```
status: decided | tags: forge,smithy,town,fire,building | safe: yes
```

> Heat and iron. A stone smithy near the square where the bellows never rest. The walls are black with years of soot.

ASCII scene: `assets/scenes/forge.ascii` (new).

### The Warden's Library

```
status: decided | tags: library,study,scrolls,quiet,building | safe: yes
```

> Shelves climb the walls of a round stone room. Dust motes float in the lantern light. Not all the books are in a language you know.

ASCII scene: `assets/scenes/library.ascii` (new).

Both added to `src/db/schema.sql` seed data.

---

## Implementation — Code Changes

### `src/index.ts` — daily-job button handler

The handler at ~line 846 gains a teleport step **before** `engine.startAction`:

```python
[!] Pseudocode — actual changes described below
```

1. Read `workplaceLocation` from the parsed day-jobs YAML (or compute for Wanderer).
2. If `character.location === "The Warden's Oak"`:
   - Deduct 1 stamina: `charRepo.update(char.id, { stamina: Math.max(0, char.stamina - 1) })`.
   - Set location to workplace: `charRepo.update(char.id, { location: workplaceLocation })`.
   - Show a commute embed: `**You head to the {workplace}.**  \n⚡ -1 stamina` (ephemeral, then replaced by the action flow).
3. If not at the Oak → skip teleport, proceed normally.
4. Call `engine.startAction(char.id, hook)` as before.

The stamina deduction and location change happen in the handler, not inside the engine. This keeps `WorldEngine` clean — it doesn't need to know about workplace teleport.

### `src/discord/commands/hi.ts`

- `DayJobDef` interface gains `workplace_location: string | null`.
- The `/hi` response shows the workplace name next to the job title:

  ```   🔨 Town Guard — Town Square   ```

### `src/engine/WorldEngine.ts` & `WorldEngineImpl.ts`

No changes needed. The handler orchestrates teleport before handing off to the engine.

---

## Open Questions

None locked. Everything above is decided.

