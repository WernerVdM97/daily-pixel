---
title: ANSI Art Classification & Rendering Framework
status: exploring
domain: engine
phase: mvp
tags:
  - ansi
  - ascii
  - framework
  - rendering
  - classification
  - registers
related:
  - "[[mvp+ansi-art]]"
  - "[[action-engine-framework]]"
  - "[[poc-plus-roadmap]]"
---
_A classification framework that maps every player-facing scenario to an ANSI art **register** — a fixed structural template with deterministic (engine-owned) and generative (LLM-authored) slots. Defines the full taxonomy of registers, their chrome/slot budgets, colour-role conventions, and the slot-binding rules that keep every frame structurally sound regardless of whether its content came from dice math or an LLM._

> **Scope:** the classification taxonomy (register shapes, slot contracts, colour vocabulary) is MVP — it guides the `AnsiRenderer` architecture from day one. Individual registers are phased: COMBAT_FRAME, COMBAT_CRIT, DATA_CARD, BROADCAST_CARD, and DIALOGUE_MODAL are MVP-tier (core-loop surfaces); the remaining nine registers are mvp+ depth and deferred. Each register in §3 carries a `phase` tag so the implementation order is explicit.

---

# ANSI Art Classification & Rendering Framework

## 1. The core insight: registers, not one-off frames

Every ANSI frame the bot emits is an instance of a **register** — a named visual grammar with a fixed chrome (border, structural lines), swappable slots (content zones), and a binding contract that says how each slot gets populated: from engine data, from an LLM prompt, or from a DB-backed fragment.

The [[mvp+ansi-art]] experiment doc catalogued 14 visual scenarios as design references; this doc formalises them into a **machine-readable framework** the `AnsiRenderer` can consume, and cross-references every register against the action-engine pipeline so each scenario knows which register to use.

A register answers five questions:

1. **Width budget** — 30 cols (mobile-safe) or 40 cols (desktop showpiece)?
2. **Chrome** — border style, corners, ornaments, rivets, crest interrupt?
3. **Slots** — what named zones exist, and at what size?
4. **Binding** — per slot: is the content engine-owned (deterministic), LLM-authored (generative), or DB-backed hybrid fragment?
5. **Colour palette** — which roles from the standard vocabulary apply?

The Renderer never invents structure — it always operates inside a register's constraints. This is how we guarantee every frame passes the mobile-monochrome test, stays under 2 000 chars, and reads as polished regardless of the quality of any single LLM-generated sentence inside it.

---

## 2. The three ownership zones (applied to ANSI)

Same three zones from the action-engine framework, applied to visual output:

- ⚙️ **Deterministic (engine)** — chrome (borders, corner ornaments), HP bars, stat readouts, damage floaters, dice results, selection markers, pip meters, resource bars, crumble state. Purely mechanical data rendered into fixed glyph runs. Always correct by construction.
- 🗣️ **Generative (LLM / DMAs)** — flavour text in bounded message boxes, NPC dialogue, outcome narration, event lines, flavour subtitles. Always inside a slot with a hard char budget. Never controls layout.
- 🎨 **Hybrid (DB fragment + engine state)** — sprites, monster portraits, PC/NPC character art, item silhouettes, consumable outlines, scene vignettes. The engine maps entity keys (`enemy.name`, `npc.class`, `item.name`) to rows in the `fragments` table, selects the correct zoom level and pose variant, and applies render-time transforms (flip, degradation). LLM-generated fragments can be inserted at runtime when a new entity is discovered.

The Renderer's job is to assemble a register's chrome plus the current tick's slot content into a validated, colour-applied string ready for a Discord `ansi` code block.

---

## 3. Register catalog — the complete taxonomy

Each register is a row in the rendering matrix. The scenarios column lists every action-engine event that maps to it.

### 3.1 COMBAT_FRAME — standard encounter `[mvp]`
`combat` · RESOLVE_ROLL · single-enemy fight tick

| Property | Value |
|---|---|
| Width | 30 cols (28 interior) |
| Chrome | `+`/`|`/`+` box border |
| Header slot | `{enemyName} Lv {enemyLevel}` (31 red for enemy, 33 yellow for boss), right-aligned |
| HP bar slot | `HP [{filled}{empty}] {current}/{max}` — filled `█` 32 green, empty `─` 90 gray. When <30%: crumble tail `█▓▒░` |
| Sprite slot | ~6 rows × 20 cols. Fragment from catalog: `{enemyName}` → sprite fragment; state variant: idle/hit/dead. LLM can signal a new enemy; engine pulls the nearest match |
| Player zone | `WARDEN Lv{N}` (34 cyan), `HP {current}/{max} [{bar}]` — bar crumble applies here too |
| Floater slot | `{actor} -{N} HP` or `{actor} +{N} HP`. Actor name 31 red (enemy) / 34 cyan (player), damage 31 red, healing 32 green |
| Message box | 2 rows × 26 cols. LLM-authored flavour text. Hard budget — the LLM prompt includes the char limit. 90 gray text |
| Char budget | ~820–1 250 coloured |

**Binding contracts:**
- **header** → engine: `enemy.name`, `enemy.level` from combat scene-state edge (`in_combat` props)
- **HP bar** → engine: `enemy.hp`, `enemy.maxHp` from edge; crumble threshold ≥30%
- **sprite** → hybrid: engine queries `fragments` table where `entity_type='enemy', entity_key=<enemy.name>, zoom_level='full'`. Pose: `idle` by default; `hp < 30%` → `hurt`; `hp = 0` → `dead`. No match found → generic silhouette fragment or LLM-generated fallback
- **floater** → engine: `hpDelta` from resolved margin; `actor` = "WARDEN" or enemy name
- **message box** → LLM: resolve-stage `outcome_text`, truncated to 2×26

**Scenarios:** every non-critical combat tick; the default form for `/action` fight resolutions.

### 3.2 COMBAT_DIAGONAL — size-hierarchy fight `[mvp+]`
`combat` · RESOLVE_ROLL · acting-creature-emphasis layout

| Property | Value |
|---|---|
| Width | 30 cols (28 interior) |
| Chrome | `+`/`|`/`+` box border |
| Layout | Large foreground enemy (7+ rows), small player (5 rows) in opposite corner. Diagonal composition as in the dire-badger-maul fragment |
| HP bar slot | Per-combatant bars with crumble. Enemy bar top, player bar near player zone |
| Floater slot | Large `-18!!!` style damage callout when the acting creature lands a heavy hit |
| Ground strip | Scatter-falloff speckles on bg 42 brown, running the full width below sprites |
| Message box | 2×26 as COMBAT_FRAME |
| Char budget | ~870–1 650 coloured |

