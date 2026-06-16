
# TODO

Items migrated into the design vault are marked `[>]` with their home doc. `[ ]` items
have no doc home yet. See `docs/decisions/poc-action-ux-refinements.md`,
`docs/engine/poc-build-polish.md` §7, and the MVP sparks.

## scratchpad (humans start here)

- [ ] add player class emoji to global action outcome messages 
  - still improve formatting of final response
- [ ] bug: got an extra throw on the second action and then autocompleted the last one ended with me not getting a sleep button but instead another action button. Luckily that blocked me.
- [ ] delay sleep tick message and setup daily messages, with a button to start playing
- [ ] implement layered db migration framework
- [ ] how to make wealth spendable or meaning full (same for stamina and health)?
  - how do we handle death or 0 HP?
- [ ] stealth or following mechanics?
- [ ] evaluate the /action flow and prompt and determine how much of it we can pull into the bot to do probalistically instead of having the LLM do calculation or cross dependant choices.
  - like bail, the LLM does not have to return the bail option as a decision, we can just infer it from `required: false`?
  - or drop the `done: true` and just infer it if there arent decision options.
  - MVP: start capping rolls per action type... add short rest option
  - players should be rewarded for slow build up play or daily work on subsequent actions instead of jumping straight into it
  - pacing should not be done by the llm but by the bot before hand. If every fourth encounter should be dangerous, that must be tracked in the bot
  this links to refacotring the prompting. the pacing outcome can be injected into the prompt.
- [ ] add global hints of treasure or rumours to move players into dangerous locations that havent been explored yet, like the caves.
- [ ] A/B test with pro vs flash (high vs xhigh thinking) for different stages? Token usage seems very low right now... could get away with more expensive models
- [ ] better community feedback in chat, like tagging people (but not too spammy) or just showing off stuf to each other. globals messages on nat 1 or 20
- [ ] use reactions as a way of buffering input before a button is pressed (expend items or use certain abilities to amplify actions, also works for trades) 
  `this is cool!!!`
  (but does it work with ephemeral..?)
- [ ] use the "thinking" or loading interval in actions to display the user choice or action better and any possible response that is already known?
- [ ] add a weight to time, the world should evolve with progression. DC should become higher, new threats appear
- [ ] [2026-06-16 12:20:29.829] (node:30) Warning: Supplying "ephemeral" for interaction response options is deprecated. Utilize flags instead.
(Use `node --trace-warnings ...` to show where the warning was created)
- [ ] travelling to existing or already explored areas should be deterministic based on the distance and/or difficulty.
- [ ] using a daily_action should immeadiately teleport the person (if they are nearby(?), safe, or at camp) to the place of their work (associate jobs with locations).

## MVP — deferred

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

## Not yet homed

- [ ] pipeline the bugs table into github issues (periodically poll and clean with LLM) — MVP infra, no doc home yet
- [ ] improve journal formatting and relevance. — trimmed from POC scope
  - track or show quests or hints?
  - add clue system? also grants +1 roll
  - show outcomes of recent actions ?
