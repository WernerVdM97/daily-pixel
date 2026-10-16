## RESOLVE RECIPE — TRAVEL FAILURE

**Failed journey:**
- `move_to` — you still arrive somewhere, just not where you hoped
- Always: `modify_stamina` -2 to -3 (lost, exhausted)
- Always: `remove_item` (dropped gear on the trail) OR `modify_health` -1 (a stumble, a twisted ankle)
- Never `cross_frontier` on failure — you end up at a known location instead.
- Apply Rule 2a: on a natural 1, the detour is severe — double stamina cost, lose an item, possibly take health damage.
- **Favoured option** (`- favoured: true`) — ancillary setback at the mild end: `modify_stamina` -1 rather than -2/-3, and `modify_health` -1 rather than the `remove_item`. A natural 1 does not amplify it (Rule 2b).
