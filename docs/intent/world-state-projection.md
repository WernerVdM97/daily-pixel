# The Vault View — World State Projection

> *The graph is the world. The vault is the window. You never write the window — you render it.*

---

A companion to [daily-fellowship-game.md](./daily-fellowship-game.md). That doc describes *what* the world is. This one describes how the entire living world — every PC, NPC, location, item, and quest — is mirrored into a browsable Obsidian-style markdown vault **without spending a meaningful number of LLM tokens.**

The reference is a real year-long Curse of Strahd campaign archive: one markdown file per entity, `[[wikilinks]]` between them, aggregate roll-up files (a party sheet, a quest list, a session log), published as a static site. That vault was hand-written by a human DM. Ours is **rendered automatically from the graph DB** — but it should *read* as if a careful chronicler kept it.

---

## The Core Principle

**Markdown is a view, not a source.** State lives in one place — the graph DB. A markdown file is a pure function of the relevant subgraph:

```
render(node, subgraph) → markdown_file
```

`render()` is a deterministic template. It runs on every daily tick, costs **zero LLM tokens**, and simply overwrites the file. A git diff of the vault after each tick becomes a free, human-readable audit log of everything the simulation did that day.

The catch is that some of what we want in the file is *prose* — narrative English a template can't invent. The resolution is the principle that makes the whole scheme cheap:

> **LLM-authored prose is itself state. It is generated once, on an event, and stored as a field on the graph node. Every subsequent `render()` injects the stored string — it never re-calls the LLM.**

Your schema already anticipates this: `Location.description_cache`, `NPC.dialogue_cache_keys`, `Quest.generated_text`, and the NPC weekly `summary` are all cached prose. The vault view is just a second consumer of those same cached strings.

### Data vs. prose

| | What it is | Who writes it | Token cost |
|---|---|---|---|
| **Data** | `wealth: 280c`, `location: [[The Winery]]`, `hope: 8` | Deterministic sim | 0 — templated |
| **Prose** | "Garrick is proud of his new anvil but the smoke keeps him up at night." | LLM, on an event | Paid once, then cached and reused forever |

A template phrases data for free. The LLM is only ever paid to write prose, only when a meaningful event fires, and never again for that same prose.

---

## The Two Mechanisms

The vault is built from exactly two patterns. Everything else is a special case of these.

### Mechanism B — Entity files: skeleton + cached prose

One file per entity, **overwritten** every tick. Structure:

1. **Frontmatter** — the machine-readable current-state mirror (the canonical fields, serialized straight from the node).
2. **Templated body** — tables, stats, and `[[wikilink]]` edge lists, generated deterministically.
3. **Fenced prose blocks** — LLM-authored strings pulled verbatim from graph fields, wrapped in markers so `render()` knows they are cached, not generated:

```markdown
<!-- llm:weekly-summary gen=day49 hash=a3f2 -->
Garrick is proud of his new anvil...
<!-- /llm -->
```

The fence carries the provenance: which field, when it was generated, and a hash of the inputs that produced it. `render()` never touches the inside of a fence — it copies it. The prose only changes when the **weekly sentiment pass** (already budgeted at ~200 tokens/NPC) writes a new string into the node.

This is "B + D" from the design discussion: D (frontmatter-as-mirror) is simply the *format* of B's skeleton, not a separate mechanism.

### Mechanism C — Append-only logs: the timeline

Some files are never overwritten — only **appended** to. The world `Log.md`, per-character event lists, the quest timeline. A new line is added per event:

```markdown
- **Day 47** · [[Kaelen]] reached [[The Warden's Oak]]. Scouted Stonebridge — siege-smoke. → quest [[Stonebridge Burning]] opened.
```

Most lines are template-filled (free). A rare set piece (a death, the December climax) may be a one-shot LLM line, generated once and appended — never re-read, never rewritten. Append cost is constant regardless of how long the history grows.

**B answers "what is true *now*?" C answers "what *happened*?"** Every entity gets a B file; the world and each character get a C log. That is the whole system.

---

## Example: An NPC Entity File (Mechanism B)

Here is `vault/NPCs/Garrick.md` as `render()` would emit it. Annotations point to where each region comes from.

