---
title: ANSI Art Classification & Rendering Framework
status: spark
domain: spark
phase: mvp+
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

---

# ANSI Art Classification & Rendering Framework

## 1. The core insight: registers, not one-off frames

Every ANSI frame the bot emits is an instance of a **register** — a named visual grammar with a fixed chrome (border, structural lines), swappable slots (content zones), and a binding contract that says how each slot gets populated: from engine data, from an LLM prompt, or from a fragment catalog.

The mvp+ansi-art spark doc already catalogued 14 of these registers as design references; this doc formalises them into a **machine-readable framework** the `AnsiRenderer` can consume, and cross-references every register against the action-engine pipeline so each scenario knows which register to use.

A register answers five questions:

1. **Width budget** — 30 cols (mobile-safe) or 40 cols (desktop showpiece)?
2. **Chrome** — border style, corners, ornaments, rivets, crest interrupt?
3. **Slots** — what named zones exist, and at what size?
4. **Binding** — per slot: is the content engine-owned (deterministic), LLM-authored (generative), or fragment-catalog (hybrid)?
5. **Colour palette** — which roles from the standard vocabulary apply?

The Renderer never invents structure — it always operates inside a register's constraints. This is how we guarantee every frame passes the mobile-monochrome test, stays under 2 000 chars, and reads as polished regardless of the quality of any single LLM-generated sentence inside it.

---

## 2. The three ownership zones (applied to ANSI)

Same three zones from the action-engine framework, applied to visual output:

- ⚙️ **Deterministic (engine)** — chrome (borders, corner ornaments), HP bars, stat readouts, damage floaters, dice results, selection markers, pip meters, resource bars, crumble state. Purely mechanical data rendered into fixed glyph runs. Always correct by construction.
- 🗣️ **Generative (LLM / DMAs)** — flavour text in bounded message boxes, NPC dialogue, outcome narration, event lines, flavour subtitles. Always inside a slot with a hard char budget. Never controls layout.
- 🎨 **Hybrid (fragment catalog + engine state)** — sprites, monster portraits, item silhouettes, consumable outlines, scene vignettes. The LLM signals *what* to show (a `combatEnemy` name, an item rarity, an ActionType) and the engine selects the right fragment + variant (idle/hit/dead, solid/ghost/sparkled) from the `.ascii` catalog.

The Renderer's job is to assemble a register's chrome plus the current tick's slot content into a validated, colour-applied string ready for a Discord `ansi` code block.

---

## 3. Register catalog — the complete taxonomy

Each register is a row in the rendering matrix. The scenarios column lists every action-engine event that maps to it.

### 3.1 COMBAT_FRAME — standard encounter
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
- **sprite** → hybrid: engine maps `enemy.name` → nearest `.ascii` fragment; variant = `idle` unless `hp < 30%` → `hurt`, `hp = 0` → `dead`
- **floater** → engine: `hpDelta` from resolved margin; `actor` = "WARDEN" or enemy name
- **message box** → LLM: resolve-stage `outcome_text`, truncated to 2×26

**Scenarios:** every non-critical combat tick; the default form for `/action` fight resolutions.

### 3.2 COMBAT_DIAGONAL — size-hierarchy fight
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

**Binding:** same as COMBAT_FRAME but with a layout flag. Used when the engine signals the enemy acted (not the Warden), so the enemy gets the foreground. The resolve-stage narration determines who acted; the Renderer picks COMBAT vs COMBAT_DIAGONAL based on the `hpDelta` sign.

**Scenarios:** enemy mauls Warden; the enemy landed a heavy hit; the Warden is on low HP and the frame emphasises the threat.

### 3.3 COMBAT_CRIT — nat-20 kill / dramatic beat
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

### 3.4 BOSS_INTRO — set-piece encounter opener
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
- **viewport sprite** → hybrid: boss name maps to `.ascii` bestiary fragment (monster portrait register, head-crop)
- **name tag** → engine: boss name
- **footer** → engine: static decorative, or LLM-authored label text signalling key mechanics

