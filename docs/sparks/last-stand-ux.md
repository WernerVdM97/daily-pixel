---
title: Last-Stand Screen: Emoji Captions & Combat Scene Frame
status: exploring
domain: spark
phase: mvp+
tags:
- ui
- ansi
- discord
- combat
related:
- '[[ansi-art-classification-framework]]'
- '[[visual-craft]]'
- '[[mvp+ansi-art]]'
- '[[poc-action-ux-refinements]]'
---
The desperate-choice beat's screen, settled in review: the combat frame is the game's screen and leads the decision screen of every action, the card below keeps only what the frame cannot carry, and both captions render alike under one button convention and one emoji vocabulary. Each block states the code it assumes. Design only; the code work is the sibling implementation card.

---

## The beat, and the two surfaces it renders

When the day's first lethal blow lands, the engine floors the player to 1 HP and authors a forced decision with exactly two options: `{ label: 'Bail bloodied', dcModifier: null }` and `{ label: 'Last stand', dcModifier: 0 }` (`src/engine/action/PipelineActionStateMachine.ts:645-646`; the triage note cited 740-741, and the file has moved since). It renders through `buildDecisionView` (`src/view/actionViewState.ts:137`) and reaches Discord through `decisionViewToDiscord` (`src/discord/viewToDiscord.ts:25`).

Two render facts shape the screen as it renders today, and both are what the settled design below changes:

- The bail label becomes the **worded button** (`shortLabel(opt.label, 80)`, `actionViewState.ts:223`), while the non-bail label becomes the **lettered body line** (`**A.** …`, `actionViewState.ts:233`). "Caption" is therefore two surfaces at two different widths, and quoting a button caption at body width (or the reverse) would miss the one that actually truncates.
- Neither forced label carries `stat`, and `dcArrow(0)` is empty for the last stand (`actionViewState.ts:54`; `statEmoji`, `:60`, returns nothing for a label with no `stat`), so today both captions render bare. The existing emoji vocabulary (`DISTILLED_EMOJI`, `src/engine/OutcomeRenderer.ts:101`, reached through `distilledActionEmoji`) keys on distilled action type and is never consulted from an option label.

The screen also escalates its own border: `chooseContinueBorder` (`actionViewState.ts:94`) returns the heavy style at ≤25% HP, which the last stand always is, so the continue card renders `╔` while the opener-register frames render `┌`.

## How it renders today

Plain captions, no scene frame, and the two captions on two different surfaces. Reproduced from a live call of `buildDecisionView` + `decisionViewToDiscord` on the desperate-beat payload (GLOOMFANG at 3/5 pips, player 1/30, a heavy round), not hand-drawn.

````text
🤔 Decision                        ← embed title; one body embed, one button row
──────────────────────────────────────────────────────────  ← wireframe rule, not rendered
> 🧭 **Quest:** attack the gloomfang

↪ **Stand firm**

```ansi
╔════════════════════════════╗
║  GLOOMFANG          [hard] ║
║  HP [▓▓▓░░] BRUISED        ║
║  YOU                       ║
║  HP [█░░░░░░░░░░░░░░] 1/30 ║
╠════════════════════════════╣
║  4           vs 17 +3 = 20 ║
║  +2 = 6                    ║
║  hit -14 margin      HEAVY ║
║  you -12            foe -3 ║
╚════════════════════════════╝
```

> The blow would be lethal — you feel death's cold
> touch. Make your stand or flee before it's too
> late.

**A.** Last stand
──────────────────────────────────────────────────────────  ← wireframe rule, not rendered
[ Bail bloodied ]   [ A ]          ← button row
Decision 2                         ← embed footer
````

**Assumes this code.** The continue card arrives as the `combatStatus` block, assembled by `renderCombatStatusFrame` (`actionViewState.ts:101`) and emitted in the decision embed's block list at `viewToDiscord.ts:29-33`. The bail caption is the worded button (`actionViewState.ts:223`); the last-stand caption is the lettered body line (`actionViewState.ts:233`). No scene frame: `combatSceneBlock` is only ever assigned inside `buildOutcomeView` (`actionViewState.ts:309`, `:319`, returned at `:361`) and only the outcome message selects it (`viewToDiscord.ts:92-95`, mirrored for the agent adapter at `src/agent/viewToText.ts:99-104`). The decision screen's other frame slot is `openingFrame` (`actionViewState.ts:252`), which the desperate beat never asks for.

## The settled screen: the frame is the game's screen

