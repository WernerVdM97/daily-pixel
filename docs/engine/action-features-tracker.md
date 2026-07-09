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
| 1 | `combat` | buttonsRoll (multi-round) | 0.3.0 | COMBAT_FRAME, COMBAT_CRIT, COMBAT_DIAGONAL `[mvp+]`, BOSS_INTRO `[mvp+]` | ❌ none — renderer not built |
| 2 | `travel` | buttonsRoll | 0.2.6 | — (map / look views use embeds, not frames) | ❌ none — no register mapped |
| 3 | `social` | freetextJudged | POC | DIALOGUE_MODAL | ❌ none — renderer not built |
| 4 | `skill` | buttonsRoll | POC | DATA_CARD | ❌ none — renderer not built |
| 5 | `search` | buttonsRoll / rolllessSolve | POC | DIALOGUE_MODAL | ❌ none — renderer not built |
| 6 | `rest` | often rollless | 0.2.2 | REST_STOP `[mvp+]` | ❌ none — renderer not built |
| 7 | `other` | generic fallback | POC | — (catch-all, no art planned) | — |

**Art coverage:** 0 of 7 action types have ANSI art today. 4 have registers assigned (combat, social, skill, search). The remaining 2 (travel, rest) have mvp+ registers deferred. `other` never gets art.

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
| 7 | `modify_max_stamina` | 0.2.6 | Ceiling gains; `CharacterRepository.update` allow-list gap fixed `[Unreleased]` |
| 8 | `modify_wealth` | POC | Coin delta |
| 9 | `modify_rolls_remaining` | POC | Bonus-roll mechanic; needs design per TODO.md |

### Inventory (2)

| # | Op | Live since | Notes |
|---|---|---|---|
| 10 | `add_item` | POC | Item gained; stat bonus surfaces on `/stats` |
| 11 | `remove_item` | POC | Item lost/consumed; loss rendering unclear (B#4) |

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
| CombatBeatLog telemetry | ✅ live | Round, band, HP deltas, ops per beat; parked for prose-critic trigger decision |
| Combat save (once-per-day floor) | ✅ live | `combat_save` relation; no one-shot kills |
| Multi-round combat | ✅ live | Lifted decision cap; `in_combat` edge persists across beats |
| Combat HUD / HP bars | ❌ none | B#5/B#6: crammed text, negative HP display |
| Combat maths reveal | ❌ none | F#7: show dice, margin, per-combatant HP bars |
| ANSI combat frame | ❌ none | T2 in [[poc-plus-stage-1-plan]]; renderer not built |

## 6. Art integration — current vs target

### What exists (monochrome ASCII, pre-ANSI)

23 `.ascii` scene files in `assets/scenes/`, loaded by `src/assets/ascii-loader.ts`. Tag-keyed, colour-free, rendered as plain text inside Discord code blocks — no ANSI escape codes, no frame system.

### What the ANSI classification framework calls for

| Layer | Component | Status |
|---|---|---|
| Renderer | `AnsiRenderer` (`src/render/AnsiRenderer.ts`) | ❌ not built |
| Registers | Chrome templates (`assets/ansi/templates/registers/`) | ❌ not built |
| UI templates | Bar templates, pip meters, ground strips (`assets/ansi/templates/ui/`) | ❌ not built |
| Colour maps | `standard_roles.json`, `register_overrides.json` | ❌ not built |
| Fragment DB | `fragments` table (entity_type, entity_key, zoom_level, pose) | ❌ not built |
| Seed fragments | `assets/ansi/seed-fragments.yml` → DB insert at boot | ❌ not built |
| Register dispatch | Scenario → register lookup table | ❌ not built |

### Art coverage by POC+ item

| POC+ item | Registers needed | Renderer built? | Fragment art needed? |
|---|---|---|---|
| 2 · Combat maths reveal | COMBAT_FRAME, COMBAT_CRIT, DATA_CARD | ❌ T2 builds it | Enemy sprites (combat), d20 centrepiece (crit), no fragments for DATA_CARD |
| 3 · Nat 1/20 broadcast | BROADCAST_CARD | Reuses #2 renderer | d20 centrepiece (crit-lite); re-enactment lifted from resolve narration (no fragment needed) |
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

What's missing to complete POC+ art coverage:

| Gap | Blocking | Est. effort |
|---|---|---|
| `AnsiRenderer` + chrome templates for COMBAT_FRAME, COMBAT_CRIT, DATA_CARD, BROADCAST_CARD | Items 2, 3 | T2 in stage 1 plan |
| Fragment DB table + seed enemy sprites | Item 2 (combat frames) | Not yet tasked |
| Enemy fragment art (at least 2-3 common foes) | Item 2 (combat frames) | Not yet tasked |
| DIALOGUE_MODAL chrome + text-slot rendering | Item 4 | Not yet tasked |
| BOSS_INTRO chrome + HUD strips | Item 5 | Deferred (mvp+) |

The renderer build (T2) is the single chokepoint — once it ships, items 2-4 all reuse it. Fragment art is the next bottleneck: the renderer can render chrome-only frames (no sprite slot) for an initial pass, but combat frames really want the enemy sprite.
