---
title: Last-Stand Screen: Emoji Captions & Combat Scene Frame
status: spark
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
---
Wireframes for the desperate-choice beat: how the last-stand screen renders today, and two candidate treatments that put an emoji on both forced labels and a combat scene frame on the screen. Each block states the code it assumes, and the caption-width check decides whether the captions survive mobile. Evaluation only; the options stay options.

---

## The beat, and the two things it renders

When the day's first lethal blow lands, the engine floors the player to 1 HP and authors a forced decision with exactly two options: `{ label: 'Bail bloodied', dcModifier: null }` and `{ label: 'Last stand', dcModifier: 0 }` (`src/engine/action/PipelineActionStateMachine.ts:645-646`; the triage note cited 740-741, and the file has moved since). It renders through `buildDecisionView` (`src/view/actionViewState.ts:137`) and reaches Discord through `decisionViewToDiscord` (`src/discord/viewToDiscord.ts:25`).

Two render facts shape every wireframe below:

- The bail label becomes the **worded button** (`shortLabel(opt.label, 80)`, `actionViewState.ts:223`), while the non-bail label becomes the **lettered body line** (`**A.** …`, `actionViewState.ts:233`). "Caption" is therefore two surfaces at two different widths, and quoting a button caption at body width (or the reverse) would miss the one that actually truncates.
- Neither forced label carries `stat`, and `dcArrow(0)` is empty for the last stand (`actionViewState.ts:54`; `statEmoji`, `:60`, returns nothing for a label with no `stat`), so today both captions render bare. The existing emoji vocabulary (`DISTILLED_EMOJI`, `src/engine/OutcomeRenderer.ts:101`, reached through `distilledActionEmoji`) keys on distilled action type and is never consulted from an option label.

The screen also escalates its own border: `chooseContinueBorder` (`actionViewState.ts:94`) returns the heavy style at ≤25% HP, which the last stand always is, so the continue card renders `╔` while the opener-register frames render `┌`.

## (a) As it renders today

Plain captions, no scene frame. Reproduced from a live call of `buildDecisionView` + `decisionViewToDiscord` on the desperate-beat payload (GLOOMFANG at 3/5 pips, player 1/30, a heavy round), not hand-drawn.

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

**Assumes this code.** The continue card arrives as the `combatStatus` block, assembled by `renderCombatStatusFrame` (`actionViewState.ts:101`) and emitted in the decision embed's block list at `viewToDiscord.ts:29-33`. The bail caption is the worded button (`actionViewState.ts:223`); the last-stand caption is the lettered body line (`actionViewState.ts:233`). No scene frame: `combatSceneBlock` is only ever assigned inside `buildOutcomeView` (`actionViewState.ts:308`, `:318`, returned at `:350`) and only the outcome message selects it (`viewToDiscord.ts:92-95`, mirrored for the agent adapter at `src/agent/viewToText.ts:99-104`). The decision screen's other frame slot is `openingFrame` (`actionViewState.ts:252`), which the desperate beat never asks for.

## (b) Candidate: emoji captions, combat scene frame above the card

Both forced captions gain an emoji from the existing vocabulary, and the screen leads with the registered COMBAT_FRAME (opener variant, `src/render/OpeningFrameRenderer.ts`) above the continue card.

````text
[ embeds[0]: COMBAT_FRAME, opener register, prepended ]
```ansi
┌────────────────────────────┐
│  GLOOMFANG                 │
│  HP [▓▓▓░░] BRUISED        │
│                            │
│        /\        /\        │
│       /  \______/  \       │
│      |    o    o    |      │
│      |      /\      |      │
│       \    '--'    /       │
│        '-.______.-'        │
│                            │
│   ,^.                      │
│  ( _ )   WARDEN            │
│  /|_|\   HP [░░░░░░░] 1/30 │
│  _/ \_                     │
└────────────────────────────┘
```

[ embeds[1]: the same body as (a), one emoji added, read under the scene above ]
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

**A.** ⚔️ Last stand
──────────────────────────────────────────────────────────  ← wireframe rule, not rendered
[ 🏃 Bail bloodied ]   [ A ]       ← button row
````

