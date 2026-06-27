
# TODO

## scratchpad (humans start here)

### TBD — POC polish (small UI wins, no spark warranted)
- [ ] derived/distilled action should show as an emoji next to the decision head while the action evolves — today the decision title is hardcoded `🤔 Decision` (`action.ts:552`) and the distilled-type emoji only appears on the outcome breadcrumb (`buildOutcomeEmbed`).
- [ ] custom (free-text) actions need a real "thinking" screen — three dots + "thinking…" as its own page. Preset day-job actions already show a ⏳ "Starting…" loading envelope (`action.ts:204`); the custom-modal path shows nothing before `engine.startAction`.
- [ ] `/stats` — show how the character builder (race/class) shaped each base score, and make it prettier. The base+gear breakdown already ships (`+6 (+4 base, +2 🎒)`); levels/upskilling/traits and per-race/class char-creator guidance are deferred → MVP below.
- [ ] global broadcast on a natural 1 or 20 — a short public shout-out when anyone crits or fumbles. (Wider community feedback — tagging, showing off — is deferred → MVP below.)

## MVP — deferred

- [ ] menu framework coupled to views — standardise the views/command/message terminology and a tab/subtab layout per message. See [[discord-interaction-layer]] (the interaction-plumbing layer; subtabs are explicitly MVP there).
- [ ] make wealth (and stamina, health) spendable/meaningful, and define death / 0 HP. The death track is deferred from the POC by design ([[the-poc]]); see [[mvp-progression]] (lifecycle/death), [[mvp-combat]] (HP stakes), [[mvp+npc-economy]] (wealth sink).
- [ ] cap rolls per action type + add a short-rest option; reward slow build-up / daily-work play on subsequent actions instead of jumping straight in. Check for hard-coded roll caps. Extends [[roll-economy-timeouts-and-world-growth]].
- [ ] character progression depth — levels, upskilling, traits; the char creator shows which stats matter per race/class and how each modifies them. See [[mvp-progression]], [[mvp-character-drivers]].
- [ ] richer community feedback in chat — tag people (not too spammy), let players show off to each other. See [[mvp-social-model]], [[mvp-discord-ux]].
- [ ] use both models differently, flash for generating quick responses and daily work, pro for decision trees.
- [ ] saturday special event, spawn an "evil npc" somewhere with a hint. Incentivise hunting it/them and add npc death mutation
- [ ] choose age
- [ ] Improved journal/story
  - track or show quests or hints?
  - add clue system? also grants +1 roll
- [>] travelling to existing or already explored areas should be deterministic based on the distance and/or difficulty. → now designed in [[per-player-map-exploration]] (engine-owned routing + `stamina = Σ edge difficulty`; `distance` reserved for the time mechanic).
- [ ] **schema: normalise location references to FK ids** — locations are keyed by `name` (TEXT) everywhere (`player_characters.location`, `npcs.location`, `location_edges`, `actions.location_name`). `actions.location_name` is a deliberate point-in-time *snapshot* (keep it), but a future polish pass should decide whether the live-reference tables move to `location_id` FKs consistently — a holistic refactor, not a lone divergence. See [[per-player-map-exploration]] §6.
- [ ] use reactions as a way of buffering input before a button is pressed (expend items or use certain abilities to amplify actions, also works for trades) 
  `this is cool!!!`
  (but does it work with ephemeral..?)
- [ ] stealth or following mechanics?
- [ ] mechanic — bonus rolls: an LLM `modify_rolls_remaining: +N` reward is a deliberate mechanic, not a bug (the "extra throw" report traces to this; no deterministic double-decrement exists — a roll is spent exactly once per action in startAction). Design it properly: when/why the world grants an extra roll, and surface it to the player so it reads as a reward. Belongs to the roll-economy work in [[mvp-llm-prompt-architecture]].
- [>] `[[mvp-llm-prompt-architecture]]` — prompt refactor:
  - optimise prompt to llm as markdown (more friendly) not json. Response can remain json
  - options should still be produced by the llm, but there should be some rolls before to influence it
    example: player prompts they want to hunt. llm responds with choices, player succeeds, bot then rolls for rarity of an item, llm generates item.
    example: player trains at camp, llm provides choices, player fails, bot rolls for the severity (loses a lot of stamina), llm gives outcome message.
    THIS IDEA NEEDS A LOT OF REFINEMENT or just better system prompts.
  - outcomes should be rolled before the response flavour is generated.
    roll as DM and add certain promp elements. determine outcome sentiment before prompting.
  - utilise multiple agent in short bursts for actions or chain agents instead of one big chat?
  - try disabling thinking again? Or use A B testing with thinking on and off
  - optimise prompts with simulations to see when LLM digresses
  - use testing data as a couple of LLM mocks (for dev'ing or unit testing)
- [>] `[[mvp-combat]]` — there is no combat, this should be a core mechanic..!
- [>] `[[mvp-data-model]]` — graph db for backend coherency (relationships, items, distances, groups)
  - better world state tracking, which areas are hostile, how hostile, what type of faction or encounters to expect
- [>] `[[mvp+npc-economy]]` — introduce NPCs more often in interactions and save them (also reuse them more often)
- [>] `[[mvp+world-state-projection]]` — rethink sleep mechanic, yes we want people to sleep at the wardens oak, but they shouldnt be able to just tp out of an unsafe or far away location.
  - related to world state tracking too: finishing your day in an unsafe location should have conesquences
    (you dont sleep well or you get put in jail and must escape)
- [>] `[[mvp-ascii-render-pipeline]]` — scrape prettier ascii art or images for converting with ascii image converter

---

## Triaged out of TBD (for provenance — 2026-06-26)

- **Done / shipped (struck):** preset work labelled `Work:` not `🧭 Quest:` and commute `−1 stamina` shown on the thinking page; the no-op refund scope question (stamina-/roll-only "shrug" is again a refundable no-op — D1 follow-up). All in `[Unreleased]`.
- **Working as designed (struck):** post-`/join` welcome shows no "Hi" button because that screen *is* the Hi screen (`getNavButtons` filters the current command — `format.ts:137`).
- **Routed to sparks:** Warden NPC duplicates (hooded figure vs The Warden) → [[mutation-vocabulary-refinement]] §2 (NPC name-resolution); world evolves with time / rising DC / new threats → [[prompt-v10-scaling-and-pipeline]] Thread B (World Tier); global rumours pulling players toward dangerous unexplored locations → [[prompt-v10-scaling-and-pipeline]] Thread B + [[per-player-map-exploration]] (`reveal_location` leaf); end-to-end flow tests with mocked LLM + scripted button presses → [[mvp-llm-prompt-architecture]].