The frame on top is the game's screen, not a decorative opener: it leads the decision screen of every action, this beat included, and the card below keeps only what the frame cannot carry. On the last stand the frame renders the heavy border, the ladder the card is already on (`chooseContinueBorder` returns heavy at ≤25% HP, `actionViewState.ts:94`), so the two borders agree instead of dropping from `╔` to `┌` mid-screen. The card loses the foe nameplate, the condition band and both HP reads, all of which the frame is already showing, and keeps the round's dice maths; the foe's danger tag moves up to the frame's nameplate, which today carries the name alone (`OpeningFrameRenderer.ts:114`).

````text
[ embeds[0]: COMBAT_FRAME, heavy register, leading the decision screen ]
```ansi
╔════════════════════════════╗
║  GLOOMFANG          [hard] ║
║  HP [▓▓▓░░] BRUISED        ║
║                            ║
║        /\        /\        ║
║       /  \______/  \       ║
║      |    o    o    |      ║
║      |      /\      |      ║
║       \    '--'    /       ║
║        '-.______.-'        ║
║                            ║
║   ,^.                      ║
║  ( _ )   WARDEN            ║
║  /|_|\   HP [░░░░░░░] 1/30 ║
║  _/ \_                     ║
╚════════════════════════════╝
```

[ embeds[1]: the body, with the card reduced to the round ledger ]
> 🧭 **Quest:** attack the gloomfang

↪ **Stand firm**

```ansi
╔════════════════════════════╗
║  4           vs 17 +3 = 20 ║
║  +2 = 6                    ║
║  hit -14 margin      HEAVY ║
║  you -12            foe -3 ║
╚════════════════════════════╝
```

> The blow would be lethal — you feel death's cold
> touch. Make your stand or flee before it's too
> late.

**A.** 🏃 Bail bloodied
**B.** ⚔️ Last stand
──────────────────────────────────────────────────────────  ← wireframe rule, not rendered
[ A ]   [ B ]                    ← button row
Decision 2                       ← embed footer
````

**Assumes this code.** The heavy border costs no new asset: `renderOpeningFrame` already takes the border style as its fourth argument (`OpeningFrameRenderer.ts:277-282`), so the emphasis is an argument at the call site rather than a fork in the renderer, and the register stays the shipped one. Leading every decision screen is a call-site change, not a view-slot change: the decision message already leads with an embed when `openingFrame` is set (the `showOpeningFrame` gate at `actionViewState.ts:252`, prepended at `viewToDiscord.ts:69-77`, and already included for the agent adapter at `viewToText.ts:82`), but the gate defaults off (`actionViewState.ts:165`) and is passed `true` only on an action's first decision (`SessionController.ts:656`) and on combat resumes (`:295`, `:593`). The desperate beat is a later decision of a continued action, rendered through `stepChoice` (`SessionController.ts:243-261`), which passes neither the flag nor the `actionType`/enemy slots, so this path gains a flag plus those slots. The card's duplicated blocks are the nameplate, HP and band lines from `buildContinueLines` (`CombatCardRenderer.ts:118-170`), and the `borderMid` divider exists only to separate them from the ledger (`CombatCardRenderer.ts:189`); the tag is `dangerTier(lastRound.dc)` (`combat-dc.ts:170`), passed to the card alone and riding its nameplate, so rehoming it on the frame needs a tag slot beside the name.

- [p] One screen, one read: the card's 15-column player bar and the frame's 7-column bar no longer render side by side, so the `1/30` that read as one pip on one and an empty run on the other is gone, and the frame's bar plus its suffix (`OpeningFrameRenderer.ts:140-143`) is the only player-HP read left.
- [p] Reuse over invention: the frame is the shipped COMBAT_FRAME at a heavier border, and the emoji pair the captions need already exists in the vocabulary.
- [c] The frame now leads every decision screen, so the gate and the `actionType`/enemy slots move onto `stepChoice` (`SessionController.ts:243-261`), a path every continued action takes.
- [c] The frame's own bar still rounds `1/30` to an empty 7-wide bar beside its own `1/30` suffix, the width-plus-rounding artefact rather than a missing floor; the deferred health-bar card owns it.
- [c] Height: two embeds and a 16-line art block sit above the choices on the screen where a panicking player most needs both choices near the thumb, though the card below them drops from eight interior lines to four.

## Captions: one emoji, one convention for the row

Both forced options render alike: the caption sits in the message as a lettered line with its emoji, and the button carries the letter (`**B.** ⚔️ Last stand`, `[ B ]`). The letters follow the beat's authored option order, which puts the bail first (`PipelineActionStateMachine.ts:645-646`), so the last stand lands on B. That is what every non-terminal option already does (`actionViewState.ts:233`, `:227-228`), so it is the cheaper of the two conventions the review offered: it deletes the terminal option's special case (`actionViewState.ts:222-223`) instead of adding a second one for a non-terminal option, and it leaves the caption on the 30-column body line, where a re-worded label cannot truncate. [POC action UX refinements](../decisions/poc-action-ux-refinements.md) § 1 carved "+ the terminal button" out of its own option-text-in-the-body rule; settling on letters retires that carve-out, and the implementation card amends that record.

