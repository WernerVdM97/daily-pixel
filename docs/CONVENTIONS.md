# Docs Conventions

How we keep a brainstorm-heavy repo from turning into slop. Read this before adding a doc.

The deal is simple: **bodies are free-form** (dump ideas however you like), but **every file carries strict frontmatter** and lives in the right folder. The frontmatter is what lets us tell a wild idea from a locked direction at a glance, and lets tools (and future-you) navigate.

---

## 1. Every file starts with frontmatter

Copy the shape from **[`docs/templates/doc-template.md`](./templates/doc-template.md)** — that's the canonical frontmatter (and body) skeleton; don't reproduce it here.

`title`, `status`, `domain` are **required**. `tags`, `phase`, and `related` are strongly encouraged. The `supersedes` / `superseded_by` pair appears only on docs involved in a replacement. Shipped docs may use `superseded_by: "implemented in code"` to signal the spec was built.

### `phase` — the implementation target

| phase | Meaning |
| --- | --- |
| `poc` | Essential for a short proof-of-concept. Ship or die. |
| `mvp` | Core game loop, needed before anyone plays for real. |
| `mvp+` | Polish, depth, and deferred features. Only after POC survives. |

`phase` is orthogonal to `status`. A doc can be `status: spark, phase: poc` (raw idea, but essential) or `status: exploring, phase: mvp+` (fleshed-out, but deferred).

### List markers

Bodies use Obsidian task markers to signal the *kind* of list item, not just done-ness. A marker is **always a list item**: write `- [!] text`, never a bare `[!] text` line, which Obsidian renders as prose and which no reader can tell from a stray bracket.

Decision-making (any doc):

- `- [?]` open question
- `- [!]` critical/must-resolve
- `- [I]` alternative idea
- `- [p]` pro
- `- [c]` con

Progress (build plans / specs):

- `- [ ]` to-do
- `- [/]` in progress
- `- [x]` done
- `- [-]` cancelled
- `- [>]` forwarded
- `- [<]` scheduled

**Never use `[x]` in sparks** (`[x]` tracks code implementation only). Never use plain `-` bullets when a list mixes kinds; mix flavours freely.

> **NB** The set above is closed, and the letters are load-bearing: `[p]` is not `[P]`, and `[M]` or any other invented letter is a typo that reads as a decision, not a marker. If a genuinely new kind of item is needed, add it to this table (and say what it means) before the doc that uses it lands.

## 2. `status` — the maturity signal (lives here, never in the folder)

A doc only moves between folders once as it matures from a spark. Its maturity is further tagged in this one field.

| status       | Meaning                                                             | Trust it to…                                                       |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `spark`      | Raw idea. May be half-baked, wrong, or contradict another spark.    | …capture a thought. Don't build on it.                             |
| `exploring`  | A real candidate direction, actively being fleshed out. Not locked. | …discuss and prototype against, knowing it may change.             |
| `decided`    | This **is** the direction. Build against it.                        | …implement. Changing it requires a decision record.                |
| `shipped`    | Implemented. The code is the living artifact.                       | …read for history. The spec has been built.                        |
| `superseded` | Retired for a replacement, which `superseded_by` names.             | …understand why we moved on. Nothing else.                         |
| `nogo`       | Explored and rejected. Won't pursue — at least not in current form. | …remember why we said no. Don't resurrect without new information. |

The last three are **archive reasons**, and the only statuses a retired doc may carry. There is no `archived` status: the folder says *that* a doc was retired, the status says *why* — `shipped` (the code is the living artifact), `superseded` (`superseded_by` names the replacement) or `nogo` (we said no).

**Rule:** to overturn a `decided` or `shipped` doc, write a `decisions/` record and flip the old doc to `superseded` — don't silently edit it into something new, and don't open a competing third doc.

**When to use `nogo`:** a spark was explored (prototyped, researched, or discussed) and the conclusion was "not now, maybe never." Unlike `superseded`, there's no replacement — just a door we chose not to walk through. Kept so we don't re-litigate the same idea next month.

---

## 3. `domain` — which part of the design a doc belongs to