```markdown
---
id: npc_garrick                      # NPC.id
name: Garrick                        # NPC.name
role: blacksmith                     # NPC.role
status: alive                        # NPC.status
location: "[[The Winery]]"           # edge at_location(NPC→Location)
workplace: "[[Stonebridge Forge]]"   # edge works_at(NPC→Location)
home: "[[Garrick's Cottage]]"        # edge lives_at(NPC→Location)
wealth: 280                          # NPC.wealth
daily_income: 20                     # NPC.daily_income
stamina: 7/10                        # NPC.stamina_npc
sentiment: {hope: 8, fear: 5, trust_in_fellowship: 4, local_tension: 6}   # NPC.sentiment
ideals: ["community first"]          # NPC.ideals
flaws: ["proud"]                     # NPC.flaws
tags: [npc, blacksmith, stonebridge] # derived from role + location
last_tick: day_49                    # render timestamp
---

# Garrick

![[garrick.png]]                     <!-- NPC.portrait_asset -->

> [!summary] State of mind — *as of day 49*
<!-- llm:weekly-summary gen=day49 hash=a3f2 -->                 <!-- NPC.summary (cached prose) -->
> Garrick is proud of his new anvil, but the smoke from Stonebridge
> keeps him up at night. He's decided to put his best steel toward
> helping the travelers.
<!-- /llm -->

## Goals                             <!-- NPC.goals[] — templated list -->
- Forge a masterwork blade for the fellowship  *(new, day 49)*
- ~~Save for a new anvil~~  *(complete, day 45)*

## Wealth & Work                     <!-- templated table from NPC.* + town econ -->
| | Value |
|---|---|
| Wealth | 280c  *(+50 this week)* |
| Daily income | 20c  *(anvil upgrade, day 46)* |
| Town prosperity | 62/100 → income +10% |

## Bonds                             <!-- edges bonded_npc(NPC→NPC) + knows_of -->
- [[Mera]] — friend *(herbalist; trades gossip)*
- [[Kaelen]] — acquaintance *(PC; visited day 47, bought a shield)*

## Recent events                     <!-- tail of this NPC's append-only log (Mechanism C) -->
- **Day 47** · [[Kaelen]] visited. Sold a reinforced shield, +45c.
- **Day 45** · Installed new anvil. Forge quality upgraded.
- **Day 44** · Heard the Stonebridge rumor at the tavern.
```

Everything outside the `<!-- llm -->` fence is regenerated deterministically each tick. The fenced block is copied verbatim from `NPC.summary` until the weekly pass replaces that field.

The NPC file is shown here because it exercises every tier (data, hybrid drivers, edges, cached prose). The other node shapes follow the **same B + C pattern** with different fields, and have their own templates to be specified later: a **Location** file (town-economy frontmatter — `prosperity`, `supply`/`demand`, `tax_rate` — plus adjacency edges), an **Item** file (mostly static lore + an `owner`/`location` edge), a **Quest** file (`status`, `progress`, cached `generated_text`), a **PC** file (a full class/stat statblock alongside the same driver tiers), and the **aggregate roll-ups** — `The Party`, `Quests`, `Map`, and the world `Log.md` (the canonical Mechanism-C append-only timeline).

---

## Region → Graph Field Mapping

How `render()` builds each region of the file above:

| Markdown region | Source | Mechanism | Cost per tick |
|---|---|---|---|
| Frontmatter scalars (`wealth`, `role`, `sentiment`…) | Node attributes, serialized | B / D | 0 |
| Frontmatter links (`location`, `workplace`, `home`) | Follow the typed edge, emit `[[target.name]]` | B (edge → wikilink) | 0 |
| `tags` | Derived from `role` + location node | B | 0 |
| Portrait embed | `NPC.portrait_asset` path | B | 0 |
| **State-of-mind summary** | `NPC.summary` (cached string) | B, fenced prose | 0 to render; ~200 tok only when weekly pass rewrites it |
| Goals / Wealth / Bonds tables | Attributes + outgoing edges (`bonded_npc`, `knows_of`) | B, templated | 0 |
| Recent events | Tail N entries of this node's event log | C, append-only | 0 to render; ~0–50 tok if a set-piece line was LLM-authored |

The single rule: **a `[[wikilink]]` in markdown is a graph edge.** Rendering the vault is graph traversal; the prose is just cached node fields carried along for the ride.

---

## Character Drivers — the D&D Layer

A character is *driven* by the D&D-style descriptors that define who they are: alignment, class, background, ideals, flaws, bonds, motivations, agenda, traits. These do **not** split cleanly into "data" and "prose" — they fall on a spectrum, and **where you place each one decides whether it drives the deterministic sim for free or has to be authored.** This is the single most important modeling choice for a character.

