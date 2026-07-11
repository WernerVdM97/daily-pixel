---
title: Action Features & Art Integration Tracker
status: exploring
domain: engine
phase: mvp
tags:
  - tracker
  - actions
  - mutations
  - pipeline
  - art
  - ansi
  - registers
related:
  - "[[action-engine-framework]]"
  - "[[ansi-art-classification-framework]]"
  - "[[poc-plus-roadmap]]"
  - "[[prompt-v12-scene-state]]"
---
_Compact tracker of every feature built in the action space (action types, mutations, pipeline stages, scene-state relations, combat) cross-referenced against ANSI art register coverage and the POC+ roadmap. Answers "what have we built, and how much of it has art?" at a glance._

---

# Action Features & Art Integration Tracker

## 1. Action types (7)

All live and in use. Pipeline classify DMA routes every action to one of these.

| # | ActionType | ResolutionMode | Live since | ANSI register | Art status |
|---|---|---|---|---|---|
| 1 | `combat` | buttonsRoll (multi-round) | 0.3.0 | COMBAT_FRAME, COMBAT_CRIT, COMBAT_DIAGONAL `[mvp+]`, BOSS_INTRO `[mvp+]` | ✅ combat continue + terminal cards (0.3.1) and opening frame (0.3.1) — enemy sprite fragments deferred, placeholder scene |
| 2 | `travel` | buttonsRoll | 0.2.6 | — (map / look views use embeds, not frames) | ✅ opening frame (0.3.1, origin-location scene) — but auto-resolved travel shows none yet (known gap) |
| 3 | `social` | freetextJudged | POC | DIALOGUE_MODAL | ✅ opening frame (0.3.1, NPC bust placeholder) — DIALOGUE_MODAL not built |
| 4 | `skill` | buttonsRoll | POC | DATA_CARD | ✅ opening frame (0.3.1, placeholder scene) |
| 5 | `search` | buttonsRoll / rolllessSolve | POC | DIALOGUE_MODAL | ✅ opening frame (0.3.1, placeholder scene) |
| 6 | `rest` | often rollless | 0.2.2 | REST_STOP `[mvp+]` | ✅ opening frame (0.3.1) — auto-resolved rest shows none yet (known gap) |
| 7 | `other` | generic fallback | POC | — (catch-all, no art planned) | ✅ opening frame (0.3.1, placeholder scene) |

**Art coverage (post-`0.3.1`):** the `AnsiRenderer` is built and all 7 types now lead with an ANSI opening frame; `combat` additionally renders bespoke continue + terminal cards showing the round maths. The remaining gap is the **fragment catalogue** (enemy sprites, NPC busts, PC poses) — mvp+/deferred, so the sprite/scene slots render as deliberate placeholder scenes. Two known runtime gaps: actions that auto-resolve at start (common for travel/rest) show no opening frame, and combat's opening frame reads "Unknown foe" pre-first-step. Both tracked in `TODO.md`.

## 2. Mutation vocabulary (17 ops)

Grouped by target entity per the [[action-engine-framework]] Diagram 3. Every op is LLM-proposed, engine-disposed.

### Location / world graph (4)

| # | Op | Live since | Notes |
|---|---|---|---|
| 1 | `move_to` | 0.3.0 | Charted-node travel; supersedes `set_location` for known destinations |
| 2 | `set_location` | POC | Legacy alias; kept for backward compat, replaced by `move_to` |
| 3 | `cross_frontier` | 0.2.6 | Frontier crossing; the exploration verb. Mints + charts new ground |
| 4 | `reveal_location` | POC | Reveals a location node (rumour, map unlock) |

### Character scalars (5)

