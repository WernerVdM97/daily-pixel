
# TODO

## scratchpad (humans start here)

### NB
- [ ] add more narrative to the recent action journal entry
- [ ] too many buttons missing
- [ ] review 0.2.2

### Other
- [ ] the /join options should be loaded from the yaml, not injected in code. merge the hard coded options into the yamls in assets/
- [ ] how to make wealth spendable or meaning full (same for stamina and health)?
  - how do we handle death or 0 HP?
- [ ] MVP: start capping rolls per action type... add short rest option
  - players should be rewarded for slow build up play or daily work on subsequent actions instead of jumping straight into it
  - pacing should not be done by the llm but by the bot before hand. If every fourth encounter should be dangerous, that must be tracked in the bot
  this links to refacotring the prompting. the pacing outcome can be injected into the prompt.
- [ ] add global hints of treasure or rumours to move players into dangerous locations that havent been explored yet, like the caves.
- [ ] better community feedback in chat, like tagging people (but not too spammy) or just showing off stuf to each other. globals messages on nat 1 or 20
- [ ] add a weight to time, the world should evolve with progression. DC should become higher, new threats appear

## MVP — deferred


- [ ] Improved journal/story
  - track or show quests or hints?
  - add clue system? also grants +1 roll
- [ ] travelling to existing or already explored areas should be deterministic based on the distance and/or difficulty.
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

