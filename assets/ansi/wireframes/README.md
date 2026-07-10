# Opening-frame wireframes

Canonical **monochrome mocks** of the opening frame shown for each classified action type. These are reference art — the shape the `AnsiRenderer` is coded to produce — not assets loaded at runtime. They are width-validated by `tests/render/opening-wireframes.test.ts` (every body line is exactly 30 chars) and are the **mandatory inspiration input** for any AI-authored opening frame (see the `ansi-frames` skill).

Author monochrome; colour is applied by role at render time (mobile strips colour, so the monochrome body must carry all meaning). Each `.ascii` file's frontmatter documents its register, slots, colour roles, binding (engine / LLM / fragment), and what belongs in the replied message body.

**Single-width glyphs only (hard rule).** Every character must occupy exactly one monospace cell — no emoji or Miscellaneous-Symbols / Dingbats glyphs (`⚠ ☺ ✦ ❖ ✓ ✗`), which render double-width in Discord and push the border out of line. The same trap catches East-Asian-Ambiguous punctuation like `§` and `→` (use `#` and `>`). Use ASCII, box-drawing, block/shade, and Geometric-Shapes glyphs only. See the `ansi-frames` skill §1.

## Where an opening frame sits in the pipeline

The action pipeline **always** shows an opening frame after `classify` and before the first decision:

```
/action <text>  →  classify (route to type)  →  OPENING FRAME (art post)
                                              →  reply: narration + option buttons
                                              →  … decisions …  →  outcome
```

## The art-post + reply-body convention

The frame is its own Discord message — the **art post**. The **message body** (narration, the lettered options, the buttons) is a **reply** posted beneath it. The frame is visual only; prose and interactive state live in the reply. This is the standing pattern for the whole art/Discord messaging engine — see `docs/engine/ansi-art-classification-framework.md`.

For `social`, this is load-bearing: the NPC's actual speech goes in the reply body, so the opening frame is a mute bust. For `skill` and `other` (open-ended types) the scene slot is a placeholder — the player character — until a bespoke scene exists.

## Two files per type

Each type ships a **slot template** and a **filled example**, both width-validated:

- `opening-<type>.slots.ascii` — the **generic grid**: `[data_slot]` for engine-interpolated values (`[enemy_name]`, `[hp/max]`), `[ fragment ]( dims/pose )` for hybrid DB-backed art slots. This is the contract the renderer is coded against.
- `opening-<type>.ascii` — the **inserted example**: one realized instance, so the template's slots have something concrete to read against.

Aligned with `docs/sparks/mvp+ansi-art.md` (live-tested constraints) and the register taxonomy in `docs/engine/ansi-art-classification-framework.md` (not yet fully implemented).

| Type     | Register                  | What it sets                                      |
| -------- | ------------------------- | ------------------------------------------------- |
| `combat` | COMBAT_FRAME (opener)     | foe nameplate + full HP + sprite, player footer   |
| `travel` | SCENE (route strip)       | origin → winding path → rumoured destination      |
| `social` | DIALOGUE_MODAL (bust)     | NPC bust behind rim + crest; speech in the reply  |
| `skill`  | SCENE (focus placeholder) | player char at a task rig                         |
| `search` | SCENE (scavenge)          | player peering with a lens; `?` clue glyphs       |
| `rest`   | REST_STOP (campfire)      | resting player + campfire, `z Z` sleep glyphs     |
| `other`  | SCENE (minimal)           | bare player char — the catch-all has no scene yet |

## Gallery — slot template beside its filled example

### `combat`

```
slot template                     example
+----------------------------+    +----------------------------+
|  [enemy_name]    [Lv]      |    |  GLOOMFANG           Lv 4  |
|  HP [===bar===]  [hp/max]  |    |  HP [██████████████] 20/20 |
|                            |    |                            |
|       [ enemy_big ]        |    |        /\        /\        |
|  ( sprite ~6 x 20, idle )  |    |       /  \______/  \       |
|                            |    |      |    o    o    |      |
|                            |    |      |      /\      |      |
|  [pc_small]                |    |       \    '--'    /       |
|  ( ~4 x 8 )  [pc_name][Lv] |    |        '-.______.-'        |
|              HP [bar][h/m] |    |                            |
+----------------------------+    |   ,^.                      |
                                  |  ( _ )   WARDEN      Lv 3  |
                                  |  /|_|\   HP [██████] 30/30 |
                                  |  _/ \_                     |
                                  +----------------------------+
```

