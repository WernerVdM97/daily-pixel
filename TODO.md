
# TODO

Items migrated into the design vault are marked `[>]` with their home doc. `[ ]` items
have no doc home yet. See `docs/decisions/poc-action-ux-refinements.md`,
`docs/engine/poc-build-polish.md` §7, and the MVP sparks.

## scratchpad (humans start here)
- [ ] place decision prompts in a folder and add a current_source.md that always mirrors the latest version. Easier to then diff changes between versions.
- [ ] players should be rewarded for slow build up play or daily work on subsequent actions instead of jumping straight into it
- [ ] stealth or following mechanics?
- [ ] travelling to existing or already explored areas should be deterministic based on the distance and/or difficulty.
  The LLM can be prompted if a random encounter is injected.
- [ ] evaluate the /action flow and prompt and determine how much of it we can pull into the bot to do probalistically instead of having the LLM do calculation or cross dependant choices.
  - like bail, the LLM does not have to return the bail option as a decision, we can just infer it from `required: false`?
  - or drop the `done: true` and just infer it if there arent decision options.
  - MVP: start capping rolls per action type... add short rest option
- [ ] add global hints of treasure or rumours to move players into dangerous locations that havent been explored yet, like the caves.
- [ ] pacing should not be done by the llm but by the bot before hand. If every fourth encounter should be dangerous, that must be tracked in the bot
  this links to refacotring the prompting. the pacing outcome can be injected into the prompt.
- [ ] A/B test with pro for actions and flash for narration? Token usage seems very low right now... could get away with more expensive models
- [ ] how to make wealth spendable?
- [ ] better community feedback in chat, like tagging people (but not too spammy) or just showing off stuf to each other. globals messages on nat 1 or 20
- [ ] use reactions as a way of buffering input before a button is pressed (expend items or use certain abilities to amplify actions, also works for trades) 
  `this is cool!!!`
  (but does it work with ephemeral..?)
- [ ] use the "thinking" or loading interval in actions to display the user choice or action better and any possible response that is already known?
- [ ] distingiush between bail (loose stamina) and skip (ignore the interaction, unless it is associated with traveling?)
- [ ] using a daily_action should immeadiately teleport the person (if they are nearby, safe, or at camp) to the place of their work (associate jobs with locations).
- [ ] add a weight to time, the world should evolve
- [ ] implement layered db migration framework
- [ ] where ever a full stat is described, 'Wisdom', shorten it 'WIS'. or replace with emoji?
- [ ] [2026-06-16 12:20:29.829] (node:30) Warning: Supplying "ephemeral" for interaction response options is deprecated. Utilize flags instead.
(Use `node --trace-warnings ...` to show where the warning was created)
- [ ] how do we handle death or 0 HP?

## POC — polish (next day or two)

- [>] `[[poc-action-ux-refinements]]` §1 — the /action decision options button captions are too long and cut off, perhaps print them in text on the message (and limit them both in the prompt and bot) and only show button caption A B C?
- [>] `[[poc-action-ux-refinements]]` §2 + `[[poc-build-polish]]` §7 — when clicking the bail option on a non-required action, the next message shows a green banner and a success text. dit should be a neutral yellow.
  - we should probably opt to differentiate between skips, bail, or just finish. 
  - a hunt is bailed (at the cost of stamina), but a dialogue or interaction can be skipped (just opted out of and nothing happens)
  - a travel to town is just finished (a weird interaction often happens where if you say "go to the shrine and pray" the LLM gives no choices back 
    and just gives you a new set location and non required response, meaning all you can do is press "step back" but that looks negative with the red button)
    the response then also doesnt line up the same sentiment
    example:
    ```
    Decision
    You: go take a nap in the woods to recover stamina

    You curl into the hollow, breathing the scent of damp earth and moss.
    Sleep comes quickly, dreamless, and you wake an hour later feeling steadier.
    A distant howl reminds you that this peace is borrowed — the woods are not safe.

    Choose your approach

    "Step back"
    ```
    followed by
    ```
    You: go take a nap in the woods to recover stamina␍
    Decision: You curl into the hollow, breathing the scent of damp earth and moss.
    Sleep comes quickly, dreamless, and you wake an hour later feeling steadier.
    A distant howl reminds you that this peace is borrowed — the woods are not safe.␍
    → Step back (DC +0)␍
    ␍
    ✓ Success␍
    ␍
    You curl into the hollow, breathing the scent of damp earth and moss. Sleep comes quickly, dreamless, and you wake an hour later feeling steadier. A distant howl reminds you that this peace is borrowed — the woods are not safe.␍
    ␍
    → The Forest Edge ┃ Stamina: 11/10 (+2) ┃ Rolls: 0/2
    ```
    (also what up with the carriage returns? and stamina going over max)
    step back should just be a finish button, or even better just auto finish.
- [>] `[[poc-action-ux-refinements]]` §3 — work on discord presentation. Seperator emojis, formatting, etc
      clearer distinctions on longer messages, beter visibility on item or decision stats
      standardise outcome footer with emoji
- [>] `[[poc-action-ux-refinements]]` §4 — we should add a lot more premade actions for daily work and select three of them randomly (or those the player hasnot recently done yet)
  - they should also be a bit more generic, the are too specific or detailed now so when they repeat it looks weird.
- [>] `[[poc-build-polish]]` §7 — wasted tokens: there are attributes sent and received by the LLM that does not seem to get shown to the user?
      Double check the views/messages shown on discord and the info that the llm usually generates
- [>] `[[poc-build-polish]]` §7 — check item trading, i had two ingots and traded one for a goat, but lost both.

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
