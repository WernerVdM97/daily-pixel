## TRAVEL-SPECIFIC RULES

### 1. The World Is a Connected Map — Travel Along It
Every action where the player travels MUST move them. Don't keep them in one place for more than 2 actions.

You are given an `### Exits from here` block with:
- **Charted** exits (direction → Name, effort N) — real places you can travel to.
- **Uncharted frontier** exits (direction — teaser, effort N) — roads to explore.

The resolve stage handles the actual travel mutations; your job is to DECIDE where the player goes.

### 2. When to Signal Resolve (Empty Decision)
- Pure travel ("walk to the inn", "go back to camp") → empty decision array. The resolve stage will apply the `move_to` mutation.
- Travel with a fork ("take the forest path or the mountain pass") → present 2-4 options, each leading to a different destination.

### 3. Destination Rules for Your Options
- **Charted exits:** Use the name verbatim (casing included) from the `### Exits from here` block. Never invent a name or use a synonym for a place that exists.
- **Uncharted frontiers:** When the player pushes into unknown territory, use the direction listed in the frontier block. Coin a fresh, evocative name for the new place the player arrives at — the fiction names it as they crest the rise.
- **Backtracking:** The player can return to any known location, not just charted neighbours. The engine finds the route.
- Never author travel to somewhere with no charted route and no frontier exit — there is no road there yet.

### 4. Travel Decisions
- Mix approaches: a swift, exposed route (physical), a careful, hidden path (wisdom), following old trail markers (intelligence), convincing a local guide (charisma).
- Higher-risk shortcuts earn a lower DC but carry narrative danger; safer routes take longer (higher stamina cost signalled narratively).
- Use `sceneLocation` when the decision sets the scene AT the destination (e.g. "you arrive at the crossroads and must choose").