**Assumes this code.** Same option labels as (a), at `PipelineActionStateMachine.ts:645-646`. The scene half needs no new view slot, but it is not free of call-site change: the decision message already leads with an embed when `openingFrame` is set (the `showOpeningFrame` gate at `actionViewState.ts:252`, prepended at `viewToDiscord.ts:69-77`, and already included for the agent adapter at `viewToText.ts:82`), so a last-stand screen reusing it shows the frame to the player-agent too. The gate defaults off (`actionViewState.ts:165`) and is passed `true` only on an action's first decision (`SessionController.ts:653`) and on combat resumes (`:295`, `:593`). The desperate beat is a later decision of a continued action, rendered through `stepChoice` (`SessionController.ts:243-261`), which passes neither the flag nor the `actionType`/enemy slots, so reusing the register costs that path a flag plus those slots, not a new view slot. The emoji half reads `DISTILLED_EMOJI` (`OutcomeRenderer.ts:101`): `distilledActionEmoji('flee')` and `('retreat')` return 🏃, `('combat')` and `('attack')` return ⚔️, while `('bail')` falls through to the ✴️ default, so the captions need a key the vocabulary already has (`flee`, `combat`) or a label-keyed map beside it. A label-keyed map is the cheaper route, because `opt.label` is not only the button caption and the body line (`actionViewState.ts:223` and `:233`): it is also the choice key and the persisted choice, resolved by string equality in `step` (`PipelineActionStateMachine.ts:299-301`) and recorded as `chosen` (`:309`, `:336`), which renders into the story thread (`actionViewState.ts:86`). Baking the emoji into the labels at `PipelineActionStateMachine.ts:645-646` would therefore carry it to both surfaces from one place, but it is an engine-plus-wire change, not the free move it looks like: every `stepAction` addressing an option by label breaks (`Invalid choice`), and the next screen's thread reads `↪ **⚔️ Last stand**`. That is why the render-side decorations keep `opt.label` raw (`actionViewState.ts:227-228`).

- [p] Cheapest option: the frame slot exists, the emoji vocabulary exists, and a label-keyed render map keeps `opt.label` raw, so nothing on the wire moves; the only engine-side edit is the frame's own call site on the mid-action path.
- [c] The frame duplicates the card. Both carry the foe's nameplate, its condition band and the player's HP, and side by side they disagree on the same 1 HP: both renderers call `hpBar` (`AnsiRenderer.ts:148`), which has no fill floor, but the continue card passes it a 15-column width and the opener 7, so `round(1/30 * 15) = 1` against `round(1/30 * 7) = 0` — the opener shows `[░░░░░░░]` (reads dead) where the card shows `[█░░░░░░░░░░░░░░]`.
- [c] Register clash: a standard-bordered `┌` frame directly above a heavy-bordered `╔` card shows two borders from two ladders at once.
- [c] Height: a second embed plus a 16-line art block sits on the screen where a panicking player most needs both choices near the thumb.

## (c) Variant: the frame replaces the card

Same captions, one frame, no duplication. The round's dice maths has to go somewhere, because the frame carries none.

````text
[ embeds[0]: COMBAT_FRAME, header and footer re-pointed at the live fight ]
┌────────────────────────────┐
│  GLOOMFANG          BRUISED│     ← condition band in the header slot
│                            │
│        /\        /\        │
│       /  \______/  \       │
│      |    o    o    |      │     ← the foe mid-fight, not at its opener
│      |      /\      |      │
│       \    '--'    /       │
│        '-.______.-'        │
│                            │
│   ,^.                      │
│  ( _ )   WARDEN    1/30    │
│  /|_|\   `4 vs 17 +3 = 20` │     ← dice line rehomed into the footer
│  _/ \_   `hit -14 · HEAVY` │
└────────────────────────────┘

> The blow would be lethal — you feel death's cold touch.
> Make your stand or flee before it's too late.

**A.** ⚔️ Last stand
[ 🏃 Bail bloodied ]   [ A ]
````

**Assumes this code.** Captions and their emoji as in (b), from the labels at `PipelineActionStateMachine.ts:645-646`. Everything the frame lacks today it would have to gain: the opener variant is fed static slots (`openingFrameSlots`, `actionViewState.ts:244-252`), while the card's live values come from `CombatStatusData` and the last `CombatBeatLog` (`renderCombatStatusFrame`, `actionViewState.ts:101-127`). This is a frame-register change rather than a decision-view change, and it costs the card's own dice layout (`src/render/CombatCardRenderer.ts:188-230`).