| # | Op | Live since | Notes |
|---|---|---|---|
| 5 | `modify_health` | POC | Clamped 0..max |
| 6 | `modify_stamina` | POC | Clamped 0..max |
| 7 | `modify_max_stamina` | 0.2.6 | Ceiling gains; `CharacterRepository.update` allow-list gap fixed (0.3.1, B#2) |
| 8 | `modify_wealth` | POC | Coin delta |
| 9 | `modify_rolls_remaining` | POC | Bonus-roll mechanic; needs design per TODO.md |

### Inventory (2)

| # | Op | Live since | Notes |
|---|---|---|---|
| 10 | `add_item` | POC | Item gained; stat bonus surfaces on `/stats` |
| 11 | `remove_item` | POC | Item lost/consumed; loss now renders as a subtraction with a real minus glyph (0.3.1, B#4) |

### NPCs (4)

| # | Op | Live since | Notes |
|---|---|---|---|
| 12 | `add_npc` | POC | NPC created + placed |
| 13 | `spawn_npc` | 0.2.3 | Alias for `add_npc`; used by Saturday threat spawn |
| 14 | `update_npc` | POC | NPC state change |
| 15 | `remove_npc` | POC | NPC removed from world |

### Scene-state relations (2)

| # | Op | Live since | Notes |
|---|---|---|---|
| 16 | `set_relation` | 0.3.0 | Edge-shaped mutation; creates `(from, to, relType, props)` edge |
| 17 | `update_relation` | 0.3.0 | Updates props on existing edge; dropped-with-warn if edge missing |

## 3. Pipeline stages (4 DMAs)

Live since 0.3.0. The classify → decide → dice → resolve spine from [[prompt-separation-of-concerns]].

| # | DMA | Role | Owns |
|---|---|---|---|
| 1 | CLASSIFY | Route action to ActionType + extract routing flags | ActionType, combat detection, scene-location extraction |
| 2 | DECIDE | Author options (per-option stat, DC, mutation intent) | Option shape, narration (CONTINUE beats), difficulty hints |
| 3 | RESOLVE-MUTATE | Propose mutations against roll verdict | Mutation set, outcome_text (pre-adjustment) |
| 4 | RESOLVE-NARRATE | Patch prose only; no state changes | Flavour text, message-box content |

**Critic:** fires on every decide beat (since 0.3.0). Reviews for shape/coherence; triggers re-decide on `major` verdict. Patch-prose-only — never authors mutations.

## 4. Scene-state relations (8 relTypes)

Live since 0.3.0. Edge-shaped state carried across beats per [[prompt-v12-scene-state]].

| # | relType | Writes | Use |
|---|---|---|---|
| 1 | `in_combat` | `combat` | Enemy HP, round, posture; anchors combat scene |
| 2 | `combat_save` | `combat` | Once-per-day no-one-shot floor; per PC→PC edge |
| 3 | `trust` | `social` | NPC trust level (0–100) |
| 4 | `owes_debt` | `social` | Debt amount to NPC |
| 5 | `knows_secret` | `social` | Secret the PC knows about this NPC |
| 6 | `fears` | `social` | What the NPC fears (PC knows) |
| 7 | `disposition` | `social` | NPC disposition toward PC (−10 to +10) |
| 8 | `puzzle` | `skill`, `search` | Puzzle node state, clues found |

## 5. Combat feature surface

Live since 0.3.0 per [[prompt-v12-combat]] + [[prompt-v12-scene-state]] Thread C.

| Feature | Status | Notes |
|---|---|---|
| Contested d20 (player vs enemy) | ✅ live | Engine-rolled both dice |
| Severity bands (clean / glanced / trade / heavy) | ✅ live | Determines HP delta per round |
| CombatBeatLog telemetry | ✅ live | Round, band, HP deltas, ops per beat, plus full per-round maths (`playerD20`/`playerBonus`/`dc`/`enemyD20`/`enemyBonus`/`margin`, added 0.3.1); still parked for the prose-critic trigger decision |
| Combat save (once-per-day floor) | ✅ live | `combat_save` relation; no one-shot kills |
| Multi-round combat | ✅ live | Lifted decision cap; `in_combat` edge persists across beats |
| Combat HUD / HP bars | ✅ live | 0.3.1: per-combatant HP-bar lines, clamped `[0, max]`, banded enemy pips; closes B#5/B#6 |
| Combat maths reveal | ✅ live | 0.3.1: dice vs boxed DC, margin, band word, per-round readout on the continue card; closes F#7 |
| ANSI combat frame | ✅ live | 0.3.0/0.3.1: `AnsiRenderer` + `CombatCardRenderer` (continue + terminal cards), border intensity/rarity ladder |

## 6. Art integration — current vs target

### What exists

Two layers coexist. The legacy monochrome ASCII: 23 `.ascii` scene files in `assets/scenes/`, tag-keyed and colour-free, loaded by `src/assets/ascii-loader.ts` and rendered as plain text (still used for non-combat outcome scene art). And the new ANSI frame system shipped across 0.3.0/0.3.1: `src/render/` (`AnsiRenderer` + `palette.ts` + `CombatCardRenderer` + `OpeningFrameRenderer`), colour-by-role at render time with a monochrome-safe mobile degrade, driven by width-validated wireframes in `assets/ansi/wireframes/`. Migrating the old `.ascii` scenes onto the ANSI system (semantics, source files, references) is still open in `TODO.md`.

### What the ANSI classification framework calls for

| Layer | Component | Status |
|---|---|---|
| Renderer | `AnsiRenderer` (`src/render/AnsiRenderer.ts`) | ✅ built (0.3.0/0.3.1) — palette-driven, border ladder |
| Registers | Chrome templates (`assets/ansi/templates/registers/`) | ◐ partial — combat cards + opening frames render as code, not yet a template directory |
| UI templates | Bar templates, pip meters, ground strips (`assets/ansi/templates/ui/`) | ◐ partial — HP bars + enemy pips live in code, not extracted as templates |
| Colour maps | `standard_roles.json`, `register_overrides.json` | ✅ superseded — colour vocabulary lives in `src/render/palette.ts` (`PALETTES` house/ember/gloom) |
| Fragment DB | `fragments` table (entity_type, entity_key, zoom_level, pose) | ❌ not built (mvp+/deferred) |
| Seed fragments | `assets/ansi/seed-fragments.yml` → DB insert at boot | ❌ not built (mvp+/deferred) |
| Register dispatch | Scenario → register lookup table | ◐ partial — classify routes the opening frame per type; no general register table |

### Art coverage by POC+ item

| POC+ item | Registers needed | Renderer built? | Fragment art needed? |
|---|---|---|---|
| 2 · Combat maths reveal | COMBAT_FRAME, COMBAT_CRIT, DATA_CARD | ✅ built (0.3.1) | Enemy sprites (combat), d20 centrepiece (crit), no fragments for DATA_CARD |
| 3 · Nat 1/20 broadcast | BROADCAST_CARD | Reuses #2 renderer (BROADCAST_CARD itself not yet built) | d20 centrepiece (crit-lite); re-enactment lifted from resolve narration (no fragment needed) |
| 4 · Cross-player buffs | DIALOGUE_MODAL | Reuses #2 renderer | NPC busts (future); no fragment art in first pass — chrome + text slots only |
| 5 · Saturday boss hunt | BOSS_INTRO `[mvp+]`, COMBAT_CRIT | Reuses #2 renderer | Boss sprite (full figure), HUD strips; deferred past POC+ |

## 7. POC+ roadmap coverage map

Cross-reference of every POC+ item against action features and art status.

| # | Item | Action types touched | Mutations needed | Scene-state needed | Art registers | Art status |
|---|---|---|---|---|---|---|
| 0 | v12 closeout tail | — | — | — | — | n/a — code sweep only |
| 1 | Welcome tag | — (join command) | — | — | WELCOME_CARD `[mvp+]` | ❌ deferred; embed-based in T1 |
| 2 | Combat maths reveal | `combat` | `modify_health`, `set_relation`, `update_relation` | `in_combat` | COMBAT_FRAME, COMBAT_CRIT, DATA_CARD | ❌ T2 builds renderer |
| 3 | Nat 1/20 broadcast | `combat`, `skill`, `search`, `social` | — (read-only, no new mutations) | — (reads existing) | BROADCAST_CARD | Reuses #2 renderer |
| 4 | Cross-player buffs | `social` | `modify_health`, `modify_stamina`, `modify_rolls_remaining` (on target PC) | `trust` / `disposition` (nearby-player awareness) | DIALOGUE_MODAL | Reuses #2 renderer |
| 5 | Saturday boss hunt | `combat` | `set_relation`, `update_relation` (shared HP edge) | `in_combat` (shared), `threat_pending` / `threat_defeated` | BOSS_INTRO `[mvp+]`, COMBAT_CRIT | Deferred past POC+ |

## 8. Gap summary

What's missing to complete POC+ art coverage (the `AnsiRenderer` chokepoint is now resolved — shipped 0.3.1):

| Gap | Blocking | Est. effort |
|---|---|---|
| BROADCAST_CARD frame (reuses the renderer) | Item 3 (nat 1/20 broadcast) | Stage 2 |
| Fragment DB table + seed enemy sprites | Item 2 combat frames (sprite slots) | Not yet tasked (mvp+) |
| Enemy fragment art (at least 2-3 common foes) | Item 2 (combat frames) | Not yet tasked (mvp+) |
| DIALOGUE_MODAL chrome + text-slot rendering | Item 4 | Not yet tasked |
| BOSS_INTRO chrome + HUD strips | Item 5 | Deferred (mvp+) |
| Opening frame on auto-resolved actions; combat opener "Unknown foe" | Runtime coverage of the 0.3.1 opening frame | Small follow-ups in `TODO.md` |

The renderer build (0.3.1) is done, and items 2-4 reuse it. **Fragment art is now the single next bottleneck**: the renderer renders chrome + placeholder scenes today, but combat frames and DIALOGUE_MODAL really want the enemy sprite / NPC bust from the deferred `fragments` catalogue.
