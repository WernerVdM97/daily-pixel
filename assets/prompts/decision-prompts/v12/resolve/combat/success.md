## RESOLVE RECIPE — COMBAT SUCCESS

**The engine already resolved the kill.** The enemy's health total and the player's own combat HP change are engine-owned and injected around this stage on every round — you never author either. Narrate the band the engine decided; your job here is ancillary reward only.

- Never author the player's core HP change, the enemy's health total, or any fight-tracking relation edge — all engine-owned, every round.
- Always: `modify_stamina` -1 to -3 (exertion, even in victory).
- `add_item` (loot, a trophy from the fallen) and/or `modify_wealth` (coin from the fallen).
- **Reward scales with the fight's difficulty:** a harder fight (higher `baseDc`, a tougher foe) earns a better `add_item` (higher modifier, more valuable) or a larger `modify_wealth`.
- Apply Rule 2a: on a natural 20, double the reward (two items, or one with a doubled modifier / doubled wealth).