**Binding:** same as COMBAT_FRAME but with a layout flag. The player sprite also comes from the `fragments` table (`entity_type='pc_class', entity_key=<character.class>`) — rendered at a reduced scale (5 rows) in the opposite corner. Used when the engine signals the enemy acted (not the Warden), so the enemy gets the foreground. The resolve-stage narration determines who acted; the Renderer picks COMBAT vs COMBAT_DIAGONAL based on the `hpDelta` sign.

**Scenarios:** enemy mauls Warden; the enemy landed a heavy hit; the Warden is on low HP and the frame emphasises the threat.

### 3.3 COMBAT_CRIT — nat-20 kill / dramatic beat `[mvp]`
`combat` · RESOLVE_ROLL · crit/fumble or kill blow

| Property | Value |
|---|---|
| Width | 30 cols (28 interior) |
| Chrome | `+`/`|`/`+` box |
| Centrepiece | d20 gem `▄▀▀▀▀▄`/`▐ 20 ▌`/`▀▄▄▄▄▀` (33 yellow + bold-white 20) or fumble skull |
| Burst rays | `\ | /` and `*` sparkles radiating from centrepiece |
| Dissolve death | Enemy sprite replaced by dissolve gradient `▓ → ▒ → ░ → .` drifting up-right when the kill blow lands |
| Floater | Large `CRIT x2` or `FUMBLE!` callout, 33 yellow |
| Message box | 2×26 |
| Char budget | ~950–1 250 coloured |

**Binding:** triggers when combat RESOLVE_ROLL carries `crit: true` or `fumble: true` or `enemyHpAfter = 0`. Engines owns the d20/centrepiece; LLM owns the message box.

**Scenarios:** nat-20 kill blow; nat-1 disaster; enemy death on any roll.

### 3.4 BOSS_INTRO — set-piece encounter opener `[mvp+]`
`combat` · NEW_ACTION or first CONTINUE · boss/showpiece foe

| Property | Value |
|---|---|
| Width | 40 cols (38 interior) — desktop showpiece |
| Chrome | Piped border `o══╡@╞══o` with red corner knobs; HUD sandwich (status strip / viewport / footer strip) |
| Status strip | Boss name (31 red), Lv, segmented HP bar `▮▮▮▮▯▯`, hearts row. Engine-owned |
| Viewport | Scene viewport ~8 rows: boss sprite (large), environmental detail (shrine, lair), in-scene name tag with underline, micro-doodads (spider, candles) |
| Footer strip | Decorative footer with hotbar-slot-style labels. Discord buttons still handle actual interaction |
| Texture islands | Brick courses `═`/`▭`, hatch `╱` runs — irregular patches, never wall-to-wall |
| In-scene name tag | Boss name in speech-bubble label with underline, floating in viewport |
| Char budget | ~1 800–1 950 coloured (careful near 2 000 ceiling) |
| Colour discipline | Red 31 reserved for threat (boss name, eyes, low HP number). Green 32 for full HP bar segments. |

**Binding:**
- **status strip** → engine: boss name, level, HP, max HP from combat edge
- **viewport sprite** → hybrid: boss name maps to `fragments` table (`entity_type='enemy', zoom_level='full'`); BOSS_INTRO uses the largest available pose, or falls back to the standard combat sprite scaled up
- **name tag** → engine: boss name
- **scroll strip** → engine: static decorative, or LLM-authored label text signalling key mechanics
*No sprite art in this frame unless the register is extended to include a dialogue bust — see §5.3 for NPC bust fragments.*

**Scenarios:** Saturday shared-boss hunt spawn (POC+ item 5); any named, multi-HP-bar boss; Rotking intro (the existing fragment is an embryonic version of this register).

### 3.5 DIALOGUE_MODAL — loot, NPC speech, confirmations `[mvp]`
`social` · any phase · `search` · RESOLVE_ROLL · `skill` · RESOLVE_ROLL

| Property | Value |
|---|---|
| Width | 28 cols (26 interior) |
| Chrome | Ornamental dash-dot rim `.-·-._.-·-.` in one dim colour run; crest interrupt `+==< ≡☺≡ >==+` top centre; corner sparkles `✦`/`❖`. Nested: bright outer double-line, dimmer inner rim |
| Event line | `•` bullet event line — what happened (LLM-authored, e.g. "You found GLOWCAP!") |
| Detail line | `+` indented detail line — quantity/context (LLM, e.g. "+ 3 mushrooms, foraged") |
| Question line | The prompt question (LLM) |
| Choice rows | `●` filled marker for take/active, `·` hollow for decline/inactive. Shape-redundant so state survives mobile colour strip. LLM authors labels; engine appends actual Discord buttons underneath |
| Inline colour | Item name 37 white, quantity 37 white, flavour/species name 33 yellow, keyword 34/36 cyan — single-word colour roles inside prose |
| Char budget | ~500–800 coloured |
| Colour polish | The rim + crest + sparkles are all single-colour ASCII runs — polish at near-zero char-budget cost |

**Binding:**
- **chrome** → engine: fixed template, zero LLM involvement
- **event/detail/question** → LLM: resolve-stage `outcome_text` adapted to the 4-beat layout
- **choice labels** → LLM: authored per the social/search/skill decide template
- **selection markers** → engine: `●` on the take/confirm option, `·` on others
- **inline colour** → hybrid: engine scans LLM text for known item names/NPC names and wraps them in colour roles

**Scenarios:** loot found (search resolve); NPC gives an item; confirmation prompt ("Stash these?"); quest hand-in; skill training result; social transaction result.

### 3.6 DATA_CARD — roll result, skill check, stat readout `[mvp]`
`skill` · `search` · `combat` · any buttonsRoll resolve