The lever: **the further a driver sits toward the data end, the more it can steer the deterministic tick at zero token cost — but the more rigid it is. The further toward prose, the more flavorful and flexible — but the more mechanically inert it is** (it only affects the sim indirectly, by spawning `goals`). The art is putting each descriptor in the tier that matches how much mechanical work you want it to do.

| Tier | Descriptors | Modeled as | Drives the deterministic sim? | Token cost |
|---|---|---|---|---|
| **Enumerable data** | alignment, class, fighting style, background, species | Frontmatter enum from a **fixed vocabulary** | **Yes, directly** — categorical modifiers and decision weights | 0 |
| **Hybrid (enum + prose)** | ideals, flaws, traits | An enum **tag** (does the mechanical work) *plus* an optional cached prose line (expresses it in words) | **Yes, via the tag** | 0 to render; prose authored once when it changes |
| **Deterministic relationship** | bonds | A typed **edge** (`bonded_npc` / `trusts`: target + type + value), with optional "why" prose | **Yes** — by graph traversal | 0 |
| **Pure prose** | motivations, agenda, backstory | Cached prose field; an agenda may *spawn* `goals` (which are data) | **Only indirectly**, through the goals it generates | Authored once per change, then cached |

Three consequences worth stating plainly:

- **Alignment, class, background, fighting style are clean enums.** Alignment is the 3×3 grid (`{lawful, neutral, chaotic}` × `{good, neutral, evil}`); background is a fixed list (`scholar | noble | merchant | hero | …`); class and fighting style are bounded by the rules. All categorical, rarely change, and act as deterministic modifiers — zero tokens, full sim authority.
- **The personality triad (ideals / flaws / traits) is the interesting hybrid.** Model each as a tag from a constrained vocabulary — that tag does the mechanical work (a `proud` flaw deterministically weights Garrick toward *refusing* charity; a `community-first` ideal weights him toward *giving*). The prose is only the human-readable expression of the same tag, authored once and cached. This refines the earlier "data vs. prose" table: ideals and flaws are **not** pure data — their *tag* is data, their *expression* is prose.
- **Bonds are relationships, so they are edges — not prose, not tags.** `Garrick —friend→ Mera (value 6)` is an edge with a type and a strength the sim reads and updates. The *reason* for the bond ("they trade gossip") may be a short prose annotation, but the bond itself is structural. This is what "frame them as deterministic relationships" means.

The character-driver block of the frontmatter, made explicit:

```yaml
# --- Enumerable data: fixed vocabulary, drives the sim, 0 tokens ---
alignment: lawful-good          # DERIVED from moral_position (the 3×3 grid) — see ## Moral Drift
background: merchant            # scholar | noble | merchant | hero | ...
class: fighter                  # PCs & combat NPCs only
fighting_style: great-weapon    # bounded subset of class

# --- Hybrid: the enum tag drives decision weights; prose expresses it ---
ideals: [community-first]       # constrained vocab → weight in the decision model
flaws: [proud]                  # "proud" → deterministically resists accepting help
traits: [stubborn, generous]

# --- Deterministic relationships: rendered from edges, never authored ---
# bonds come from bonded_npc / trusts edges → see the ## Bonds section
```

Motivations and agenda are the pure-prose remainder: a cached block ("Garrick wants to matter to the fellowship; secretly fears the smoke means his town is next"), regenerated only when an event would change the person — and where it needs to *act*, it spawns a tracked `goal` (data) the sim can advance.

---

## Sentiment, Bonds & Relationships

Three axes that are easy to conflate but do different jobs. Keeping them separate is what lets the social simulation run deterministically — and it's the substrate the moral system (below) acts on.

| | Lives in | Directed? | Affective? | Answers |
|---|---|---|---|---|
| **Sentiment** | a node **attribute** (a vector on one character) | No — intrinsic | Yes (mood) | "How does this character *feel*, in general?" |
| **Bond** | an **edge** between two characters | Yes (A→B) | Yes (social) | "How does A feel about *B specifically*?" |
| **Relationship** | the **umbrella for all typed edges** | Yes | Not necessarily | "How is X *linked* to Y at all?" |

