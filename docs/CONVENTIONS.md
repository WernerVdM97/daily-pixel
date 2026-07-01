# Docs Conventions

How we keep a brainstorm-heavy repo from turning into slop. Read this before adding a doc.

The deal is simple: **bodies are free-form** (dump ideas however you like), but **every file carries strict frontmatter** and lives in the right folder. The frontmatter is what lets us tell a wild idea from a locked direction at a glance, and lets tools (and future-you) navigate.

---

## 1. Every file starts with frontmatter

Copy the shape from **[`docs/templates/doc-template.md`](./templates/doc-template.md)** — that's the canonical frontmatter (and body) skeleton; don't reproduce it here.

`title`, `status`, `domain` are **required**. `tags`, `phase`, and `related` are strongly encouraged. The `supersedes` / `superseded_by` pair appears only on docs involved in a replacement. Shipped docs may use `superseded_by: "implemented in code"` to signal the spec was built.

### `phase` — the implementation target

| phase | Meaning |
|---|---|
| `poc` | Essential for a short proof-of-concept. Ship or die. |
| `mvp` | Core game loop, needed before anyone plays for real. |
| `mvp+` | Polish, depth, and deferred features. Only after POC survives. |

`phase` is orthogonal to `status`. A doc can be `status: spark, phase: poc` (raw idea, but essential) or `status: exploring, phase: mvp+` (fleshed-out, but deferred).

### List markers

Bodies use Obsidian task markers to signal the *kind* of list item, not just done-ness. **Never use `[x]` in sparks** (`[x]` tracks code implementation only). Never use plain `-` bullets when a list mixes kinds; mix flavours freely.

Decision-making (any doc):
[?] open question
[!] critical/must-resolve
[I] alternative idea
[p] pro
[c] con

Progress (build plans / specs):
[ ] to-do
[/] in progress
[x] done
[-] cancelled
[>] forwarded
[<] scheduled

## 2. `status` — the maturity signal (lives here, never in the folder)

A doc only moves between folders once as it matures from a spark. Its maturity is further tagged in this one field.

| status       | Meaning                                                             | Trust it to…                                                       |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `spark`      | Raw idea. May be half-baked, wrong, or contradict another spark.    | …capture a thought. Don't build on it.                             |
| `exploring`  | A real candidate direction, actively being fleshed out. Not locked. | …discuss and prototype against, knowing it may change.             |
| `decided`    | This **is** the direction. Build against it.                        | …implement. Changing it requires a decision record.                |
| `shipped`    | Implemented and archived. The code is the living artifact.          | …read for history. The spec has been built.                        |
| `superseded` | Kept for history. Points to what replaced it via `superseded_by`.   | …understand why we moved on. Nothing else.                         |
| `nogo`       | Explored and rejected. Won't pursue — at least not in current form. | …remember why we said no. Don't resurrect without new information. |

**Rule:** to overturn a `decided` or `shipped` doc, write a `decisions/` record and flip the old doc to `superseded` — don't silently edit it into something new, and don't open a competing third doc.

**When to use `nogo`:** a spark was explored (prototyped, researched, or discussed) and the conclusion was "not now, maybe never." Unlike `superseded`, there's no replacement — just a door we chose not to walk through. Kept so we don't re-litigate the same idea next month.

---

## 3. `domain` — the folder

| Folder       | Domain     | Holds                                                                                                                                                |
| ------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vision/`    | `vision`   | Mission, pillars, north star, goals, non-goals. The "why."                                                                                           |
| `game/`      | `game`     | Core loop, mechanics, economy, world, narrative design.                                                                                              |
| `engine/`    | `engine`   | Graph DB, render, simulation, LLM gateway, data model. The "how it runs."                                                                            |
| `ui/`        | `ui`       | Discord UX, command flows, ASCII presentation, and `ui/mockups/`.                                                                                    |
| `decisions/` | —          | Decision records (ADRs): cross-cutting trade-offs that have been resolved.                                                                           |
| `sparks/`    | `spark`    | Design inbox. All docs live here during Phase 1 (design). Docs graduate to domain folders when they reach `status: exploring` or higher in Phase 2+. |
| `archived/`  | `archived` | Done deals: shipped specs (`status: shipped`), rejected ideas (`status: nogo`), replaced directions (`status: superseded`). Kept for history.        |

`domain` in frontmatter always matches the folder the file sits in.

---

## 4. The sparks → domain flow

1. New idea → drop it in `sparks/` with `status: spark`, `domain: spark`.
2. When it earns a clear domain and firm direction, **`git mv`** it into that folder and bump `status` to `exploring` (or `decided`).
3. When it becomes the direction → `status: decided`.
4. When it's been implemented and the code is the living artifact → **`git mv`** into `archived/`, flip `status` to `shipped`, set `superseded_by: "implemented in code"`. Shipped docs don't appear in the map of content — they're history, not active reference. Active docs that link to shipped docs should note the reference in their `related:` frontmatter so readers know where to look.

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

Every doc must appear in the map of content — **[`docs/README.md`](./README.md)**, which owns the index and its maintenance rules. Add your doc's row there when you create it. If it's not on the map, it's slop.

Maintain it when docs are promoted through statusses.