| Property | Value |
|---|---|
| Width | 24 cols (22 interior) |
| Chrome | Plain `+`/`|`/`+` box, no sprite art, no ornaments |
| Label line | Dim caps `ROLL RESULT` or `SKILL CHECK` (90 gray) |
| Focal number | Big centred number `19` (37 white bold) with right-aligned dim context `d20` (90 gray) |
| Calculation line | `+2 STR +2 bond = 23` — stat bonuses + item bonuses + total. Engine-owned |
| Verdict line | `DC 15 ✓ SUCCESS (+7 margin)` — colour-coded: 32 green for success, 31 red for failure. `✓`/`✗` shape-redundant |
| Flavour line | One line of dim prose (LLM). Two colour switches total in the whole card |
| Char budget | ~160–250 — the cheapest register |

**Binding:**
- **all numbers, stat names, verdict** → engine: `rollResult`, `baseDc`, `effectiveDc`, `margin`, `stat`, `statBonus`, `itemBonus`. Zero LLM involvement in the numeric layer
- **flavour line** → LLM: one 22-char sentence

**Scenarios:** every roll reveal in POC+ item 2 (combat maths reveal); any skill-check tick; inspection of a puzzle clue. This is the "show the maths" frame.

### 3.7 BROADCAST_CARD — nat 1/20 global shoutout `[mvp]`
`combat` · `skill` · `search` · `social` · critical roll on any type

| Property | Value |
|---|---|
| Width | 30 cols (28 interior) |
| Chrome | COMBAT_CRIT lite: d20 centrepiece + burst rays, or fumble skull, but no full combat chrome |
| Header | `{PlayerName} rolled a NATURAL 20!` (33 yellow bold + 37 white) or `…rolled a NATURAL 1!` (31 red) |
| Re-enactment zone | ~4 rows: one dramatic beat from the action — the enemy that was felled, the ravine they tumbled into. Lifted from the resolve-stage `outcome_text`, not a new LLM call |
| Floater | `{actionSummary}: {outcome}` — one line, engine-owned |
| Footer | `👏` reactions prompt or flavour |
| Char budget | ~600–900 coloured |

**Binding (per POC+ item 3 — deterministic, no extra LLM calls):**
- **header** → engine: `playerName`, `roll`
- **re-enactment** → engine: lifted verbatim from the resolve-stage `outcome_text` that was already generated for the private outcome. Truncated to 4×28
- **floater** → engine: distilled action summary from the tick result

**Scenarios:** POC+ item 3; any nat 1 or 20 on any roll type. The first shared-world visual moment.

### 3.8 WELCOME_CARD — character join / new hero `[mvp+]`
`/join` command · character creation complete

