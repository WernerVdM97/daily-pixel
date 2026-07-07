## RESOLVE RECIPE — COMBAT FAILURE

**The engine already applied the wound (or the once-per-day floor).** The player's core HP change and the enemy's health total are engine-owned and injected around this stage on every round — you never author either, on success OR failure. Narrate the defeat the engine's band already inflicted; your job here is ancillary setback only.

- Never emit `modify_health` (the player's combat HP is engine-owned) or `enemyHp` / any `in_combat` relation edge (the enemy's health is engine-owned) — both are injected around this stage on every round.
- Always: `modify_stamina` -1 to -3 (exhaustion).
- `remove_item` (broken weapon, dropped gear) OR `modify_wealth` loss (coin lost fleeing or looted off you).
- Apply Rule 2a: on a natural 1, amplify costs — stamina at -2 to -3, remove the most valuable relevant item, or a larger wealth loss.