- [p] One nameplate, one HP read, no contradiction on the 1/30 bar.
- [c] The continue card is shared with every mid-fight decision, so touching it for the last stand touches every combat round's screen.
- [c] Puts the "cooler" half of the ask into the ANSI frame library, which needs its own wireframe and colour roles before it can be emitted.

## Caption budget against Discord mobile width

Budget assumed, stated because truncation is the risk being evaluated: **20 visible columns for the worded bail caption** and **30 columns for a body option line**.

- The 30 is measured, not guessed: phone portrait is a hard 30-column cap for scene text, with 60 columns the ceiling for a code block ([Discord Window Size Reference](../templates/discord-window-size.md), and [Discord UX](../ui/poc-discord-ux.md) § Width).
- The 20 is derived: the bail caption shares its action row with the lettered `A` button plus Discord's own button padding, which takes roughly a third of the 30. The empirical anchor is the recorded POC failure, where a 24-column caption ("Decline — I'll use steel") in a two-button row truncated on mobile, and is why option text moved into the body while the buttons became letters ([POC action UX refinements](../decisions/poc-action-ux-refinements.md) § 1).
- Emoji count 2 columns, a variation selector counts 0, spaces count 1. Today's caption is 13 columns, and the row is comfortable.

| Caption | Columns | Verdict |
| --- | --- | --- |
| `Bail bloodied` (today) | 13 | fits |
| `🏃 Bail bloodied` | 16 | fits, 4 spare |
| `🏃 Bail out bloodied` | 20 | exactly the budget, with nothing spare: the longest caption that still fits |
| `🏃 Bail out, bleed later` | 24 | over the row, truncates |
| `**A.** ⚔️ Last stand`, in the body | 16 of 30 | fits, with room for a longer label |

So the emoji is affordable: it costs 3 columns on the worded caption and leaves the short labels a forced beat needs well inside the row. What it does not afford is a re-worded, more dramatic bail caption. The emoji and a longer label compete for the same few columns, and a caption that only looks cooler on desktop buys a truncated button on the platform that must pass.

## Open questions

- [?] **Own frame register, or reuse COMBAT_FRAME?** Reading the last stand as the COMBAT_FRAME opener variant is the zero-new-assets path, but an opener is an encounter-setter and this is a mid-fight crisis. A distinct last-stand register buys the drama and costs an asset, a colour-role set and a wireframe.
- [?] **Emoji per option, or per outcome?** The vocabulary is per distilled action type today, so 🏃 and ⚔️ are derived from intent words. A label-keyed map suits a caption better but grows a second vocabulary beside the first.
- [?] **Frame above the card, or replacing it?** (b) duplicates the nameplate and the HP bar and shows two border registers; (c) removes both and pays in the shared continue card and the dice line's rehoming.
- [?] **Which border wins?** The card is already heavy on this screen (`chooseContinueBorder`, `actionViewState.ts:94`), so a frame keeping `┌` above it reads as a downgrade of the moment.
- [?] **Opener bar width, or a 1 HP floor?** The disagreement above is width plus rounding, not a missing fill rule, so either fix moves more than this one bar: widening the opener moves every opener reading (2/30 shows no pip in 7 columns where the card's 15 shows one), a floor inside `hpBar` moves every bar in the game.
- [?] **Is 20 columns right?** The derived budget matches the recorded POC truncation, but nothing in the repo has measured a two-button row on a phone. A live check settles it, and `🏃 Bail out bloodied` is its test case: the one caption that sits exactly on the line.
- [!] **Nothing here is approved.** The code work is the sibling implementation card, which needs `Status=Approved` on its own; these wireframes only show what it would look like.

---

- Frame conventions: [[ansi-art-classification-framework]] (registers, slots, the art-post + reply convention), [[mvp+ansi-art]] (live-tested colour constraints, frame slots, splash), [[visual-craft]] (the craft bar these treatments are judged against).
- Cheap next step for a live check: paste a wireframe into a file and run `npm run send-dm -- --fence ansi -f <file>` to deliver it to the admin DM for a desktop and phone comparison.