| Folder       | Domain     | Holds                                                                                                                                                |
| ------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vision/`    | `vision`   | Mission, pillars, north star, goals, non-goals. The "why."                                                                                           |
| `game/`      | `game`     | Core loop, mechanics, economy, world, narrative design.                                                                                              |
| `engine/`    | `engine`   | Graph DB, render, simulation, LLM gateway, data model. The "how it runs."                                                                            |
| `ui/`        | `ui`       | Discord UX, command flows, ASCII presentation, and `ui/mockups/`.                                                                                    |
| `decisions/` | —          | Decision records (ADRs): cross-cutting trade-offs that have been resolved.                                                                           |
| `sparks/`    | `spark`    | Design inbox. All docs live here during Phase 1 (design). Docs graduate to domain folders when they reach `status: exploring` or higher in Phase 2+. |
| `archived/`  | —          | Done deals, kept for history: shipped specs, rejected ideas, replaced directions. Flat: one file per doc, no per-arc subfolders.                     |

`domain` matches the folder the file sits in, with one exception: under `archived/` it keeps the domain the doc had when it was retired, so we can still see where it came from. That is the only exception, and it is the folder — never a field — that marks a doc as retired, so the tooling filters on the folder: `Docs Index.base` drops `archived/` from its by-domain view with `!file.inFolder("docs/archived")`, and its archive view groups what lives there by `status`.

A flattened archive loses the arc a doc was written for, so the map's archived table carries it in an `Arc` column (`poc`, `poc-plus`, `json-seam`, `v12-build-plans`, `factory`, …).

---

## 4. The sparks → domain flow

1. New idea → drop it in `sparks/` with `status: spark`, `domain: spark`.
2. When it earns a clear domain and firm direction, **`git mv`** it into that folder and bump `status` to `exploring` (or `decided`).
3. When it becomes the direction → `status: decided`.
4. When it's been implemented and the code is the living artifact → **`git mv`** it into `archived/` (flat, filename only), keep the `domain` it had, flip `status` to `shipped`, set `superseded_by: "implemented in code"`, and move its row out of its domain's table into the map's archived table. Archived docs are history, not active reference, so they appear on the map under `🗄️ archived` rather than among the live docs. Active docs that link to them should note the reference in their `related:` frontmatter so readers know where to look.

Sparks are allowed to be messy and to contradict each other. The other folders are not.

---

## 5. Decisions resolve conflicts (don't spawn a third doc)

When two docs disagree, or a trade-off gets settled, write a record in `decisions/`:

- State the **context**, the **options**, and the **choice** (with consequences).
- Flip any losing doc to `status: superseded` and set its `superseded_by`.
- Link the decision from the `related` of the docs it touches.

This is the single most important anti-slop habit: **contradictions become one decision, not two rival docs that quietly drift.**

---

## 6. Naming & links

- **Filenames:** `kebab-case.md`, descriptive, one topic per file. No dates in the name (that's git's job).
- **Links:** use Obsidian-style `[[doc-name]]` (filename, no path/extension) in `related` and prose — on-theme with the vault and resilient to moves. Plain relative links work too for GitHub rendering.
- **Assets:** images live in `docs/assets/`. Name them after the doc they support.

---

## 7. The index

Every doc must appear in the map of content — **[`docs/README.md`](./README.md)**, which owns the index and its maintenance rules. Add your doc's row there when you create it: in its domain's table while it lives, in the `🗄️ archived` table once it is retired, which carries `Reason`, `Arc`, `Doc`, `Domain` and `Summary`. If it's not on the map, it's slop.

Maintain it when docs are promoted through statuses.

---

## 8. Citing the source

Docs describe the code, so they cite it — and the citation is the part that rots first.

- **Name the file and the symbol, never a line number.** `src/engine/action/PipelineActionStateMachine.ts`, function `enqueueContinue` survives an edit; `machine.ts:562` is a lie the day after it is written, and nothing flags it.
- **A retired path is a stale citation too.** When a module is renamed or moved, the docs that name the old one are wrong until it is swept; the sweep is the librarian's, but the rename's author is the cheapest place to catch it.
