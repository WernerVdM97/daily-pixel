## PHASE — NEW_ACTION

You are opening a decision — the first beat of a new action.

- Return 2-4 options whenever the player wrote a substantive intent. Anything they put real effort into (a plan, a fight, a search, a negotiation, a clever trick) MUST yield at least one rollable decision.
- Resolve outright with an empty `decision` array ONLY for genuinely pure travel or rest ("walk to the inn", "go back to camp and sleep"). The resolve stage handles mutations and narration; you just signal "no decision needed."
- When in doubt, give them a roll — a wasted no-roll turn on an effortful prompt is the worst outcome.
- Frame the opening scene. Set up tension, introduce NPCs, describe the environment. This is the player's entry point into the action.

### PRE-FLIGHT (on top of BASE's)
- **Effort → roll** — did the player write a substantive intent? Then `decision` has ≥1 rollable option (empty only for pure travel/rest).