**Scenarios:** Saturday shared-boss hunt spawn (POC+ item 5); any named, multi-HP-bar boss; Rotking intro (the existing fragment is an embryonic version of this register).

### 3.5 DIALOGUE_MODAL — loot, NPC speech, confirmations
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

### 3.6 DATA_CARD — roll result, skill check, stat readout
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

### 3.7 BROADCAST_CARD — nat 1/20 global shoutout
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

### 3.8 WELCOME_CARD — character join / new hero
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
- **character info** → engine: `playerName`, `characterClass`, `alignment` from character creation result
- **tag** → engine: Discord mention tag with ping suppressed, attached `Hi` button component

**Scenarios:** POC+ item 1 (welcome tag); every `/join` completion.

### 3.9 DAILY_CARD — /hi check-in
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

### 3.10 REST_STOP — idle / rest tick
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
- **vignette** → hybrid: `location.type` (camp, cave, inn, Oak) → rest-scene fragment from catalog
- **status glyphs** → engine: `health < 50%` → `°o` poison; `stamina = 0` → `z z Z`; nothing → no glyph
- **caption** → LLM: one short narrator line, or static per-location catalog
- **recovery** → engine: `staminaDelta`, `healthDelta` from rest mutations

**Scenarios:** `/rest` command; "nothing happened" quiet ticks; camp at a frontier; the rest beat that an async game has in abundance.

### 3.11 ITEM_SHOWCASE — rare+ drop reveal
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
- **item art** → hybrid: `item.name` → nearest `.ascii` fragment from item-catalog; rarity → detail level (common = outline only, rare = full showcase)
- **name, tier, stat** → engine: `item.name`, `item.rarity`, `item.stat`, `item.modifier`
- **flavour** → LLM: one lore sentence
- **colour strategy** → engine: item type (elemental → one-hue ramp; ornate → temperature split)

**Scenarios:** rare+ drop notification; legendary item in bestiary; inspect of a significant item. Common loot stays in DIALOGUE_MODAL — the showcase register itself signals rarity.

### 3.12 MONSTER_PORTRAIT — bestiary / inspect reply
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
- **portrait** → hybrid: `creature.name` → bestiary `.ascii` fragment (head-crop). HP → contour degradation level
- **name, HP, level** → engine: from combat edge or bestiary data
- **flavour** → LLM: one-liner, or static catalog per creature

**Scenarios:** inspect of a known creature; `/bestiary` lookup; scan result; encounter thumbnail when the player hasn't seen this foe before.

### 3.13 INVENTORY_BENTO — inventory / character sheet / shop
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
- **panel grid** → engine: inventory items, shop stock. Each item → one panel with its `.ascii` inventory-scale icon
- **cash** → engine: `wealth`
- **stats** → engine: ability scores
- **selection** → engine: active panel gets white outline (shape-redundant). LLM not involved

**Scenarios:** `/inventory`; `/shop` browse; character sheet view.

### 3.14 SPLASH — title / chapter / version stamp
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
- **scene strip** → static: one of N catalog vignettes (season/event themed)
- **credits** → engine: version number

**Scenarios:** `/hi` first-ever splash; chapter transition card; version-up announcement.

**Deferred per POC+ roadmap:** the splash showpiece stays in mvp+ansi-art; the POC+ arc ships combat + broadcast frames only.

---

## 4. The register-to-scenario matrix

Every player-facing event maps to exactly one register. The Renderer's dispatch table:

| Scenario | Trigger | Register | Width |
|---|---|---|---|
| `/join` complete | character creation | WELCOME_CARD | 30 |
| `/hi` daily check-in | morning/return | DAILY_CARD | 30 |
| `/hi` first-ever | onboarding | SPLASH | 40 |
| Combat tick — standard | combat RESOLVE_ROLL | COMBAT_FRAME | 30 |
| Combat tick — enemy attacks | combat RESOLVE_ROLL, hpDelta < 0 on Warden | COMBAT_DIAGONAL | 30 |
| Combat tick — crit/fumble | combat RESOLVE_ROLL, crit or fumble flag | COMBAT_CRIT | 30 |
| Combat tick — enemy death | combat RESOLVE_ROLL, enemyHpAfter = 0 | COMBAT_CRIT | 30 |
| Boss encounter intro | combat NEW_ACTION, boss/named foe | BOSS_INTRO | 40 |
| Skill check reveal | skill/search/buttonsRoll RESOLVE_ROLL | DATA_CARD | 24 |
| Nat 1/20 broadcast | any RESOLVE_ROLL, natural 1 or 20 | BROADCAST_CARD | 30 |
| Loot found | search RESOLVE_ROLL, add_item mutation | DIALOGUE_MODAL | 28 |
| Rare+ loot found | search/combat RESOLVE_ROLL, rare item | ITEM_SHOWCASE | 28 |
| NPC gives item | social RESOLVE_ROLL | DIALOGUE_MODAL | 28 |
| NPC dialogue | social NEW_ACTION or CONTINUE | DIALOGUE_MODAL | 28 |
| Transaction confirm | social RESOLVE_ROLL, wealth/item delta | DIALOGUE_MODAL | 28 |
| Rest/camp outcome | rest RESOLVE_ROLL | REST_STOP | 28 |
| Idle/quiet tick | rest/social non-roll resolution | REST_STOP | 28 |
| Inspect creature | `/inspect` or scan | MONSTER_PORTRAIT | 24 |
| Bestiary entry | bestiary lookup | MONSTER_PORTRAIT | 24 |
| Inventory view | `/inventory` | INVENTORY_BENTO | 30 |
| Shop browse | `/shop` | INVENTORY_BENTO | 30 |
| Character sheet | `/sheet` or `/stats` | INVENTORY_BENTO | 30 |
| Cross-player buff received | buff mutation lands on recipient | DIALOGUE_MODAL | 28 |
| Saturday boss spawn | scheduled event, public channel | BOSS_INTRO | 40 |
| Saturday boss kill | shared HP reaches 0 | COMBAT_CRIT + BROADCAST_CARD | 30 |
| Version/chapter | chapter transition | SPLASH | 40 |

---

## 5. Slot composition — the grid of ownership

Every slot in every register is one of three kinds. This grid is the contract the `AnsiRenderer` enforces:

| Slot kind | Populated by | Examples | Constraints |
|---|---|---|---|
| **Data slot** | Engine — direct variable interpolation | HP bars, stat numbers, damage floaters, dice results, pip meters, crumble state | Fixed glyph runs. Validated for width, never overflows. Always correct |
| **Text slot** | LLM — authored by a DMA with a char budget in the prompt | Message boxes, flavour text, NPC dialogue, event lines, narrator captions | Hard char budget declared in the prompt. Truncated if over. Never controls layout |
| **Fragment slot** | Hybrid — engine maps an entity key to a `.ascii` catalog entry, then applies a state variant | Sprites, monster portraits, item silhouettes, scene vignettes, rest scenes, inventory icons | `.ascii` fragment must be width-validated at catalog-load time. State transforms (solid→ghost, idle→hurt→dead) are engine-applied render passes |

### Fragment state transforms

Three render-time transforms applied to monochrome `.ascii` fragments, derivable without authoring new art:

| State | Transform | Use |
|---|---|---|
| **Solid** (default) | Full outline + fill | Owned item, alive creature, present NPC |
| **Hurt** | Contour chips + `▒` dither patches inside body. Scales: more chips as HP drops | Creature at <50% HP. Can extend across 2-3 posts for degradation-over-time |
| **Ghost** | Contour thinned to `·`/`:` stipple, fill dropped, 3–4 `✦ +` sparkles scattered | Sought/consumed item, dead/vanished creature, quest objective not yet found |
| **Sparkled** | Solid + sparkle halo | Enchanted/cursed variant |

---

## 6. Colour roles (the standard vocabulary, per-register overrides)