- **Sentiment** is intrinsic and undirected — `{hope, fear, trust_in_fellowship, local_tension}` living *on* the node. It points at nothing; it's a state, not a link. It is the **only** one of the three with LLM-authored prose attached (the weekly summary). Everything else feeds into it.
- **Bond** is directed, typed, and valued — `Garrick —friend(6)→ Mera`, `Kiril —rivalry→ Emil`. The affective subset of edges (family, friendship, rivalry, romance). The sim reads and updates the value deterministically; an optional short prose annotation records the *why*.
- **Relationship** is the superset: every typed edge. Most carry no feeling — `works_at`, `owns`, `at_location`, `trades_with`, `owes_debt`. **All bonds are relationships; most relationships are not bonds.**

**Two overlaps to keep straight:**

- **`trust_in_fellowship` (sentiment) vs. a `trusts` edge (bond)** — *diffuse vs. directed*. The scalar is "how warm toward the party as a whole"; the edge is "how much I trust *Kaelen specifically*." Store the edge only if the sim needs per-target resolution; otherwise the scalar suffices. Don't store both by reflex.
- **`owes_debt` (relationship) vs. a `rivalry` bond** — *money vs. emotion*. A debt is structural and economic; the feeling about it is a separate bond. The two coexist so the economy sim can settle the debt without touching the social graph.

**Mechanics — how each updates and what it drives:**

| Axis | Updated by | Drives | Token cost |
|---|---|---|---|
| **Sentiment** | aggregation of bonds + events + moral drift (deterministic); summarized by the weekly LLM pass | the weekly prose beat; town "mood" flavor; quest-hook tone | 0 to update; ~200 tok weekly summary |
| **Bonds** | events — gift `+`, betrayal `−`, co-op `+`, alignment distance (deterministic) | co-op bonuses, missed-week rescue, who travels with whom, sentiment aggregation | 0 |
| **Relationships** | the sim wiring the world — jobs, ownership, trade, debt | economy, location of things, faction logic, graph traversal for the vault | 0 |

The flow: **events update bonds and relationships → those aggregate into sentiment → the weekly LLM turns sentiment into prose.** Only the last arrow costs tokens.

---

## Moral Drift — Alignment as a Derived Label

Alignment sits in the enumerable-data tier, yet we want it to *change over time*. Resolve the tension with one move: **store a continuous moral vector; make the 3×3 label a projection of it.**

```
moral_position M = (law, good)     # two scalars in [-100, +100]
alignment_label  = bucket(M)       # which of the 9 cells M sits in — computed at render, 0 tokens
```

The label stays the cheap enumerable data the sim reads (faction reactions, modifiers); the *thing that drifts* is a number. Because the label is recomputed at render time, a drifting alignment costs **nothing** to display.

**Drift is deterministic.** Each action carries a template-defined moral delta — spare a foe `good +3`, break an oath `law −6`, steal `good −2, law −3`, charity `good +4`. The roll engine already knows what the player did, so tagging it is free; the vector simply accumulates. No LLM judges morality.

**The governor loop** (per tick, all deterministic):

```
M += Σ today's action_deltas        # behavior pushes you
M += k_decay * (anchor − M)         # the ideal pulls you back   ← keeps it in check
M += world_pressure                 # the world leans on you
M  = clamp(M, −100, +100)
```

Four governors keep it honest:

1. **Set-point gravity (the governor).** The character's **ideal** (a hybrid-tier tag) defines `anchor` — the moral position they relax toward (`community-first → ≈(+40,+60)`). `k_decay` is the conscience stiffness: **high = resists corruption and snaps back; low = malleable.** A character whose *behavior* persistently fights their *ideal* is the dramatic case — the spring loses and they drift. *This is what "keeping alignment in check" means.*
2. **Hysteresis (no flicker).** The label flips only on crossing a threshold *with margin* — Neutral→Good at `good > 34`, back only below `26` — so a boundary character doesn't oscillate daily.
3. **Mean reversion.** The decay term also stops a single bad day from locking someone Evil; yesterday's lapse fades if not repeated.
4. **Flaws bias the field.** `greedy` shifts the anchor toward evil-neutral, or shrinks the `−good` penalty on wealth-grabbing acts (rationalization).

Optional, on-theme for a dice game: gate big discrete temptations behind a **moral save** (d20 vs. resolve/WIS) — fail the save and the delta lands. Morality on the same visible-dice spine as everything else.

