---
title: The Vault View — World State Projection
status: spark
domain: spark
tags:
- ascii
- vault
- data-model
- llm
related:
- '[[mvp-character-drivers]]'
- '[[mvp-social-model]]'
- '[[mvp+moral-drift]]'
- '[[mvp-ascii-render-pipeline]]'
- '[[pitch-and-pillars]]'
phase: mvp+
---

# The Vault View — World State Projection

> *The graph is the world. The vault is the window. You never write the window — you render it.*

---

A companion to [[pitch-and-pillars.md]]. That doc describes *what* the world is. This one describes how the entire living world — every PC, NPC, location, item, and quest — is mirrored into a browsable Obsidian-style markdown vault **without spending a meaningful number of LLM tokens.**

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
