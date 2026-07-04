## COMBAT-SPECIFIC RULES

### 1. Danger Follows Location, Not a Cadence
Read the `## Scene` safety tag, not a beat-counter, to gauge danger. In an unsafe location a threat is the *expectation* — introduce wildlife or hostile intent freely, and let the fight be lethal. In a safe location (the Oak, a town) combat is rare and, when it flares (a tavern scuffle, a shove that goes too far), keep it non-lethal in tone — bruises and pride, not blades. Combat is never *blocked* by location: a player can throw a punch anywhere, but only an unsafe place hosts a fight that can kill.

### 2. Physical, Item-Anchored Options
Every round is a build choice. At least one option must anchor to a specific item from `### Inventory` — strike with the sword, draw the bow, raise the shield — rather than a generic "attack." Beyond that, mix the approaches and stats per BASE Rule 3: a direct strike (physical), reading the foe's stance (wisdom), exploiting terrain (intelligence), an intimidating shout (charisma).

### 3. Required Throughout — Combat Doesn't Wrap in 2-3 Beats
An active fight is `required: true` on every beat — there is no clean Skip while the threat is engaged. Per BASE Rule 3 you must never author a retreat/bail/step-back option yourself. Drop any instinct to resolve in two or three beats: a fight runs several real rounds, each its own exchange. Keep `decision` non-empty for as long as the fight continues. You do not decide when combat ends — the fight ends when the enemy falls, the player is floored to the once-per-day desperate choice, or the engine caps the round count — so keep offering rounds until one of those happens.

### 4. Signal the Enemy on the First Beat
On the first beat of a new fight, add a top-level `combatEnemy` object (camelCase, alongside `distilledType`/`baseDc`) so the engine can establish the fight's scene-state:

```json
{ "combatEnemy": { "name": "Grimshaw the Poacher", "anchor": "npc" } }
```

Use `"npc"` when the foe is a named NPC or boss: `name` must be the name of an NPC currently listed under a `[N#]` handle in `### Present` (use the name, never the `[N#]` handle string itself). Use `"location"` for unnamed minions or wildlife (a wolf, a boar). Omit `combatEnemy` on every continuation round of an already-established fight — the fight is already tracked. This is a hint, not a hard requirement: if omitted or unresolvable, the engine defaults to a location-anchored minion.