**World mechanic — ambient corruption.** `world_pressure` is the lever a world mechanic pulls. Proximity to the Threat applies a constant `good −p` each tick: linger near the rising evil and you drift dark *whether you act or not* — your conscience now fights an external field, not just your own choices. This is the Castlevania/Barovia premise, and the source campaign records it directly: a character "accepted the dark gift" and gained `vampirism` / `lichdom` traits. A **dark gift** is just a discrete large-delta event plus a trait flag that can flip the bucket.

**Ripple — moral drift reshapes the three axes above, for free:**

| Drift effect | Mechanism | Result |
|---|---|---|
| → **Bonds** | alignment *distance* modulates bond growth/decay | as someone drifts dark, bonds to the Good fellowship decay automatically — the social graph reacts unscripted |
| → **Sentiment** | `M` moving *away* from `anchor` (acting against the ideal) | guilt: `fear +`, `hope −`; living in accordance: `hope +` |
| → **Relationships** | factions read the derived label | temples bar the fallen; aligned towns price-favor their kin — all 0-token edge logic |

**When the LLM gets paid:** never for the drift — it is pure data. Only on a **threshold crossing** (the bucket actually flips, or behavior diverges sharply from the ideal): generate one cached beat — *"Garrick catches his own reflection and doesn't recognize the man holding the coin"* — append it to the C log, reuse forever. A full corruption system, emergent, at ~0 marginal token cost.

**Schema — added to the source-of-truth driver block:**

```yaml
moral_position: {law: -12, good: 41}   # the continuous truth — drifts each tick
moral_anchor:   {law: +40, good: +60}  # derived from ideals — the set point
k_decay: 0.15                          # conscience stiffness (high = sticky, low = malleable)
alignment: neutral-good                # DERIVED bucket(moral_position) — render-time output
```

`alignment` is *output*, recomputed each render — never authored. `moral_anchor` is itself derived from `ideals` (+ `flaws` bias), so the only independently stored field is `moral_position`.

---

## When `render()` Runs, and When the LLM Runs

```
DAILY TICK (deterministic, 0 LLM tokens)
  1. Sim advances the graph (rolls, economy, NPC routines)
  2. For each node touched today: render(node) → overwrite its B file
  3. For each event today: append one line to the relevant C log(s)
  4. (optional) git commit the vault → free daily audit diff

WEEKLY PASS (the ONLY routine LLM spend)
  For each key NPC within 2 hops of an active player:
    - generate new `summary` (~200 tok), write it to the node
  Next render() picks up the new string for free.

EVENT-DRIVEN (rare, one-shot, cached)
  Death narration, quest text, December set pieces:
    - generate once, store on the node / append to a C log, reuse forever.
```

The vault can be re-rendered from scratch a thousand times and cost nothing — because rendering reads cached prose, it never authors it.

---

## Token Economics — and When It Grows Significant

Steady-state cost stays at the ~2K tokens/week already budgeted for the weekly sentiment pass, **independent of how many files the vault has or how often it is rendered.** Cost scales with *narrative events*, not with world size or view frequency.

It only becomes significant if a design choice breaks the principle above:

| Trap | Why it explodes | The discipline |
|---|---|---|
| Regenerating prose every tick | 365 days × N NPCs of LLM calls | Gate prose behind a state-delta; render copies the cached field |
| Re-summarizing the log to keep it short | Cost grows with total history (re-reads everything) | Append-only; never re-read to rewrite |
| "Pretty-writing" deterministic data | Paying an LLM to phrase `wealth: 280` | Template all data; the LLM never sees a number |
| Full-file LLM rewrites for a one-field change | Whole file in + whole file out, every time | Patch the one fenced region; everything else is deterministic |
| Feeding the whole vault as generation context | Input tokens scale with world size — the silent killer | Feed only the 2-hop subgraph, never the kingdom |

---

## Direction of Truth

The graph DB is the **single source of truth**; the vault is a generated, effectively read-only projection. We do **not** parse markdown back into state during normal operation — that would invite drift and make the markdown a second database to keep consistent. (Frontmatter is structured enough to *re-ingest* as a cold backup or migration path, but that is a recovery tool, not the live loop.)

This gives the COS "see the whole world at a glance" property — browse in Obsidian, publish via Quartz — while every byte in the vault traces back to a graph field, and the only thing we ever pay an LLM for is a sentence no template could have written.

---

*Design intent, not a specification. Hand off to `spec-driven-development` for the `render()` contract and the exact frontmatter schema per node type.*