Base vocabulary from mvp+ansi-art, reused across all registers:

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
| 30-col register interior width | exactly 28 | Fragment catalog load + slot fill validation |
| 40-col register interior width | exactly 38 | Same |
| Text slot overflow | truncated to slot budget | Renderer truncates LLM output |
| Monochrome source width | no line exceeds interior width | `.ascii` fragment validation at catalog load |
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
   │ Interpolate │  │ Prompt DMA  │  │ Map key → .ascii │
   │ variables   │  │ with budget │  │ Apply state pass │
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
   - Fragment slots: map entity key → `.ascii` catalog entry → apply state transform
3. **Assemble monochrome** — build the complete frame as a list of fixed-width strings. Assert every line matches the interior width.
4. **Validate** — hard constraints (§7). Reject or truncate. Fill any transparent gaps with bg 44.
5. **Colour** — apply register's colour-role map: wrap glyph runs in ESC codes per the role assignments.
6. **Budget check** — count total chars including ESC codes + ` ```ansi ` fences. Reject if > 2 000.
7. **Send** — wrap in fence, post to the appropriate channel.

---

## 9. Fragment catalog — the `.ascii` asset library

The catalog maps entity keys (creature names, item names, location types) to validated `.ascii` fragments. Organised by register:

```
assets/ansi/
  combat/
    enemies/
      gloomfang.ascii
      dire_badger.ascii
      rotking.ascii
    boss/
      rotking_intro.ascii      # BOSS_INTRO viewport fragment
  items/
    consumables/
      glowcap.ascii            # inventory-scale
      potion_heal.ascii
      potion_poison.ascii
    rare/
      blade_teal.ascii         # ITEM_SHOWCASE scale
      sword_ornate.ascii
  monsters/
    bestiary/
      gloomfang_portrait.ascii # head-crop
      dire_badger_portrait.ascii
      rotking_portrait.ascii
  scenes/
    rest/
      campfire.ascii
      cave.ascii
      oak_shrine.ascii
    splash/
      pine_cottage_oak.ascii
  ui/
    inventory/
      sword_icon.ascii
      shield_icon.ascii
      potion_icon.ascii
```

Each `.ascii` file:
- Is **monochrome only** — no ESC codes in the source
- Has a header comment declaring width, register, and variant
- Is width-validated at catalog load: every line must match the declared interior width
- State transforms (solid/hurt/ghost/sparkled) are render passes, not separate files

---

## 10. LLM DMA integration — text slot contracts

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

## 11. Open questions

- [?] **Text slot overflow handling** — truncate silently, or feed a "too long" signal back to the critic DMA for a rewrite? Default: truncate with `…` at the budget boundary; log a warning so register slot sizes can be tuned.
- [?] **Fragment catalog scale** — how many enemy/item/location fragments before we need a fuzzy-match fallback (generate a new fragment via LLM or use a generic silhouette)? Default: 5–10 per category at POC+ scale; MVP needs a scaling plan.
- [?] **Per-register colour role overrides** — the lavender (35 magenta) override in INVENTORY_BENTO suggests a general pattern: should every register declare its own `ColourManifest` that may override roles? Default: yes, a manifest per register, with the standard vocabulary as fallback.
- [?] **COMBAT_DIAGONAL vs COMBAT_FRAME selection** — the Renderer decides based on `hpDelta` sign (enemy acts → diagonal, Warden acts → standard). Is this signal reliable, or should the decide-stage DMA explicitly set a `layout: "diagonal"` flag? Default: engine derives from `hpDelta`; add an explicit flag later if edge cases appear.
- [?] **BROADCAST_CARD re-enactment quality** — lifting the `outcome_text` from a private resolve that wasn't written for a public broadcast. Will it read coherently out of context? Default: test with live data in POC+ item 3; if incoherent, add a one-sentence "broadcast preamble" LLM call (cheap).
- [?] **SPLASH mobile degradation** — the 40-wide splash exceeds mobile wrap; it will be a horizontal-scroll or clipped. Is this acceptable for a one-time title screen? Default: yes — SPLASH is a deliberate desktop showpiece, and it degrades to readable monochrome art even on narrow screens.