| Property | Value |
|---|---|
| Width | 30 cols (28 interior) |
| Chrome | Simplified splash border — piped `o════════o` corners, crest `╡@╞` centre-top |
| Title line | `A NEW HERO JOINS THE O` (33 yellow block letter or caps) |
| Character zone | Class icon (emoji or 2-char glyph from class-catalog), name (37 white bold), class + alignment (34 cyan) |
| Tag line | Player mention (no ping — suppressed per `0.2.8` F#3/F#8 convention), `🌅 Hi` button anchor |
| Flavour | One line: "The Oak's roots stir. Another soul seeks shelter." (LLM or static catalog) |
| Char budget | ~450–700 coloured |

**Binding:**
- **title** → engine: static template
- **character info** → engine: `playerName`, `characterClass`, `alignment` from character creation result. Class icon from `fragments` table (`entity_type='pc_class', entity_key=<class>, zoom_level='portrait'`), or simple emoji fallback
- **tag** → engine: Discord mention tag with ping suppressed, attached `Hi` button component

**Scenarios:** POC+ item 1 (welcome tag); every `/join` completion.

### 3.9 DAILY_CARD — /hi check-in `[mvp+]`
`/hi` command

| Property | Value |
|---|---|
| Width | 30 cols (28 interior) |
| Chrome | Dialogue modal lite: ornamental rim, crest interrupt, corner sparkles (like DIALOGUE_MODAL but no choices) |
| Date line | `Day {N}` or morning/evening flavour, 90 gray |
| Status bars | Health `[█▓▒░--------] {h}/{max}` 32 green, Stamina `[████--------] {s}/{max}` 33 yellow. Engine-owned |
| Scene line | "You wake at {locationName}." (34 cyan for location name, otherwise LLM) |
| Budget line | `{rollsRemaining} rolls remaining today` (33 yellow / 31 red if 0) |
| Bottom line | `What will you do today?` prompt |
| Char budget | ~400–600 coloured |

**Binding:**
- **status bars** → engine: `health`, `maxHealth`, `stamina`, `maxStamina` with crumble thresholds
- **scene line** → engine: `location.name`; LLM: seasonal/time-of-day flavour
- **budget** → engine: `rollsRemaining` with colour switching at 0

**Scenarios:** every `/hi`; the player's daily anchor frame.

### 3.10 REST_STOP — idle / rest tick `[mvp+]`
`rest` · RESOLVE_ROLL · quiet ticks · "nothing happened" beats

| Property | Value |
|---|---|
| Width | 28 cols (26 interior) |
| Chrome | Tailed caption box — a box with a small connector tail down to the scene spot it anchors |
| Scene vignette | ~4-5 rows: small campfire scene, a sleeping sprite, steam curls. Fragment from the rest catalog |
| Status glyphs | Floating above sprites: `z z Z` sleep, `°o` poison bubbles, `!` alert, `?` confusion. All in 35 magenta, shape-carried for mobile |
| Narrator caption | Letter-spaced caps in a tailed box: e.g. "T A K E   A   R E S T   H E R E" (the narrator's typographic voice, short lines only) |
| Recovery line | `+{N} STA  +{M} HP` floated, 32 green |
| Char budget | ~500–700 coloured |

**Binding:**
- **vignette** → hybrid: `location.type` (camp, cave, inn, Oak) → `fragments` table lookup where `entity_type='scene', zoom_level='full'`
- **sleeping sprite** → hybrid: `fragments` table lookup where `entity_type='pc_class', entity_key=<character.class>, pose='dead'` (collapsed pose repurposed for sleep)
- **status glyphs** → engine: `health < 50%` → `°o` poison; `stamina = 0` → `z z Z`; nothing → no glyph
- **caption** → LLM: one short narrator line, or static per-location catalog
- **recovery** → engine: `staminaDelta`, `healthDelta` from rest mutations

**Scenarios:** `/rest` command; "nothing happened" quiet ticks; camp at a frontier; the rest beat that an async game has in abundance.

### 3.11 ITEM_SHOWCASE — rare+ drop reveal `[mvp+]`
`search` · `combat` · rare loot awarded

| Property | Value |
|---|---|
| Width | 28 cols (26 interior) |
| Chrome | Stepped corner brackets (cheapest ornament tier) + blueprint backdrop (dashed construction guides `- - -`, corner `+` registration marks) in 90 gray dim |
| Item art zone | ~6 rows × 14 cols centre-diagonal: `▀▄` staircases and `/ \` edges on empty ground. Fragment from item catalog |
| Name line | Item name 37 white bold, centred |
| Tier meter | `▢▪▪▪` pip meter — shape-redundant rarity notation. Engine-owned |
| Stat line | `{stat} +{modifier}` — 33 yellow for the stat, 37 white for the number |
| Flavour line | One line of lore text (LLM) |
| Colour strategy | **One-hue ramp** for elemental/simple items: bevel planes one step apart, one highlight edge run. **Temperature split** for ornate/named gear: cool blade (functional part, long single runs), warm guard (crafted part, concentrated colour switches ~6-col zone) |
| Char budget | ~600–900 coloured |

**Binding:**
- **item art** → hybrid: queries `fragments` table where `entity_type='item', entity_key=<item.name>, zoom_level='showcase'`. Falls back to `zoom_level='icon'` upscaled. Rarity → detail level (common = outline only, rare = full showcase)
- **name, tier, stat** → engine: `item.name`, `item.rarity`, `item.stat`, `item.modifier`
- **flavour** → LLM: one lore sentence
- **colour strategy** → engine: item type (elemental → one-hue ramp; ornate → temperature split)

**Scenarios:** rare+ drop notification; legendary item in bestiary; inspect of a significant item. Common loot stays in DIALOGUE_MODAL — the showcase register itself signals rarity.

### 3.12 MONSTER_PORTRAIT — bestiary / inspect reply `[mvp+]`
`inspect` · bestiary lookup · scan-creature

| Property | Value |
|---|---|
| Width | 24 cols (22 interior) |
| Chrome | Dashed card border `-------` — same card system as item showcase and data card |
| Portrait zone | ~5 rows: head-crop only, full bodies belong to encounter viewports |
| Signature detail | One gross memorable feature: exposed brain, single eye, split jaw. Contour deliberately chipped/pocked for corruption. `▒` dither patches inside body (scale with HP: cleaner at full, chipped at low) |
| Name line | `{creatureName}` 31 red (threat role), `Lv {N}` |
| HP line | `HP [{bar}]` with crumble |
| Flavour line | One line (LLM or static) |
| Colour pairing | Sickly green body 32 + pink detail 35 + red eyes 31 — horror via complementary clash |
| Char budget | ~400–600 coloured |

**Binding:**
- **portrait** → hybrid: queries `fragments` table where `entity_type='enemy', zoom_level='portrait'`. Portrait zoom is a head-crop only (2-3 rows); full bodies live in combat registers. HP-driven contour degradation (solid → chipped → crumbling) applied at render time
- **name, HP, level** → engine: from combat edge or bestiary data
- **flavour** → LLM: one-liner, or static catalog per creature

**Scenarios:** inspect of a known creature; `/bestiary` lookup; scan result; encounter thumbnail when the player hasn't seen this foe before.

### 3.13 INVENTORY_BENTO — inventory / character sheet / shop `[mvp+]`
`/inventory` · `/shop` · character sheet

| Property | Value |
|---|---|
| Width | 30 cols (28 interior) |
| Chrome | Triple border: outer `█`-run gold frame (33 yellow), black bg gutter, inner light box-drawing line. Bento panel grid — irregular rectangles, one icon per panel. Rivet dots `·`/`▪` at panel corners and junctions |
| Panel slots | One icon per panel — half-block art `▀▄█` (flat two-tone only, zero dither — scenes get dither, UI gets flat fills). Palette near-1:1 ANSI: gold→33, orange→31, lavender→35, white accents→37 sparse |
| Cash plaque | `≡ $ ≡` with coin count, 33 yellow |
| Stat summary | Compact stat block — one row per stat, bars or numbers |
| Char budget | ~900–1 400 coloured |
| Colour | Two warm + two cool tones per icon. Per-screen role override for menu frames allowed (lavender 35 as chrome metal instead of its normal "reserved: magic" role) |

**Binding:**
- **panel grid** → engine: inventory items, shop stock. Each item → `fragments` table lookup where `entity_type='item', entity_key=<item.name>, zoom_level='icon'`. Falls back to a generic bag/token icon for items without dedicated art
- **cash** → engine: `wealth`
- **stats** → engine: ability scores
- **selection** → engine: active panel gets white outline (shape-redundant). LLM not involved

**Scenarios:** `/inventory`; `/shop` browse; character sheet view.

### 3.14 SPLASH — title / chapter / version stamp `[mvp+]`
`/hi` first-ever · chapter transition · version announcement

| Property | Value |
|---|---|
| Width | 40 cols (38 interior) — the ceiling, desktop only |
| Chrome | Gold double-line piped border `o══════════════════╡@╞═════════════════o`, red corner knobs, acorn crest `╡@╞` |
| Title zone | 3-row half-block font for `WARDEN'S`, 4-row font for `OAK` in 33 yellow tan-gold. Block-letter font dicts keyed by letter — reusable |
| Scene strip | ~3 rows: pines, cottage, oak, mushroom vignette over bg 42 ground band |
| Credits line | Subtitle / version number (90 gray dim) |
| Background | bg 40 teal panel fill over the entire interior — makes it read as a solid card |
| Char budget | ~1 900–1 950 coloured (near the 2 000 ceiling) |
| Mobile | Degrades to plain monochrome art — layout intact, colour gone |

**Binding:**
- **title** → engine: block-letter font dict, string from config
- **scene strip** → static: one of N catalog vignettes (season/event themed), loaded from disk template, not the DB — splash art is authored, not procedural
- **credits** → engine: version number

**Scenarios:** `/hi` first-ever splash; chapter transition card; version-up announcement.

**Implementation phasing:** SPLASH, BOSS_INTRO, and all fragment-backed registers beyond the five MVP registers are deferred past POC+. The POC+ arc ([[poc-plus-roadmap]]) ships COMBAT_FRAME, COMBAT_CRIT, DATA_CARD, and BROADCAST_CARD; DIALOGUE_MODAL follows in early MVP.

---

## 4. The register-to-scenario matrix

Every player-facing event maps to exactly one register. The Renderer's dispatch table:

| Scenario | Trigger | Register | Width | Phase |
|---|---|---|---|---|
| `/join` complete | character creation | WELCOME_CARD | 30 | mvp+ |
| `/hi` daily check-in | morning/return | DAILY_CARD | 30 | mvp+ |
| `/hi` first-ever | onboarding | SPLASH | 40 | mvp+ |
| Combat tick — standard | combat RESOLVE_ROLL | COMBAT_FRAME | 30 | mvp |
| Combat tick — enemy attacks | combat RESOLVE_ROLL, hpDelta < 0 on Warden | COMBAT_DIAGONAL | 30 | mvp+ |
| Combat tick — crit/fumble | combat RESOLVE_ROLL, crit or fumble flag | COMBAT_CRIT | 30 | mvp |
| Combat tick — enemy death | combat RESOLVE_ROLL, enemyHpAfter = 0 | COMBAT_CRIT | 30 | mvp |
| Boss encounter intro | combat NEW_ACTION, boss/named foe | BOSS_INTRO | 40 | mvp+ |
| Skill check reveal | skill/search/buttonsRoll RESOLVE_ROLL | DATA_CARD | 24 | mvp |
| Nat 1/20 broadcast | any RESOLVE_ROLL, natural 1 or 20 | BROADCAST_CARD | 30 | mvp |
| Loot found | search RESOLVE_ROLL, add_item mutation | DIALOGUE_MODAL | 28 | mvp |
| Rare+ loot found | search/combat RESOLVE_ROLL, rare item | ITEM_SHOWCASE | 28 | mvp+ |
| NPC gives item | social RESOLVE_ROLL | DIALOGUE_MODAL | 28 | mvp |
| NPC dialogue | social NEW_ACTION or CONTINUE | DIALOGUE_MODAL | 28 | mvp |
| Transaction confirm | social RESOLVE_ROLL, wealth/item delta | DIALOGUE_MODAL | 28 | mvp |
| Rest/camp outcome | rest RESOLVE_ROLL | REST_STOP | 28 | mvp+ |
| Idle/quiet tick | rest/social non-roll resolution | REST_STOP | 28 | mvp+ |
| Inspect creature | `/inspect` or scan | MONSTER_PORTRAIT | 24 | mvp+ |
| Bestiary entry | bestiary lookup | MONSTER_PORTRAIT | 24 | mvp+ |
| Inventory view | `/inventory` | INVENTORY_BENTO | 30 | mvp+ |
| Shop browse | `/shop` | INVENTORY_BENTO | 30 | mvp+ |
| Character sheet | `/sheet` or `/stats` | INVENTORY_BENTO | 30 | mvp+ |
| Cross-player buff received | buff mutation lands on recipient | DIALOGUE_MODAL | 28 | mvp |
| Saturday boss spawn | scheduled event, public channel | BOSS_INTRO | 40 | mvp+ |
| Saturday boss kill | shared HP reaches 0 | COMBAT_CRIT + BROADCAST_CARD | 30 | mvp |
| Version/chapter | chapter transition | SPLASH | 40 | mvp+ |

---

## 5. Slot composition — the grid of ownership

Every slot in every register is one of three kinds. This grid is the contract the `AnsiRenderer` enforces:

| Slot kind | Populated by | Examples | Constraints |
|---|---|---|---|
| **Data slot** | Engine — direct variable interpolation | HP bars, stat numbers, damage floaters, dice results, pip meters, crumble state | Fixed glyph runs. Validated for width, never overflows. Always correct |
| **Text slot** | LLM — authored by a DMA with a char budget in the prompt | Message boxes, flavour text, NPC dialogue, event lines, narrator captions | Hard char budget declared in the prompt. Truncated if over. Never controls layout |
| **Fragment slot** | Hybrid — engine queries the `fragments` DB table by `(entity_type, entity_key, zoom_level, pose)`, applies orientation transforms, then composites into the frame | Enemy sprites, PC combat poses, NPC busts/portraits, item showpieces, inventory icons, scene vignettes | Fragment width validated at insert time. Pose selected by engine state. Orientation (`flip_h`) applied at render time. Degradation pass (solid → chipped → crumbling) when HP drops |

### 5.1 Fragment zoom levels

Each entity type supports one or more zoom levels, defining how much of the figure fits in the slot:

```
┌─────────────────────────────────────────────────────┐
│  ZOOM LEVEL 3: SCENE (BOSS_INTRO, SPLASH)          │
│  Full environment: terrain, architecture, multiple  │
│  figures, atmosphere. 8+ rows. Disk template only.  │
│  ┌─────────────────────────────────────────────┐    │
│  │  ZOOM LEVEL 2: FULL FIGURE (COMBAT_FRAME,   │    │
│  │  COMBAT_DIAGONAL, REST_STOP)                │    │
│  │  Standing pose, full body with gear.         │    │
│  │  5-7 rows. DB-backed fragment.               │    │
│  │  ┌──────────────────────────────────────┐    │    │
│  │  │  ZOOM LEVEL 1: BUST (DIALOGUE_MODAL, │    │    │
│  │  │  ITEM_SHOWCASE, WELCOME_CARD)        │    │    │
│  │  │  Shoulders-up, 3-4 rows. DB-backed.  │    │    │
│  │  │  ┌──────────────────────────────┐    │    │    │
│  │  │  │  ZOOM LEVEL 0: PORTRAIT/ICON │    │    │    │
│  │  │  │  (MONSTER_PORTRAIT, INVENTORY│    │    │    │
│  │  │  │  BENTO, DAILY_CARD, stats)   │    │    │    │
│  │  │  │  Head-crop or item glyph.    │    │    │    │
│  │  │  │  2-3 rows. DB-backed.        │    │    │    │
│  │  │  └──────────────────────────────┘    │    │    │
│  │  └──────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### 5.2 Pose variants

Each fragment row carries a `pose` column. The engine picks the pose based on game state:

| Pose | Trigger | Used by |
|---|---|---|
| `idle` | Default, neutral standing | All entity types |
| `attack` | Entity just dealt damage | Enemies, PCs (combat) |
| `defend` | Entity braced / guarding | PCs (combat) |
| `hurt` | HP < 50% | Enemies, PCs (combat). Rendered as idle + degradation pass if no dedicated `hurt` file |
| `dead` | HP = 0 | Enemies (dissolve gradient), PCs (collapse announce) |
| `neutral` | Non-combat scene | NPCs, PCs (bust portrait for dialog, character sheet) |
| `speak` | NPC delivering dialogue | NPCs (DIALOGUE_MODAL bust) |

Fragments that don't exist for a specific pose fall back through the chain: `attack` → `idle`, `defend` → `idle`, `speak` → `neutral`, `dead` → `hurt` → `idle` with dissolve pass.

### 5.3 Entity fragment matrix

Which zoom/pose combinations exist per entity type, and which registers use them:

| Entity type | Zoom levels | Poses | Registers |
|---|---|---|---|
| `enemy` | `full`, `portrait` | `idle`, `hurt`, `dead` (+ `attack` stubs for bosses) | COMBAT_FRAME, COMBAT_DIAGONAL, COMBAT_CRIT, BOSS_INTRO, MONSTER_PORTRAIT |
| `pc_class` | `full`, `bust`, `portrait` | `idle`, `attack`, `defend`, `hurt`, `dead`, `neutral` | COMBAT_FRAME, COMBAT_DIAGONAL, WELCOME_CARD, DAILY_CARD, REST_STOP |
| `npc_archetype` | `full`, `bust`, `portrait` | `idle`, `neutral`, `speak` | DIALOGUE_MODAL (bust), scene vignettes (full) |
| `item` | `showcase`, `icon` | `idle` (single pose) | ITEM_SHOWCASE, INVENTORY_BENTO |
| `location` | `full` | `idle` (single pose) | REST_STOP, location scene renders |

PC classes get the broadest coverage — they appear in combat (full figure, multiple poses), dialog (bust), and character sheets (portrait). NPCs get bust/portrait for dialog; only story-significant NPCs get full figure. Enemies use full and portrait; `attack` is a luxury reserved for bosses.

### 5.4 Orientation: the `flip_h` transform

Sprites are authored facing one direction (right). When an entity occupies the left side of a frame facing right, the renderer applies a horizontal flip: each line is reversed and directional glyphs are swapped (`/` ↔ `\`, `)` ↔ `(`, `<` → `>`, etc.).

| Register | Enemy position | PC position | Enemy flip? | PC flip? |
|---|---|---|---|---|
| COMBAT_FRAME | Left | Right | Yes (face right → face left) | No (natural right-facing) |
| COMBAT_DIAGONAL | Foreground (centre) | Corner (right) | No (natural) | No |
| DIALOGUE_MODAL | — | — | — | NPC bust placed left or right by register; flipped as needed |

Asymmetric gear (shield hand, weapon hand) stays correct because the flip is mechanical — a shield drawn on the figure's left stays on figure's left after mirroring. The player reads the flipped figure as "facing the other way," not as "shield swapped hands."

### 5.5 Degradation pass

Applied on top of any pose when HP drops. No separate fragment files — the renderer modifies the monochrome source:

| State | Transform | Trigger |
|---|---|---|
| **Solid** (default) | Full outline + fill | HP ≥ 50% |
| **Chipped** | Contour `▒` dither patches at edges, 2-3 chips. Scales: more chips as HP drops | HP < 50% |
| **Crumbling** | Heavy `▒ ░` degradation, floating `.`/`✦` fragments drifting up-right | HP < 15% |
| **Dissolved** | Contour thinned to stipple, fill dropped, residual sparkles | HP = 0 (non-crit death) |

---

## 6. Colour roles (the standard vocabulary, per-register overrides)

Base vocabulary from the [[mvp+ansi-art]] colour experiment, reused across all registers:

| Code | Role | Usage pattern |
|---|---|---|
| 90 bright black | Chrome | Borders, labels, empty bar segments, dim text. Always 90, never 30 (30 is invisible on Discord dark bg) |
| 31 red | Threat | Enemy names, damage, low HP, eyes. **Red discipline:** only where threat lives |
| 32 green | Life | HP fill, healing, XP gains, positive outcomes |
| 33 yellow | Warmth/reward | Fire, loot, crits, title lettering, tan-gold accents |
| 34/36 cyan | Player/cool | Player name, NPC speech, cool distance (treelines, hills) |
| 35 magenta | Reserved | Magic/status effects, lavender UI metal (INVENTORY_BENTO override) |
| 37 white | Emphasis | Sprites, item names, big numbers. Bold for crits |
| bg 44 blue | Panel fill | Solid backdrop (never bg 40 — matches code block, invisible) |
| bg 41/42 | Surface | Ground strips, bar backgrounds |

**Per-register overrides:**

- **INVENTORY_BENTO**: 35 magenta → lavender UI metal instead of "reserved: magic"
- **ITEM_SHOWCASE**: one-hue ramp items use one colour + bold/dim + `░▒▓` ≈ 4 steps
- **MONSTER_PORTRAIT**: sickly green 32 body + pink 35 detail + red 31 eyes
- **REST_STOP**: 35 magenta reserved for status glyphs (`z z Z`, `°o`, `!`, `?`)

---

## 7. Budget enforcement (hard constraints)

The Renderer rejects any assembled frame that violates these:

| Constraint | Value | Enforced at |
|---|---|---|
| Max total chars (incl. ANSI escapes + fences) | 2 000 | Renderer assembly, before send |
| 30-col register interior width | exactly 28 | Fragment insert validation (DB) + slot fill validation (renderer) |
| 40-col register interior width | exactly 38 | Same |
| Text slot overflow | truncated to slot budget | Renderer truncates LLM output |
| Monochrome source width | no line exceeds declared width | `fragments` table CHECK or insert-time validation |
| Background fill | every cell carries bg colour or fill glyph | Renderer post-process — fills gaps with bg 44 |
| No ANSI black (30 fg, 40 bg) | rejected | Renderer validation |
| Mobile-monochrome readability | all gameplay info carried by shape, not colour | Review check before shipping a new register |

---

## 8. The Renderer assembly pipeline

```
                    ┌──────────────────┐
                    │  Scenario router  │  "combat RESOLVE_ROLL, crit flag"
                    └────────┬─────────┘
                             │ register key
                             ▼
               ┌─────────────────────────┐
               │   Load register def     │  chrome template, slot map, binding rules
               └────────────┬────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                  ▼
   ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐
   │ Data slots  │  │ Text slots  │  │ Fragment slots   │
   │ (engine)    │  │ (LLM DMA)   │  │ (catalog +state) │
   └──────┬──────┘  └──────┬──────┘  └────────┬─────────┘
          │                │                   │
          ▼                ▼                   ▼
   ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐
   │ Interpolate │  │ Prompt DMA  │  │ DB query → ascii │
   │ variables   │  │ with budget │  │ Pose + flip pass │
   └──────┬──────┘  └──────┬──────┘  └────────┬─────────┘
          │                │                   │
          └────────────────┼───────────────────┘
                           │
                           ▼
               ┌─────────────────────────┐
               │   Assemble monochrome   │  chrome + slots, validate width per line
               └────────────┬────────────┘
                            │
                            ▼
               ┌─────────────────────────┐
               │   Validate constraints  │  width, char budget, bg fill, no black
               └────────────┬────────────┘
                            │
                            ▼
               ┌─────────────────────────┐
               │   Apply colour roles    │  colour map per register, per-role ESC wrapping
               └────────────┬────────────┘
                            │
                            ▼
               ┌─────────────────────────┐
               │   Final char budget     │  reject if > 2 000
               └────────────┬────────────┘
                            │
                            ▼
               ┌─────────────────────────┐
               │  Wrap in ```ansi fence  │
               └────────────┬────────────┘
                            │
                            ▼
                    Discord message
```

### Render phases

1. **Route** — scenario → register key. Deterministic lookup table (§4 matrix).
2. **Bind** — evaluate each slot's binding contract:
   - Data slots: interpolate engine state variables into glyph templates
   - Text slots: call the appropriate LLM DMA (resolve-stage for outcome_text, decide-stage for choice labels) with the slot's char budget in the prompt
   - Fragment slots: query `fragments` table by `(entity_type, entity_key, zoom_level)` → select correct pose row → apply `flip_h` if required → apply degradation pass
3. **Assemble monochrome** — build the complete frame as a list of fixed-width strings. Assert every line matches the interior width.
4. **Validate** — hard constraints (§7). Reject or truncate. Fill any transparent gaps with bg 44.
5. **Colour** — apply register's colour-role map: wrap glyph runs in ESC codes per the role assignments.
6. **Budget check** — count total chars including ESC codes + ` ```ansi ` fences. Reject if > 2 000.
7. **Send** — wrap in fence, post to the appropriate channel.

---

## 9. Fragment storage — the `fragments` table

Entity-specific art (sprites, portraits, icons, scene vignettes) lives in the database. Only architectural constants — chrome templates, bar layouts, ground strips, colour-role maps — live on disk.

### The split

```
DISK (assets/ansi/templates/)          DB (fragments table)
─────────────────────────────────      ─────────────────────
Register chrome (borders, corners)     Enemy sprites (all poses)
Background/ground strips               PC combat figures, busts, portraits
Pip meter templates                    NPC busts, portraits, full figures
Bar templates (HP, stamina)            Item showpieces, inventory icons
Crest interrupts (╡@╞)                Scene vignettes (campfire, cave)
Fixed UI labels                        Location-specific art
Colour-role maps (per register)        LLM-generated fragments at runtime
```

The disk holds **what never changes across a world**. The DB holds **what is specific to this world's entities**. A new item, a procedurally-generated NPC, a discovered creature — their art gets `INSERT`ed into `fragments`, not committed to the repo.

### Table schema

```sql
CREATE TABLE fragments (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type          TEXT    NOT NULL,  -- 'enemy' | 'pc_class' | 'npc_archetype' | 'item' | 'location'
  entity_key           TEXT    NOT NULL,  -- 'gloomfang' | 'warden' | 'blacksmith' | 'glowcap'
  zoom_level           TEXT    NOT NULL,  -- 'full' | 'bust' | 'portrait' | 'showcase' | 'icon'
  pose                 TEXT    NOT NULL,  -- 'idle' | 'attack' | 'defend' | 'hurt' | 'dead' | 'neutral' | 'speak'
  ascii_data           TEXT    NOT NULL,  -- raw monochrome art, no ANSI escape codes
  width                INTEGER NOT NULL,  -- validated column width at insert time
  height               INTEGER NOT NULL,  -- row count
  source               TEXT    NOT NULL DEFAULT 'seed',  -- 'seed' | 'llm' | 'admin'
  created_by_action_id INTEGER REFERENCES actions(id),
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_type, entity_key, zoom_level, pose)
);
```

### Renderer lookup

```
Renderer receives:                            Renderer executes:
  entity_type = 'enemy'                       db.prepare(`
  entity_key  = 'gloomfang'                     SELECT ascii_data, width, height
  zoom_level  = 'full'                           FROM fragments
  pose        = 'hurt'                           WHERE entity_type = ?
                                                   AND entity_key  = ?
                                                   AND zoom_level  = ?
                                                   AND pose        = ?
                                                 ').get(...)
```

No file I/O. No path resolution. The same query works for seed fragments, LLM-generated fragments, and admin-authored fragments.

### Fragment fallback chain

When the exact `(entity_type, entity_key, zoom_level, pose)` row doesn't exist:

1. **Pose fallback**: `attack` → `idle`. `defend` → `idle`. `speak` → `neutral`. `dead` → `hurt` → `idle` (with dissolve pass).
2. **Zoom fallback**: `showcase` → `icon` (upscaled for display). `full` → `portrait` (not ideal but never blanks the frame).
3. **Entity fallback**: Exact key not found → generic silhouette per entity type (`entity_key = '_generic'`).
4. **LLM generation**: If no generic fallback exists and the scenario permits latency, an LLM DMA authors a new fragment and `INSERT`s it. The next render finds it.

### Seed fragment loading

Core fragments (the base bestiary, starter items, PC class art, NPC archetypes) are authored in a single YAML file and inserted at boot:

```yaml
# assets/ansi/seed-fragments.yml
fragments:
  - entity_type: enemy
    entity_key: gloomfang
    zoom_level: full
    poses:
      idle: |
        ┌──────────────────┐
        │   /\  /\        │
        │  ( ◉◉ )        │
        │   \/  \/        │
        │  ═══╤═══        │
        └──────────────────┘
      hurt: |
        ┌──────────────────┐
        │   /\  /\        │
        │  ( ◉- )  ▒▒     │
        │   \/  \/ ▒      │
        │  ═══╤═══        │
        └──────────────────┘
  - entity_type: item
    entity_key: glowcap
    zoom_level: icon
    poses:
      idle: |
        ┌────┐
        │ ▀▄ │
        │ ▄▀ │
        └────┘
```

`seedFragments(db)` loads this once at boot: validates every line width against the zoom level's declared interior width, then `INSERT OR IGNORE` so redeploys are idempotent. The DB is the source of truth from that point forward.

### LLM-generated fragments

When a player discovers a creature (or item, or NPC) not in the seed data, the pipeline can:

1. Call an LLM DMA with the fragment's slot dimensions and a style prompt ("6-row × 20-col ASCII spider, chitinous, many legs, single eye")
2. Validate: every line must match the declared width, no ANSI codes, no linefeeds inside lines
3. `INSERT INTO fragments (entity_type, entity_key, zoom_level, pose, ascii_data, source='llm', created_by_action_id=...)`
4. The Renderer finds it on the next tick

No deploy. No file-system write. The art lives with the world state. Two bot instances (or future shards) can have different art for the same entity name — the fragment is world state, not source code.

---

## 10. Disk templates — the architectural constants

What stays on disk is the **visual grammar** — the things that define how a register looks but contain zero entity-specific content:

```
assets/ansi/templates/
  registers/
    COMBAT_FRAME.chrome.ascii       # +---+ border, corner ornaments
    COMBAT_DIAGONAL.chrome.ascii    # same, layout flag for foreground/background
    COMBAT_CRIT.chrome.ascii        # d20 centrepiece, burst rays
    BOSS_INTRO.chrome.ascii         # o══╡@╞══o piped border, HUD strips
    DIALOGUE_MODAL.chrome.ascii     # dash-dot rim, crest, corner sparkles
    DATA_CARD.chrome.ascii          # plain +---+ box
    BROADCAST_CARD.chrome.ascii     # crit-lite centrepiece
    WELCOME_CARD.chrome.ascii       # piped corners, crest
    DAILY_CARD.chrome.ascii         # DIALOGUE_MODAL lite, no choices
    ITEM_SHOWCASE.chrome.ascii      # stepped brackets, blueprint guides
    MONSTER_PORTRAIT.chrome.ascii   # dashed card border
    INVENTORY_BENTO.chrome.ascii    # triple border, panel grid layout
    REST_STOP.chrome.ascii          # tailed caption box
    SPLASH.chrome.ascii             # gold double-line piped border, acorn crest
  ui/
    hp_bar.ascii                    # [████████░░░░░░] fill/empty template
    stamina_bar.ascii               # same, different segment chars
    pip_meter.ascii                 # ▢▪▪▪ template
    stat_row.ascii                  # label: [bar] template
  ground/
    grass.ascii                     # ground strip fills
    stone.ascii
    dirt.ascii
    cave_floor.ascii
  colour/
    standard_roles.json             # base colour vocabulary (§6)
    register_overrides.json         # per-register role overrides
```

These are loaded once at boot, validated, and never change at runtime. They define the frame; fragments populate it.

---

## 11. LLM DMA integration — text slot contracts

Each text slot in a register maps to a specific DMA with a char-budget constraint. The prompt builder appends the budget:

| Slot | DMA | Budget | Notes |
|---|---|---|---|
| Combat message box | resolve-stage `outcome_text` | 2 lines × 26 chars | Already generated per-action; Renderer truncates if over |
| Dialogue event/detail/question | resolve-stage `outcome_text` adapted to 4-beat layout | 3 × 26 chars | Engine splits the outcome text into beat lines |
| Data card flavour | resolve-stage `outcome_text` | 1 line × 22 chars | Shortest budget |
| Rest narrator caption | resolve-stage `outcome_text` | 1 line × 26 chars, letter-spaced | LLM or static per-location catalog |
| Item showcase flavour | resolve-stage `outcome_text` | 1 line × 26 chars | Lore snippet |
| Monster portrait flavour | resolve-stage `outcome_text` | 1 line × 22 chars | Static catalog preferred to keep creature lore consistent |

The critical rule: **text slots are always bounded**. The Renderer truncates, never word-wraps. If a slot's content needs more room, either the register's slot is too small or the LLM prompt didn't respect the budget.

---

## 12. Open questions

- [?] **Text slot overflow handling** — truncate silently, or feed a "too long" signal back to the critic DMA for a rewrite? Default: truncate with `…` at the budget boundary; log a warning so register slot sizes can be tuned.
- [?] **LLM fragment generation quality** — when the pipeline inserts LLM-authored fragments at runtime, what stops them from degrading the visual catalogue? Default: validate width + max height at insert; human review gate for `source='llm'` rows flagged as `needs_review`; admin can promote/reject.
- [?] **Pose fallback for PCs** — if only `idle` exists for a PC class, does `hurt` render as idle + degradation pass, or is a dedicated `hurt` fragment required? Default: degradation pass on `idle` is acceptable for MVP; dedicated `hurt` sprites are a polish target.
- [?] **Per-register colour role overrides** — the lavender (35 magenta) override in INVENTORY_BENTO suggests a general pattern: should every register declare its own `ColourManifest` that may override roles? Default: yes, a manifest per register, with the standard vocabulary as fallback.
- [?] **COMBAT_DIAGONAL vs COMBAT_FRAME selection** — the Renderer decides based on `hpDelta` sign (enemy acts → diagonal, Warden acts → standard). Is this signal reliable, or should the decide-stage DMA explicitly set a `layout: "diagonal"` flag? Default: engine derives from `hpDelta`; add an explicit flag later if edge cases appear.
- [?] **BROADCAST_CARD re-enactment quality** — lifting the `outcome_text` from a private resolve that wasn't written for a public broadcast. Will it read coherently out of context? Default: test with live data in POC+ item 3; if incoherent, add a one-sentence "broadcast preamble" LLM call (cheap).
- [?] **SPLASH mobile degradation** — the 40-wide splash exceeds mobile wrap; it will be a horizontal-scroll or clipped. Is this acceptable for a one-time title screen? Default: yes — SPLASH is a deliberate desktop showpiece, and it degrades to readable monochrome art even on narrow screens.
- [?] **Fragment table size ceiling** — a single SQLite row per fragment is fine for 50-100 entities, but the row size (monochrome art) is modest (30×7 = 210 chars). At what scale does in-memory caching become necessary? Default: LRU cache in the Renderer, invalidated on insert to the `fragments` table.