### `travel`

```
slot template                     example
+----------------------------+    +----------------------------+
|  [label]                   |    |  TRAVEL                    |
|                            |    |                            |
|  [origin] o                |    |  OAK                       |
|            '.              |    |   (=)._                    |
|             '.  ( terrain )|    |       '._      ^  ^  ^     |
|                '.          |    |          '._  ^ /\ ^  ^    |
|  [ route scene fragment ]  |    |             '.(  )  ^  ^   |
|   [pc_small]     '. [dest] |    |       ,^.     '._          |
|                            |    |      ( _ )       '._  ???? |
+----------------------------+    |      /|_|\          '-(o)  |
                                  |                            |
                                  +----------------------------+
```

### `social`

```
slot template                     example
+----------------------------+    +----------------------------+
| [ rim + crest (chrome) ]   |    | .-.~.-.~< @ >~.-.~.-.~.-.  |
|                            |    |                            |
|        [ npc_bust ]        |    |           ______           |
|  ( fragment, speak pose )  |    |          /      \          |
|  ~3-4 rows, shoulders-up   |    |         | o    o |         |
|                            |    |         |   <    |         |
| [ rim (chrome) ]           |    |          \  __  /          |
| speech -> REPLY BODY       |    |          |`----'|          |
+----------------------------+    |         /|      |\         |
                                  |                            |
                                  | .-.~.-.~.-.~.-.~.-.~.-.~.  |
                                  +----------------------------+
```

### `skill`

```
slot template                     example
+----------------------------+    +----------------------------+
|  [label]                   |    |  SKILL                     |
|                            |    |                            |
|        [ pc_small ]        |    |          ,^.               |
|       ( idle pose )        |    |         ( o )              |
|                            |    |         /|_|\   ??         |
|  [ task_rig placeholder ]  |    |          / \   (  )        |
|                            |    |      ======[==]======      |
+----------------------------+    |       |            |       |
                                  |                            |
                                  +----------------------------+
```

### `search`

```
slot template                     example
+----------------------------+    +----------------------------+
|  [label]                   |    |  SEARCH                    |
|                            |    |                            |
|  [pc_small + lens]   [?]   |    |     ,^.        ?           |
|  ( peering pose )   [? ?]  |    |    ( o )     ?    ?        |
|                            |    |    /|Q|\                   |
| [ clue glyphs ] [ ground ] |    |     / \     .   ,    .     |
|                            |    |  .,·.,·.,·.,·.,·.,·.,·.,·. |
+----------------------------+    |                            |
                                  +----------------------------+
```

### `rest`

```
slot template                     example
+----------------------------+    +----------------------------+
|  [label]                   |    |  REST                      |
|                            |    |                            |
|  [sleep glyphs: z z Z]     |    |        z Z                 |
|                            |    |      z                     |
|  [pc_rest]    [ campfire ] |    |     ,^.        ( )         |
|  ( pose )     ( fragment ) |    |    ( - )      ( ~ )        |
|  [======= ground =======]  |    |    /|_|\      ,@@@,        |
+----------------------------+    |  ,,,,,,,,,@@@@@@@@@,,,,,,  |
                                  |                            |
                                  +----------------------------+
```

### `other`

```
slot template                     example
+----------------------------+    +----------------------------+
|  [label]                   |    |  . . .                     |
|                            |    |                            |
|        [ pc_small ]        |    |            ,^.             |
|      ( placeholder )       |    |           ( o )            |
|                            |    |           /|_|\            |
|  ( no bespoke scene yet )  |    |             |              |
|                            |    |           _/ \_            |
+----------------------------+    |                            |
                                  +----------------------------+
```