The emoji is per option, from one vocabulary for the whole game, so an option carries the same emoji wherever it renders: `DISTILLED_EMOJI` maps `combat`/`attack` to ⚔️ and `flee`/`retreat` to 🏃 (`OutcomeRenderer.ts:101`), while `bail` falls through to the ✴️ default, so the map keys on the option's intent or on its label, render-side. `opt.label` stays raw either way, because it is also the choice key and the persisted choice, resolved by string equality in `step` (`PipelineActionStateMachine.ts:299-301`) and recorded as `chosen` (`:309`, `:336`), which renders into the story thread (`actionViewState.ts:86`); baking the emoji into the label would break every `stepAction` addressing the option by name and leak the glyph into the next screen's thread. The bail letter keeps the danger tint (`viewToDiscord.ts:51-55`), so the way out still reads as one.

## Rejected on the way here

- [I] **The frame replacing the card.** It would have to gain the live nameplate, the band and the dice layout the card owns (`src/render/CombatCardRenderer.ts:188-230`), and the card is the shared screen of every mid-fight decision, so the last stand would have rewritten every combat round rather than one beat.
- [I] **A last-stand register of its own.** An opener is an encounter-setter and this is a mid-fight crisis, but a distinct register buys that drama with an asset, a colour-role set and a wireframe, where combat frames stay standard.

## Caption budget against Discord mobile width

Budget stated because truncation is the risk that decided the convention: **20 visible columns for a caption on a two-button row**, and **30 columns for a body option line**. The captions ride the body, so the 20 is kept as the measurement the button route failed rather than as a live constraint.

- The 30 is measured, not guessed: phone portrait is a hard 30-column cap for scene text, with 60 columns the ceiling for a code block ([Discord Window Size Reference](../templates/discord-window-size.md), and [Discord UX](../ui/poc-discord-ux.md) § Width).
- The 20 is derived: a worded caption shares its action row with the other button plus Discord's own button padding, which takes roughly a third of the 30. The empirical anchor is the recorded POC failure, where a 24-column caption ("Decline — I'll use steel") in a two-button row truncated on mobile, and is why option text moved into the body while the buttons became letters ([POC action UX refinements](../decisions/poc-action-ux-refinements.md) § 1).
- Emoji count 2 columns, a variation selector counts 0, spaces count 1. Today's bail caption is 13 columns on the button, and the row is comfortable.

| Caption | Columns | Verdict |
| --- | --- | --- |
| `**A.** 🏃 Bail bloodied`, in the body | 19 of 30 | fits, 11 spare |
| `**B.** ⚔️ Last stand`, in the body | 16 of 30 | fits, with room for a longer label |
| `Bail bloodied` (today's button) | 13 | fits |
| `🏃 Bail bloodied` on a button | 16 of 20 | fits, 4 spare |
| `🏃 Bail out bloodied` on a button | 20 of 20 | on the line with nothing spare: the longest caption the row would hold |
| `🏃 Bail out, bleed later` on a button | 24 | over the row, truncates |

So the emoji is affordable on either surface. What settles the convention is the bottom of that table: a button caption has 20 columns, the bail label already spends 16 of them, and a more dramatic label truncates on the platform that must pass, while the body line it moves to still has 11 columns spare.

## Settled, and deferred

- [p] **Frame register:** the shipped COMBAT_FRAME, parameterised, not a register of its own. Combat frames stay standard, and the last stand reads as the same screen in a heavier mood.
- [p] **Emoji:** per option, one vocabulary for the whole game, applied wherever an option renders.
- [p] **Frame above the card, not replacing it:** the card keeps the round ledger, which the frame has no room for.
- [p] **Border:** both thick on this screen, so the two borders come off one ladder.
- [p] **Button convention:** the caption in the message for every option, the letter on every button.
- [>] **Health bars:** a follow-up card owns them in general; the 1 HP read stays a placeholder here.
- [p] **The 20-column budget:** with no caption in the button row, nothing on this screen rides it; the body lines sit inside the measured 30, so no live check gates the implementation.
- [!] **Nothing here is built.** The design is settled; the code work is the sibling implementation card, which needs `Status=Approved` on its own.

---

- Frame conventions: [[ansi-art-classification-framework]] (registers, slots, the art-post + reply convention), [[mvp+ansi-art]] (live-tested colour constraints, frame slots, splash), [[visual-craft]] (the craft bar these treatments are judged against).
- Cheap next step for a live check: paste a wireframe into a file and run `npm run send-dm -- --fence ansi -f <file>` to deliver it to the admin DM for a desktop and phone comparison.
